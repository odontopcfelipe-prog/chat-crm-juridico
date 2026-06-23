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
      // Onda 17.56 — hora no fuso America/Maceio (UTC-3). Antes comparava em UTC,
      // então send_at "07:00" disparava às 04:00 local. Espelha checkBirthdayGreetings.
      const maceio = new Date(now.getTime() - 3 * 60 * 60 * 1000);
      const maceioHH = String(maceio.getUTCHours()).padStart(2, '0');
      const currentHHMM = `${maceioHH}:00`;

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
        const sendHH = String(cfg.send_at || '07:00').split(':')[0].padStart(2, '0');
        if (sendHH !== maceioHH) continue;

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

  /**
   * Disparo de aniversário (Onda 17.49). Roda toda hora cheia. Pra cada tenant
   * com BIRTHDAY_GREETING enabled cujo send_at bate com a hora ATUAL em Maceió
   * (UTC-3) e que ainda não disparou hoje (last_run_date), manda os parabéns.
   */
  @Cron('0 * * * *')
  async checkBirthdayGreetings() {
    try {
      const now = new Date();
      // Hora e data no fuso America/Maceio (UTC-3, sem horario de verao).
      const maceio = new Date(now.getTime() - 3 * 60 * 60 * 1000);
      const maceioHH = String(maceio.getUTCHours()).padStart(2, '0');
      const todayMaceio = maceio.toISOString().slice(0, 10); // YYYY-MM-DD

      const settings = await this.prisma.globalSetting.findMany({
        where: { key: { startsWith: 'BIRTHDAY_GREETING' } },
      });

      for (const s of settings) {
        let cfg: any;
        try { cfg = JSON.parse(s.value || '{}'); } catch { continue; }

        const tenantId = s.key === 'BIRTHDAY_GREETING'
          ? undefined
          : s.key.replace(/^BIRTHDAY_GREETING_/, '');
        if (!tenantId) continue; // aniversario e sempre por-tenant

        // Onda 17.61 — DUAS mensagens no dia (o desejo e o presente), cada uma no
        // seu horario e com dedup proprio (last_run_date / message2_last_run_date).
        const msg1HH = String(cfg.send_at || '00:00').split(':')[0].padStart(2, '0');
        const msg2HH = String(cfg.message2_send_at || '12:00').split(':')[0].padStart(2, '0');

        // Mensagem 1 — o desejo
        if (cfg.enabled && msg1HH === maceioHH && cfg.last_run_date !== todayMaceio) {
          try {
            await this.calendarService.setBirthdayGreetingConfig(tenantId, { last_run_date: todayMaceio });
            await this.calendarService.sendBirthdayGreetingsNow(tenantId, 1);
            this.logger.log(`[CRON] Aniversario msg1 (desejo) disparada pra tenant ${tenantId} (${maceioHH}:00 Maceio)`);
          } catch (e: any) {
            this.logger.error(`[CRON] Erro no disparo msg1 aniversario tenant ${tenantId}: ${e.message}`);
          }
        }

        // Mensagem 2 — o presente
        if (cfg.message2_enabled && msg2HH === maceioHH && cfg.message2_last_run_date !== todayMaceio) {
          try {
            await this.calendarService.setBirthdayGreetingConfig(tenantId, { message2_last_run_date: todayMaceio });
            await this.calendarService.sendBirthdayGreetingsNow(tenantId, 2);
            this.logger.log(`[CRON] Aniversario msg2 (presente) disparada pra tenant ${tenantId} (${maceioHH}:00 Maceio)`);
          } catch (e: any) {
            this.logger.error(`[CRON] Erro no disparo msg2 aniversario tenant ${tenantId}: ${e.message}`);
          }
        }
      }
    } catch (e: any) {
      this.logger.error(`[CRON] Erro no checkBirthdayGreetings: ${e.message}`);
    }
  }
}
