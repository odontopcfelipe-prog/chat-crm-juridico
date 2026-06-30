import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTransactionDto, UpdateTransactionDto, CreateCategoryDto, UpdateCategoryDto, CreateDailyRateTransactionDto } from './financeiro.dto';

// Categorias padrao da clinica odontologica (seed quando o tenant ainda nao tem
// categorias proprias). DIARIA fica por causa do lancador de diaria (Fase 5).
const DEFAULT_CATEGORIES = [
  { type: 'RECEITA', name: 'Procedimento', icon: 'stethoscope' },
  { type: 'RECEITA', name: 'Consulta', icon: 'stethoscope' },
  { type: 'RECEITA', name: 'Produto', icon: 'shopping-bag' },
  { type: 'RECEITA', name: 'Outros', icon: 'ellipsis' },
  { type: 'DESPESA', name: 'Aluguel', icon: 'home' },
  { type: 'DESPESA', name: 'Material Odontologico', icon: 'package' },
  { type: 'DESPESA', name: 'Laboratorio', icon: 'flask' },
  { type: 'DESPESA', name: 'Folha de Pagamento', icon: 'users' },
  { type: 'DESPESA', name: 'Contas (agua/luz/internet)', icon: 'zap' },
  { type: 'DESPESA', name: 'Equipamento', icon: 'wrench' },
  { type: 'DESPESA', name: 'DIARIA', icon: 'calendar-clock' },
  { type: 'DESPESA', name: 'Outros', icon: 'ellipsis' },
];

@Injectable()
export class FinanceiroService {
  private readonly logger = new Logger(FinanceiroService.name);

  constructor(private prisma: PrismaService) {}

  // ─── Audit Log ──────────────────────────────────────────

  async logAction(userId: string | null, action: string, entityId: string, meta: Record<string, any>) {
    try {
      await this.prisma.auditLog.create({
        data: {
          actor_user_id: userId,
          action,
          entity: 'FINANCEIRO',
          entity_id: entityId,
          meta_json: meta,
        },
      });
    } catch (e: any) {
      this.logger.warn(`[AUDIT] Falha ao registrar log: ${e.message}`);
    }
  }

  // ─── Helpers ────────────────────────────────────────────

  private async verifyTransactionAccess(id: string, tenantId?: string) {
    const record = await this.prisma.financialTransaction.findUnique({
      where: { id },
    });
    if (!record) throw new NotFoundException('Transacao nao encontrada');
    if (tenantId && record.tenant_id && record.tenant_id !== tenantId) {
      throw new ForbiddenException('Acesso negado a este recurso');
    }
    return record;
  }

  private async verifyCategoryAccess(id: string, tenantId?: string) {
    const record = await this.prisma.financialCategory.findUnique({
      where: { id },
    });
    if (!record) throw new NotFoundException('Categoria nao encontrada');
    if (tenantId && record.tenant_id && record.tenant_id !== tenantId) {
      throw new ForbiddenException('Acesso negado a este recurso');
    }
    return record;
  }

  // ─── Transactions CRUD ─────────────────────────────────

  async findAllTransactions(query: {
    tenantId?: string;
    type?: string;
    category?: string;
    status?: string;
    legalCaseId?: string;
    leadId?: string;
    dentistId?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
    offset?: number;
  }) {
    const where: any = {};

    if (query.tenantId) where.tenant_id = query.tenantId;
    if (query.type) where.type = query.type;
    if (query.category) where.category = query.category;
    if (query.status) {
      where.status = query.status;
    } else {
      // Por padrão, não mostrar CANCELADO
      where.status = { not: 'CANCELADO' };
    }
    // STUBBED: legal_case_id removido Fase 0.2
    if (query.leadId) where.lead_id = query.leadId;
    if (query.dentistId) {
      // Dentista vê: suas transações + despesas gerais visíveis (receitas só dele)
      if (query.type === 'RECEITA') {
        where.dentist_id = query.dentistId;
      } else {
        where.OR = [
          { dentist_id: query.dentistId },
          { dentist_id: null, visible_to_dentist: true },
        ];
      }
    }

    if (query.startDate || query.endDate) {
      const dateFilter: any = {};
      if (query.startDate) dateFilter.gte = new Date(query.startDate);
      if (query.endDate) dateFilter.lte = new Date(query.endDate);

      // Transações do período + vencidas de meses ANTERIORES (não do mesmo mês)
      const existingOr = where.OR || [];
      delete where.OR;
      where.AND = [
        ...(where.AND || []),
        ...(existingOr.length > 0 ? [{ OR: existingOr }] : []),
        { OR: [
          { date: dateFilter },
          // Dívidas de meses anteriores: date ANTES do período + still PENDENTE
          ...(query.startDate ? [{
            status: 'PENDENTE',
            date: { lt: new Date(query.startDate) },
          }] : []),
        ]},
      ];
    }

    const [data, total] = await Promise.all([
      // STUBBED: legal_case/honorario_payment relations removidas Fase 0.2
      this.prisma.financialTransaction.findMany({
        where,
        include: {
          lead: {
            select: { id: true, name: true, phone: true },
          },
          dentist: {
            select: { id: true, name: true, email: true },
          },
        },
        orderBy: { date: 'desc' },
        take: query.limit || 50,
        skip: query.offset || 0,
      }),
      this.prisma.financialTransaction.count({ where }),
    ]);

    // Enriquecer transações PENDENTE/ATRASADO de honorários com juros legais
    const enriched = await this.enrichWithInterest(data);

    return { data: enriched, total };
  }

