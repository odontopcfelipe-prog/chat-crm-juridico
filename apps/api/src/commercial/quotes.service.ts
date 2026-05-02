import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException, Inject, forwardRef, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { PortalAuthService } from '../portal/portal-auth.service';
import { QuoteVersionsService } from './quote-versions.service';
import { Prisma } from '@crm/shared';

type ItemInput = {
  procedure_id: string;
  tooth_fdi?: string;
  quantity?: number;
  unit_price?: number;
  notes?: string;
};

// Validade padrao quando operador nao informa — alinhada com norma de
// planos comerciais de clinicas dentais (orcamento "fica de pe" 30 dias).
const DEFAULT_VALID_DAYS = 30;
// Antecedencia da notificacao de expiracao (lembrete pro paciente)
const EXPIRY_REMINDER_DAYS = 3;

@Injectable()
export class QuotesService {
  private readonly logger = new Logger(QuotesService.name);

  constructor(
    private prisma: PrismaService,
    @Optional() @Inject(forwardRef(() => WhatsappService)) private whatsapp?: WhatsappService,
    @Optional() @Inject(forwardRef(() => PortalAuthService)) private portalAuth?: PortalAuthService,
    @Optional() private versions?: QuoteVersionsService,
  ) {}

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

    // Default valid_until = hoje + 30 dias se nao informado.
    // Nunca cria orcamento sem validade — vira problema na auto-expiracao.
    const validUntil = data.valid_until
      ? new Date(data.valid_until)
      : (() => {
          const d = new Date();
          d.setDate(d.getDate() + DEFAULT_VALID_DAYS);
          return d;
        })();

