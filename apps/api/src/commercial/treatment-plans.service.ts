import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException, Inject, forwardRef, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReferralsService } from '../referrals/referrals.service';
import { Prisma } from '@crm/shared';

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

@Injectable()
export class TreatmentPlansService {
  private readonly logger = new Logger(TreatmentPlansService.name);
  constructor(
    private prisma: PrismaService,
    @Optional() @Inject(forwardRef(() => ReferralsService)) private referralsService?: ReferralsService,
  ) {}

  async findByPatient(patientId: string, tenantId: string) {
    await this.assertPatientBelongsToTenant(patientId, tenantId);
    return this.prisma.treatmentPlan.findMany({
      where: { patient_id: patientId },
      orderBy: { created_at: 'desc' },
      include: {
        _count: { select: { items: true } },
        quote: { select: { id: true, created_at: true } },
      },
    });
  }

  async findOne(id: string, tenantId: string) {
    const plan = await this.prisma.treatmentPlan.findUnique({
      where: { id },
      include: {
        patient: { select: { id: true, name: true, tenant_id: true } },
        quote: true,
        contract_signature: true,
        items: {
          orderBy: [{ order_index: 'asc' }, { created_at: 'asc' }],
          include: {
            procedure: { select: { id: true, name: true, code_tuss: true } },
            executed_by: { select: { id: true, name: true } },
            scheduled_appointment: { select: { id: true, start_at: true, title: true } },
          },
        },
      },
    });
    if (!plan) throw new NotFoundException('Plano de tratamento nao encontrado');
    if (plan.patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    return plan;
  }

  async update(id: string, tenantId: string, data: Prisma.TreatmentPlanUncheckedUpdateInput) {
    await this.findOne(id, tenantId);
    const patch: Prisma.TreatmentPlanUncheckedUpdateInput = { ...data };
    if (data.start_date) patch.start_date = new Date(data.start_date as any);
    if (data.end_date) patch.end_date = new Date(data.end_date as any);
    return this.prisma.treatmentPlan.update({ where: { id }, data: patch });
  }

  /** Atalho: ativar plano (ex: apos assinatura manual em TCLE externo) */
  async activate(id: string, tenantId: string) {
    const plan = await this.findOne(id, tenantId);
    if (plan.status === 'ACTIVE') return plan;
    if (plan.status === 'COMPLETED' || plan.status === 'CANCELLED') {
      throw new BadRequestException(`Plano esta ${plan.status} — nao pode ser ativado`);
    }
    const updated = await this.prisma.treatmentPlan.update({
      where: { id },
      data: { status: 'ACTIVE', start_date: plan.start_date || new Date() },
    });

    // Hook Indicação Premiada (Fase 21): se este paciente foi indicado por
    // outro, marca a Referral como EARNED (cashback liberado pro indicador).
    if (this.referralsService) {
      try {
        await this.referralsService.markEarned(plan.patient.id, id);
      } catch (e: any) {
        this.logger.warn(`[REFERRAL HOOK] Falhou marcar EARNED: ${e?.message}`);
      }
    }

    return updated;
  }

  /** Marca plano como completo quando todos os items estao DONE ou CANCELLED. */
  async complete(id: string, tenantId: string) {
    const plan = await this.findOne(id, tenantId);
    const pending = plan.items.filter((i) => !['DONE', 'CANCELLED'].includes(i.status));
    if (pending.length > 0) {
      throw new BadRequestException(`Plano tem ${pending.length} item(ns) ainda pendente(s)`);
    }
    return this.prisma.treatmentPlan.update({
      where: { id },
      data: { status: 'COMPLETED', end_date: new Date() },
    });
  }

  // ─── TreatmentPlanItem ────────────────────────────────────────

  async updateItem(
    itemId: string,
    tenantId: string,
    data: {
      status?: string;
      scheduled_at?: string;
      scheduled_appointment_id?: string;
      notes?: string;
      order_index?: number;
    },
  ) {
    const item = await this.getItemEnsuringTenant(itemId, tenantId);
    const patch: Prisma.TreatmentPlanItemUncheckedUpdateInput = { ...data };
    if (data.scheduled_at) patch.scheduled_at = new Date(data.scheduled_at);
    return this.prisma.treatmentPlanItem.update({ where: { id: item.id }, data: patch });
  }

  /** Marca item como DONE com timestamp + dentista executor.
   *  Tambem gera Commission automaticamente baseada em CommissionRule
   *  resolvida por (executor, procedimento, categoria) — Fase 10 PR3.
   */
  async executeItem(
    itemId: string,
    tenantId: string,
    userId: string,
    data: { appointment_id?: string; notes?: string } = {},
  ) {
    const item = await this.getItemEnsuringTenant(itemId, tenantId);
    if (item.status === 'DONE') throw new BadRequestException('Item ja foi executado');
    if (item.status === 'CANCELLED') throw new BadRequestException('Item cancelado nao pode ser executado');

    const updated = await this.prisma.treatmentPlanItem.update({
      where: { id: item.id },
      data: {
        status: 'DONE',
        executed_at: new Date(),
        executed_by_user_id: userId,
        ...(data.appointment_id ? { scheduled_appointment_id: data.appointment_id } : {}),
        ...(data.notes ? { notes: data.notes } : {}),
      },
      include: {
        procedure: { select: { id: true, name: true, category: true } },
        treatment_plan: { select: { patient_id: true, quote_id: true } },
      },
    });

    // Gera comissao se houver regra aplicavel — best-effort, nao falha
    // o execute caso nao consiga gerar a comissao.
    try {
      await this.generateCommissionForItem(tenantId, userId, updated);
    } catch (e: any) {
      this.logger.warn(`[CommissionAutoGen] Falhou para item ${item.id}: ${e.message}`);
    }

    return updated;
  }

  /**
   * Resolve CommissionRule mais especifica para (executor, procedimento)
   * e gera Commission status=DEVIDA. Prioridade:
   *   procedure_id > procedure_category > sem escopo (geral)
   * Considera apenas regras ativas e dentro da vigencia.
   */
  private async generateCommissionForItem(
    tenantId: string,
    executedByUserId: string,
    item: {
      id: string;
      unit_price: Prisma.Decimal;
      quantity: number;
      procedure_id: string | null;
      procedure: { id: string; name: string; category: string | null } | null;
      treatment_plan: { patient_id: string; quote_id: string | null } | null;
    },
  ) {
    if (!item.procedure_id || !item.procedure || !item.treatment_plan?.patient_id) return;

    const now = new Date();
    const rules = await this.prisma.commissionRule.findMany({
      where: {
        tenant_id: tenantId,
        professional_user_id: executedByUserId,
        active: true,
        OR: [
          { starts_at: null, ends_at: null },
          { starts_at: { lte: now }, ends_at: { gte: now } },
          { starts_at: { lte: now }, ends_at: null },
          { starts_at: null, ends_at: { gte: now } },
        ],
      },
    });

    if (rules.length === 0) return;

    // Resolve mais especifica
    const byProcedure = rules.find((r) => r.procedure_id === item.procedure_id);
    const byCategory = item.procedure.category
      ? rules.find((r) => r.procedure_category === item.procedure!.category)
      : undefined;
    const general = rules.find((r) => !r.procedure_id && !r.procedure_category);
    const rule = byProcedure || byCategory || general;
    if (!rule) return;

    // Calcula valor
    const baseValue = Number(item.unit_price) * (item.quantity || 1);
    let amount = 0;
    if (rule.percentage) amount = baseValue * Number(rule.percentage) / 100;
    else if (rule.fixed_value) amount = Number(rule.fixed_value);
    else return;

    // Status inicial: ON_PAYMENT mantem DEVIDA ate paciente pagar.
    // ON_EXECUTION ja pode liberar imediatamente (DISPONIVEL).
    const status = rule.trigger === 'ON_EXECUTION' ? 'DISPONIVEL' : 'DEVIDA';
    const availableAt = status === 'DISPONIVEL' ? now : null;

    await this.prisma.commission.create({
      data: {
        tenant_id: tenantId,
        professional_user_id: executedByUserId,
        patient_id: item.treatment_plan.patient_id,
        procedure_id: item.procedure_id,
        treatment_plan_item_id: item.id,
        quote_id: item.treatment_plan.quote_id,
        base_value: new Prisma.Decimal(baseValue),
        percentage: rule.percentage,
        fixed_value: rule.fixed_value,
        amount: new Prisma.Decimal(amount),
        status,
        available_at: availableAt,
        reference_month: monthKey(now),
        notes: `Auto-gerada pela execucao de "${item.procedure.name}" (regra ${rule.id.slice(0, 8)}, trigger ${rule.trigger})`,
      },
    });

    this.logger.log(
      `[CommissionAutoGen] Item ${item.id} -> Commission de R$ ${amount.toFixed(2)} ` +
      `(${status}, regra ${rule.percentage ? `${rule.percentage}%` : `R$ ${rule.fixed_value}`})`,
    );
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private async assertPatientBelongsToTenant(patientId: string, tenantId: string) {
    const row = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { tenant_id: true },
    });
    if (!row) throw new NotFoundException('Paciente nao encontrado');
    if (row.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
  }

  private async getItemEnsuringTenant(itemId: string, tenantId: string) {
    const item = await this.prisma.treatmentPlanItem.findUnique({
      where: { id: itemId },
      include: {
        treatment_plan: { select: { patient: { select: { tenant_id: true } } } },
      },
    });
    if (!item) throw new NotFoundException('Item nao encontrado');
    if (item.treatment_plan.patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    return item;
  }
}