  /**
   * Calcula juros legais (1% a.m. padrão) para transações de honorários vencidas.
   * Cálculo em tempo de leitura — não altera dados no banco.
   */
  private async enrichWithInterest(transactions: any[]) {
    const now = new Date();

    return Promise.all(
      transactions.map(async (tx) => {
        // Só calcular juros para receitas de honorário pendentes/vencidas com due_date
        if (
          tx.type !== 'RECEITA' ||
          tx.category !== 'HONORARIO' ||
          tx.status === 'PAGO' ||
          tx.status === 'CANCELADO' ||
          !tx.due_date
        ) {
          return { ...tx, interest_amount: 0, total_with_interest: Number(tx.amount) };
        }

        const dueDate = new Date(tx.due_date);
        if (dueDate >= now) {
          return { ...tx, interest_amount: 0, total_with_interest: Number(tx.amount) };
        }

        // STUBBED: HonorarioPayment removido Fase 0.2 — taxa padrão 1% a.m.
        const monthlyRate = 1.0;

        // Calcular meses de atraso
        const msPerMonth = 30.44 * 24 * 60 * 60 * 1000;
        const monthsOverdue = Math.max(0, (now.getTime() - dueDate.getTime()) / msPerMonth);
        const amount = Number(tx.amount);
        const interestAmount = Math.round(amount * (monthlyRate / 100) * monthsOverdue * 100) / 100;

        return {
          ...tx,
          interest_amount: interestAmount,
          total_with_interest: Math.round((amount + interestAmount) * 100) / 100,
        };
      }),
    );
  }

  async createTransaction(data: CreateTransactionDto & { tenant_id?: string; actor_id?: string }) {
    // STUBBED: legal_case_id/honorario_payment_id removidos Fase 0.2
    const tx = await this.prisma.financialTransaction.create({
      data: {
        tenant_id: data.tenant_id,
        type: data.type,
        category: data.category,
        description: data.description,
        amount: data.amount,
        date: data.date ? new Date(data.date) : new Date(),
        due_date: data.due_date ? new Date(data.due_date) : null,
        paid_at: data.paid_at ? new Date(data.paid_at) : null,
        payment_method: data.payment_method,
        status: data.status || 'PENDENTE',
        lead_id: data.lead_id,
        dentist_id: data.dentist_id,
        reference_id: data.reference_id,
        notes: data.notes,
        visible_to_dentist: data.visible_to_dentist ?? true,
        is_recurring: data.is_recurring ?? false,
        recurrence_pattern: data.is_recurring ? data.recurrence_pattern : null,
        recurrence_day: data.is_recurring ? data.recurrence_day : null,
        recurrence_end_date: data.is_recurring && data.recurrence_end_date ? new Date(data.recurrence_end_date) : null,
      } as any,
      include: {
        lead: { select: { id: true, name: true } },
        dentist: { select: { id: true, name: true } },
      },
    });

    const actionType = data.type === 'DESPESA' ? 'DESPESA_CRIADA' : 'RECEITA_CRIADA';
    await this.logAction(data.actor_id || null, actionType, tx.id, {
      tipo: data.type, categoria: data.category, descricao: data.description,
      valor: data.amount, status: data.status || 'PENDENTE',
      cliente: (tx as any).lead?.name,
      dentist_id: data.dentist_id,
    });

    return tx;
  }

