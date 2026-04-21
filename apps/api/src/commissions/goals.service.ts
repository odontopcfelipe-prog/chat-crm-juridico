import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@crm/shared';
import { CreateGoalDto, UpdateGoalDto } from './dto/goal.dto';

@Injectable()
export class GoalsService {
  private readonly logger = new Logger(GoalsService.name);

  constructor(private prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateGoalDto) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const goal = await this.prisma.goal.create({
      data: {
        tenant_id: tenantId,
        metric: dto.metric,
        scope: dto.scope || 'CLINIC',
        professional_user_id: dto.professional_user_id,
        direction: dto.direction || 'ACHIEVE',
        target_value: new Prisma.Decimal(dto.target_value),
        period_type: dto.period_type || 'MONTHLY',
        period_start: new Date(dto.period_start),
        period_end: new Date(dto.period_end),
        active: dto.active ?? true,
        notes: dto.notes,
      },
    });
    // Calcula valor inicial em segundo plano (best-effort)
    this.recalculate(tenantId, goal.id).catch((e) => this.logger.warn(`recalculate falhou: ${e.message}`));
    return goal;
  }

  async findAll(
    tenantId: string,
    opts: {
      active?: boolean;
      scope?: string;
      professional_user_id?: string;
      metric?: string;
    } = {},
  ) {
    const where: Prisma.GoalWhereInput = {
      tenant_id: tenantId,
      ...(opts.active !== undefined ? { active: opts.active } : {}),
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...(opts.professional_user_id ? { professional_user_id: opts.professional_user_id } : {}),
      ...(opts.metric ? { metric: opts.metric } : {}),
    };
    return this.prisma.goal.findMany({
      where,
      orderBy: [{ period_start: 'desc' }, { metric: 'asc' }],
      include: { professional: { select: { id: true, name: true } } },
    });
  }

  /** Metas ativas em vigor (period_start <= now <= period_end). */
  async findActive(tenantId: string) {
    const now = new Date();
    return this.prisma.goal.findMany({
      where: {
        tenant_id: tenantId,
        active: true,
        period_start: { lte: now },
        period_end: { gte: now },
      },
      orderBy: [{ scope: 'asc' }, { metric: 'asc' }],
      include: { professional: { select: { id: true, name: true } } },
    });
  }

  async findOne(tenantId: string, id: string) {
    const goal = await this.prisma.goal.findFirst({
      where: { id, tenant_id: tenantId },
      include: { professional: { select: { id: true, name: true } } },
    });
    if (!goal) throw new NotFoundException('Meta nao encontrada');
    return goal;
  }

  async update(tenantId: string, id: string, dto: UpdateGoalDto) {
    await this.findOne(tenantId, id);
    return this.prisma.goal.update({
      where: { id },
      data: {
        metric: dto.metric,
        scope: dto.scope,
        professional_user_id: dto.professional_user_id,
        direction: dto.direction,
        target_value: dto.target_value !== undefined ? new Prisma.Decimal(dto.target_value) : undefined,
        period_type: dto.period_type,
        period_start: dto.period_start ? new Date(dto.period_start) : undefined,
        period_end: dto.period_end ? new Date(dto.period_end) : undefined,
        active: dto.active,
        notes: dto.notes,
      },
    });
  }

  async remove(tenantId: string, id: string) {
    await this.findOne(tenantId, id);
    await this.prisma.goal.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Recalcula current_value e projected_value de uma meta.
   * Implementa as metricas mais comuns: SALES_VALUE, FIRST_CONSULTATIONS,
   * NEW_PATIENTS, MISSES_PCT, CONVERSIONS. Outras retornam 0 (CUSTOM e
   * OCCUPATION_PCT precisam de logica especifica futura).
   */
  async recalculate(tenantId: string, id: string) {
    const goal = await this.findOne(tenantId, id);
    const now = new Date();
    const start = new Date(goal.period_start);
    const end = new Date(goal.period_end);

    const baseFilter = {
      tenant_id: tenantId,
      ...(goal.scope === 'PROFESSIONAL' && goal.professional_user_id
        ? { professional_filter: goal.professional_user_id }
        : {}),
    };

    let current = 0;

    switch (goal.metric) {
      case 'SALES_VALUE': {
        // Soma total_value de Quotes ACCEPTED no periodo
        const quotes = await this.prisma.quote.findMany({
          where: {
            patient: { tenant_id: tenantId },
            status: 'ACCEPTED',
            accepted_at: { gte: start, lte: end },
            ...(goal.scope === 'PROFESSIONAL' && goal.professional_user_id
              ? { created_by_user_id: goal.professional_user_id }
              : {}),
          },
          select: { total_value: true },
        });
        current = quotes.reduce((sum, q) => sum + Number(q.total_value), 0);
        break;
      }
      case 'FIRST_CONSULTATIONS': {
        // Pacientes cuja first_visit_at caiu no periodo
        current = await this.prisma.patient.count({
          where: {
            tenant_id: tenantId,
            first_visit_at: { gte: start, lte: end },
            ...(goal.scope === 'PROFESSIONAL' && goal.professional_user_id
              ? { primary_dentist_id: goal.professional_user_id }
              : {}),
          },
        });
        break;
      }
      case 'NEW_PATIENTS': {
        current = await this.prisma.patient.count({
          where: {
            tenant_id: tenantId,
            created_at: { gte: start, lte: end },
            ...(goal.scope === 'PROFESSIONAL' && goal.professional_user_id
              ? { primary_dentist_id: goal.professional_user_id }
              : {}),
          },
        });
        break;
      }
      case 'MISSES_PCT': {
        // % de eventos com status=CANCELADO no periodo
        const total = await this.prisma.calendarEvent.count({
          where: {
            tenant_id: tenantId,
            start_at: { gte: start, lte: end },
            type: 'CONSULTA',
            ...(goal.scope === 'PROFESSIONAL' && goal.professional_user_id
              ? { assigned_user_id: goal.professional_user_id }
              : {}),
          },
        });
        const cancelled = total === 0 ? 0 : await this.prisma.calendarEvent.count({
          where: {
            tenant_id: tenantId,
            start_at: { gte: start, lte: end },
            type: 'CONSULTA',
            status: 'CANCELADO',
            ...(goal.scope === 'PROFESSIONAL' && goal.professional_user_id
              ? { assigned_user_id: goal.professional_user_id }
              : {}),
          },
        });
        current = total === 0 ? 0 : (cancelled / total) * 100;
        break;
      }
      case 'CONVERSIONS': {
        // Quotes ACCEPTED / Quotes SENT no periodo (em %)
        const sent = await this.prisma.quote.count({
          where: {
            patient: { tenant_id: tenantId },
            sent_at: { gte: start, lte: end },
          },
        });
        const accepted = sent === 0 ? 0 : await this.prisma.quote.count({
          where: {
            patient: { tenant_id: tenantId },
            sent_at: { gte: start, lte: end },
            status: 'ACCEPTED',
          },
        });
        current = sent === 0 ? 0 : (accepted / sent) * 100;
        break;
      }
      default:
        // OCCUPATION_PCT, CUSTOM — placeholder, retorna 0
        current = 0;
    }

    // Projecao "no ritmo atual": current * (totalDias / diasDecorridos)
    const totalMs = end.getTime() - start.getTime();
    const elapsedMs = Math.max(1, Math.min(totalMs, now.getTime() - start.getTime()));
    const projection = current * (totalMs / elapsedMs);

    return this.prisma.goal.update({
      where: { id },
      data: {
        current_value: new Prisma.Decimal(current.toFixed(2)),
        projected_value: new Prisma.Decimal(projection.toFixed(2)),
        last_calculated_at: now,
      },
    });
  }

  /** Recalcula todas as metas ativas — chamada por cron. */
  async recalculateActive(tenantId: string) {
    const active = await this.findActive(tenantId);
    let ok = 0;
    let failed = 0;
    for (const g of active) {
      try {
        await this.recalculate(tenantId, g.id);
        ok++;
      } catch (e: any) {
        this.logger.warn(`Goal ${g.id} recalc fail: ${e.message}`);
        failed++;
      }
    }
    return { ok, failed, total: active.length };
  }
}
