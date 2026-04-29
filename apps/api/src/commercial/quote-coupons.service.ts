/**
 * QuoteCouponsService — admin de cupons promocionais (Fase 24 — Onda 2).
 *
 * Cupons sao codigos de desconto (ex: "FRIEND15", "BLACKFRIDAY"). Operador
 * digita o codigo no orcamento e desconto eh aplicado automaticamente.
 *
 * Validacoes ao aplicar:
 *  - Cupom existe e is_active
 *  - Esta dentro da janela valid_from/valid_until
 *  - Nao excedeu max_uses
 *  - Subtotal >= min_order_value (se setado)
 *
 * Tipos de desconto:
 *  - PERCENT: aplica % ao subtotal
 *  - FIXED: desconta R$ fixo
 *
 * Auditoria: incrementa used_count toda vez que um quote eh CRIADO com
 * o cupom (nao decrementa em caso de exclusao do quote — cupom usado
 * fica registrado).
 */
import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateCouponDto {
  code: string;
  description?: string | null;
  discount_type?: 'PERCENT' | 'FIXED';
  discount_amount: number;
  valid_from?: string | null;
  valid_until?: string | null;
  max_uses?: number | null;
  min_order_value?: number | null;
  is_active?: boolean;
  notes?: string | null;
}

export interface UpdateCouponDto extends Partial<CreateCouponDto> {}

@Injectable()
export class QuoteCouponsService {
  private readonly logger = new Logger(QuoteCouponsService.name);

  constructor(private prisma: PrismaService) {}

  async list(tenantId: string, opts: { activeOnly?: boolean } = {}) {
    return (this.prisma as any).quoteCoupon.findMany({
      where: {
        tenant_id: tenantId,
        ...(opts.activeOnly ? { is_active: true } : {}),
      },
      orderBy: [{ is_active: 'desc' }, { code: 'asc' }],
    });
  }

