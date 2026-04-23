import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import axios from 'axios';

/**
 * Worker cron para alertas de pagamento:
 * 1. Lembretes de vencimento (3 dias antes) — 8h Seg-Sex
 * 2. Alertas de inadimplência (parcelas vencidas) — 9h Seg-Sex
 * 3. Atualização de status PENDENTE → ATRASADO — 0h diário
 */
@Injectable()
export class PaymentAlertsCronService {
  private readonly logger = new Logger(PaymentAlertsCronService.name);

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
  ) {}

  // ─── 0h diário: marcar parcelas vencidas como ATRASADO ─────────────────

  @Cron('5 0 * * *', { timeZone: 'America/Maceio' })
  async markOverduePayments() {
    this.logger.warn('[PAYMENT-ALERTS] Cron desativado na transição odonto — reativar com Installment na Fase 2');
    return;
  }

  // ─── 8h Seg-Sex: lembrete de vencimento (3 dias antes) ─────────────────

  @Cron('0 8 * * 1-5', { timeZone: 'America/Maceio' })
  async sendDueReminders() {
    this.logger.warn('[PAYMENT-ALERTS] Cron desativado na transição odonto — reativar com Installment na Fase 2');
    return;
  }

  // ─── 9h Seg-Sex: alerta de inadimplência ───────────────────────────────

  @Cron('0 9 * * 1-5', { timeZone: 'America/Maceio' })
  async sendOverdueAlerts() {
    this.logger.warn('[PAYMENT-ALERTS] Cron desativado na transição odonto — reativar com Installment na Fase 2');
    return;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private async sendWhatsApp(phone: string, text: string): Promise<void> {
    try {
      const { apiUrl, apiKey } = await this.settings.getEvolutionConfig();
      if (!apiUrl) {
        this.logger.warn('[PAYMENT-ALERTS] EVOLUTION_API_URL não configurada');
        return;
      }
      const instance = process.env.EVOLUTION_INSTANCE_NAME || 'whatsapp';
      const cleanPhone = phone.replace(/\D/g, '');
      await axios.post(
        `${apiUrl}/message/sendText/${instance}`,
        { number: cleanPhone, text },
        { headers: { apikey: apiKey }, timeout: 15000 },
      );
    } catch (e: any) {
      this.logger.warn(`[PAYMENT-ALERTS] Falha ao enviar WhatsApp para ${phone}: ${e.message}`);
    }
  }

  /**
   * Verifica se um lembrete já foi enviado nas últimas X horas.
   * Usa a tabela de audit_log como registro de envio (simples e sem nova tabela).
   */
  private async wasReminderSentRecently(referenceId: string, type: string, hoursAgo: number): Promise<boolean> {
    const cutoff = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
    const existing = await this.prisma.auditLog.findFirst({
      where: {
        entity: 'PAYMENT_ALERT',
        entity_id: referenceId,
        action: type,
        created_at: { gte: cutoff },
      },
    });
    return !!existing;
  }

  private async logReminder(referenceId: string, type: string, leadId: string): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          entity: 'PAYMENT_ALERT',
          entity_id: referenceId,
          action: type,
          meta_json: { lead_id: leadId, sent_at: new Date().toISOString() },
        },
      });
    } catch {}
  }
}
