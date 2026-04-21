import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Servico de leitura/acoes do portal do paciente. Todas as funcoes
 * recebem patient_id+tenant_id que vem do PortalJwtGuard, garantindo
 * que paciente so ve seus proprios dados.
 */
@Injectable()
export class PortalService {
  constructor(private prisma: PrismaService) {}

  async getMe(tenantId: string, patientId: string) {
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, tenant_id: tenantId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        cpf: true,
        birth_date: true,
        primary_dentist: { select: { id: true, name: true } },
        _count: { select: { appointments: true, installments: true, anamneses: true } },
      },
    });
    if (!patient) throw new NotFoundException('Paciente nao encontrado');
    return patient;
  }

  /** Proxima consulta + ultimas 5 (futuras + recentes). */
  async getAppointments(tenantId: string, patientId: string) {
    const now = new Date();
    const [upcoming, past] = await Promise.all([
      this.prisma.calendarEvent.findMany({
        where: {
          tenant_id: tenantId,
          patient_id: patientId,
          start_at: { gte: now },
          status: { in: ['AGENDADO', 'CONFIRMADO'] },
        },
        orderBy: { start_at: 'asc' },
        take: 10,
        select: {
          id: true,
          title: true,
          description: true,
          start_at: true,
          end_at: true,
          status: true,
          assigned_user: { select: { id: true, name: true } },
        },
      }),
      this.prisma.calendarEvent.findMany({
        where: {
          tenant_id: tenantId,
          patient_id: patientId,
          start_at: { lt: now },
        },
        orderBy: { start_at: 'desc' },
        take: 5,
        select: {
          id: true,
          title: true,
          start_at: true,
          status: true,
          assigned_user: { select: { id: true, name: true } },
        },
      }),
    ]);

    return { upcoming, past };
  }

  /** Confirma consulta — paciente clicou 'Vou comparecer'. */
  async confirmAppointment(tenantId: string, patientId: string, appointmentId: string) {
    const ev = await this.prisma.calendarEvent.findFirst({
      where: { id: appointmentId, tenant_id: tenantId, patient_id: patientId },
    });
    if (!ev) throw new NotFoundException('Agendamento nao encontrado');
    if (ev.status === 'CANCELADO') throw new BadRequestException('Consulta cancelada');

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.calendarEvent.update({
        where: { id: ev.id },
        data: { status: 'CONFIRMADO' },
      });
      // Marca tambem a confirmacao mais recente (se houver) como respondida
      const latest = await tx.appointmentConfirmation.findFirst({
        where: { appointment_id: ev.id, response_status: 'PENDENTE' },
        orderBy: { created_at: 'desc' },
      });
      if (latest) {
        await tx.appointmentConfirmation.update({
          where: { id: latest.id },
          data: {
            response_status: 'CONFIRMADO',
            response_at: new Date(),
            response_text: '[Confirmado via portal]',
          },
        });
      }
      return updated;
    });
  }

  /** Cancela consulta — paciente nao podera comparecer. */
  async cancelAppointment(tenantId: string, patientId: string, appointmentId: string, reason?: string) {
    const ev = await this.prisma.calendarEvent.findFirst({
      where: { id: appointmentId, tenant_id: tenantId, patient_id: patientId },
    });
    if (!ev) throw new NotFoundException('Agendamento nao encontrado');
    if (ev.status === 'CANCELADO') return ev;
    if (ev.status === 'CONCLUIDO') throw new BadRequestException('Consulta ja realizada');

    return this.prisma.calendarEvent.update({
      where: { id: ev.id },
      data: {
        status: 'CANCELADO',
        description: ev.description
          ? `${ev.description}\n\n[Cancelado pelo paciente: ${reason || 'sem motivo'}]`
          : `[Cancelado pelo paciente: ${reason || 'sem motivo'}]`,
      },
    });
  }

  /** Lista parcelas (abertas + recentes pagas). */
  async getInstallments(tenantId: string, patientId: string) {
    const installments = await this.prisma.installment.findMany({
      where: { tenant_id: tenantId, patient_id: patientId },
      orderBy: [{ status: 'asc' }, { due_date: 'asc' }],
      take: 50,
      select: {
        id: true,
        sequence: true,
        total_count: true,
        amount: true,
        amount_paid: true,
        due_date: true,
        paid_at: true,
        payment_method: true,
        status: true,
      },
    });

    const totals = installments.reduce(
      (acc, i) => {
        const remaining = Number(i.amount) - Number(i.amount_paid);
        if (i.status === 'PAGA') acc.paid += Number(i.amount_paid);
        else if (i.status === 'ABERTA' || i.status === 'PARCIAL' || i.status === 'ATRASADA') {
          acc.open += remaining;
          if (new Date(i.due_date) < new Date()) acc.overdue += remaining;
        }
        return acc;
      },
      { paid: 0, open: 0, overdue: 0 },
    );

    return { installments, totals };
  }

  /** Lista anamneses (preenchidas + pendentes). */
  async getAnamneses(tenantId: string, patientId: string) {
    return this.prisma.anamnesis.findMany({
      where: {
        patient: { id: patientId, tenant_id: tenantId },
      },
      orderBy: { filled_at: 'desc' },
      take: 10,
      select: {
        id: true,
        filled_at: true,
        updated_at: true,
        template: { select: { id: true, version: true } },
      },
    });
  }
}