  async findOne(id: string, tenantId: string) {
    const c = await (this.prisma as any).quoteCoupon.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Cupom nao encontrado');
    if (c.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    return c;
  }

  async create(tenantId: string, data: CreateCouponDto) {
    if (!data.code?.trim()) throw new BadRequestException('Codigo do cupom e obrigatorio');
    if (data.discount_amount === undefined || data.discount_amount < 0) {
      throw new BadRequestException('Valor do desconto invalido');
    }
    const code = data.code.trim().toUpperCase();
    // Unicidade por tenant — schema garante via @@unique
    const existing = await (this.prisma as any).quoteCoupon.findUnique({
      where: { tenant_id_code: { tenant_id: tenantId, code } },
    });
    if (existing) throw new BadRequestException(`Ja existe um cupom com codigo "${code}"`);

    return (this.prisma as any).quoteCoupon.create({
      data: {
        tenant_id: tenantId,
        code,
        description: data.description?.trim() || null,
        discount_type: data.discount_type || 'PERCENT',
        discount_amount: data.discount_amount,
        valid_from: data.valid_from ? new Date(data.valid_from) : null,
        valid_until: data.valid_until ? new Date(data.valid_until) : null,
        max_uses: data.max_uses ?? null,
        min_order_value: data.min_order_value ?? null,
        is_active: data.is_active !== false,
        notes: data.notes?.trim() || null,
      },
    });
  }

  async update(id: string, tenantId: string, data: UpdateCouponDto) {
    await this.findOne(id, tenantId);
    const patch: any = {};
    if (data.code !== undefined) patch.code = data.code.trim().toUpperCase();
    if (data.description !== undefined) patch.description = data.description?.trim() || null;
    if (data.discount_type !== undefined) patch.discount_type = data.discount_type;
    if (data.discount_amount !== undefined) patch.discount_amount = data.discount_amount;
    if (data.valid_from !== undefined) patch.valid_from = data.valid_from ? new Date(data.valid_from) : null;
    if (data.valid_until !== undefined) patch.valid_until = data.valid_until ? new Date(data.valid_until) : null;
    if (data.max_uses !== undefined) patch.max_uses = data.max_uses;
    if (data.min_order_value !== undefined) patch.min_order_value = data.min_order_value;
    if (data.is_active !== undefined) patch.is_active = data.is_active;
    if (data.notes !== undefined) patch.notes = data.notes?.trim() || null;
    return (this.prisma as any).quoteCoupon.update({ where: { id }, data: patch });
  }

  async remove(id: string, tenantId: string) {
    await this.findOne(id, tenantId);
    return (this.prisma as any).quoteCoupon.delete({ where: { id } });
  }

  /**
   * Valida cupom pra um quote (sem aplicar). Usado pelo frontend pra dar
   * feedback ao operador antes de salvar. Retorna desconto calculado.
   */
  async validate(code: string, tenantId: string, quoteSubtotal?: number) {
    const upperCode = code.trim().toUpperCase();
    const coupon = await (this.prisma as any).quoteCoupon.findUnique({
      where: { tenant_id_code: { tenant_id: tenantId, code: upperCode } },
    });
    if (!coupon) {
      throw new BadRequestException('Cupom nao encontrado');
    }
    if (!coupon.is_active) {
      throw new BadRequestException('Cupom esta inativo');
    }
    const now = new Date();
    if (coupon.valid_from && now < coupon.valid_from) {
      throw new BadRequestException('Cupom ainda nao esta valido');
    }
    if (coupon.valid_until && now > coupon.valid_until) {
      throw new BadRequestException('Cupom expirado');
    }
    if (coupon.max_uses !== null && coupon.used_count >= coupon.max_uses) {
      throw new BadRequestException('Cupom atingiu o limite de usos');
    }
    if (
      coupon.min_order_value !== null &&
      quoteSubtotal !== undefined &&
      quoteSubtotal < Number(coupon.min_order_value)
    ) {
      throw new BadRequestException(
        `Valor mínimo do orçamento pra esse cupom: R$ ${Number(coupon.min_order_value).toFixed(2)}`,
      );
    }

    let discountValue = 0;
    let discountPercent = 0;
    if (coupon.discount_type === 'PERCENT') {
      discountPercent = Number(coupon.discount_amount);
      if (quoteSubtotal !== undefined) {
        discountValue = quoteSubtotal * (discountPercent / 100);
      }
    } else {
      // FIXED
      discountValue = Number(coupon.discount_amount);
      if (quoteSubtotal !== undefined && quoteSubtotal > 0) {
        discountPercent = (discountValue / quoteSubtotal) * 100;
      }
    }

    return {
      coupon_id: coupon.id,
      code: coupon.code,
      description: coupon.description,
      discount_type: coupon.discount_type,
      discount_amount: Number(coupon.discount_amount),
      discount_value: Number(discountValue.toFixed(2)),
      discount_percent: Number(discountPercent.toFixed(2)),
    };
  }

  /** Aplica cupom a um quote em DRAFT — atualiza coupon_id + recalcula totais. */
  async applyToQuote(quoteId: string, code: string, tenantId: string) {
    const quote = await this.prisma.quote.findUnique({
      where: { id: quoteId },
      include: { patient: { select: { tenant_id: true } } },
    });
    if (!quote) throw new NotFoundException('Orcamento nao encontrado');
    if (quote.patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    if (quote.status !== 'DRAFT') {
      throw new BadRequestException('Cupons so podem ser aplicados em rascunhos');
    }

    const validated = await this.validate(code, tenantId, Number(quote.subtotal));

    return this.prisma.$transaction(async (tx) => {
      // Atualiza quote
      const updated = await tx.quote.update({
        where: { id: quoteId },
        data: {
          coupon_id: validated.coupon_id,
          discount_percent: validated.discount_percent,
          discount_value: validated.discount_value,
          total_value: Number(quote.subtotal) - validated.discount_value,
        },
      });

      // Incrementa used_count
      await (tx as any).quoteCoupon.update({
        where: { id: validated.coupon_id },
        data: { used_count: { increment: 1 } },
      });

      this.logger.log(`[COUPON] ${validated.code} aplicado em ${quoteId} (-R$ ${validated.discount_value})`);
      return updated;
    });
  }

  /** Remove cupom do quote — zera desconto. */
  async removeFromQuote(quoteId: string, tenantId: string) {
    const quote = await this.prisma.quote.findUnique({
      where: { id: quoteId },
      include: { patient: { select: { tenant_id: true } } },
    });
    if (!quote) throw new NotFoundException('Orcamento nao encontrado');
    if (quote.patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    if (quote.status !== 'DRAFT') {
      throw new BadRequestException('Cupons so podem ser removidos em rascunhos');
    }
    if (!quote.coupon_id) {
      throw new BadRequestException('Orcamento nao tem cupom aplicado');
    }

    return this.prisma.$transaction(async (tx) => {
      // Decrementa used_count do cupom anterior
      await (tx as any).quoteCoupon.update({
        where: { id: quote.coupon_id! },
        data: { used_count: { decrement: 1 } },
      });
      // Zera desconto
      return tx.quote.update({
        where: { id: quoteId },
        data: {
          coupon_id: null,
          discount_percent: 0,
          discount_value: 0,
          total_value: quote.subtotal,
        },
      });
    });
  }
}
