import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import {
  computeBusinessHoursStatus,
  isAfterHoursAiEnabled,
  loadBusinessHoursSettings,
  loadOfficeHoursValues,
} from '@crm/shared';

/**
 * AfterHoursService
 * ─────────────────
 * Liga a IA fora do expediente APENAS em conversas de CLIENTES
 * (lead.is_client=true) — eles usam a skill "Acompanhamento de Cliente" e
 * esperam atendimento humano durante o dia. Leads (is_client=false) são
 * atendidos 24/7 pela IA com skills de triagem normais, então o cron NÃO
 * mexe neles.
 *
 * POR CLÍNICA: cada tenant segue o PRÓPRIO horário (grade de Ajustes › IA →
 * horário do escritório da clínica → global legado), os PRÓPRIOS feriados e o
 * PRÓPRIO liga/desliga (AFTER_HOURS_AI_ENABLED da clínica, senão o global), e
 * só mexe nas conversas DELA. Antes era um horário único pra todas as clínicas
 * e o feriado de uma fechava todas. Conversas legadas sem clínica seguem a
 * regra global (só feriados globais).
 *
 * COMPORTAMENTO DA TRANSIÇÃO:
 *  - Fora do expediente → liga IA (`ai_mode=true, source='CRON_AFTER_HOURS'`).
 *  - Entrada no expediente → NÃO desliga a IA. Apenas limpa
 *    `ai_mode_source=NULL`. IA permanece ligada até o operador desligar
 *    manualmente. O prompt da IA usa {{business_hours_info}} (calculado no
 *    processor) para decidir se menciona o horário ao cliente.
 *
 * Conversas em modo MANUAL nunca são mexidas pelo cron.
 *
 * A lógica de horário, feriado e timezone vive em `@crm/shared`
 * (business-hours.ts) e é compartilhada com o ai.processor.
 */
@Injectable()
export class AfterHoursService {
  private readonly logger = new Logger(AfterHoursService.name);

  constructor(private prisma: PrismaService) {}

  /** Roda a cada 5 minutos no timezone de Maceió. */
  @Cron('*/5 * * * *', { timeZone: 'America/Maceio' })
  async tick() {
    let tenants: { id: string }[];
    try {
      tenants = await this.prisma.tenant.findMany({
        where: { status: { not: 'DELETED' } },
        select: { id: true },
      });
    } catch (e: any) {
      this.logger.error(`[AfterHours] Falha ao listar clínicas: ${e.message}`);
      return;
    }
    for (const t of tenants) await this.tickTenant(t.id);
    // Conversas legadas sem clínica: regra global (como antes).
    await this.tickTenant(null);
  }

  /** Uma clínica (ou `null` = conversas sem clínica): horário, feriado e flag DELA. */
  private async tickTenant(tenantId: string | null) {
    const label = tenantId ?? 'sem-clinica';
    try {
      const { values } = await loadOfficeHoursValues(this.prisma, tenantId);
      if (!isAfterHoursAiEnabled(values)) {
        this.logger.debug(`[AfterHours] [${label}] AFTER_HOURS_AI_ENABLED=false — pulando`);
        return;
      }

      const status = await computeBusinessHoursStatus(this.prisma, tenantId);
      this.logger.debug(
        `[AfterHours] [${label}] ${status.currentDayName} ${status.currentTime} businessHour=${status.isBusinessHour} holiday=${status.isHoliday}`,
      );

      if (status.isBusinessHour) {
        await this.restoreBusinessHours(tenantId);
      } else {
        await this.activateAfterHours(tenantId);
      }
    } catch (e: any) {
      this.logger.error(`[AfterHours] [${label}] Falha no tick: ${e.message}`);
    }
  }

  // ─── Núcleo ────────────────────────────────────────────────────────

  private async activateAfterHours(tenantId: string | null): Promise<void> {
    // Só age em conversas de CLIENTES (lead.is_client=true) DESTA clínica.
    // Lógica 3-valores do SQL: `ai_mode_source <> 'MANUAL'` retorna NULL
    // quando a coluna é NULL — cobrimos NULL explicitamente no OR.
    const result = await this.prisma.conversation.updateMany({
      where: {
        tenant_id: tenantId,
        status: { notIn: ['FECHADO', 'ENCERRADO'] },
        ai_mode: false,
        lead: { is_client: true },
        OR: [
          { ai_mode_source: null },
          { ai_mode_source: { not: 'MANUAL' } },
        ],
      },
      data: {
        ai_mode: true,
        ai_mode_source: 'CRON_AFTER_HOURS',
        ai_mode_disabled_at: null,
      },
    });

    if (result.count > 0) {
      this.logger.log(
        `[AfterHours] [${tenantId ?? 'sem-clinica'}] 🌙 Modo noturno ativado: ${result.count} conversa(s) de cliente com IA ligada`,
      );
    }
  }

  private async restoreBusinessHours(tenantId: string | null): Promise<void> {
    // Entrada no expediente: IA continua ligada; apenas limpa a origem
    // CRON_AFTER_HOURS. Operador desliga manualmente se quiser assumir.
    const result = await this.prisma.conversation.updateMany({
      where: {
        tenant_id: tenantId,
        ai_mode: true,
        ai_mode_source: 'CRON_AFTER_HOURS',
      },
      data: {
        ai_mode_source: null,
      },
    });

    if (result.count > 0) {
      this.logger.log(
        `[AfterHours] [${tenantId ?? 'sem-clinica'}] ☀️  Transição diurna: ${result.count} conversa(s) de cliente mantêm IA ligada (origem CRON limpa)`,
      );
    }
  }

  // ─── Exposto só para smoke test ────────────────────────────────────
  async loadSettings(tenantId: string | null = null) {
    return loadBusinessHoursSettings(this.prisma, tenantId);
  }
}
