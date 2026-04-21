import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@crm/shared';
import { CreateCommissionRuleDto, UpdateCommissionRuleDto } from './dto/commission-rule.dto';

@Injectable()
export class CommissionRulesService {
  constructor(private prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateCommissionRuleDto) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!dto.percentage && !dto.fixed_value) {
      throw new BadRequestException('Informe percentage OU fixed_value');
    }
    if (dto.percentage && dto.fixed_value) {
      throw new BadRequestException('Informe percentage OU fixed_value, nao ambos');
    }

    return this.prisma.commissionRule.create({
      data: {
        tenant_id: tenantId,
        professional_user_id: dto.professional_user_id,
        procedure_id: dto.procedure_id,
        procedure_category: dto.procedure_category,
        percentage: dto.percentage ? new Prisma.Decimal(dto.percentage) : undefined,
        fixed_value: dto.fixed_value ? new Prisma.Decimal(dto.fixed_value) : undefined,
        trigger: dto.trigger || 'ON_PAYMENT',
        active: dto.active ?? true,
        starts_at: dto.starts_at ? new Date(dto.starts_at) : undefined,
        ends_at: dto.ends_at ? new Date(dto.ends_at) : undefined,
        notes: dto.notes,
      },
    });
  }

  async findAll(
    tenantId: string,
    opts: { professional_user_id?: string; active?: boolean } = {},
  ) {
    const where: Prisma.CommissionRuleWhereInput = {
      tenant_id: tenantId,
      ...(opts.professional_user_id ? { professional_user_id: opts.professional_user_id } : {}),
      ...(opts.active !== undefined ? { active: opts.active } : {}),
    };
    return this.prisma.commissionRule.findMany({
      where,
      orderBy: [{ professional_user_id: 'asc' }, { created_at: 'desc' }],
      include: {
        professional: { select: { id: true, name: true } },
      },
    });
  }

  async findOne(tenantId: string, id: string) {
    const rule = await this.prisma.commissionRule.findFirst({
      where: { id, tenant_id: tenantId },
      include: { professional: { select: { id: true, name: true } } },
    });
    if (!rule) throw new NotFoundException('Regra nao encontrada');
    return rule;
  }

  async update(tenantId: string, id: string, dto: UpdateCommissionRuleDto) {
    await this.findOne(tenantId, id);
    return this.prisma.commissionRule.update({
      where: { id },
      data: {
        procedure_id: dto.procedure_id,
        procedure_category: dto.procedure_category,
        percentage: dto.percentage !== undefined ? new Prisma.Decimal(dto.percentage) : undefined,
        fixed_value: dto.fixed_value !== undefined ? new Prisma.Decimal(dto.fixed_value) : undefined,
        trigger: dto.trigger,
        active: dto.active,
        starts_at: dto.starts_at ? new Date(dto.starts_at) : undefined,
        ends_at: dto.ends_at ? new Date(dto.ends_at) : undefined,
        notes: dto.notes,
      },
    });
  }

  async archive(tenantId: string, id: string) {
    await this.findOne(tenantId, id);
    return this.prisma.commissionRule.update({
      where: { id },
      data: { active: false },
    });
  }

  /**
   * Resolve a regra mais especifica aplicavel a (profissional, procedimento).
   * Prioridade: procedure_id > procedure_category > sem escopo.
   * Retorna a primeira ativa e dentro da vigencia, ou null.
   */
  async resolveForExecution(
    tenantId: string,
    professionalUserId: string,
    procedureId: string,
    procedureCategory: string | null,
  ) {
    const now = new Date();
    const rules = await this.prisma.commissionRule.findMany({
      where: {
        tenant_id: tenantId,
        professional_user_id: professionalUserId,
        active: true,
        OR: [
          { starts_at: null, ends_at: null },
          { starts_at: { lte: now }, ends_at: { gte: now } },
          { starts_at: { lte: now }, ends_at: null },
          { starts_at: null, ends_at: { gte: now } },
        ],
      },
      orderBy: [{ procedure_id: 'desc' }, { procedure_category: 'desc' }],
    });

    // Mais especifica primeiro
    const byProcedure = rules.find((r) => r.procedure_id === procedureId);
    if (byProcedure) return byProcedure;
    if (procedureCategory) {
      const byCategory = rules.find((r) => r.procedure_category === procedureCategory);
      if (byCategory) return byCategory;
    }
    return rules.find((r) => !r.procedure_id && !r.procedure_category) || null;
  }
}