  /**
   * Fase 5 — Lançar Diária.
   *
   * Cria uma DESPESA no caixa (category='DIARIA') a partir do daily_rate do
   * profissional. NÃO é comissão — é gasto operacional. Meia-diária = 50%.
   * Quem lança: admin/financeiro (permissão manage_financial no controller);
   * o dentista NÃO. visible_to_dentist=false pra não aparecer pro profissional.
   */
  // Fase 5 — profissionais do tenant que têm diária configurada (pro picker de diária).
  async professionalsWithDailyRate(tenantId: string) {
    return this.prisma.user.findMany({
      where: { tenant_id: tenantId, daily_rate: { not: null } },
      select: { id: true, name: true, daily_rate: true },
      orderBy: { name: 'asc' },
    });
  }

  async createDailyRateTransaction(
    data: CreateDailyRateTransactionDto & { tenant_id: string; actor_id: string },
  ) {
    const professional = await this.prisma.user.findUnique({
      where: { id: data.professional_user_id },
      select: { id: true, name: true, daily_rate: true, tenant_id: true },
    });

    // Onda 17.67 — isolamento de tenant: user de outro tenant é tratado como inexistente
    // (não vaza a existência cross-tenant + impede IDOR de lançar diária de fora).
    if (!professional || professional.tenant_id !== data.tenant_id) {
      throw new NotFoundException('Profissional nao encontrado');
    }
    if (professional.daily_rate == null) {
      throw new BadRequestException('Profissional nao tem diaria configurada');
    }

    const baseRate = Number(professional.daily_rate);
    if (!(baseRate > 0)) {
      throw new BadRequestException('Diaria do profissional deve ser maior que zero');
    }
    const amount = data.is_half_day ? Math.round((baseRate / 2) * 100) / 100 : baseRate;

    const tx = await this.prisma.financialTransaction.create({
      data: {
        tenant_id: data.tenant_id,
        type: 'DESPESA',
        category: 'DIARIA',
        description: `${data.is_half_day ? 'Meia-' : ''}Diária — ${professional.name}`,
        amount,
        date: data.date ? new Date(data.date) : new Date(),
        status: 'PENDENTE',
        dentist_id: data.professional_user_id,
        visible_to_dentist: false,
        notes: data.notes,
      } as any,
      include: {
        dentist: { select: { id: true, name: true } },
      },
    });

    await this.logAction(data.actor_id || null, 'DIARIA_LANCADA', tx.id, {
      profissional_id: professional.id,
      profissional: professional.name,
      meia_diaria: !!data.is_half_day,
      valor: amount,
    });

    return tx;
  }

  async updateTransaction(id: string, data: UpdateTransactionDto, tenantId?: string, actorId?: string) {
    await this.verifyTransactionAccess(id, tenantId);

    const updateData: any = {};

    if (data.type !== undefined) updateData.type = data.type;
    if (data.category !== undefined) updateData.category = data.category;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.amount !== undefined) updateData.amount = data.amount;
    if (data.date !== undefined) updateData.date = data.date ? new Date(data.date) : new Date();
    if (data.due_date !== undefined) updateData.due_date = data.due_date ? new Date(data.due_date) : null;
    if (data.paid_at !== undefined) updateData.paid_at = data.paid_at ? new Date(data.paid_at) : null;
    if (data.payment_method !== undefined) updateData.payment_method = data.payment_method;
    if (data.status !== undefined) updateData.status = data.status;
    // STUBBED: legal_case_id/honorario_payment_id removidos Fase 0.2
    if (data.lead_id !== undefined) updateData.lead_id = data.lead_id;
    if (data.dentist_id !== undefined) updateData.dentist_id = data.dentist_id;
    if (data.reference_id !== undefined) updateData.reference_id = data.reference_id;
    if (data.notes !== undefined) updateData.notes = data.notes;

    const updated = await this.prisma.financialTransaction.update({
      where: { id },
      data: updateData,
      include: {
        lead: { select: { id: true, name: true } },
        dentist: { select: { id: true, name: true } },
      },
    });

    // Determinar tipo de ação para log
    const isPago = data.status === 'PAGO';
    const isDespesa = updated.type === 'DESPESA';
    let actionType = isDespesa ? 'DESPESA_EDITADA' : 'RECEITA_EDITADA';
    if (isPago) actionType = isDespesa ? 'DESPESA_PAGA' : 'PAGAMENTO_RECEBIDO';
    await this.logAction(actorId || null, actionType, id, {
      campos: Object.keys(updateData), valor: updated.amount ? Number(updated.amount) : undefined,
      descricao: updated.description, status: updated.status,
      metodo: updated.payment_method, dentist_id: (updated as any).dentist_id,
    });

