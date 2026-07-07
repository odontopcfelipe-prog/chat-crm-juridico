import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { formatTenantAddress, toBrazilWhatsappNumber, DEFAULT_ORTO_REMINDER } from '@crm/shared';

/**
 * Onda 18.x — LEMBRETE DE ORTODONTIA (por ordem de chegada) ~1h antes.
 *
 * Ortodontia atende em FLUXO (vários pacientes no mesmo bloco, sem hora
 * exclusiva). Este disparo avisa o paciente ~1h antes de os "portões abrirem",
 * reforçando que é por ordem de chegada.
 *
 * Diferente da confirmação (scheduler + dispatcher separados p/ auditoria), este
 * é SELF-CONTAINED: agenda e envia no mesmo cron. Roda XX:10 (depois do
 * confirmation scheduler XX:00 e dispatcher XX:05) pra não competir por recursos.
 *
 * Janela: eventos type=ORTODONTIA com start_at entre +1h e +2h (banda de 1h ⇒
 * idempotente por hora — cada evento cai em exatamente uma execução). Com o cron
 * no topo da hora, aberturas em hora cheia (08:00, 14:00) recebem ~1h antes.
 *
 * OPT-IN: só dispara se APPOINTMENT_ORTO_REMINDER_ENABLED_<tenant> === 'true'.
 * Dedup + auditoria via DispatchLog (type='orto_reminder', ref_event_id).
 */
