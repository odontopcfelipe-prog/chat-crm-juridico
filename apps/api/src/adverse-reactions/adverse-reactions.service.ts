import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@crm/shared';
import {
  CreateAdverseReactionDto,
  UpdateAdverseReactionDto,
  ReportNotivisaDto,
} from './dto/adverse-reaction.dto';

@Injectable()
export class AdverseReactionsService {
  private readonly logger = new Logger(AdverseReactionsService.name);

  constructor(private prisma: PrismaService) {}

  async create(
    tenantId: string,
    patientId: string,
    userId: string | undefined,
    dto: CreateAdverseReactionDto,
  ) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente no contexto');
    if (!userId) throw new BadRequestException('reported_by_user_id ausente — faca login');

    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, tenant_id: tenantId },
    });
    if (!patient) throw new NotFoundException('Paciente nao encontrado');

    if (dto.esthetic_application_id) {
      const app = await this.prisma.estheticApplication.findFirst({
        where: { id: dto.esthetic_application_id, tenant_id: tenantId },
      });
      if (!app) throw new NotFoundException('Aplicacao estetica nao encontrada');
    }

    const created = await this.prisma.adverseReaction.create({
      data: {
        tenant_id: tenantId,
        patient_id: patientId,
        esthetic_application_id: dto.esthetic_application_id,
        procedure_id: dto.procedure_id,
        severity: dto.severity,
        reaction_type: dto.reaction_type,
        description: dto.description,
        onset_at: new Date(dto.onset_at),
        treatment_given: dto.treatment_given,
        hospitalized: dto.hospitalized ?? false,
        reported_by_user_id: userId,
      },
    });

    if (dto.severity === 'GRAVE' || dto.severity === 'AMEACA_VIDA') {
      this.logger.warn(
        `Reacao adversa GRAVE registrada: paciente ${patient.name} (${patient.id}), tipo ${dto.reaction_type}. Considerar notificacao NOTIVISA.`,
      );
    }

    return created;
  }

  async findByPatient(tenantId: string, patientId: string) {
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, tenant_id: tenantId },
    });
    if (!patient) throw new NotFoundException('Paciente nao encontrado');

    return this.prisma.adverseReaction.findMany({
      where: { tenant_id: tenantId, patient_id: patientId },
      orderBy: { reported_at: 'desc' },
      include: {
        esthetic_application: {
          select: { id: true, application_point: true, batch_number: true, applied_at: true },
        },
        procedure: { select: { id: true, name: true, category: true } },
        reported_by: { select: { id: true, name: true } },
      },
    });
  }

  async findAll(
    tenantId: string,
    opts: {
      severity?: string;
      reaction_type?: string;
      notivisa_reported?: boolean;
      from?: string;
      to?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const page = Math.max(1, opts.page || 1);
    const limit = Math.min(200, Math.max(1, opts.limit || 50));
    const skip = (page - 1) * limit;

    const where: Prisma.AdverseReactionWhereInput = {
      tenant_id: tenantId,
      ...(opts.severity ? { severity: opts.severity } : {}),
      ...(opts.reaction_type ? { reaction_type: opts.reaction_type } : {}),
      ...(opts.notivisa_reported !== undefined
        ? { notivisa_reported: opts.notivisa_reported }
        : {}),
      ...(opts.from || opts.to
        ? {
            reported_at: {
              ...(opts.from ? { gte: new Date(opts.from) } : {}),
              ...(opts.to ? { lte: new Date(opts.to) } : {}),
            },
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.adverseReaction.findMany({
        where,
        orderBy: { reported_at: 'desc' },
        skip,
        take: limit,
        include: {
          patient: { select: { id: true, name: true, phone: true } },
          esthetic_application: {
            select: { id: true, application_point: true, batch_number: true },
          },
          procedure: { select: { id: true, name: true } },
          reported_by: { select: { id: true, name: true } },
        },
      }),
      this.prisma.adverseReaction.count({ where }),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  async findOne(tenantId: string, id: string) {
    const reaction = await this.prisma.adverseReaction.findFirst({
      where: { id, tenant_id: tenantId },
      include: {
        patient: { select: { id: true, name: true, phone: true, email: true } },
        esthetic_application: true,
        procedure: { select: { id: true, name: true, category: true } },
        reported_by: { select: { id: true, name: true, email: true } },
      },
    });
    if (!reaction) throw new NotFoundException('Reacao adversa nao encontrada');
    return reaction;
  }

  async update(tenantId: string, id: string, dto: UpdateAdverseReactionDto) {
    const existing = await this.prisma.adverseReaction.findFirst({
      where: { id, tenant_id: tenantId },
    });
    if (!existing) throw new NotFoundException('Reacao adversa nao encontrada');

    return this.prisma.adverseReaction.update({
      where: { id },
      data: {
        severity: dto.severity,
        reaction_type: dto.reaction_type,
        description: dto.description,
        resolved_at: dto.resolved_at ? new Date(dto.resolved_at) : undefined,
        resolution_notes: dto.resolution_notes,
        treatment_given: dto.treatment_given,
        hospitalized: dto.hospitalized,
      },
    });
  }

  /**
   * Marca como reportado ao NOTIVISA (Sistema Nacional de Notificacoes
   * para a Vigilancia Sanitaria — ANVISA). Armazena o protocolo retornado.
   */
  async reportNotivisa(tenantId: string, id: string, dto: ReportNotivisaDto) {
    const existing = await this.prisma.adverseReaction.findFirst({
      where: { id, tenant_id: tenantId },
    });
    if (!existing) throw new NotFoundException('Reacao adversa nao encontrada');

    return this.prisma.adverseReaction.update({
      where: { id },
      data: {
        notivisa_reported: true,
        notivisa_reported_at: new Date(),
        notivisa_protocol: dto.notivisa_protocol,
      },
    });
  }
}
