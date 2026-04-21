import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@crm/shared';

@Injectable()
export class TreatmentPlansService {
  constructor(private prisma: PrismaService) {}

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
    return this.prisma.treatmentPlan.update({
      where: { id },
      data: { status: 'ACTIVE', start_date: plan.start_date || new Date() },
    });
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

  /** Marca item como DONE com timestamp + dentista executor. */
  async executeItem(
    itemId: string,
    tenantId: string,
    userId: string,
    data: { appointment_id?: string; notes?: string } = {},
  ) {
    const item = await this.getItemEnsuringTenant(itemId, tenantId);
    if (item.status === 'DONE') throw new BadRequestException('Item ja foi executado');
    if (item.status === 'CANCELLED') throw new BadRequestException('Item cancelado nao pode ser executado');
    return this.prisma.treatmentPlanItem.update({
      where: { id: item.id },
      data: {
        status: 'DONE',
        executed_at: new Date(),
        executed_by_user_id: userId,
        ...(data.appointment_id ? { scheduled_appointment_id: data.appointment_id } : {}),
        ...(data.notes ? { notes: data.notes } : {}),
      },
      include: { procedure: { select: { id: true, name: true } } },
    });
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
