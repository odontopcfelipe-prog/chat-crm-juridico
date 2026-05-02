import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import axios from 'axios';

/**
 * Worker cron de recall de manutencao (Fase 25 Onda 5.4).
 *
 * Roda 2x ao dia (8h e 14h) e:
 *
 * 1. RECALL: pega tasks PENDING com due_date entre HOJE e +7d (sem reminder
 *    ainda enviado), envia WhatsApp pro paciente "Sua revisao esta proxima!"
 *    Marca reminder_sent_at + reminder_message_id pra evitar reenvio.
 *
 * 2. AUTO-MISSED: tasks PENDING/SCHEDULED com due_date < HOJE - 1d viram
 *    automaticamente status MISSED. Operadora pode reabrir manualmente
 *    se fizer sentido.
 *
 * Idempotente — re-execucao no mesmo dia nao duplica notificacao
 * (filtro reminder_sent_at IS NULL).
 */
@Injectable()
export class MaintenanceRecallCronService {
  private readonly logger = new Logger(MaintenanceRecallCronService.name);

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
  ) {}

  // ─── Cron principal: 8h e 14h, segunda a sabado ───────────────────────

  @Cron('0 8,14 * * 1-6', { timeZone: 'America/Maceio' })
  async runDaily() {
    await this.sendRecallReminders();
    await this.autoMarkMissed();
  }

  /**
   * Envia WhatsApp pra pacientes com revisita em <= 7 dias.
   * Marca reminder_sent_at apos sucesso pra nao reenviar.
   */
  async sendRecallReminders(): Promise<{ sent: number; failed: number }> {
    const now = new Date();
    const in7days = new Date();
    in7days.setDate(in7days.getDate() + 7);

    const tasks = await (this.prisma as any).maintenanceTask.findMany({
      where: {
        status: { in: ['PENDING', 'SCHEDULED'] },
        due_date: { gte: now, lte: in7days },
        reminder_sent_at: null,
      },
      include: {
        patient: { select: { id: true, name: true, phone: true, tenant_id: true } },
        procedure: { select: { name: true } },
      },
      take: 200, // safety cap por execucao
    });

    let sent = 0;
    let failed = 0;
    for (const task of tasks) {
      if (!task.patient.phone) {
        this.logger.warn(`[RECALL] Task ${task.id} sem telefone do paciente — pulando`);
        continue;
      }

      const dueDateStr = new Date(task.due_date).toLocaleDateString('pt-BR', {
        day: '2-digit', month: 'long',
      });
      const firstName = task.patient.name.split(' ')[0];
      const procName = task.procedure?.name || task.title;
      const msg =
        `Olá, ${firstName}! 👋\n\n` +
        `Aqui é da clínica — está chegando a data da sua revisão de *${procName}*: ${dueDateStr}.\n\n` +
        `Quer que eu agende para você? É só responder esta mensagem com o melhor dia/horário e a gente confirma. 😊`;

      const messageId = await this.sendWhatsApp(task.patient.phone, msg);
      if (messageId !== false) {
        try {
          await (this.prisma as any).maintenanceTask.update({
            where: { id: task.id },
            data: {
              reminder_sent_at: new Date(),
              reminder_message_id: typeof messageId === 'string' ? messageId : null,
            },
          });
          sent++;
        } catch (e: any) {
          this.logger.warn(`[RECALL] Falha ao marcar reminder em task ${task.id}: ${e.message}`);
        }
      } else {
        failed++;
      }
    }

    if (sent > 0 || failed > 0) {
      this.logger.log(`[RECALL] Lembretes enviados: ${sent} sucesso, ${failed} falhas (de ${tasks.length} eligiveis)`);
    }
    return { sent, failed };
  }

  /**
   * Marca como MISSED tasks PENDING/SCHEDULED com due_date >= 1 dia atrasada.
   * Tolera 1 dia de "graca" pra evitar marcar overnight (ex: due hoje 23:50).
   */
  async autoMarkMissed(): Promise<number> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const result = await (this.prisma as any).maintenanceTask.updateMany({
      where: {
        status: { in: ['PENDING', 'SCHEDULED'] },
        due_date: { lt: yesterday },
      },
      data: { status: 'MISSED' },
    });

    if (result.count > 0) {
      this.logger.log(`[RECALL] ${result.count} task(s) marcada(s) como MISSED (atraso > 1d)`);
    }
    return result.count;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  /**
   * Envia mensagem WhatsApp via Evolution API.
   * Retorna messageId (string) em sucesso, ou false em falha.
   */
  private async sendWhatsApp(phone: string, text: string): Promise<string | false> {
    try {
      const { apiUrl, apiKey } = await this.settings.getEvolutionConfig();
      if (!apiUrl) {
        this.logger.warn('[RECALL] Evolution apiUrl nao configurada — pulando');
        return false;
      }
      const instance = process.env.EVOLUTION_INSTANCE_NAME || 'whatsapp';
      const cleanPhone = phone.replace(/\D/g, '');
      const res = await axios.post(
        `${apiUrl}/message/sendText/${instance}`,
        { number: cleanPhone, text },
        { headers: { apikey: apiKey }, timeout: 15000 },
      );
      return res.data?.key?.id || res.data?.messageId || true as any;
    } catch (e: any) {
      this.logger.warn(`[RECALL] Falha WhatsApp para ${phone}: ${e.message}`);
      return false;
    }
  }
}
