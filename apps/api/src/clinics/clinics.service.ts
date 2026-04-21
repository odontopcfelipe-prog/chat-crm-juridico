import {
  Injectable, Logger, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@crm/shared';
import { CreateClinicDto, UpdateClinicDto, AssignUserClinicDto } from './dto/clinic.dto';

@Injectable()
export class ClinicsService {
  private readonly logger = new Logger(ClinicsService.name);

  constructor(private prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateClinicDto) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.prisma.clinic.create({
      data: {
        tenant_id: tenantId,
        name: dto.name,
        short_name: dto.short_name,
        address: dto.address,
        city: dto.city,
        state: dto.state,
        phone: dto.phone,
        email: dto.email,
        cnpj: dto.cnpj,
        type: dto.type || 'MIXED',
        logo_url: dto.logo_url,
        brand_color: dto.brand_color,
        active: dto.active ?? true,
        is_franchise: dto.is_franchise ?? false,
        franchisee_owner_user_id: dto.franchisee_owner_user_id,
      },
    });
  }

  async findAll(tenantId: string, opts: { active?: boolean } = {}) {
    const where: Prisma.ClinicWhereInput = {
      tenant_id: tenantId,
      ...(opts.active !== undefined ? { active: opts.active } : {}),
    };
    return this.prisma.clinic.findMany({
      where,
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { user_clinics: true } },
      },
    });
  }

  async findOne(tenantId: string, id: string) {
    const clinic = await this.prisma.clinic.findFirst({
      where: { id, tenant_id: tenantId },
      include: {
        user_clinics: {
          include: { user: { select: { id: true, name: true, email: true } } },
        },
      },
    });
    if (!clinic) throw new NotFoundException('Unidade nao encontrada');
    return clinic;
  }

  async update(tenantId: string, id: string, dto: UpdateClinicDto) {
    await this.findOne(tenantId, id);
    return this.prisma.clinic.update({ where: { id }, data: dto });
  }

  async archive(tenantId: string, id: string) {
    await this.findOne(tenantId, id);
    return this.prisma.clinic.update({ where: { id }, data: { active: false } });
  }

  async assignUser(tenantId: string, clinicId: string, dto: AssignUserClinicDto) {
    await this.findOne(tenantId, clinicId);
    const user = await this.prisma.user.findUnique({
      where: { id: dto.user_id },
      select: { id: true, tenant_id: true },
    });
    if (!user) throw new NotFoundException('Usuario nao encontrado');
    if (user.tenant_id && user.tenant_id !== tenantId) {
      throw new BadRequestException('Usuario pertence a outro tenant');
    }

    return this.prisma.userClinic.upsert({
      where: { user_id_clinic_id: { user_id: dto.user_id, clinic_id: clinicId } },
      create: {
        user_id: dto.user_id,
        clinic_id: clinicId,
        role: dto.role,
        is_default: dto.is_default ?? false,
      },
      update: { role: dto.role, is_default: dto.is_default },
    });
  }

  async unassignUser(tenantId: string, clinicId: string, userId: string) {
    await this.findOne(tenantId, clinicId);
    await this.prisma.userClinic.deleteMany({
      where: { user_id: userId, clinic_id: clinicId },
    });
    return { ok: true };
  }

  /**
   * Ranking comparativo entre unidades agregando metricas no periodo.
   * Como esta fase nao adicionou clinic_id em Quote/CalendarEvent/etc.,
   * o ranking aqui e baseado apenas em USERS associados a cada clinica
   * (via UserClinic) e suas metricas: vendas (quotes_created),
   * comissoes recebidas, agendamentos atribuidos.
   *
   * Para metricas reais por unidade (sem proxy via user), preciso
   * adicionar clinic_id em Quote/Patient/CalendarEvent — postpone
   * para Fase 15.5.
   */
  async ranking(
    tenantId: string,
    opts: { from?: string; to?: string } = {},
  ) {
    const start = opts.from ? new Date(opts.from) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const end = opts.to ? new Date(`${opts.to}T23:59:59.999Z`) : new Date();

    const clinics = await this.prisma.clinic.findMany({
      where: { tenant_id: tenantId, active: true },
      include: {
        user_clinics: { select: { user_id: true } },
      },
    });

    const rows: Array<{
      clinic_id: string;
      name: string;
      city: string | null;
      type: string;
      revenue: number;
      quotes_count: number;
      appointments_count: number;
      commissions_paid: number;
    }> = [];

    for (const c of clinics) {
      const userIds = c.user_clinics.map((u) => u.user_id);

      const [quoteAgg, apptCount, commPaid] = await Promise.all([
        userIds.length === 0
          ? Promise.resolve({ _sum: { total_value: 0 }, _count: { _all: 0 } })
          : this.prisma.quote.aggregate({
              where: {
                patient: { tenant_id: tenantId },
                status: 'ACCEPTED',
                accepted_at: { gte: start, lte: end },
                created_by_user_id: { in: userIds },
              },
              _sum: { total_value: true },
              _count: { _all: true },
            }),
        userIds.length === 0
          ? Promise.resolve(0)
          : this.prisma.calendarEvent.count({
              where: {
                tenant_id: tenantId,
                type: 'CONSULTA',
                start_at: { gte: start, lte: end },
                assigned_user_id: { in: userIds },
              },
            }),
        userIds.length === 0
          ? Promise.resolve({ _sum: { amount: 0 } })
          : this.prisma.commission.aggregate({
              where: {
                tenant_id: tenantId,
                status: 'PAGA',
                paid_at: { gte: start, lte: end },
                professional_user_id: { in: userIds },
              },
              _sum: { amount: true },
            }),
      ]);

      rows.push({
        clinic_id: c.id,
        name: c.name,
        city: c.city,
        type: c.type,
        revenue: Number((quoteAgg as any)._sum?.total_value || 0),
        quotes_count: (quoteAgg as any)._count?._all || 0,
        appointments_count: apptCount,
        commissions_paid: Number((commPaid as any)._sum?.amount || 0),
      });
    }

    rows.sort((a, b) => b.revenue - a.revenue);

    return {
      period: { start, end },
      total_clinics: clinics.length,
      total_revenue: rows.reduce((s, r) => s + r.revenue, 0),
      ranking: rows,
    };
  }
}
