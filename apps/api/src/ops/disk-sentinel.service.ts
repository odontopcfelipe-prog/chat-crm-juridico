import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { promises as fs } from 'fs';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../common/mail/mail.service';

/**
 * F0b — vigia de disco do servidor.
 *
 * O servidor já parou por disco cheio (imagens Docker acumuladas). A cada 10 min
 * mede o disco onde ficam as mídias (MEDIA_STORAGE_PATH — mesmo volume do host)
 * e, a partir de 80%, manda e-mail aos SUPER_ADMIN: no máximo 1 por faixa (80% e
 * 90%) por dia, com o tamanho do banco e da tabela de anexos dos disparos (que
 * guarda vídeo em bytea e pode estar em outro disco). Só lê e avisa; não apaga nada.
 *
 * Envs: DISK_SENTINEL_OFF=1 desliga; DISK_SENTINEL_LIMITES="80,90" muda as
 * faixas (ex.: "1,2" para testar o e-mail).
 */
@Injectable()
export class DiskSentinelService {
  private readonly logger = new Logger('DiskSentinel');

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
  ) {}

  @Cron('*/10 * * * *')
  async verificar(): Promise<void> {
    if (process.env.DISK_SENTINEL_OFF === '1') return;
    try {
      const caminho = process.env.MEDIA_STORAGE_PATH || '/var/lib/crm-media';
      const uso = await usoDoDisco(caminho);
      const faixa = faixaAtingida(uso.pct, limites());
      if (faixa === null) return;
      this.logger.warn(`[DISK] ${caminho}: ${uso.pct.toFixed(1)}% usado (${gb(uso.livre)} livres) — faixa ${faixa}%`);
      const hoje = hojeMaceio();
      if (!(await this.reivindicarAvisoDoDia(faixa, hoje))) return;
      // Nenhum e-mail saiu (SMTP fora, sem destinatário, erro): devolve a trava para a
      // próxima rodada tentar de novo — senão o aviso da faixa some pelo resto do dia.
      let enviados = 0;
      try {
        enviados = await this.avisar(caminho, uso, faixa);
      } finally {
        if (enviados === 0) await this.liberarAvisoDoDia(faixa, hoje).catch(() => undefined);
      }
    } catch (e: any) {
      this.logger.warn(`[DISK] vigia falhou: ${e?.message}`);
    }
  }

  /**
   * 1 e-mail por faixa por dia, mesmo com mais de uma réplica da API: trava
   * atômica numa GlobalSetting (DISK_SENTINEL_<faixa> = data de hoje em Maceió).
   */
  private async reivindicarAvisoDoDia(faixa: number, hoje: string): Promise<boolean> {
    const key = `DISK_SENTINEL_${faixa}`;
    const r = await this.prisma.globalSetting.updateMany({
      where: { key, value: { not: hoje } },
      data: { value: hoje },
    });
    if (r.count > 0) return true;
    try {
      await this.prisma.globalSetting.create({ data: { key, value: hoje } });
      return true;
    } catch {
      return false; // já existe com a data de hoje (outra réplica ou outra rodada)
    }
  }

  /** Só desfaz a trava que ainda é de hoje (não apaga a de outra rodada). */
  private async liberarAvisoDoDia(faixa: number, hoje: string): Promise<void> {
    await this.prisma.globalSetting.updateMany({
      where: { key: `DISK_SENTINEL_${faixa}`, value: hoje },
      data: { value: '' },
    });
  }

  /** Devolve quantos e-mails saíram de fato. */
  private async avisar(caminho: string, uso: UsoDisco, faixa: number): Promise<number> {
    const [banco, anexos] = await Promise.all([
      this.tamanho(`SELECT pg_database_size(current_database())::bigint AS n`),
      this.tamanho(`SELECT pg_total_relation_size('"DisparoAnexo"')::bigint AS n`),
    ]);
    const destinos = await this.prisma.user.findMany({
      where: { roles: { has: 'SUPER_ADMIN' }, email: { not: '' } },
      select: { email: true },
    });
    const emails = [...new Set(destinos.map((d) => d.email).filter((e): e is string => !!e))];
    if (!emails.length) {
      this.logger.warn('[DISK] nenhum SUPER_ADMIN com e-mail para avisar');
      return 0;
    }
    const linhas = [
      `Disco do servidor em <b>${uso.pct.toFixed(1)}%</b> (faixa de ${faixa}%).`,
      `Livre: <b>${gb(uso.livre)}</b> de ${gb(uso.total)} (medido em ${caminho}).`,
      banco !== null ? `Banco de dados: ${gb(banco)}.` : '',
      anexos !== null ? `Anexos dos disparos (DisparoAnexo): ${gb(anexos)}.` : '',
      'O que fazer: no servidor, <code>df -h</code> e <code>docker system df</code>; imagens antigas ocupam a maior parte.',
    ].filter(Boolean);
    const html = this.mail.renderTemplate({
      title: `Disco do servidor em ${uso.pct.toFixed(0)}%`,
      bodyHtml: linhas.join('<br>'),
      footerNote: 'Aviso automático do vigia de disco — no máximo 1 por faixa por dia.',
    });
    let enviados = 0;
    for (const to of emails) {
      try {
        if (await this.mail.send({ to, subject: `⚠️ Disco do servidor em ${uso.pct.toFixed(0)}%`, html })) enviados++;
      } catch (e: any) {
        this.logger.warn(`[DISK] e-mail para ${to} falhou: ${e?.message}`);
      }
    }
    return enviados;
  }

  private async tamanho(sql: string): Promise<number | null> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ n: bigint | number }[]>(sql);
      return rows?.[0]?.n != null ? Number(rows[0].n) : null;
    } catch {
      return null;
    }
  }
}

export type UsoDisco = { pct: number; total: number; livre: number };

/** Mesmo cálculo do `df`: usado / (usado + disponível para usuário comum). */
export async function usoDoDisco(caminho: string): Promise<UsoDisco> {
  const s = await fs.statfs(caminho);
  const usado = (s.blocks - s.bfree) * s.bsize;
  const livre = s.bavail * s.bsize;
  const pct = usado + livre > 0 ? (usado / (usado + livre)) * 100 : 0;
  return { pct, total: s.blocks * s.bsize, livre };
}

export function limites(env = process.env.DISK_SENTINEL_LIMITES): number[] {
  const v = (env || '80,90')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 100);
  return (v.length ? v : [80, 90]).sort((a, b) => a - b);
}

/** Maior faixa atingida, ou null abaixo da menor. */
export function faixaAtingida(pct: number, faixas: number[]): number | null {
  let achou: number | null = null;
  for (const f of faixas) if (pct >= f) achou = f;
  return achou;
}

/** Data de hoje em Maceió (UTC-3), AAAA-MM-DD. */
function hojeMaceio(): string {
  return new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
