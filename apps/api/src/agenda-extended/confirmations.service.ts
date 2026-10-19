import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateConfirmationDto, RespondConfirmationDto } from './dto/confirmation.dto';
// Fase 0 — rastro da agenda (função pura, sem DI).
import { registrarAuditoria } from '../common/utils/audit-log.util';

@Injectable()
export class ConfirmationsService {
  private readonly logger = new Logger(ConfirmationsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Registra tentativa de confirmacao para um agendamento.
   * Se sent_at nao for informado, usa agora (assume disparo imediato).
   */
  async create(tenantId: string, appointmentId: string, dto: CreateConfirmationDto) {
    const appointment = await this.prisma.calendarEvent.findFirst({
      where: { id: appointmentId, tenant_id: tenantId },
      select: { id: true },
    });
    if (!appointment) throw new NotFoundException('Agendamento nao encontrado');

    return this.prisma.appointmentConfirmation.create({
      data: {
        appointment_id: appointmentId,
        channel: dto.channel,
        scheduled_for: dto.scheduled_for ? new Date(dto.scheduled_for) : undefined,
        sent_at: dto.sent_at ? new Date(dto.sent_at) : new Date(),
        message_text: dto.message_text,
        message_id: dto.message_id,
        delivery_status: dto.delivery_status || 'SENT',
      },
    });
  }

  async findByAppointment(tenantId: string, appointmentId: string) {
    const appointment = await this.prisma.calendarEvent.findFirst({
      where: { id: appointmentId, tenant_id: tenantId },
      select: { id: true },
    });
    if (!appointment) throw new NotFoundException('Agendamento nao encontrado');

    return this.prisma.appointmentConfirmation.findMany({
      where: { appointment_id: appointmentId },
      orderBy: { created_at: 'desc' },
    });
  }

  /**
   * Registra resposta do paciente. Quando confirmado, atualiza tambem o
   * status do CalendarEvent para "CONFIRMADO" para o front-end pintar
   * com cor verde no slot da agenda.
   */
  async respond(tenantId: string, confirmationId: string, dto: RespondConfirmationDto, actorUserId?: string | null) {
    const confirmation = await this.prisma.appointmentConfirmation.findUnique({
      where: { id: confirmationId },
      include: {
        appointment: { select: { id: true, tenant_id: true, status: true, validated_at: true, type: true } },
      },
    });
    if (!confirmation) throw new NotFoundException('Confirmacao nao encontrada');
    if (confirmation.appointment.tenant_id !== tenantId) {
      throw new BadRequestException('Confirmacao pertence a outro tenant');
    }

    const updated = await this.prisma.appointmentConfirmation.update({
      where: { id: confirmationId },
      data: {
        response_status: dto.response_status,
        response_at: new Date(),
        response_text: dto.response_text,
        message_id: dto.message_id,
      },
    });

    // Atualiza CalendarEvent.status quando confirmado/rejeitado
    if (dto.response_status === 'CONFIRMADO' && confirmation.appointment.status === 'AGENDADO') {
      await this.prisma.calendarEvent.update({
        where: { id: confirmation.appointment.id },
        data: { status: 'CONFIRMADO' },
      });
    } else if (dto.response_status === 'REJEITADO') {
      // Fase 0 — "não vou" só desmarca consulta ainda por acontecer: nunca a já validada
      // nem a que já chegou/foi atendida (antes derrubava qualquer status para CANCELADO).
      const r = await this.prisma.calendarEvent.updateMany({
        where: {
          id: confirmation.appointment.id,
          validated_at: null,
          status: { in: ['AGENDADO', 'CONFIRMADO'] },
        },
        data: { status: 'CANCELADO' },
      });
      if (r.count > 0) {
        await registrarAuditoria(this.prisma, {
          tenantId,
          actorUserId: actorUserId ?? null,
          entity: 'AGENDA_EVENTO',
          entityId: confirmation.appointment.id,
          action: 'STATUS',
          before: { status: confirmation.appointment.status },
          after: { status: 'CANCELADO' },
          meta: { via: 'confirmacao_resposta', confirmation_id: confirmationId, type: confirmation.appointment.type },
        }, this.logger);
      }
    }

    return updated;
  }

  /**
   * Lista tentativas pendentes (sem resposta) para a recepcao acompanhar.
   */
  async findPending(tenantId: string) {
    return this.prisma.appointmentConfirmation.findMany({
      where: {
        response_status: 'PENDENTE',
        appointment: { tenant_id: tenantId },
      },
      orderBy: { sent_at: 'desc' },
      take: 100,
      include: {
        appointment: {
          select: {
            id: true,
            title: true,
            start_at: true,
            patient: { select: { id: true, name: true, phone: true } },
          },
        },
      },
    });
  }
}
