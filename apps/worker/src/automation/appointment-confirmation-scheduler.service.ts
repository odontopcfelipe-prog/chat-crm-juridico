import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Cron horario que cria AppointmentConfirmation pendente para
 * CalendarEvent.start_at entre 24h e 25h no futuro (status AGENDADO,
 * tipo CONSULTA, sem confirmacao registrada ainda).
 *
 * O envio efetivo do WhatsApp/SMS/email e responsabilidade de outro
 * worker que processa AppointmentConfirmation com sent_at IS NULL.
 *
 * Esta separacao permite:
 *  - Auditoria (registro existe mesmo se envio falhar)
 *  - Reenvio (basta limpar sent_at)
 *  - Multiplos canais (cada canal cria seu registro)
 *
 * Estrategia de janela: 24-25h evita disparar duplicado se o cron rodar
 * varias vezes (idempotencia natural por janela de 1h).
 */
@Injectable()
export class AppointmentConfirmationSchedulerService {
  private readonly logger = new Logger(AppointmentConfirmationSchedulerService.name);

  constructor(private prisma: PrismaService) {}

  @Cron('0 * * * *', { timeZone: 'America/Maceio' })
  async scheduleConfirmations() {
    try {
      const now = new Date();
      const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const in25h = new Date(now.getTime() + 25 * 60 * 60 * 1000);

      // Agendamentos elegiveis: CONSULTA, AGENDADO, com paciente, em 24-25h
      const eligible = await this.prisma.calendarEvent.findMany({
        where: {
          type: 'CONSULTA',
          status: 'AGENDADO',
          patient_id: { not: null },
          start_at: { gte: in24h, lt: in25h },
        },
        select: {
          id: true,
          tenant_id: true,
          title: true,
          start_at: true,
          patient: { select: { id: true, name: true, phone: true } },
        },
      });

      if (eligible.length === 0) return;

      let created = 0;
      let skipped = 0;

      for (const ev of eligible) {
        if (!ev.patient?.phone) {
          skipped++;
          continue;
        }

        // Ja existe confirmacao por WhatsApp para este agendamento?
        const existing = await this.prisma.appointmentConfirmation.findFirst({
          where: {
            appointment_id: ev.id,
            channel: 'WHATSAPP',
          },
        });
        if (existing) {
          skipped++;
          continue;
        }

        const time = new Date(ev.start_at).toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit',
        });
        const date = new Date(ev.start_at).toLocaleDateString('pt-BR', {
          day: '2-digit',
          month: '2-digit',
        });

        await this.prisma.appointmentConfirmation.create({
          data: {
            appointment_id: ev.id,
            channel: 'WHATSAPP',
            scheduled_for: now,
            // sent_at fica null — outro worker envia efetivamente
            message_text:
              `Ola ${ev.patient.name.split(' ')[0]}! Confirmando sua consulta amanha (${date}) as ${time}. ` +
              `Responda 1 para CONFIRMAR ou 2 para REMARCAR.`,
            response_status: 'PENDENTE',
          },
        });
        created++;
      }

      if (created > 0 || skipped > 0) {
        this.logger.log(
          `[ConfirmationScheduler] ${created} criada(s), ${skipped} pulada(s) (sem telefone ou ja existente)`,
        );
      }
    } catch (e: any) {
      this.logger.error(`[ConfirmationScheduler] Erro: ${e.message}`);
    }
  }
}
