import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@crm/shared';

type ItemInput = {
  procedure_id: string;
  tooth_fdi?: string;
  quantity?: number;
  unit_price?: number;
  notes?: string;
};

@Injectable()
export class QuotesService {
  constructor(private prisma: PrismaService) {}

  async create(
    patientId: string,
    tenantId: string,
    userId: string,
    data: {
      valid_until?: string;
      discount_percent?: number;
      payment_terms?: string;
      notes?: string;
      items?: ItemInput[];
    },
  ) {
    await this.assertPatientBelongsToTenant(patientId, tenantId);

    const items = data.items || [];
    const resolvedItems = await this.resolveItems(items, tenantId);
    const totals = this.computeTotals(resolvedItems, data.discount_percent || 0);

    return this.prisma.quote.create({
      data: {
        patient_id: patientId,
        created_by_user_id: userId,
        valid_until: data.valid_until ? new Date(data.valid_until) : null,
        discount_percent: data.discount_percent || 0,
        discount_value: totals.discount_value,
        subtotal: totals.subtotal,
        total_value: totals.total,
        payment_terms: data.payment_terms || null,
        notes: data.notes || null,
        items: {
          create: resolvedItems.map((i, idx) => ({
            procedure_id: i.procedure_id,
            tooth_fdi: i.tooth_fdi || null,
            quantity: i.quantity,
            unit_price: i.unit_price,
            total_price: i.total_price,
            notes: i.notes || null,
            order_index: idx,
          })),
        },
      },
      include: { items: { include: { procedure: { select: { id: true, name: true } } } } },
    });
  }

  async findByPatient(patientId: string, tenantId: string) {
    await this.assertPatientBelongsToTenant(patientId, tenantId);
    return this.prisma.quote.findMany({
      where: { patient_id: patientId },
      orderBy: { created_at: 'desc' },
      include: {
        _count: { select: { items: true } },
        created_by: { select: { id: true, name: true } },
      },
    });
  }

