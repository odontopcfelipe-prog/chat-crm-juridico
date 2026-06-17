import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

/**
 * Cron horario que processa AppointmentConfirmation pendentes
 * (sent_at IS NULL, response_status = PENDENTE) e dispara via Evolution
 * API para o telefone do paciente.
 *
 * Roda 5 minutos apos o scheduler (XX:05) para reduzir condicao de
 * corrida com AppointmentConfirmationSchedulerService.
 *
 * Para cada confirmacao:
 *  1. Carrega agendamento + paciente (telefone obrigatorio)
 *  2. Descobre instance WhatsApp do tenant (primeira Instance ativa)
 *  3. Envia via Evolution API
 *  4. Atualiza sent_at + delivery_status (SENT ou FAILED)
 *
 * Failsafe: maximo de 50 envios por execucao para evitar burst.
 */
@Injectable()
export class AppointmentConfirmationDispatcherService {
  private readonly logger = new Logger(AppointmentConfirmationDispatcherService.name);
  private readonly MAX_PER_RUN = 50;

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
  ) {}

  @Cron('5 * * * *', { timeZone: 'America/Maceio' })
  async dispatchPending() {
    try {
      const pending = await this.prisma.appointmentConfirmation.findMany({
        where: {
          sent_at: null,
          response_status: 'PENDENTE',
          channel: 'WHATSAPP',
        },
        take: this.MAX_PER_RUN,
        orderBy: { created_at: 'asc' },
        include: {
          appointment: {
            select: {
              id: true,
              tenant_id: true,
              start_at: true,
              patient: { select: { id: true, name: true, phone: true } },
            },
          },
        },
      });

      if (pending.length === 0) return;

      // Carrega config Evolution global (URL + key)
      const { apiUrl, apiKey } = await this.settings.getEvolutionConfig();
      if (!apiUrl || !apiKey) {
        this.logger.warn('[ConfirmDispatcher] Evolution API nao configurada — skip');
        return;
      }

      // Cache de instances por tenant para evitar query repetida
      const instanceByTenant = new Map<string, string | null>();
      // Onda 17.49 — cache do liga/desliga da confirmacao por tenant
      const enabledByTenant = new Map<string, boolean>();

      let sent = 0;
      let failed = 0;
      let skipped = 0;

      for (const c of pending) {
        const tenantId = c.appointment?.tenant_id;
        const phone = c.appointment?.patient?.phone;

        if (!tenantId || !phone) {
          await this.markFailed(c.id, 'Sem tenant ou telefone');
          skipped++;
          continue;
        }

        // Onda 17.49 — respeita o toggle "Confirmação" do painel Operacional.
        // Default LIGADO: so nao envia se a key estiver explicitamente 'false'.
        // Nao marca como falha (fica PENDENTE) — volta a enviar se religar.
        let confEnabled = enabledByTenant.get(tenantId);
        if (confEnabled === undefined) {
          const s = await this.prisma.globalSetting.findUnique({
            where: { key: `APPOINTMENT_CONFIRMATION_ENABLED_${tenantId}` },
          });
          confEnabled = (s?.value ?? 'true') !== 'false';
          enabledByTenant.set(tenantId, confEnabled);
        }
        if (!confEnabled) { skipped++; continue; }

        // Resolve instance do tenant
        let instance = instanceByTenant.get(tenantId);
        if (instance === undefined) {
          const inst = await this.prisma.instance.findFirst({
            where: { tenant_id: tenantId },
            select: { name: true },
            orderBy: { name: 'asc' },
          });
          instance = inst?.name || null;
          instanceByTenant.set(tenantId, instance);
        }

        if (!instance) {
          await this.markFailed(c.id, 'Sem Evolution instance configurada para o tenant');
          skipped++;
          continue;
        }

        try {
          await axios.post(
            `${apiUrl}/message/sendText/${instance}`,
            {
              number: phone,
              text: c.message_text || 'Confirmando sua consulta amanha. Responda 1 para CONFIRMAR ou 2 para REMARCAR.',
            },
            { headers: { 'Content-Type': 'application/json', apikey: apiKey }, timeout: 15000 },
          );

          await this.prisma.appointmentConfirmation.update({
            where: { id: c.id },
            data: { sent_at: new Date(), delivery_status: 'SENT' },
          });
          sent++;
        } catch (err: any) {
          const msg = err?.response?.data?.message || err?.message || 'erro desconhecido';
          await this.markFailed(c.id, msg);
          failed++;
        }
      }

      this.logger.log(
        `[ConfirmDispatcher] ${sent} enviada(s), ${failed} falha(s), ${skipped} pulada(s) ` +
        `de ${pending.length} pendente(s)`,
      );
    } catch (e: any) {
      this.logger.error(`[ConfirmDispatcher] Erro: ${e.message}`);
    }
  }

  private async markFailed(id: string, reason: string) {
    await this.prisma.appointmentConfirmation.update({
      where: { id },
      data: {
        sent_at: new Date(),
        delivery_status: 'FAILED',
        message_text: `[ERRO: ${reason.slice(0, 200)}]`,
      },
    });
  }
}