@Injectable()
export class AppointmentOrtoReminderService {
  private readonly logger = new Logger(AppointmentOrtoReminderService.name);
  private readonly MAX_PER_RUN = 50;

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
  ) {}

  @Cron('10 * * * *', { timeZone: 'America/Maceio' })
  async sendOrtoReminders() {
    try {
      const now = new Date();
      const in1h = new Date(now.getTime() + 60 * 60 * 1000);
      const in2h = new Date(now.getTime() + 120 * 60 * 1000);

      const eligible = await this.prisma.calendarEvent.findMany({
        where: {
          type: 'ORTODONTIA',
          status: { in: ['AGENDADO', 'CONFIRMADO'] },
          patient_id: { not: null },
          start_at: { gte: in1h, lt: in2h },
        },
        take: this.MAX_PER_RUN,
        select: {
          id: true,
          tenant_id: true,
          start_at: true,
          location: true,
          assigned_user: { select: { name: true } },
          patient: { select: { id: true, name: true, phone: true } },
        },
      });

      if (eligible.length === 0) return;

      // Config Evolution global (URL + key) — sem ela nao ha como enviar.
      const { apiUrl, apiKey } = await this.settings.getEvolutionConfig();
      if (!apiUrl || !apiKey) {
        this.logger.warn('[OrtoReminder] Evolution API nao configurada — skip');
        return;
      }

      // Caches por tenant (evita query repetida no mesmo run)
      const enabledByTenant = new Map<string, boolean>();
      const templateByTenant = new Map<string, string>();
      const addressByTenant = new Map<string, string>();
      const instanceByTenant = new Map<string, string | null>();

      let sent = 0;
      let failed = 0;
      let skipped = 0;

      for (const ev of eligible) {
        const tid = ev.tenant_id || '';
        const phone = ev.patient?.phone;
        if (!phone) { skipped++; continue; }

        // OPT-IN: só dispara com o toggle explicitamente ligado (default OFF).
        let enabled = enabledByTenant.get(tid);
        if (enabled === undefined) {
          const s = await this.prisma.globalSetting.findUnique({
            where: { key: `APPOINTMENT_ORTO_REMINDER_ENABLED_${tid}` },
          });
          enabled = s?.value === 'true';
          enabledByTenant.set(tid, enabled);
        }
        if (!enabled) { skipped++; continue; }

        // Dedup: já mandamos o lembrete de orto pra este evento?
        const already = await this.prisma.dispatchLog.findFirst({
          where: { tenant_id: tid, type: 'orto_reminder', ref_event_id: ev.id },
          select: { id: true },
        });
        if (already) { skipped++; continue; }

        // Resolve instance do tenant. Mensagem é pro PACIENTE ⇒ prefere o chip
        // CLINICA (principal), com fallback pra qualquer instance (tenant 1-chip).
        let instance = instanceByTenant.get(tid);
        if (instance === undefined) {
          const clinica = await this.prisma.instance.findFirst({
            where: { tenant_id: tid, purpose: 'CLINICA' },
            select: { name: true },
            orderBy: { name: 'asc' },
          });
          const inst = clinica || await this.prisma.instance.findFirst({
            where: { tenant_id: tid },
            select: { name: true },
            orderBy: { name: 'asc' },
          });
          instance = inst?.name || null;
          instanceByTenant.set(tid, instance);
        }
        if (!instance) { skipped++; continue; }

        // Template editável do tenant (fallback pro default do @crm/shared).
        let tpl = templateByTenant.get(tid);
        if (tpl === undefined) {
          const ts = await this.prisma.globalSetting.findUnique({
            where: { key: `APPOINTMENT_ORTO_REMINDER_TEMPLATE_${tid}` },
          });
          let parsed: any = null;
          try { parsed = ts?.value ? JSON.parse(ts.value) : null; } catch { parsed = null; }
          tpl =
            parsed && typeof parsed.template === 'string' && parsed.template.trim()
              ? String(parsed.template)
              : DEFAULT_ORTO_REMINDER;
          templateByTenant.set(tid, tpl);
        }

        // {local} = local do evento OU endereço cadastrado da clínica.
        let tenantAddr = addressByTenant.get(tid);
        if (tenantAddr === undefined) {
          const trow = await this.prisma.tenant.findUnique({
            where: { id: tid },
            select: {
              address: true, address_number: true, address_complement: true,
              neighborhood: true, city: true, state: true,
            },
          });
          tenantAddr = formatTenantAddress(trow);
          addressByTenant.set(tid, tenantAddr);
        }

        const time = new Date(ev.start_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const date = new Date(ev.start_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        const local = ev.location || tenantAddr;
        const localLine = local ? `📍 ${local}\n` : '';
        const message = tpl
          .replace(/\{nome_completo\}/g, ev.patient!.name)
          .replace(/\{nome\}/g, ev.patient!.name.split(' ')[0])
          .replace(/\{dentista\}/g, ev.assigned_user?.name || 'a clínica')
          .replace(/\{data\}/g, date)
          .replace(/\{hora\}/g, time)
          .replace(/\{local_line\}/g, localLine)
          .replace(/\{local\}/g, local)
          .replace(/\n{3,}/g, '\n\n')
          .trim();

        try {
          await axios.post(
            `${apiUrl}/message/sendText/${instance}`,
            { number: toBrazilWhatsappNumber(phone), text: message },
            { headers: { 'Content-Type': 'application/json', apikey: apiKey }, timeout: 15000 },
          );
          await this.prisma.dispatchLog.create({
            data: {
              tenant_id: tid,
              type: 'orto_reminder',
              channel: 'WHATSAPP',
              recipient_name: ev.patient?.name,
              recipient_phone: phone,
              status: 'SENT',
              ref_event_id: ev.id,
              ref_patient_id: ev.patient?.id,
            },
          });
          sent++;
        } catch (err: any) {
          const msg = err?.response?.data?.message || err?.message || 'erro desconhecido';
          // Registra a FALHA (com ref_event_id) — assim não re-tenta em loop no mesmo
          // evento a cada hora; a auditoria fica no DispatchLog.
          await this.prisma.dispatchLog.create({
            data: {
              tenant_id: tid,
              type: 'orto_reminder',
              channel: 'WHATSAPP',
              recipient_name: ev.patient?.name,
              recipient_phone: phone,
              status: 'FAILED',
              error: String(msg).slice(0, 300),
              ref_event_id: ev.id,
              ref_patient_id: ev.patient?.id,
            },
          }).catch(() => {});
          failed++;
        }
      }

      if (sent > 0 || failed > 0 || skipped > 0) {
        this.logger.log(`[OrtoReminder] ${sent} enviado(s), ${failed} falha(s), ${skipped} pulado(s) de ${eligible.length}`);
      }
    } catch (e: any) {
      this.logger.error(`[OrtoReminder] Erro: ${e.message}`);
    }
  }
}
