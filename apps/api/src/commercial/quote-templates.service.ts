/**
 * QuoteTemplatesService — admin de templates por especialidade (Fase 24 — Onda 2).
 *
 * Templates sao "cestas" pre-prontas de procedimentos. Operador escolhe
 * "Implante unitario completo" e ja vem 4-5 itens (avaliacao, RX, cirurgia,
 * coroa, etc) com precos sugeridos. Reduz tempo de montagem de orcamento
 * de ~5 minutos pra ~30 segundos em casos comuns.
 *
 * applyTemplate(quoteId, templateId): copia items do template pro orcamento,
 * resolvendo unit_price (template.unit_price OU procedure.base_price atual).
 */
import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateTemplateDto {
  name: string;
  description?: string | null;
  specialty?: string | null;
  is_active?: boolean;
  items?: Array<{
    procedure_id: string;
    quantity?: number;
    unit_price?: number | null;
    notes?: string | null;
  }>;
}

export interface UpdateTemplateDto extends Partial<CreateTemplateDto> {}

@Injectable()
export class QuoteTemplatesService {
  private readonly logger = new Logger(QuoteTemplatesService.name);

  constructor(private prisma: PrismaService) {}

  async list(tenantId: string, opts: { activeOnly?: boolean } = {}) {
    return (this.prisma as any).quoteTemplate.findMany({
      where: {
        tenant_id: tenantId,
        ...(opts.activeOnly ? { is_active: true } : {}),
      },
      include: {
        _count: { select: { items: true } },
      },
      orderBy: [{ is_active: 'desc' }, { name: 'asc' }],
    });
  }

  async findOne(id: string, tenantId: string) {
    const tpl = await (this.prisma as any).quoteTemplate.findUnique({
      where: { id },
      include: {
        items: {
          orderBy: { order_index: 'asc' },
          include: {
            procedure: { select: { id: true, name: true, base_price: true, code_tuss: true } },
          },
        },
      },
    });
    if (!tpl) throw new NotFoundException('Template nao encontrado');
    if (tpl.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    return tpl;
  }

  async create(tenantId: string, data: CreateTemplateDto) {
    if (!data.name?.trim()) {
      throw new BadRequestException('Nome do template e obrigatorio');
    }
    return (this.prisma as any).quoteTemplate.create({
      data: {
        tenant_id: tenantId,
        name: data.name.trim(),
        description: data.description?.trim() || null,
        specialty: data.specialty?.trim() || null,
        is_active: data.is_active !== false,
        items: data.items?.length
          ? {
              create: data.items.map((it, idx) => ({
                procedure_id: it.procedure_id,
                quantity: it.quantity || 1,
                unit_price: it.unit_price !== null && it.unit_price !== undefined ? it.unit_price : null,
                notes: it.notes?.trim() || null,
                order_index: idx,
              })),
            }
          : undefined,
      },
      include: {
        items: { include: { procedure: { select: { id: true, name: true, base_price: true } } } },
      },
    });
  }

  async update(id: string, tenantId: string, data: UpdateTemplateDto) {
    await this.findOne(id, tenantId);

    return this.prisma.$transaction(async (tx) => {
      const updated = await (tx as any).quoteTemplate.update({
        where: { id },
        data: {
          ...(data.name !== undefined ? { name: data.name.trim() } : {}),
          ...(data.description !== undefined ? { description: data.description?.trim() || null } : {}),
          ...(data.specialty !== undefined ? { specialty: data.specialty?.trim() || null } : {}),
          ...(data.is_active !== undefined ? { is_active: data.is_active } : {}),
        },
      });

      // Se passou items novos, substitui o conjunto
      if (data.items !== undefined) {
        await (tx as any).quoteTemplateItem.deleteMany({ where: { template_id: id } });
        if (data.items.length > 0) {
          await (tx as any).quoteTemplateItem.createMany({
            data: data.items.map((it, idx) => ({
              template_id: id,
              procedure_id: it.procedure_id,
              quantity: it.quantity || 1,
              unit_price: it.unit_price !== null && it.unit_price !== undefined ? it.unit_price : null,
              notes: it.notes?.trim() || null,
              order_index: idx,
            })),
          });
        }
      }

      return updated;
    });
  }

  async remove(id: string, tenantId: string) {
    await this.findOne(id, tenantId);
    return (this.prisma as any).quoteTemplate.delete({ where: { id } });
  }

  /**
   * Aplica template a um quote em DRAFT — copia todos os items.
   * Resolve unit_price: usa template.unit_price se setado, senao base_price
   * do Procedure no momento. Adiciona ao final dos items existentes.
   */
  async applyToQuote(quoteId: string, templateId: string, tenantId: string) {
    const tpl = await this.findOne(templateId, tenantId);
    const quote = await this.prisma.quote.findUnique({
      where: { id: quoteId },
      include: { patient: { select: { tenant_id: true } } },
    });
    if (!quote) throw new NotFoundException('Orcamento nao encontrado');
    if (quote.patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    if (quote.status !== 'DRAFT') {
      throw new BadRequestException('Templates so podem ser aplicados em rascunhos');
    }

    // Pega quantos items ja existem pra continuar order_index
    const existingCount = await this.prisma.quoteItem.count({ where: { quote_id: quoteId } });

    const newItems = tpl.items.map((ti: any, idx: number) => {
      const unitPrice = ti.unit_price !== null
        ? Number(ti.unit_price)
        : Number(ti.procedure?.base_price || 0);
      const qty = ti.quantity || 1;
      return {
        quote_id: quoteId,
        procedure_id: ti.procedure_id,
        tooth_fdi: null,
        quantity: qty,
        unit_price: unitPrice,
        total_price: qty * unitPrice,
        notes: ti.notes,
        order_index: existingCount + idx,
      };
    });

    if (newItems.length > 0) {
      await this.prisma.quoteItem.createMany({ data: newItems });
    }

    // Recalcula totais
    const allItems = await this.prisma.quoteItem.findMany({
      where: { quote_id: quoteId },
      select: { total_price: true },
    });
    const subtotal = allItems.reduce((acc, i) => acc + Number(i.total_price), 0);
    const discountPercent = Number(quote.discount_percent || 0);
    const discountValue = subtotal * (discountPercent / 100);
    await this.prisma.quote.update({
      where: { id: quoteId },
      data: {
        subtotal,
        discount_value: discountValue,
        total_value: subtotal - discountValue,
      },
    });

    this.logger.log(`[TEMPLATE] Aplicado template ${templateId} no orcamento ${quoteId} (${newItems.length} items)`);
    return { added: newItems.length };
  }
}
