/**
 * Registro de acesso (Marco Civil da Internet, art. 15): data e hora de cada
 * entrada pela tela de login e o IP de origem, na tabela AccessLog. Guardado por
 * 6 meses; uma vez por dia apaga o que passou disso.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import type { OrigemDaRequisicao } from '../common/utils/origem-da-requisicao';

/** 6 meses contados com folga (6 × 31 dias): nada sai antes de completar 6 meses. */
export const DIAS_DE_GUARDA_DO_ACESSO = 186;

/** Antes disto, o registro já passou dos 6 meses. */
export function limiteDaGuarda(agora: Date): Date {
  return new Date(agora.getTime() - DIAS_DE_GUARDA_DO_ACESSO * 24 * 60 * 60 * 1000);
}

/** Linha da AccessLog de quem acabou de entrar. */
export function dadosDoAcesso(user: { id: string; tenant_id?: string | null }, origem: OrigemDaRequisicao) {
  return {
    user_id: user.id,
    tenant_id: user.tenant_id ?? null,
    ip: origem.ip,
    user_agent: origem.user_agent,
  };
}

@Injectable()
export class LimpezaDoRegistroDeAcesso {
  private readonly logger = new Logger(LimpezaDoRegistroDeAcesso.name);

  constructor(private prisma: PrismaService) {}

  @Cron('20 4 * * *', { timeZone: 'America/Maceio' })
  async limpar(agora: Date = new Date()): Promise<number> {
    try {
      const r = await this.prisma.accessLog.deleteMany({ where: { created_at: { lt: limiteDaGuarda(agora) } } });
      if (r.count) this.logger.log(`[ACESSO] ${r.count} registros de acesso com mais de 6 meses apagados`);
      return r.count;
    } catch (e: any) {
      this.logger.warn(`[ACESSO] limpeza dos registros de acesso falhou: ${e?.message}`);
      return 0;
    }
  }
}