    return this.prisma.quote.create({
      data: {
        patient_id: patientId,
        created_by_user_id: userId,
        valid_until: validUntil,
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
      include: {
        items: {
          include: {
            procedure: {
              select: {
                id: true,
                name: true,
                duration_minutes: true,
                specialty: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });
  }

  async findByPatient(patientId: string, tenantId: string) {
    await this.assertPatientBelongsToTenant(patientId, tenantId);
    return this.prisma.quote.findMany({
      // Onda 25.6 — exclui soft-deletados da listagem normal
      where: { patient_id: patientId, deleted_at: null },
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
        patient: { select: { id: true, name: true, tenant_id: true, phone: true } },
        coupon: { select: { id: true, code: true, description: true, discount_type: true, discount_amount: true } },
        created_by: { select: { id: true, name: true } },
        items: {
          orderBy: { order_index: 'asc' },
          include: {
            procedure: {
              select: {
                id: true,
                name: true,
                code_tuss: true,
                duration_minutes: true,
                specialty: { select: { id: true, name: true } },
              },
            },
          },
        },
        treatment_plan: true,
        // Onda 3 — Anexos (Fase 24): retorna metadata pra UI mostrar contador.
        // Binario eh servido via /quote-attachments/:id/file separado.
        _count: { select: { attachments: true, versions: true } },
        // Onda 3b — Mostra origem da renegociacao (se vier de outro orcamento)
        renegotiated_from: {
          select: {
            id: true, status: true, total_value: true, created_at: true,
          },
        },
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

  async send(id: string, tenantId: string, userId?: string) {
    const quote = await this.findOne(id, tenantId);
    if (quote.status !== 'DRAFT') {
      throw new BadRequestException('Apenas orcamentos em DRAFT podem ser enviados');
    }

    const updated = await this.prisma.quote.update({
      where: { id },
      data: { status: 'SENT', sent_at: new Date() },
    });

    // Onda 3b — snapshot automatico do estado enviado (preserva pra renegociacao futura)
    if (this.versions && userId) {
      await this.versions.createSnapshot(id, userId, 'SEND').catch((e) =>
        this.logger.warn(`[VERSION] snapshot SEND falhou: ${e?.message}`),
      );
    }

    return updated;
  }

  async accept(id: string, tenantId: string, userId?: string) {
    const quote = await this.findOne(id, tenantId);
    if (quote.status !== 'SENT') {
      throw new BadRequestException('Apenas orcamentos SENT podem ser aceitos');
    }

    // Onda 3b — snapshot da versao final antes de mudar pra ACCEPTED
    if (this.versions && userId) {
      await this.versions.createSnapshot(id, userId, 'ACCEPT').catch((e) =>
        this.logger.warn(`[VERSION] snapshot ACCEPT falhou: ${e?.message}`),
      );
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

  async reject(id: string, tenantId: string, reason?: string, userId?: string) {
    const quote = await this.findOne(id, tenantId);
    if (quote.status !== 'SENT') {
      throw new BadRequestException('Apenas orcamentos SENT podem ser rejeitados');
    }

    const updated = await this.prisma.quote.update({
      where: { id },
      data: { status: 'REJECTED', rejected_at: new Date(), rejection_reason: reason || null },
    });

    // Onda 3b — snapshot da versao rejeitada
    if (this.versions && userId) {
      await this.versions.createSnapshot(id, userId, 'REJECT', reason).catch((e) =>
        this.logger.warn(`[VERSION] snapshot REJECT falhou: ${e?.message}`),
      );
    }

    return updated;
  }

  /**
   * Onda 25.6 (Fase 25) — Soft delete: marca deleted_at + deleted_by_user_id
   * em vez de delete fisico. Permite recuperar via restore() por 30 dias.
   * Job futuro fara hard delete dos antigos pra evitar inflar o banco.
   */
  async remove(id: string, tenantId: string, userId?: string) {
    const quote = await this.findOne(id, tenantId);
    if (quote.status !== 'DRAFT') {
      throw new BadRequestException('Apenas rascunhos podem ser removidos');
    }
    return this.prisma.quote.update({
      where: { id },
      data: {
        deleted_at: new Date(),
        deleted_by_user_id: userId || null,
      },
    });
  }

  /**
   * Onda 25.6 — Restaura orcamento soft-deletado (admin only).
   * Limpa deleted_at + deleted_by_user_id.
   */
  async restore(id: string, tenantId: string) {
    // Acessa o quote ignorando o filtro de soft-delete
    const quote = await this.prisma.quote.findUnique({
      where: { id },
      include: { patient: { select: { tenant_id: true } } },
    });
    if (!quote) throw new NotFoundException('Orçamento não encontrado');
    if (quote.patient.tenant_id !== tenantId) {
      throw new NotFoundException('Orçamento não encontrado');
    }
    if (!quote.deleted_at) {
      throw new BadRequestException('Orçamento não está deletado');
    }
    return this.prisma.quote.update({
      where: { id },
      data: { deleted_at: null, deleted_by_user_id: null },
    });
  }

  /**
   * Onda 25.6 — Lista orcamentos soft-deletados nos ultimos 30 dias do tenant.
   * Pra tela admin de recuperacao.
   */
  async listDeleted(tenantId: string) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    return this.prisma.quote.findMany({
      where: {
        deleted_at: { gte: thirtyDaysAgo, not: null },
        patient: { tenant_id: tenantId },
      },
      orderBy: { deleted_at: 'desc' },
      include: {
        patient: { select: { id: true, name: true } },
        deleted_by: { select: { id: true, name: true } },
        _count: { select: { items: true } },
      },
    });
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

  // ─── Onda 1 — Listagem global + Dashboard funil ────────────────

  /**
   * Lista TODOS os orcamentos do tenant com filtros (status, dentista, range
   * de datas). Substitui findByPatient quando operador quer visao geral
   * comercial (pagina /atendimento/orcamentos).
   */
  async findAll(
    tenantId: string,
    opts: {
      status?: string;
      createdById?: string;
      patientId?: string;
      from?: string; // ISO date
      to?: string;
      search?: string;
      limit?: number;
    } = {},
  ) {
    const limit = Math.min(500, Math.max(1, opts.limit || 100));
    const where: Prisma.QuoteWhereInput = {
      patient: { tenant_id: tenantId },
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.createdById ? { created_by_user_id: opts.createdById } : {}),
      ...(opts.patientId ? { patient_id: opts.patientId } : {}),
      ...(opts.from || opts.to
        ? {
            created_at: {
              ...(opts.from ? { gte: new Date(opts.from) } : {}),
              ...(opts.to ? { lte: new Date(opts.to) } : {}),
            },
          }
        : {}),
      ...(opts.search
        ? {
            patient: {
              tenant_id: tenantId,
              OR: [
                { name: { contains: opts.search, mode: 'insensitive' } },
                { phone: { contains: opts.search } },
                { cpf: { contains: opts.search } },
              ],
            },
          }
        : {}),
    };

    return this.prisma.quote.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: limit,
      include: {
        patient: { select: { id: true, name: true, phone: true } },
        created_by: { select: { id: true, name: true } },
        _count: { select: { items: true } },
      },
    });
  }

  /**
   * Dashboard funil de orcamentos: contagens e valores por status,
   * taxa de conversao, e expirando em ate 7 dias. Usado na pagina
   * /atendimento/orcamentos pra visao gerencial.
   */
  async getDashboardStats(
    tenantId: string,
    opts: { from?: string; to?: string } = {},
  ) {
    const where: Prisma.QuoteWhereInput = {
      patient: { tenant_id: tenantId },
      ...(opts.from || opts.to
        ? {
            created_at: {
              ...(opts.from ? { gte: new Date(opts.from) } : {}),
              ...(opts.to ? { lte: new Date(opts.to) } : {}),
            },
          }
        : {}),
    };

    const [grouped, expiringSoon] = await Promise.all([
      this.prisma.quote.groupBy({
        by: ['status'],
        where,
        _count: true,
        _sum: { total_value: true },
      }),
      this.prisma.quote.count({
        where: {
          patient: { tenant_id: tenantId },
          status: 'SENT',
          valid_until: {
            gte: new Date(),
            lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          },
        },
      }),
    ]);

    const byStatus: Record<string, { count: number; total: number }> = {
      DRAFT: { count: 0, total: 0 },
      SENT: { count: 0, total: 0 },
      ACCEPTED: { count: 0, total: 0 },
      REJECTED: { count: 0, total: 0 },
      EXPIRED: { count: 0, total: 0 },
    };
    for (const g of grouped) {
      byStatus[g.status] = {
        count: g._count,
        total: Number(g._sum.total_value) || 0,
      };
    }

    // Conversao = ACCEPTED / (ACCEPTED + REJECTED + EXPIRED) — exclui DRAFT/SENT
    // ainda em aberto. Reflete decisao final do paciente.
    const decided =
      byStatus.ACCEPTED.count + byStatus.REJECTED.count + byStatus.EXPIRED.count;
    const conversionRate = decided > 0 ? byStatus.ACCEPTED.count / decided : null;

    return {
      byStatus,
      total_count: Object.values(byStatus).reduce((s, x) => s + x.count, 0),
      pipeline_value: byStatus.SENT.total + byStatus.DRAFT.total,
      revenue_accepted: byStatus.ACCEPTED.total,
      conversion_rate: conversionRate,
      expiring_soon: expiringSoon,
    };
  }

  // ─── Onda 1 — Auto-expiracao + lembrete D-3 ────────────────────

  /**
   * Marca como EXPIRED orcamentos com status=SENT cuja valid_until
   * ja passou. Idempotente — pode rodar quantas vezes precisar.
   * Usado pelo cron diario E pode ser chamado manualmente via admin.
   */
  async expireOldQuotes(tenantId?: string): Promise<{ expired: number }> {
    const now = new Date();
    const where: Prisma.QuoteWhereInput = {
      status: 'SENT',
      valid_until: { lt: now },
      ...(tenantId ? { patient: { tenant_id: tenantId } } : {}),
    };
    const result = await this.prisma.quote.updateMany({
      where,
      data: { status: 'EXPIRED' },
    });
    if (result.count > 0) {
      this.logger.log(`[QUOTES] ${result.count} orcamento(s) auto-expirados`);
    }
    return { expired: result.count };
  }

  /**
   * Envia lembrete WhatsApp D-3 antes da expiracao pra orcamentos SENT.
   * "Seu orcamento expira em 3 dias, quer renegociar?". Best-effort —
   * roda no cron e nao bloqueia.
   */
  async sendExpiryReminders(): Promise<{ sent: number }> {
    if (!this.whatsapp) {
      this.logger.warn('[QUOTES] WhatsappService nao disponivel — pulando lembretes');
      return { sent: 0 };
    }
    // Janela: orcamentos SENT que expiram nos proximos 3 dias.
    // Usa window de 24h pra evitar duplicar lembrete (cron diario).
    const target = new Date();
    target.setDate(target.getDate() + EXPIRY_REMINDER_DAYS);
    const targetStart = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 0, 0, 0);
    const targetEnd = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 23, 59, 59);

    const candidates = await this.prisma.quote.findMany({
      where: {
        status: 'SENT',
        valid_until: { gte: targetStart, lte: targetEnd },
      },
      include: {
        patient: { select: { id: true, name: true, phone: true } },
      },
      take: 200,
    });

    let sent = 0;
    for (const q of candidates) {
      if (!q.patient?.phone) continue;
      try {
        const firstName = (q.patient.name || '').split(' ')[0] || 'Olá';
        const total = Number(q.total_value).toLocaleString('pt-BR', {
          style: 'currency', currency: 'BRL',
        });
        const validDate = q.valid_until?.toLocaleDateString('pt-BR') || '—';
        const msg =
          `Oi ${firstName}! 👋\n\n` +
          `Passando pra lembrar que seu orçamento (${total}) está prestes a expirar em ${validDate}.\n\n` +
          `Quer reservar agora ou tem alguma dúvida sobre o tratamento? É só responder por aqui que a gente conversa! 😊`;
        const result: any = await this.whatsapp.sendText(q.patient.phone, msg);
        if (result && result.statusCode < 400) sent++;
      } catch (e: any) {
        this.logger.warn(`[QUOTES] Lembrete D-3 falhou pra ${q.id}: ${e?.message}`);
      }
    }
    if (sent > 0) {
      this.logger.log(`[QUOTES] ${sent} lembrete(s) D-3 enviado(s)`);
    }
    return { sent };
  }

  /** Cron: roda 1x ao dia (3h da manhã, fora do horário comercial). */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cronDailyExpiry() {
    try {
      await this.expireOldQuotes();
      await this.sendExpiryReminders();
    } catch (e: any) {
      this.logger.error(`[QUOTES] cronDailyExpiry falhou: ${e?.message}`);
    }
  }

  // ─── Onda 1 — Envio via WhatsApp ───────────────────────────────

  /**
   * Envia orcamento por WhatsApp pro paciente: gera magic link via portal,
   * monta mensagem custom com resumo (total, items, validade), envia via
   * Evolution. Atualiza status SENT + sent_at se ainda era DRAFT.
   *
   * Aceita re-envio em SENT (sem mudar status, so registra no log).
   */
  async sendByWhatsapp(quoteId: string, tenantId: string, userId?: string) {
    if (!this.whatsapp) {
      throw new BadRequestException('Servico de WhatsApp nao disponivel');
    }
    if (!this.portalAuth) {
      throw new BadRequestException('Servico de portal nao disponivel');
    }
    const quote = await this.findOne(quoteId, tenantId);
    if (!['DRAFT', 'SENT'].includes(quote.status)) {
      throw new BadRequestException(
        `Orcamento esta ${quote.status} — nao pode reenviar. Crie um novo orcamento se precisar.`,
      );
    }
    if (!quote.patient.phone) {
      throw new BadRequestException(
        'Paciente sem telefone cadastrado — adicione antes de enviar via WhatsApp.',
      );
    }

    // Gera magic link sem disparar mensagem automatica do portal
    // (vamos enviar uma mensagem custom com dados do orcamento)
    const magic = await this.portalAuth.createMagicLink(
      tenantId, quote.patient_id, 'OTHER',
    );

    // Mensagem custom com resumo
    const firstName = (quote.patient.name || '').split(' ')[0] || 'Olá';
    const formatBRL = (v: any) =>
      Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const itemCount = quote.items?.length || 0;
    const validUntil = quote.valid_until
      ? quote.valid_until.toLocaleDateString('pt-BR')
      : null;
    // Onda 3 — conta anexos pra mencionar na mensagem (gera curiosidade no paciente)
    const attachmentCount = (quote as any)._count?.attachments || 0;

    const msg =
      `Oi ${firstName}! 👋\n\n` +
      `Seu orçamento do Instituto Odonto Passos está pronto:\n\n` +
      `📋 ${itemCount} procedimento(s)\n` +
      `💰 Total: ${formatBRL(quote.total_value)}\n` +
      (Number(quote.discount_value) > 0
        ? `🎁 Desconto: ${formatBRL(quote.discount_value)}\n`
        : '') +
      (validUntil ? `📅 Válido até ${validUntil}\n` : '') +
      (attachmentCount > 0 ? `📎 ${attachmentCount} anexo(s) (fotos, exames)\n` : '') +
      `\nAcesse pra ver detalhes e aceitar:\n${magic.link}\n\n` +
      `Qualquer dúvida, é só responder por aqui. 😊`;

    let dispatchOk = false;
    let dispatchReason = '';
    try {
      const result: any = await this.whatsapp.sendText(quote.patient.phone, msg);
      dispatchOk = result && (!result.statusCode || result.statusCode < 400) && !result.error;
      if (!dispatchOk) {
        dispatchReason = result?.error || `HTTP ${result?.statusCode || '?'}`;
      }
    } catch (e: any) {
      dispatchReason = e?.message || 'erro desconhecido';
    }

    if (!dispatchOk) {
      throw new BadRequestException(
        `Falha ao enviar WhatsApp: ${dispatchReason}. Link gerado: ${magic.link}`,
      );
    }

    // Sucesso: marca como SENT (se ainda era DRAFT)
    const wasDraft = quote.status === 'DRAFT';
    if (wasDraft) {
      await this.prisma.quote.update({
        where: { id: quoteId },
        data: { status: 'SENT', sent_at: new Date() },
      });
    }

    // Onda 3b — snapshot da versao enviada (se foi a primeira vez)
    if (wasDraft && this.versions && userId) {
      await this.versions.createSnapshot(quoteId, userId, 'SEND', 'Enviado via WhatsApp').catch((e) =>
        this.logger.warn(`[VERSION] snapshot SEND-WhatsApp falhou: ${e?.message}`),
      );
    }

    this.logger.log(
      `[QUOTES] Orcamento ${quoteId} enviado via WhatsApp pra ${quote.patient.phone}`,
    );
    return {
      ok: true,
      link: magic.link,
      sent_to: quote.patient.phone,
      status: 'SENT',
    };
  }
}
