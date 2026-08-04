import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { toBrazilWhatsappNumber } from '@crm/shared';

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
              type: true,
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
      // Onda 18.x — cache do liga/desliga da confirmação de ORTODONTIA por tenant
      const orthoEnabledByTenant = new Map<string, boolean>();

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
        // Onda 18.x — espelha o gate do scheduler: eventos de ORTODONTIA passam se a
        // confirmação de orto (default OFF) OU a principal estiverem ligadas. Assim a
        // confirmação de orto sai mesmo com a principal desligada (cada uma na sua),
        // e a confirmação normal continua honrando só o toggle principal.
        const isOrtho = c.appointment?.type === 'ORTODONTIA';
        let orthoEnabled = false;
        if (isOrtho) {
          const cached = orthoEnabledByTenant.get(tenantId);
          if (cached === undefined) {
            const s = await this.prisma.globalSetting.findUnique({
              where: { key: `APPOINTMENT_CONFIRMATION_ORTO_ENABLED_${tenantId}` },
            });
            orthoEnabled = s?.value === 'true';
            orthoEnabledByTenant.set(tenantId, orthoEnabled);
          } else {
            orthoEnabled = cached;
          }
        }
        const allowed = isOrtho ? (orthoEnabled || confEnabled) : confEnabled;
        if (!allowed) { skipped++; continue; }

        // Resolve instance do tenant. Mensagem de AGENDA é pro PACIENTE ⇒ chip
        // CLINICA. Antes pegava a primeira instance por nome (name asc), SEM olhar
        // purpose: como os nomes são t{hash}-N, isso era "o primeiro chip que a
        // clínica conectou na vida" — se fosse o do FINANCEIRO, TODA confirmação de
        // consulta saía pelo número do financeiro, de forma determinística.
        let instance = instanceByTenant.get(tenantId);
        if (instance === undefined) {
          const clinica = await this.prisma.instance.findFirst({
            where: { tenant_id: tenantId, purpose: 'CLINICA' },
            select: { name: true },
            orderBy: { name: 'asc' },
          });
          // Sem chip CLINICA: qualquer um MENOS o financeiro (cobre o tenant 1-chip
          // e os chips legados com purpose null).
          const naoFin = clinica || await this.prisma.instance.findFirst({
            where: { tenant_id: tenantId, NOT: { purpose: 'FINANCEIRO' } },
            select: { name: true },
            orderBy: { name: 'asc' },
          });
          if (!clinica && naoFin) {
            this.logger.warn(
              `[CONF-DISPATCH] Tenant ${tenantId} sem chip CLINICA — confirmação saindo por "${naoFin.name}".`,
            );
          }
          // Último recurso: só existe o financeiro. Manda (melhor que a pessoa não
          // ser confirmada) mas avisa alto — é o chip errado pra falar de agenda.
          const inst = naoFin || await this.prisma.instance.findFirst({
            where: { tenant_id: tenantId },
            select: { name: true },
            orderBy: { name: 'asc' },
          });
          if (!naoFin && inst) {
            this.logger.warn(
              `[CONF-DISPATCH] Tenant ${tenantId} só tem chip FINANCEIRO — confirmação de consulta vai sair por ele. Conecte um chip CLINICA.`,
            );
          }
          instance = inst?.name || null;
          instanceByTenant.set(tenantId, instance);
        }

        if (!instance) {
          await this.markFailed(c.id, 'Sem Evolution instance configurada para o tenant');
          skipped++;
          continue;
        }

        // CLAIM ATÔMICO — reivindica a linha ANTES de enviar. O dedup antigo era
        // check-then-send (lê sent_at=null → envia → marca): se DOIS workers rodam
        // juntos (2 réplicas, ou sobreposição durante um deploy), ambos liam null e
        // enviavam 2x (confirmação duplicada). O updateMany condicional garante que
        // só UMA execução ganha o envio; a outra vê count=0 e pula.
        const claim = await this.prisma.appointmentConfirmation.updateMany({
          where: { id: c.id, sent_at: null },
          data: { sent_at: new Date() },
        });
        if (claim.count === 0) { skipped++; continue; } // outra execução já pegou esta

        try {
          await axios.post(
            `${apiUrl}/message/sendText/${instance}`,
            {
              number: toBrazilWhatsappNumber(phone),
              text: c.message_text || 'Oi, tudo bem? 😊 Aqui é pra confirmar seu atendimento amanhã. Posso confirmar sua presença? Qualquer imprevisto, me avisa que a gente ajeita um novo horário. 🙂',
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