  async findOne(id: string, tenantId: string) {
    const quote = await this.prisma.quote.findUnique({
      where: { id },
      include: {
        patient: { select: { id: true, name: true, tenant_id: true } },
        created_by: { select: { id: true, name: true } },
        items: {
          orderBy: { order_index: 'asc' },
          include: { procedure: { select: { id: true, name: true, code_tuss: true } } },
        },
        treatment_plan: true,
      },
    });
    if (!quote) throw new NotFoundException('Orcamento nao encontrado');
    if (quote.patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    return quote;
  }

  async update(id: string, tenantId: string, data: Prisma.QuoteUncheckedUpdateInput) {
    const quote = await this.findOne(id, tenantId);
    if (quote.status !== 'DRAFT') {
      throw new BadRequestException('Orcamento nao pode ser editado apos envio');
    }

    // Recalcula totais se desconto mudou
    if (data.discount_percent !== undefined) {
      const items = await this.prisma.quoteItem.findMany({
        where: { quote_id: id },
        select: { total_price: true },
      });
      const subtotal = items.reduce((acc, i) => acc + Number(i.total_price), 0);
      const discount_percent = Number(data.discount_percent) || 0;
      const discount_value = subtotal * (discount_percent / 100);
      data.subtotal = subtotal;
      data.discount_value = discount_value;
      data.total_value = subtotal - discount_value;
    }

    return this.prisma.quote.update({
      where: { id },
      data: {
        ...data,
        valid_until: data.valid_until ? new Date(data.valid_until as any) : data.valid_until,
      },
    });
  }

  async send(id: string, tenantId: string) {
    const quote = await this.findOne(id, tenantId);
    if (quote.status !== 'DRAFT') {
      throw new BadRequestException('Apenas orcamentos em DRAFT podem ser enviados');
    }
    return this.prisma.quote.update({
      where: { id },
      data: { status: 'SENT', sent_at: new Date() },
    });
  }

  async accept(id: string, tenantId: string) {
    const quote = await this.findOne(id, tenantId);
    if (quote.status !== 'SENT') {
      throw new BadRequestException('Apenas orcamentos SENT podem ser aceitos');
    }

    // Transacao: marca quote + cria TreatmentPlan + TreatmentPlanItems
    return this.prisma.$transaction(async (tx) => {
      const acceptedQuote = await tx.quote.update({
        where: { id },
        data: { status: 'ACCEPTED', accepted_at: new Date() },
      });

      const plan = await tx.treatmentPlan.create({
        data: {
          patient_id: quote.patient_id,
          quote_id: id,
          status: 'PENDING_SIGNATURE',
          total_value: quote.total_value,
          items: {
            create: quote.items.map((qi, idx) => ({
              procedure_id: qi.procedure_id,
              tooth_fdi: qi.tooth_fdi,
              quantity: qi.quantity,
              unit_price: qi.unit_price,
              total_price: qi.total_price,
              notes: qi.notes,
              order_index: idx,
            })),
          },
        },
        include: { items: true },
      });

      return { quote: acceptedQuote, treatment_plan: plan };
    });
  }

  async reject(id: string, tenantId: string, reason?: string) {
    const quote = await this.findOne(id, tenantId);
    if (quote.status !== 'SENT') {
      throw new BadRequestException('Apenas orcamentos SENT podem ser rejeitados');
    }
    return this.prisma.quote.update({
      where: { id },
      data: { status: 'REJECTED', rejected_at: new Date(), rejection_reason: reason || null },
    });
  }

  async remove(id: string, tenantId: string) {
    const quote = await this.findOne(id, tenantId);
    if (quote.status !== 'DRAFT') {
      throw new BadRequestException('Apenas rascunhos podem ser removidos');
    }
    return this.prisma.quote.delete({ where: { id } });
  }

  // ─── QuoteItem ────────────────────────────────────────────────

  async addItem(quoteId: string, tenantId: string, input: ItemInput) {
    const quote = await this.findOne(quoteId, tenantId);
    if (quote.status !== 'DRAFT') {
      throw new BadRequestException('Itens so podem ser adicionados em rascunhos');
    }
    const [resolved] = await this.resolveItems([input], tenantId);
    const item = await this.prisma.quoteItem.create({
      data: {
        quote_id: quoteId,
        procedure_id: resolved.procedure_id,
        tooth_fdi: resolved.tooth_fdi || null,
        quantity: resolved.quantity,
        unit_price: resolved.unit_price,
        total_price: resolved.total_price,
        notes: resolved.notes || null,
        order_index: quote.items.length,
      },
    });
    await this.recalcTotals(quoteId);
    return item;
  }

  async updateItem(
    itemId: string,
    tenantId: string,
    data: { tooth_fdi?: string; quantity?: number; unit_price?: number; notes?: string; order_index?: number },
  ) {
    const item = await this.getItemEnsuringTenant(itemId, tenantId);
    if (item.quote.status !== 'DRAFT') {
      throw new BadRequestException('Itens so podem ser editados em rascunhos');
    }

    const patch: Prisma.QuoteItemUncheckedUpdateInput = { ...data };
    if (data.quantity !== undefined || data.unit_price !== undefined) {
      const qty = data.quantity ?? item.quantity;
      const price = data.unit_price ?? Number(item.unit_price);
      patch.total_price = qty * price;
    }
    const updated = await this.prisma.quoteItem.update({ where: { id: itemId }, data: patch });
    await this.recalcTotals(item.quote_id);
    return updated;
  }

  async removeItem(itemId: string, tenantId: string) {
    const item = await this.getItemEnsuringTenant(itemId, tenantId);
    if (item.quote.status !== 'DRAFT') {
      throw new BadRequestException('Itens so podem ser removidos em rascunhos');
    }
    await this.prisma.quoteItem.delete({ where: { id: itemId } });
    await this.recalcTotals(item.quote_id);
    return { ok: true };
  }

  // ─── Helpers ──────────────────────────────────────────────────

  /** Carrega procedures pra pegar preco base (quando unit_price nao informado). */
  private async resolveItems(items: ItemInput[], tenantId: string) {
    if (items.length === 0) return [];
    const procIds = [...new Set(items.map((i) => i.procedure_id))];
    const procs = await this.prisma.procedure.findMany({
      where: { id: { in: procIds }, tenant_id: tenantId },
      select: { id: true, base_price: true, tenant_id: true },
    });
    const byId = new Map(procs.map((p) => [p.id, p]));

    return items.map((i) => {
      const proc = byId.get(i.procedure_id);
      if (!proc) throw new BadRequestException(`Procedimento ${i.procedure_id} nao encontrado`);
      const quantity = i.quantity ?? 1;
      const unit_price = i.unit_price ?? Number(proc.base_price);
      const total_price = quantity * unit_price;
      return { ...i, quantity, unit_price, total_price };
    });
  }

  private computeTotals(items: { total_price: number }[], discountPercent: number) {
    const subtotal = items.reduce((acc, i) => acc + i.total_price, 0);
    const discount_value = subtotal * (discountPercent / 100);
    const total = subtotal - discount_value;
    return { subtotal, discount_value, total };
  }

  private async recalcTotals(quoteId: string) {
    const items = await this.prisma.quoteItem.findMany({
      where: { quote_id: quoteId },
      select: { total_price: true },
    });
    const quote = await this.prisma.quote.findUnique({
      where: { id: quoteId },
      select: { discount_percent: true },
    });
    const discountPercent = Number(quote?.discount_percent || 0);
    const totals = this.computeTotals(items.map((i) => ({ total_price: Number(i.total_price) })), discountPercent);
    await this.prisma.quote.update({
      where: { id: quoteId },
      data: {
        subtotal: totals.subtotal,
        discount_value: totals.discount_value,
        total_value: totals.total,
      },
    });
  }

  private async assertPatientBelongsToTenant(patientId: string, tenantId: string) {
    const row = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { tenant_id: true },
    });
    if (!row) throw new NotFoundException('Paciente nao encontrado');
    if (row.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
  }

  private async getItemEnsuringTenant(itemId: string, tenantId: string) {
    const item = await this.prisma.quoteItem.findUnique({
      where: { id: itemId },
      include: {
        quote: {
          select: { id: true, status: true, patient: { select: { tenant_id: true } } },
        },
      },
    });
    if (!item) throw new NotFoundException('Item nao encontrado');
    if (item.quote.patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    return item;
  }
}
