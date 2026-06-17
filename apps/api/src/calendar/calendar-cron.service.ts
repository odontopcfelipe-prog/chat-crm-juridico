import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ChatGateway } from '../gateway/chat.gateway';
import { CalendarService } from './calendar.service';

@Injectable()
export class CalendarCronService {
  private readonly logger = new Logger(CalendarCronService.name);

  constructor(
    private prisma: PrismaService,
    private chatGateway: ChatGateway,
    @Inject(forwardRef(() => CalendarService)) private calendarService: CalendarService,
  ) {}

  /**
   * Check for PUSH reminders every minute.
   * Finds reminders where:
   * - channel = PUSH
   * - sent_at IS NULL
   * - trigger time (event.start_at - minutes_before) is within now..now+2min
   * - event not cancelled/concluded
   */
  @Cron('*/1 * * * *')
  async checkPushReminders() {
    try {
      const now = new Date();
      const in2min = new Date(now.getTime() + 2 * 60 * 1000);

      const reminders = await this.prisma.$queryRaw<
        { id: string; event_id: string; minutes_before: number; title: string; type: string; start_at: Date; assigned_user_id: string | null; tenant_id: string | null }[]
      >`
        SELECT er.id, er.event_id, er.minutes_before,
               ce.title, ce.type, ce.start_at, ce.assigned_user_id, ce.tenant_id
        FROM "EventReminder" er
        JOIN "CalendarEvent" ce ON er.event_id = ce.id
        WHERE er.channel = 'PUSH'
          AND er.sent_at IS NULL
          AND ce.start_at - (er.minutes_before * interval '1 minute') BETWEEN ${now} AND ${in2min}
          AND ce.status NOT IN ('CANCELADO', 'CONCLUIDO', 'ADIADO')
      `;

      if (reminders.length > 0) {
        this.logger.log(`[CRON] Encontrados ${reminders.length} lembretes PUSH para enviar`);
      }

      // Onda 17.49 — respeita o toggle "Lembrete" (default LIGADO) por tenant.
      const reminderEnabledByTenant = new Map<string, boolean>();

      for (const r of reminders) {
        const tid = r.tenant_id || '';
        let lembreteOn = reminderEnabledByTenant.get(tid);
        if (lembreteOn === undefined) {
          const s = await this.prisma.globalSetting.findUnique({ where: { key: `REMINDER_CONFIG_${tid}` } });
          lembreteOn = true;
          if (s?.value) { try { lembreteOn = JSON.parse(s.value)?.enabled !== false; } catch { lembreteOn = true; } }
          reminderEnabledByTenant.set(tid, lembreteOn);
        }
        // Desligado: nao emite nem marca (fica pendente; nao dispara nesse minuto).
        if (!lembreteOn) continue;

        if (r.assigned_user_id) {
          try {
            this.chatGateway.emitCalendarReminder(r.assigned_user_id, {
              eventId: r.event_id,
              title: r.title,
              type: r.type,
              start_at: r.start_at.toISOString(),
              minutesBefore: r.minutes_before,
            });
          } catch (e: any) {
            this.logger.error(`[CRON] Erro ao emitir lembrete PUSH para user ${r.assigned_user_id}: ${e.message}`);
          }
        }

        // Mark as sent
        await this.prisma.eventReminder.update({
          where: { id: r.id },
          data: { sent_at: new Date() },
        });
      }
    } catch (e: any) {
      this.logger.error(`[CRON] Erro no checkPushReminders: ${e.message}`);
    }
  }

  /**
   * Resumo diario pra dentistas — Onda 5e v30 (Fase 25).
   *
   * Roda toda hora cheia. Pra cada tenant com config enabled=true cuja
   * send_at bate com a hora atual (HH:00, ignora minutos), dispara o
   * resumo do dia pra todos os dentistas com atendimentos.
   *
   * Multi-tenant: itera todas as configs DENTIST_DAILY_SUMMARY_*
   * cadastradas no GlobalSetting.
   */
  @Cron('0 * * * *')
  async checkDentistDailySummary() {
    try {
      const now = new Date();
      const currentHHMM = `${String(now.getUTCHours()).padStart(2, '0')}:00`;

      const settings = await this.prisma.globalSetting.findMany({
        where: { key: { startsWith: 'DENTIST_DAILY_SUMMARY' } },
      });

      for (const s of settings) {
        let cfg: any;
        try {
          cfg = JSON.parse(s.value || '{}');
        } catch {
          continue;
        }
        if (!cfg.enabled) continue;
        // Compara so a hora — minutos sao ignorados pra simplicidade
        // (cron roda no minuto 0 entao send_at "07:30" ainda dispara as 07:00).
        const sendHH = String(cfg.send_at || '07:00').split(':')[0];
        if (sendHH !== String(now.getUTCHours()).padStart(2, '0')) continue;

        // Extrai tenant_id da chave (DENTIST_DAILY_SUMMARY_<tenant>)
        const tenantId = s.key === 'DENTIST_DAILY_SUMMARY'
          ? undefined
          : s.key.replace(/^DENTIST_DAILY_SUMMARY_/, '');

        try {
          await this.calendarService.sendDentistDailySummaryNow(tenantId);
          this.logger.log(`[CRON] Resumo diario disparado pra tenant ${tenantId || 'global'} (${currentHHMM})`);
        } catch (e: any) {
          this.logger.error(`[CRON] Erro no resumo diario tenant ${tenantId}: ${e.message}`);
        }
      }
    } catch (e: any) {
      this.logger.error(`[CRON] Erro no checkDentistDailySummary: ${e.message}`);
    }
  }
}
