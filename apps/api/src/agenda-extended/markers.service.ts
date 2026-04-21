import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@crm/shared';
import { CreateMarkerDto, UpdateMarkerDto } from './dto/marker.dto';

@Injectable()
export class MarkersService {
  constructor(private prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateMarkerDto) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.prisma.appointmentMarker.create({
      data: { ...dto, tenant_id: tenantId },
    });
  }

  async findAll(tenantId: string, opts: { active?: boolean } = {}) {
    const where: Prisma.AppointmentMarkerWhereInput = { tenant_id: tenantId };
    if (opts.active !== undefined) where.active = opts.active;
    return this.prisma.appointmentMarker.findMany({
      where,
      orderBy: { name: 'asc' },
      include: { _count: { select: { assignments: true } } },
    });
  }

  async findOne(tenantId: string, id: string) {
    const marker = await this.prisma.appointmentMarker.findFirst({
      where: { id, tenant_id: tenantId },
    });
    if (!marker) throw new NotFoundException('Marcador nao encontrado');
    return marker;
  }

  async update(tenantId: string, id: string, dto: UpdateMarkerDto) {
    await this.findOne(tenantId, id);
    return this.prisma.appointmentMarker.update({ where: { id }, data: dto });
  }

  async archive(tenantId: string, id: string) {
    await this.findOne(tenantId, id);
    return this.prisma.appointmentMarker.update({
      where: { id },
      data: { active: false },
    });
  }

  /**
   * Vincula marker a um agendamento (idempotente — usa upsert).
   */
  async attach(tenantId: string, appointmentId: string, markerId: string) {
    // Validacoes de tenant scope
    const appointment = await this.prisma.calendarEvent.findFirst({
      where: { id: appointmentId, tenant_id: tenantId },
      select: { id: true },
    });
    if (!appointment) throw new NotFoundException('Agendamento nao encontrado');
    await this.findOne(tenantId, markerId);

    return this.prisma.appointmentMarkerAssignment.upsert({
      where: {
        appointment_id_marker_id: { appointment_id: appointmentId, marker_id: markerId },
      },
      create: { appointment_id: appointmentId, marker_id: markerId },
      update: {},
    });
  }

  async detach(tenantId: string, appointmentId: string, markerId: string) {
    const appointment = await this.prisma.calendarEvent.findFirst({
      where: { id: appointmentId, tenant_id: tenantId },
      select: { id: true },
    });
    if (!appointment) throw new NotFoundException('Agendamento nao encontrado');

    const result = await this.prisma.appointmentMarkerAssignment.deleteMany({
      where: { appointment_id: appointmentId, marker_id: markerId },
    });
    return { ok: true, deleted: result.count };
  }

  async listByAppointment(tenantId: string, appointmentId: string) {
    const appointment = await this.prisma.calendarEvent.findFirst({
      where: { id: appointmentId, tenant_id: tenantId },
      select: { id: true },
    });
    if (!appointment) throw new NotFoundException('Agendamento nao encontrado');

    return this.prisma.appointmentMarkerAssignment.findMany({
      where: { appointment_id: appointmentId },
      include: { marker: true },
    });
  }
}
