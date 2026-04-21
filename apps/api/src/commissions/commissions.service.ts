import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@crm/shared';
import {
  CreateCommissionDto, PayCommissionDto, UpdateCommissionDto,
} from './dto/commission.dto';

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

@Injectable()
export class CommissionsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Cria comissao manualmente. Em fluxo automatico, isso seria chamado
   * pelo handler de execucao de TreatmentPlanItem.
   */
  async create(tenantId: string, dto: CreateCommissionDto) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente');

    const patient = await this.prisma.patient.findFirst({
      where: { id: dto.patient_id, tenant_id: tenantId },
    });
    if (!patient) throw new NotFoundException('Paciente nao encontrado');

    // Calcula amount se nao informado
    let amount = dto.amount;
    if (amount === undefined) {
      if (dto.percentage) amount = (dto.base_value * dto.percentage) / 100;
      else if (dto.fixed_value) amount = dto.fixed_value;
      else throw new BadRequestException('Informe amount, percentage ou fixed_value');
    }

    return this.prisma.commission.create({
      data: {
        tenant_id: tenantId,
        professional_user_id: dto.professional_user_id,
        patient_id: dto.patient_id,
        procedure_id: dto.procedure_id,
        treatment_plan_item_id: dto.treatment_plan_item_id,
        quote_id: dto.quote_id,
        base_value: new Prisma.Decimal(dto.base_value),
        percentage: dto.percentage ? new Prisma.Decimal(dto.percentage) : undefined,
        fixed_value: dto.fixed_value ? new Prisma.Decimal(dto.fixed_value) : undefined,
        amount: new Prisma.Decimal(amount),
        reference_month: dto.reference_month || monthKey(new Date()),
        notes: dto.notes,
      },
    });
  }

  async findAll(
    tenantId: string,
    opts: {
      professional_user_id?: string;
      patient_id?: string;
      status?: string;
      reference_month?: string;
      from?: string;
      to?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const page = Math.max(1, opts.page || 1);
    const limit = Math.min(200, Math.max(1, opts.limit || 50));
    const skip = (page - 1) * limit;

    const where: Prisma.CommissionWhereInput = {
      tenant_id: tenantId,
      ...(opts.professional_user_id ? { professional_user_id: opts.professional_user_id } : {}),
      ...(opts.patient_id ? { patient_id: opts.patient_id } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.reference_month ? { reference_month: opts.reference_month } : {}),
      ...(opts.from || opts.to
        ? {
            created_at: {
              ...(opts.from ? { gte: new Date(opts.from) } : {}),
              ...(opts.to ? { lte: new Date(opts.to) } : {}),
            },
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.commission.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        include: {
          professional: { select: { id: true, name: true } },
          patient: { select: { id: true, name: true } },
          procedure: { select: { id: true, name: true, category: true } },
        },
      }),
      this.prisma.commission.count({ where }),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  async findOne(tenantId: string, id: string) {
    const commission = await this.prisma.commission.findFirst({
      where: { id, tenant_id: tenantId },
      include: {
        professional: { select: { id: true, name: true, email: true } },
        patient: { select: { id: true, name: true, phone: true } },
        procedure: true,
        quote: { select: { id: true, total_value: true, status: true } },
        treatment_plan_item: { select: { id: true, executed_at: true, executed_by_user_id: true } },
      },
    });
    if (!commission) throw new NotFoundException('Comissao nao encontrada');
    return commission;
  }

  async update(tenantId: string, id: string, dto: UpdateCommissionDto) {
    await this.findOne(tenantId, id);
    return this.prisma.commission.update({
      where: { id },
      data: { status: dto.status, notes: dto.notes },
    });
  }

  /** Marca DEVIDA -> DISPONIVEL (paciente pagou). */
  async release(tenantId: string, id: string) {
    const c = await this.findOne(tenantId, id);
    if (c.status !== 'DEVIDA') {
      throw new BadRequestException(`Comissao esta ${c.status}, so pode liberar de DEVIDA`);
    }
    return this.prisma.commission.update({
      where: { id },
      data: { status: 'DISPONIVEL', available_at: new Date() },
    });
  }

  /** Marca DISPONIVEL -> PAGA (clinica liquidou com profissional). */
  async pay(tenantId: string, id: string, dto: PayCommissionDto) {
    const c = await this.findOne(tenantId, id);
    if (c.status !== 'DISPONIVEL') {
      throw new BadRequestException(`Comissao esta ${c.status}, so pode pagar de DISPONIVEL`);
    }
    return this.prisma.commission.update({
      where: { id },
      data: {
        status: 'PAGA',
        paid_at: dto.paid_at ? new Date(dto.paid_at) : new Date(),
        payment_method: dto.payment_method,
        notes: dto.notes,
      },
    });
  }

  /**
   * Resumo agrupado por profissional × reference_month, com totais por status.
   * Usado no relatorio "Comissoes a pagar".
   */
  async summary(tenantId: string, opts: { reference_month?: string } = {}) {
    const where: Prisma.CommissionWhereInput = { tenant_id: tenantId };
    if (opts.reference_month) where.reference_month = opts.reference_month;

    const commissions = await this.prisma.commission.findMany({
      where,
      select: {
        professional_user_id: true,
        professional: { select: { name: true } },
        reference_month: true,
        status: true,
        amount: true,
      },
    });

    type Row = {
      professional_user_id: string;
      professional_name: string;
      reference_month: string;
      devida: number;
      disponivel: number;
      paga: number;
      total: number;
    };
    const byKey = new Map<string, Row>();

    for (const c of commissions) {
      const key = `${c.professional_user_id}|${c.reference_month || ''}`;
      const existing = byKey.get(key) || {
        professional_user_id: c.professional_user_id,
        professional_name: c.professional?.name || 'Sem nome',
        reference_month: c.reference_month || '—',
        devida: 0,
        disponivel: 0,
        paga: 0,
        total: 0,
      };
      const amt = Number(c.amount);
      existing.total += amt;
      if (c.status === 'DEVIDA') existing.devida += amt;
      else if (c.status === 'DISPONIVEL') existing.disponivel += amt;
      else if (c.status === 'PAGA') existing.paga += amt;
      byKey.set(key, existing);
    }

    return Array.from(byKey.values()).sort((a, b) => {
      if (a.reference_month !== b.reference_month) return b.reference_month.localeCompare(a.reference_month);
      return a.professional_name.localeCompare(b.professional_name);
    });
  }

  /** Comissoes DISPONIVEIS agrupadas por profissional — fila de pagamento. */
  async payable(tenantId: string) {
    const list = await this.prisma.commission.findMany({
      where: { tenant_id: tenantId, status: 'DISPONIVEL' },
      orderBy: { available_at: 'asc' },
      include: {
        professional: { select: { id: true, name: true } },
      },
    });

    const byProfessional = new Map<string, { professional_user_id: string; name: string; total: number; count: number; commissions: typeof list }>();
    for (const c of list) {
      const key = c.professional_user_id;
      const existing = byProfessional.get(key) || {
        professional_user_id: c.professional_user_id,
        name: c.professional?.name || 'Sem nome',
        total: 0,
        count: 0,
        commissions: [] as typeof list,
      };
      existing.total += Number(c.amount);
      existing.count += 1;
      existing.commissions.push(c);
      byProfessional.set(key, existing);
    }

    return Array.from(byProfessional.values()).sort((a, b) => b.total - a.total);
  }
}
