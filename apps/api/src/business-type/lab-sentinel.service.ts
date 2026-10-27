import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BT_LABORATORIO } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../common/mail/mail.service';
import { registrarAuditoria } from '../common/utils/audit-log.util';
import { contarForaDoLugar, foraDoLugar, type ContagemDaVigia } from './lab-sentinela';

const CHAVE_DO_DIA = 'LAB_SENTINEL_DIA';

/**
 * F2 parte 4 do laboratório — vigia diária (07:30, Maceió).
 *
 * Para cada conta de laboratório conta o que não pode existir nela (lab-sentinela.ts:
 * entidade clínica, IA, agenda de clínica, chip de outra conta, Asaas sem chave
 * própria). Tudo zero → só log. Acima de zero → AuditLog LAB_SENTINEL na conta e
 * UM e-mail por dia aos SUPER_ADMIN com a lista, enquanto houver algo fora do lugar.
 * Sem laboratório → log '[LAB-SENTINEL] 0 laboratórios' e mais nada.
 *
 * Só lê e avisa; não apaga nada. LAB_SENTINEL_OFF=1 desliga.
 */
@Injectable()
export class LabSentinelService {
  private readonly logger = new Logger('LabSentinel');

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
  ) {}

  @Cron('30 7 * * *', { timeZone: 'America/Maceio' })
  async verificar(): Promise<void> {
    if (process.env.LAB_SENTINEL_OFF === '1') return;
    try {
      // Leitura direta (sem o cache que nunca falha): se a tabela não responder, a
      // vigia registra a falha em vez de dizer "0 laboratórios".
      const labs = await this.prisma.tenantBusinessProfile.findMany({
        where: { business_type: BT_LABORATORIO },
        select: { tenant_id: true, tenant: { select: { name: true } } },
      });
      if (!labs.length) {
        this.logger.log('[LAB-SENTINEL] 0 laboratórios');
        return;
      }
      const achados: Array<{ id: string; nome: string; fora: ContagemDaVigia }> = [];
      for (const lab of labs) {
        const fora = foraDoLugar(await contarForaDoLugar(this.prisma, lab.tenant_id));
        if (Object.keys(fora).length) achados.push({ id: lab.tenant_id, nome: lab.tenant?.name || lab.tenant_id, fora });
      }
      if (!achados.length) {
        this.logger.log(`[LAB-SENTINEL] ${labs.length} laboratório(s), nada fora do lugar`);
        return;
      }
      for (const a of achados) this.logger.warn(`[LAB-SENTINEL] ${a.id} ${JSON.stringify(a.fora)}`);

      const hoje = hojeMaceio();
      if (!(await this.reivindicarODia(hoje))) return;
      let enviados = 0;
      try {
        for (const a of achados) {
          await registrarAuditoria(
            this.prisma,
            { tenantId: a.id, entity: 'LABORATORIO', entityId: a.id, action: 'LAB_SENTINEL', meta: { contagens: a.fora } },
            this.logger,
          );
        }
        enviados = await this.avisar(achados);
      } finally {
        // Nenhum e-mail saiu (SMTP fora, sem destinatário): devolve a trava para a
        // próxima rodada (o reinício da API ou o dia seguinte) tentar de novo.
        if (enviados === 0) await this.liberarODia(hoje).catch(() => undefined);
      }
    } catch (e: any) {
      this.logger.warn(`[LAB-SENTINEL] vigia falhou: ${e?.message}`);
    }
  }

  /** 1 rodada com aviso por dia, mesmo com mais de uma réplica da API. */
  private async reivindicarODia(hoje: string): Promise<boolean> {
    const r = await this.prisma.globalSetting.updateMany({
      where: { key: CHAVE_DO_DIA, value: { not: hoje } },
      data: { value: hoje },
    });
    if (r.count > 0) return true;
    try {
      await this.prisma.globalSetting.create({ data: { key: CHAVE_DO_DIA, value: hoje } });
      return true;
    } catch {
      return false; // já existe com a data de hoje (outra réplica)
    }
  }

  private async liberarODia(hoje: string): Promise<void> {
    await this.prisma.globalSetting.updateMany({ where: { key: CHAVE_DO_DIA, value: hoje }, data: { value: '' } });
  }

  /** Devolve quantos e-mails saíram de fato. */
  private async avisar(achados: Array<{ id: string; nome: string; fora: ContagemDaVigia }>): Promise<number> {
    const destinos = await this.prisma.user.findMany({
      where: { roles: { has: 'SUPER_ADMIN' }, email: { not: '' } },
      select: { email: true },
    });
    const emails = [...new Set(destinos.map((d) => d.email).filter((e): e is string => !!e))];
    if (!emails.length) {
      this.logger.warn('[LAB-SENTINEL] nenhum SUPER_ADMIN com e-mail para avisar');
      return 0;
    }
    const blocos = achados.map((a) => {
      const itens = Object.entries(a.fora)
        .map(([nome, n]) => `<li>${escapar(nome)}: <b>${n}</b></li>`)
        .join('');
      return `<p><b>${escapar(a.nome)}</b> <small>(${escapar(a.id)})</small></p><ul>${itens}</ul>`;
    });
    const html = this.mail.renderTemplate({
      title: 'Laboratório com dado que não é dele',
      bodyHtml: [
        'A vigia diária achou, em conta de laboratório, registros que só existem em clínica (ou envio por chip de outra conta).',
        ...blocos,
        'O que fazer: conferir de onde vieram (AuditLog LAB_SENTINEL e VERTICAL_DENIED da conta). Se for vazamento, congelar com LAB_FREEZE = true.',
      ].join('<br>'),
      footerNote: 'Aviso automático da vigia do laboratório — no máximo 1 por dia enquanto houver algo fora do lugar.',
    });
    let enviados = 0;
    for (const to of emails) {
      try {
        if (await this.mail.send({ to, subject: '⚠️ Vigia do laboratório: dado fora do lugar', html })) enviados++;
      } catch (e: any) {
        this.logger.warn(`[LAB-SENTINEL] e-mail para ${to} falhou: ${e?.message}`);
      }
    }
    return enviados;
  }
}

/** Data de hoje em Maceió (UTC-3), AAAA-MM-DD. */
function hojeMaceio(): string {
  return new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
}

function escapar(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
