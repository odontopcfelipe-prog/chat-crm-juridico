/**
 * Worker cron de mensagens automáticas pra influenciadores.
 *
 * Roda a cada minuto: busca InfluencerSchedule com active=true e
 * next_run_at <= now(). Pra cada schedule, resolve destinatários
 * (filtro + manual), interpola template, envia WhatsApp via Evolution API,
 * grava log idempotente (chave única schedule+influencer+scheduled_for),
 * e recalcula next_run_at:
 *   - ONCE → next_run_at = null + active = false
 *   - RECURRING → próxima ocorrência baseada em recurrence + hora
 *
 * Idempotência: se o worker reiniciar entre o disparo e a marcação de log,
 * o índice único (schedule_id, influencer_id, scheduled_for) bloqueia envio
 * duplicado.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { chipPacienteOuLegado, computeNextRunAt, contaDoLabPodeEnviar, escolherChipPaciente, interpolateTemplate, isLabTenant } from '@crm/shared';
import axios from 'axios';
import { resolveOwnedEnvChip } from '../admin-alerts/env-chip';

const MAX_SCHEDULES_PER_TICK = 50;
const MAX_RECIPIENTS_PER_SCHEDULE = 500;

@Injectable()
export class InfluencerMessagesCronService {
  private readonly logger = new Logger(InfluencerMessagesCronService.name);

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { timeZone: 'America/Maceio' })
  async tick() {
    const now = new Date();

    const schedules = await (this.prisma as any).influencerSchedule.findMany({
      where: {
        active: true,
        next_run_at: { not: null, lte: now },
      },
      include: { template: true },
      take: MAX_SCHEDULES_PER_TICK,
    });

    if (schedules.length === 0) return;

    this.logger.log(`[INF-MSG] ${schedules.length} schedule(s) elegível(is) neste tick`);

    for (const sch of schedules) {
      try {
        await this.processSchedule(sch, now);
      } catch (e: any) {
        this.logger.error(`[INF-MSG] Falha processando schedule ${sch.id}: ${e.message}`);
      }
    }
  }

  private async processSchedule(sch: any, now: Date) {
    // Laboratório com a conta suspensa ou congelada: nada sai e o agendamento não fica
    // voltando a cada minuto. O recorrente pula para a próxima ocorrência; o de uma vez só
    // é olhado de novo em 1 h e sai quando a conta voltar a ficar ativa.
    if (
      (await isLabTenant(this.prisma, sch.tenant_id, (m) => this.logger.warn(m))) &&
      !(await contaDoLabPodeEnviar(this.prisma, sch.tenant_id))
    ) {
      this.logger.log(`[INF-MSG] Schedule ${sch.id} — conta de laboratório suspensa: não envia`);
      await (this.prisma as any).influencerSchedule.update({
        where: { id: sch.id },
        data: {
          next_run_at: sch.schedule_type === 'ONCE' ? new Date(now.getTime() + 60 * 60_000) : this.proximaOcorrencia(sch, now),
        },
      });
      return;
    }

    const scheduledFor = sch.next_run_at as Date;
    const recipients = await this.resolveRecipients(sch);
    // Laboratório: o envio sai pelo chip da própria conta (undefined = clínica, como sempre).
    const chipDoLab = recipients.length > 0 ? await this.chipDoLaboratorio(sch.tenant_id) : undefined;

    if (recipients.length === 0) {
      this.logger.warn(`[INF-MSG] Schedule ${sch.id} sem destinatários — pulando`);
    } else {
      let sent = 0;
      let failed = 0;
      let skipped = 0;

      for (const inf of recipients) {
        const result = await this.dispatchOne(sch, inf, scheduledFor, chipDoLab);
        if (result === 'SENT') sent++;
        else if (result === 'FAILED') failed++;
        else skipped++;
      }
      this.logger.log(
        `[INF-MSG] Schedule "${sch.name}" (${sch.id}): ${sent} enviado(s), ${failed} falha(s), ${skipped} pulado(s) de ${recipients.length} destinatário(s)`,
      );
    }

    // Recalcula next_run_at pro próximo disparo
    const nextRunAt = this.proximaOcorrencia(sch, now);

    await (this.prisma as any).influencerSchedule.update({
      where: { id: sch.id },
      data: {
        last_run_at: now,
        next_run_at: nextRunAt,
        active: sch.schedule_type === 'ONCE' ? false : sch.active,
      },
    });
  }

  private proximaOcorrencia(sch: any, now: Date) {
    return computeNextRunAt(
      {
        schedule_type: sch.schedule_type,
        run_at: sch.run_at,
        recurrence: sch.recurrence,
        weekdays: sch.weekdays || [],
        day_of_month: sch.day_of_month,
        hour: sch.hour,
        minute: sch.minute,
      },
      now,
    );
  }

  /**
   * Conta de laboratório: o chip dela (Comercial, senão Atendimento; nunca o Financeiro).
   * null = laboratório sem chip próprio (o envio é registrado como falha). undefined = a
   * conta não é laboratório. Nunca cai no chip padrão do servidor.
   */
  private async chipDoLaboratorio(tenantId: string): Promise<string | null | undefined> {
    if (!(await isLabTenant(this.prisma, tenantId, (m) => this.logger.warn(m)))) return undefined;
    const chips = await this.prisma.instance.findMany({
      where: { type: 'whatsapp', tenant_id: tenantId },
      orderBy: { created_at: 'asc' },
      select: { name: true, purpose: true },
    });
    return chipPacienteOuLegado(escolherChipPaciente(chips, 'COMERCIAL'));
  }

  /** Aplica filtros + soma com lista manual. Deduplica por id. */
  private async resolveRecipients(sch: any): Promise<any[]> {
    const where: any = { tenant_id: sch.tenant_id };

    // Filtro automático (qualquer um pode estar vazio)
    if (sch.filter_status && sch.filter_status.length > 0) {
      where.status = { in: sch.filter_status };
    }
    if (sch.filter_platform && sch.filter_platform.length > 0) {
      where.platform = { in: sch.filter_platform };
    }
    if (sch.filter_niche) {
      where.niche = { contains: sch.filter_niche, mode: 'insensitive' };
    }

    const hasAutoFilter =
      (sch.filter_status?.length || 0) > 0 ||
      (sch.filter_platform?.length || 0) > 0 ||
      !!sch.filter_niche;

    const hasManual = (sch.manual_recipient_ids?.length || 0) > 0;

    // Se nada foi configurado: NÃO dispara pra todos automaticamente.
    // Forçar configuração explícita previne disparo acidental pro tenant todo.
    if (!hasAutoFilter && !hasManual) return [];

    let auto: any[] = [];
    if (hasAutoFilter) {
      auto = await (this.prisma as any).influencer.findMany({
        where,
        take: MAX_RECIPIENTS_PER_SCHEDULE,
      });
    }

    let manual: any[] = [];
    if (hasManual) {
      manual = await (this.prisma as any).influencer.findMany({
        where: { tenant_id: sch.tenant_id, id: { in: sch.manual_recipient_ids } },
      });
    }

    // Deduplica por id
    const map = new Map<string, any>();
    for (const i of auto) map.set(i.id, i);
    for (const i of manual) map.set(i.id, i);
    return Array.from(map.values()).slice(0, MAX_RECIPIENTS_PER_SCHEDULE);
  }

  /** Envia 1 mensagem + cria log. Retorna SENT | FAILED | SKIPPED. */
  private async dispatchOne(
    sch: any,
    inf: any,
    scheduledFor: Date,
    chipDoLab?: string | null,
  ): Promise<'SENT' | 'FAILED' | 'SKIPPED'> {
    if (!inf.phone) {
      await this.writeLog(sch, inf, scheduledFor, {
        status: 'SKIPPED',
        error_message: 'Influenciador sem telefone',
      });
      return 'SKIPPED';
    }

    const text = interpolateTemplate(sch.template.body, {
      nome: inf.name,
      handle: inf.handle || '',
      cupom: inf.coupon_code || '',
      plataforma: inf.platform || '',
      nicho: inf.niche || '',
    });

    try {
      const { apiUrl, apiKey } = await this.settings.getEvolutionConfig();
      if (!apiUrl) {
        await this.writeLog(sch, inf, scheduledFor, {
          status: 'FAILED',
          error_message: 'Evolution apiUrl não configurada',
        });
        return 'FAILED';
      }
      // Chip padrão do servidor SÓ se for desta clínica (env-chip.ts; cache de 60s, não
      // consulta por destinatário). Sem ele → catch abaixo: log FAILED, como o 404 de hoje.
      const instance = chipDoLab !== undefined
        ? chipDoLab
        : await resolveOwnedEnvChip(this.prisma, sch.tenant_id, 'influenciadores', 'whatsapp');
      if (!instance) {
        throw new Error(
          chipDoLab !== undefined
            ? 'Laboratório sem WhatsApp conectado — conecte um número em Configurações'
            : 'Clínica sem chip próprio — o chip padrão do servidor não é desta clínica',
        );
      }
      const cleanPhone = inf.phone.replace(/\D/g, '');
      const res = await axios.post(
        `${apiUrl}/message/sendText/${instance}`,
        { number: cleanPhone, text },
        { headers: { apikey: apiKey }, timeout: 15000 },
      );
      const externalId: string | null =
        res.data?.key?.id || res.data?.messageId || null;

      await this.writeLog(sch, inf, scheduledFor, {
        status: 'SENT',
        sent_at: new Date(),
        sent_text: text,
        external_id: externalId,
      });
      return 'SENT';
    } catch (e: any) {
      await this.writeLog(sch, inf, scheduledFor, {
        status: 'FAILED',
        sent_text: text,
        error_message: e?.message?.slice(0, 500) || 'Erro desconhecido',
      });
      return 'FAILED';
    }
  }

  /**
   * Grava log respeitando idempotência: usa upsert na chave única
   * (schedule, influencer, scheduled_for). Se já existir, atualiza —
   * proteção contra restart entre envio e gravação.
   */
  private async writeLog(
    sch: any,
    inf: any,
    scheduledFor: Date,
    fields: {
      status: 'SENT' | 'FAILED' | 'SKIPPED';
      sent_at?: Date;
      sent_text?: string;
      external_id?: string | null;
      error_message?: string;
    },
  ) {
    try {
      await (this.prisma as any).influencerMessageLog.upsert({
        where: {
          schedule_id_influencer_id_scheduled_for: {
            schedule_id: sch.id,
            influencer_id: inf.id,
            scheduled_for: scheduledFor,
          },
        },
        create: {
          tenant_id: sch.tenant_id,
          schedule_id: sch.id,
          influencer_id: inf.id,
          scheduled_for: scheduledFor,
          status: fields.status,
          sent_at: fields.sent_at,
          sent_text: fields.sent_text,
          external_id: fields.external_id,
          error_message: fields.error_message,
        },
        update: {
          status: fields.status,
          sent_at: fields.sent_at,
          sent_text: fields.sent_text,
          external_id: fields.external_id,
          error_message: fields.error_message,
        },
      });
    } catch (e: any) {
      this.logger.warn(`[INF-MSG] Falha ao gravar log: ${e.message}`);
    }
  }
}
