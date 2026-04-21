import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@crm/shared';
import {
  CreateReturnAlertDto,
  UpdateReturnAlertDto,
  ContactReturnAlertDto,
} from './dto/return-alert.dto';

@Injectable()
export class ReturnAlertsService {
  constructor(private prisma: PrismaService) {}

  async create(tenantId: string, userId: string | undefined, dto: CreateReturnAlertDto) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente');

    const patient = await this.prisma.patient.findFirst({
      where: { id: dto.patient_id, tenant_id: tenantId },
      select: { id: true },
    });
    if (!patient) throw new NotFoundException('Paciente nao encontrado');

    return this.prisma.returnAlert.create({
      data: {
        tenant_id: tenantId,
        patient_id: dto.patient_id,
        professional_user_id: dto.professional_user_id || userId,
        source_appointment_id: dto.source_appointment_id,
        scheduled_for: new Date(dto.scheduled_for),
        reason: dto.reason,
        notes: dto.notes,
      },
    });
  }

  async findAll(
    tenantId: string,
    opts: {
      status?: string;
      professional_user_id?: string;
      patient_id?: string;
      from?: string;
      to?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const page = Math.max(1, opts.page || 1);
    const limit = Math.min(200, Math.max(1, opts.limit || 50));
    const skip = (page - 1) * limit;

    const where: Prisma.ReturnAlertWhereInput = {
      tenant_id: tenantId,
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.professional_user_id ? { professional_user_id: opts.professional_user_id } : {}),
      ...(opts.patient_id ? { patient_id: opts.patient_id } : {}),
      ...(opts.from || opts.to
        ? {
            scheduled_for: {
              ...(opts.from ? { gte: new Date(opts.from) } : {}),
              ...(opts.to ? { lte: new Date(opts.to) } : {}),
            },
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.returnAlert.findMany({
        where,
        orderBy: { scheduled_for: 'asc' },
        skip,
        take: limit,
        include: {
          patient: { select: { id: true, name: true, phone: true, email: true } },
          professional: { select: { id: true, name: true } },
          source_appointment: { select: { id: true, title: true, start_at: true } },
          scheduled_appointment: { select: { id: true, start_at: true } },
        },
      }),
      this.prisma.returnAlert.count({ where }),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Lista alertas pendentes que ja venceram ou vencem hoje — visao
   * principal da recepcao para reagendar pacientes.
   */
  async findPendingNow(tenantId: string) {
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);

    return this.prisma.returnAlert.findMany({
      where: {
        tenant_id: tenantId,
        status: 'PENDENTE',
        scheduled_for: { lte: endOfToday },
      },
      orderBy: { scheduled_for: 'asc' },
      take: 100,
      include: {
        patient: { select: { id: true, name: true, phone: true, email: true } },
        professional: { select: { id: true, name: true } },
      },
    });
  }

  async findOne(tenantId: string, id: string) {
    const alert = await this.prisma.returnAlert.findFirst({
      where: { id, tenant_id: tenantId },
      include: {
        patient: true,
        professional: { select: { id: true, name: true, email: true } },
        source_appointment: true,
        scheduled_appointment: true,
        contacted_by: { select: { id: true, name: true } },
      },
    });
    if (!alert) throw new NotFoundException('Alerta nao encontrado');
    return alert;
  }

  async update(tenantId: string, id: string, dto: UpdateReturnAlertDto) {
    await this.findOne(tenantId, id);
    return this.prisma.returnAlert.update({
      where: { id },
      data: {
        scheduled_for: dto.scheduled_for ? new Date(dto.scheduled_for) : undefined,
        reason: dto.reason,
        notes: dto.notes,
        status: dto.status,
        scheduled_appointment_id: dto.scheduled_appointment_id,
      },
    });
  }

  /**
   * Marca alerta como CONTATADO (ou AGENDADO/REJEITADO conforme result).
   * Usado pela recepcao apos ligar/whatsapp para o paciente.
   */
  async contact(tenantId: string, id: string, userId: string, dto: ContactReturnAlertDto) {
    await this.findOne(tenantId, id);
    return this.prisma.returnAlert.update({
      where: { id },
      data: {
        status: dto.result || 'CONTATADO',
        contacted_at: new Date(),
        contacted_by_user_id: userId,
        scheduled_appointment_id: dto.scheduled_appointment_id,
        notes: dto.notes,
      },
    });
  }
}