    return updated;
  }

  /**
   * Recebimento parcial: cria transação PAGO com o valor recebido e reduz o original.
   */
  async partialPayment(id: string, amount: number, paymentMethod?: string, tenantId?: string, actorId?: string) {
    const original = await this.verifyTransactionAccess(id, tenantId);

    if (original.status === 'PAGO') {
      throw new ConflictException('Transação já está paga');
    }
    if (original.status === 'CANCELADO') {
      throw new ConflictException('Transação está cancelada');
    }

    const originalAmount = Number(original.amount);
    if (amount <= 0 || amount > originalAmount) {
      throw new ConflictException(`Valor deve ser entre R$ 0,01 e R$ ${originalAmount.toFixed(2)}`);
    }

    const remaining = Math.round((originalAmount - amount) * 100) / 100;

    // STUBBED: legal_case_id removido Fase 0.2
    // Criar transação do pagamento parcial recebido
    const partialTx = await this.prisma.financialTransaction.create({
      data: {
        tenant_id: original.tenant_id,
        type: original.type,
        category: original.category,
        description: `${original.description} (parcial)`,
        amount: amount,
        date: new Date(),
        due_date: original.due_date,
        paid_at: new Date(),
        payment_method: paymentMethod || original.payment_method,
        status: 'PAGO',
        lead_id: original.lead_id,
        dentist_id: (original as any).dentist_id,
        notes: `Recebimento parcial de R$ ${amount.toFixed(2)}`,
      } as any,
    });

    // Atualizar original: reduzir valor ou marcar como pago se zerou
    if (remaining <= 0) {
      await this.prisma.financialTransaction.update({
        where: { id },
        data: { status: 'PAGO', paid_at: new Date(), amount: 0 },
      });
    } else {
      await this.prisma.financialTransaction.update({
        where: { id },
        data: { amount: remaining },
      });
    }

    await this.logAction(actorId || null, 'PAGAMENTO_PARCIAL', id, {
      valor_recebido: amount, saldo_restante: remaining,
      metodo: paymentMethod, descricao: original.description,
      dentist_id: (original as any).dentist_id,
    });

    return { partial: partialTx, remaining };
  }

  async deleteTransaction(id: string, tenantId?: string, actorId?: string) {
    const tx = await this.verifyTransactionAccess(id, tenantId);

    const actionType = tx.type === 'DESPESA' ? 'DESPESA_EXCLUIDA' : 'RECEITA_EXCLUIDA';
    await this.logAction(actorId || null, actionType, id, {
      descricao: tx.description, valor: Number(tx.amount),
      tipo: tx.type, categoria: tx.category, dentist_id: (tx as any).dentist_id,
    });

    return this.prisma.financialTransaction.update({
      where: { id },
      data: { status: 'CANCELADO' },
    });
  }

  // ─── Create from Honorario Payment ─────────────────────

  async createFromHonorarioPayment(paymentId: string, tenantId?: string) {
    // STUBBED: HonorarioPayment/CaseHonorario/LegalCase removidos Fase 0.2
    // Método preservado apenas para manter compatibilidade de assinatura.
    this.logger.warn(`[STUB] createFromHonorarioPayment chamado com ${paymentId} — no-op Fase 0.2`);
    return null as any;
  }

  async createFromLeadHonorarioPayment(paymentId: string, tenantId?: string) {
    const payment = await this.prisma.leadHonorarioPayment.findUnique({
      where: { id: paymentId },
      include: {
        lead_honorario: {
          include: {
            lead: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!payment) throw new NotFoundException('Pagamento de honorário negociado não encontrado');

    const honorario = (payment as any).lead_honorario;
    const lead = honorario?.lead;
    const status = payment.status === 'PAGO' ? 'PAGO' : 'PENDENTE';

    const typeLabels: Record<string, string> = {
      CONTRATUAL: 'Contratuais', ENTRADA: 'Entrada', ACORDO: 'Acordo',
    };
    const typeLabel = typeLabels[honorario?.type] || honorario?.type || '';

    const existing = await this.prisma.financialTransaction.findUnique({
      where: { lead_honorario_payment_id: paymentId },
    });
    if (existing) {
      return this.prisma.financialTransaction.update({
        where: { id: existing.id },
        data: {
          status,
          amount: payment.amount,
          paid_at: payment.paid_at,
          payment_method: payment.payment_method || existing.payment_method,
          date: payment.paid_at || existing.date,
        },
      });
    }

    return this.prisma.financialTransaction.create({
      data: {
        tenant_id: tenantId || honorario?.tenant_id || null,
        type: 'RECEITA',
        category: 'HONORARIO',
        description: `Honorário ${typeLabel} - Lead ${lead?.name || 'Sem nome'}`.trim(),
        amount: payment.amount,
        date: payment.paid_at || payment.due_date || new Date(),
        paid_at: payment.paid_at,
        due_date: payment.due_date,
        payment_method: payment.payment_method,
        status,
        lead_id: lead?.id || null,
        lead_honorario_payment_id: paymentId,
        notes: honorario?.notes || payment.notes || null,
      },
    });
  }

  // ─── Audit Log ─────────────────────────────────────────

  async getAuditLog(dentistId?: string, startDate?: string, endDate?: string, limit = 50, offset = 0) {
    const where: any = { entity: 'FINANCEIRO' };

    if (startDate || endDate) {
      where.created_at = {};
      if (startDate) where.created_at.gte = new Date(startDate);
      if (endDate) where.created_at.lte = new Date(endDate);
    }

    // Filtrar por dentista via meta_json (PostgreSQL JSONB)
    if (dentistId) {
      where.meta_json = { path: ['dentist_id'], equals: dentistId };
    }

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        include: {
          actor: { select: { id: true, name: true, email: true } },
        },
        orderBy: { created_at: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { data, total };
  }

  // ─── Summary & Analytics ───────────────────────────────

  async getSummary(tenantId?: string, startDate?: string, endDate?: string, dentistId?: string) {
    const where: any = {};
    if (tenantId) where.tenant_id = tenantId;
    // Exclude cancelled from aggregation
    where.status = { not: 'CANCELADO' };

    if (startDate || endDate) {
      where.date = {};
      if (startDate) where.date.gte = new Date(startDate);
      if (endDate) where.date.lte = new Date(endDate);
    }

    // STUBBED: HonorarioPayment/CaseHonorario/LegalCase removidos Fase 0.2
    // honorarioWhere mantido vazio apenas para estrutura

    // Filtros específicos por tipo para dentista
    const receitaWhere = dentistId ? { ...where, dentist_id: dentistId } : where;
    const despesaWhere = dentistId
      ? { ...where, OR: [{ dentist_id: dentistId }, { dentist_id: null, visible_to_dentist: true }] }
      : where;

    // Where para parcelas de lead honorários negociados
    const leadHonWhere: any = {
      status: { in: ['PENDENTE', 'ATRASADO'] },
      lead_honorario: { status: { in: ['NEGOCIANDO', 'ACEITO'] } },
    };
    if (tenantId) {
      leadHonWhere.lead_honorario.tenant_id = tenantId;
    }

    const [totalRevenue, totalExpenses, totalPayable, totalReceivable, totalOverdue, leadReceivable, leadOverdue] = await Promise.all([
      // Receita efetiva (regime de caixa: só PAGO) — dentista só dele
      this.prisma.financialTransaction.aggregate({
        where: { ...receitaWhere, type: 'RECEITA', status: 'PAGO' },
        _sum: { amount: true },
      }),
      // Despesas pagas — dentista vê dele + gerais visíveis
      this.prisma.financialTransaction.aggregate({
        where: { ...despesaWhere, type: 'DESPESA', status: 'PAGO' },
        _sum: { amount: true },
      }),
      // Contas a pagar (despesas PENDENTE)
      this.prisma.financialTransaction.aggregate({
        where: { ...despesaWhere, type: 'DESPESA', status: 'PENDENTE' },
        _sum: { amount: true },
      }),
      // A receber: parcelas de honorários de casos — STUBBED Fase 0.2
      Promise.resolve({ _sum: { amount: null } } as any),
      // Atrasado: STUBBED
      Promise.resolve({ _sum: { amount: null } } as any),
      // A receber: parcelas de honorários negociados (leads)
      this.prisma.leadHonorarioPayment.aggregate({
        where: { ...leadHonWhere, status: { in: ['PENDENTE', 'ATRASADO'] } },
        _sum: { amount: true },
      }),
      // Atrasado: parcelas de leads vencidas
      this.prisma.leadHonorarioPayment.aggregate({
        where: { ...leadHonWhere, status: 'ATRASADO' },
        _sum: { amount: true },
      }),
    ]);

    const revenue = Number(totalRevenue._sum.amount || 0);
    const expenses = Number(totalExpenses._sum.amount || 0);
    const payable = Number(totalPayable._sum.amount || 0);
    const receivable = Number(totalReceivable._sum.amount || 0) + Number(leadReceivable._sum.amount || 0);
    const overdue = Number(totalOverdue._sum.amount || 0) + Number(leadOverdue._sum.amount || 0);

    return {
      totalRevenue: revenue,
      totalExpenses: expenses,
      totalPayable: payable,
      totalReceivable: receivable,
      totalOverdue: overdue,
      balance: revenue - expenses,
    };
  }

  async getCashFlow(
    tenantId?: string,
    startDate?: string,
    endDate?: string,
    groupBy: 'day' | 'week' | 'month' = 'month',
    dentistId?: string,
  ) {
    const where: any = { status: { not: 'CANCELADO' } };
    if (tenantId) where.tenant_id = tenantId;
    if (dentistId) where.dentist_id = dentistId;

    if (startDate || endDate) {
      where.date = {};
      if (startDate) where.date.gte = new Date(startDate);
      if (endDate) where.date.lte = new Date(endDate);
    }

    const transactions = await this.prisma.financialTransaction.findMany({
      where,
      select: {
        type: true,
        amount: true,
        date: true,
        status: true,
      },
      orderBy: { date: 'asc' },
    });

    // Group by period
    const groupedMap = new Map<string, { entries: number; exits: number; balance: number }>();

    for (const tx of transactions) {
      const date = new Date(tx.date);
      let key: string;

      if (groupBy === 'day') {
        key = date.toISOString().slice(0, 10); // YYYY-MM-DD
      } else if (groupBy === 'week') {
        // ISO week start (Monday)
        const day = date.getDay();
        const diff = date.getDate() - day + (day === 0 ? -6 : 1);
        const weekStart = new Date(date);
        weekStart.setDate(diff);
        key = weekStart.toISOString().slice(0, 10);
      } else {
        key = date.toISOString().slice(0, 7); // YYYY-MM
      }

      if (!groupedMap.has(key)) {
        groupedMap.set(key, { entries: 0, exits: 0, balance: 0 });
      }

      const group = groupedMap.get(key)!;
      const amount = Number(tx.amount);

      if (tx.type === 'RECEITA') {
        group.entries += amount;
      } else {
        group.exits += amount;
      }
      group.balance = group.entries - group.exits;
    }

    // Convert to array sorted by period
    const periods = Array.from(groupedMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, values]) => ({
        period,
        entries: Math.round(values.entries * 100) / 100,
        exits: Math.round(values.exits * 100) / 100,
        balance: Math.round(values.balance * 100) / 100,
      }));

    return { periods, groupBy };
  }

  // ─── Categories CRUD ───────────────────────────────────

  async findAllCategories(tenantId?: string) {
    const where: any = { active: true };
    if (tenantId) where.tenant_id = tenantId;

    return this.prisma.financialCategory.findMany({
      where,
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
  }

  async createCategory(data: CreateCategoryDto, tenantId?: string) {
    return this.prisma.financialCategory.create({
      data: {
        tenant_id: tenantId,
        type: data.type,
        name: data.name,
        icon: data.icon,
      },
    });
  }

  async updateCategory(id: string, data: UpdateCategoryDto, tenantId?: string) {
    await this.verifyCategoryAccess(id, tenantId);

    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.icon !== undefined) updateData.icon = data.icon;
    if (data.active !== undefined) updateData.active = data.active;

    return this.prisma.financialCategory.update({
      where: { id },
      data: updateData,
    });
  }

  async deleteCategory(id: string, tenantId?: string) {
    await this.verifyCategoryAccess(id, tenantId);

    return this.prisma.financialCategory.delete({
      where: { id },
    });
  }

  async seedDefaultCategories(tenantId: string) {
    const existing = await this.prisma.financialCategory.count({
      where: { tenant_id: tenantId },
    });

    if (existing > 0) {
      this.logger.log(`Tenant ${tenantId} ja possui ${existing} categorias, pulando seed`);
      return;
    }

    this.logger.log(`Criando categorias padrao para tenant ${tenantId}`);

    await this.prisma.financialCategory.createMany({
      data: DEFAULT_CATEGORIES.map((cat) => ({
        tenant_id: tenantId,
        type: cat.type,
        name: cat.name,
        icon: cat.icon,
        is_default: true,
      })),
    });

    return this.findAllCategories(tenantId);
  }
}
