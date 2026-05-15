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
import { computeNextRunAt, interpolateTemplate } from '@crm/shared';
import axios from 'axios';

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
    const scheduledFor = sch.next_run_at as Date;
    const recipients = await this.resolveRecipients(sch);

    if (recipients.length === 0) {
      this.logger.warn(`[INF-MSG] Schedule ${sch.id} sem destinatários — pulando`);
    } else {
      let sent = 0;
      let failed = 0;
      let skipped = 0;

      for (const inf of recipients) {
        const result = await this.dispatchOne(sch, inf, scheduledFor);
        if (result === 'SENT') sent++;
        else if (result === 'FAILED') failed++;
        else skipped++;
      }
      this.logger.log(
        `[INF-MSG] Schedule "${sch.name}" (${sch.id}): ${sent} enviado(s), ${failed} falha(s), ${skipped} pulado(s) de ${recipients.length} destinatário(s)`,
      );
    }

    // Recalcula next_run_at pro próximo disparo
    const nextRunAt = computeNextRunAt(
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

    await (this.prisma as any).influencerSchedule.update({
      where: { id: sch.id },
      data: {
        last_run_at: now,
        next_run_at: nextRunAt,
        active: sch.schedule_type === 'ONCE' ? false : sch.active,
      },
    });
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
      const instance = process.env.EVOLUTION_INSTANCE_NAME || 'whatsapp';
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
