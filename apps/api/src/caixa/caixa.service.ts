import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateAccountDto,
  UpdateAccountDto,
  AddMovementDto,
  CloseDayDto,
  ValidateDayDto,
} from './caixa.dto';

// Contas padrão semeadas no 1º acesso (o dono renomeia depois).
const DEFAULT_ACCOUNTS = [
  { name: 'Caixa (dinheiro)', kind: 'CAIXA', is_gateway: false, sort_order: 0 },
  { name: 'PIX — Banco', kind: 'BANCO', is_gateway: true, sort_order: 1 },
  { name: 'Maquininha (cartão)', kind: 'CARTAO', is_gateway: false, sort_order: 2 },
];

// Forma de pagamento -> balde de conferência física do fechamento.
const METHOD_BUCKET: Record<string, 'cash' | 'card' | 'pix' | 'transfer' | undefined> = {
  DINHEIRO: 'cash',
  CARTAO: 'card',
  PIX: 'pix',
  TRANSFERENCIA: 'transfer',
  BOLETO: undefined, // gateway/online — não entra na conferência física
};

@Injectable()
export class CaixaService {
  private readonly logger = new Logger(CaixaService.name);
  private readonly closingInclude = {
    opened_by: { select: { id: true, name: true } },
    closed_by: { select: { id: true, name: true } },
    validated_by: { select: { id: true, name: true } },
  };

  constructor(private prisma: PrismaService) {}

  // ─── Fuso America/Maceio (UTC-3, sem horário de verão) ──────────
  // Mesmo padrão da agenda: "hoje" = agora - 3h. cash_date é a chave naive
  // (meia-noite do dia local); a janela [startUTC, endUTC) é o dia real em UTC
  // pra casar com FinancialTransaction.date (que é UTC real).
  private dayWindow(d: Date = new Date()) {
    const maceio = new Date(d.getTime() - 3 * 60 * 60 * 1000);
    const ymd = maceio.toISOString().slice(0, 10); // YYYY-MM-DD local
    const cashDate = new Date(ymd + 'T00:00:00.000Z');
    const startUTC = new Date(cashDate.getTime() + 3 * 60 * 60 * 1000); // 00:00 local = 03:00 UTC
    const endUTC = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000);
    return { ymd, cashDate, startUTC, endUTC };
  }

  private async logAction(userId: string | null, action: string, entityId: string, meta: Record<string, any>) {
    try {
      await this.prisma.auditLog.create({
        data: { actor_user_id: userId, action, entity: 'CAIXA', entity_id: entityId, meta_json: meta },
      });
    } catch (e: any) {
      this.logger.warn(`[AUDIT] ${e.message}`);
    }
  }

  // ─── Contas ────────────────────────────────────────────────────
  async ensureDefaultAccounts(tenantId: string) {
    const n = await this.prisma.cashAccount.count({ where: { tenant_id: tenantId } });
    if (n > 0) return;
    for (const a of DEFAULT_ACCOUNTS) {
      await this.prisma.cashAccount
        .create({ data: { tenant_id: tenantId, ...a } })
        .catch(() => undefined);
    }
  }

  async listAccounts(tenantId: string) {
    await this.ensureDefaultAccounts(tenantId);
    return this.prisma.cashAccount.findMany({
      where: { tenant_id: tenantId },
      orderBy: [{ active: 'desc' }, { sort_order: 'asc' }, { created_at: 'asc' }],
    });
  }

  async createAccount(tenantId: string, dto: CreateAccountDto) {
    if (dto.is_gateway) {
      await this.prisma.cashAccount.updateMany({ where: { tenant_id: tenantId, is_gateway: true }, data: { is_gateway: false } });
    }
    return this.prisma.cashAccount.create({
      data: { tenant_id: tenantId, name: dto.name, kind: dto.kind, is_gateway: dto.is_gateway ?? false, sort_order: dto.sort_order ?? 99 },
    });
  }

  async updateAccount(id: string, tenantId: string, dto: UpdateAccountDto) {
    const acc = await this.prisma.cashAccount.findUnique({ where: { id } });
    if (!acc || acc.tenant_id !== tenantId) throw new NotFoundException('Conta nao encontrada');
    // Máx 1 conta gateway por clínica: ao marcar, desmarca as outras.
    if (dto.is_gateway === true) {
      await this.prisma.cashAccount.updateMany({ where: { tenant_id: tenantId, is_gateway: true, id: { not: id } }, data: { is_gateway: false } });
    }
    const data: any = {};
    for (const k of ['name', 'kind', 'active', 'is_gateway', 'sort_order'] as const) {
      if (dto[k] !== undefined) data[k] = dto[k];
    }
    return this.prisma.cashAccount.update({ where: { id }, data });
  }

  // ─── Caixa do dia ──────────────────────────────────────────────
  async ensureTodayClosing(tenantId: string, userId: string) {
    const { cashDate } = this.dayWindow();
    const existing = await this.prisma.cashClosing.findUnique({
      where: { tenant_id_cash_date: { tenant_id: tenantId, cash_date: cashDate } },
    });
    if (existing) return existing;
    return this.prisma.cashClosing.create({
      data: { tenant_id: tenantId, cash_date: cashDate, status: 'ABERTO', opened_by_id: userId },
    });
  }

  // Soma por balde. Lançamento vindo do gateway (reference_id do Asaas) NÃO entra
  // na conferência física — vai pro balde "gateway" (informativo). Saída (DESPESA)
  // subtrai. Assim o esperado de dinheiro/cartão/pix/transf. reflete só o que a
  // recepção recebeu na mão.
  private summarize(txns: Array<{ amount: any; type: string; payment_method: string | null; reference_id: string | null }>) {
    const by = { cash: 0, card: 0, pix: 0, transfer: 0, gateway: 0 };
    let entradas = 0, saidas = 0;
    for (const t of txns) {
      const amt = Number(t.amount) || 0;
      const signed = t.type === 'DESPESA' ? -amt : amt;
      if (t.type === 'DESPESA') saidas += amt; else entradas += amt;
      const bucket = t.reference_id ? undefined : METHOD_BUCKET[t.payment_method || ''];
      if (bucket) by[bucket] += signed;
      else by.gateway += signed;
    }
    return { by, entradas, saidas, saldo: entradas - saidas };
  }

  private dayMovements(tenantId: string) {
    const { startUTC, endUTC } = this.dayWindow();
    return this.prisma.financialTransaction.findMany({
      where: { tenant_id: tenantId, status: 'PAGO', date: { gte: startUTC, lt: endUTC } },
      orderBy: { date: 'desc' },
      include: {
        account: { select: { id: true, name: true, kind: true } },
        lead: { select: { id: true, name: true } },
      },
    });
  }

  async getToday(tenantId: string, _userId: string) {
    await this.ensureDefaultAccounts(tenantId);
    const { cashDate } = this.dayWindow();
    const [closing, accounts, movements] = await Promise.all([
      this.prisma.cashClosing.findUnique({
        where: { tenant_id_cash_date: { tenant_id: tenantId, cash_date: cashDate } },
        include: this.closingInclude,
      }),
      this.listAccounts(tenantId),
      this.dayMovements(tenantId),
    ]);
    const totals = this.summarize(movements as any);
    return { cash_date: cashDate, closing, accounts, movements, totals };
  }

  async addMovement(tenantId: string, userId: string, dto: AddMovementDto) {
    const acc = await this.prisma.cashAccount.findUnique({ where: { id: dto.account_id } });
    if (!acc || acc.tenant_id !== tenantId) throw new NotFoundException('Conta nao encontrada');
    const closing = await this.ensureTodayClosing(tenantId, userId);
    if (closing.status !== 'ABERTO') {
      throw new BadRequestException('O caixa do dia ja foi fechado. Peca ao admin pra devolver antes de lancar.');
    }
    const type = dto.direction === 'SAIDA' ? 'DESPESA' : 'RECEITA';
    const category = dto.category || (type === 'DESPESA' ? 'Outros' : 'Procedimento');
    const tx = await this.prisma.financialTransaction.create({
      data: {
        tenant_id: tenantId,
        type,
        category,
        description: dto.description || (type === 'DESPESA' ? 'Saida de caixa' : 'Entrada de caixa'),
        amount: dto.amount,
        date: new Date(),
        paid_at: new Date(),
        payment_method: dto.method,
        status: 'PAGO',
        account_id: dto.account_id,
        cash_closing_id: closing.id,
        lead_id: dto.lead_id ?? null,
      } as any,
    });
    await this.logAction(userId, dto.direction === 'SAIDA' ? 'CAIXA_SAIDA' : 'CAIXA_ENTRADA', tx.id, {
      valor: dto.amount, forma: dto.method, conta: acc.name,
    });
    return tx;
  }

  // Remove um lançamento manual do caixa (só enquanto ABERTO; só entradas/saídas
  // criadas aqui — que têm cash_closing_id. Recebido do Asaas não é removível).
  async deleteMovement(id: string, tenantId: string, userId: string) {
    const tx = await this.prisma.financialTransaction.findUnique({ where: { id }, include: { cash_closing: true } });
    if (!tx || tx.tenant_id !== tenantId || !tx.cash_closing_id) throw new NotFoundException('Lancamento nao encontrado');
    if (tx.cash_closing && tx.cash_closing.status !== 'ABERTO') {
      throw new BadRequestException('Caixa ja fechado — nao da pra remover lancamento.');
    }
    await this.prisma.financialTransaction.delete({ where: { id } });
    await this.logAction(userId, 'CAIXA_LANCAMENTO_REMOVIDO', id, { valor: Number(tx.amount) });
    return { ok: true };
  }

  async closeDay(tenantId: string, userId: string, dto: CloseDayDto) {
    const closing = await this.ensureTodayClosing(tenantId, userId);
    if (closing.status === 'VALIDADO') throw new BadRequestException('Dia ja validado — nao da pra fechar de novo.');
    const { startUTC, endUTC } = this.dayWindow();
    const movements = await this.prisma.financialTransaction.findMany({
      where: { tenant_id: tenantId, status: 'PAGO', date: { gte: startUTC, lt: endUTC } },
      select: { id: true, amount: true, type: true, payment_method: true, reference_id: true },
    });
    const { by } = this.summarize(movements as any);
    await this.prisma.$transaction([
      this.prisma.financialTransaction.updateMany({
        where: { id: { in: movements.map((m) => m.id) } },
        data: { cash_closing_id: closing.id },
      }),
      this.prisma.cashClosing.update({
        where: { id: closing.id },
        data: {
          status: 'FECHADO',
          closed_by_id: userId,
          closed_at: new Date(),
          expected_cash: by.cash, expected_card: by.card, expected_pix: by.pix, expected_transfer: by.transfer,
          counted_cash: dto.counted_cash ?? null, counted_card: dto.counted_card ?? null,
          counted_pix: dto.counted_pix ?? null, counted_transfer: dto.counted_transfer ?? null,
          closing_notes: dto.closing_notes ?? null,
        },
      }),
    ]);
    await this.logAction(userId, 'CAIXA_FECHADO', closing.id, { esperado: by, contado: dto });
    return this.getClosing(closing.id, tenantId);
  }

  // ─── Fechamentos (admin valida) ────────────────────────────────
  async listClosings(tenantId: string, status?: string) {
    return this.prisma.cashClosing.findMany({
      where: { tenant_id: tenantId, ...(status ? { status } : {}) },
      orderBy: { cash_date: 'desc' },
      take: 60,
      include: this.closingInclude,
    });
  }

  async getClosing(id: string, tenantId: string) {
    const c = await this.prisma.cashClosing.findUnique({
      where: { id },
      include: {
        ...this.closingInclude,
        transactions: {
          orderBy: { date: 'desc' },
          include: { account: { select: { id: true, name: true, kind: true } }, lead: { select: { id: true, name: true } } },
        },
      },
    });
    if (!c || c.tenant_id !== tenantId) throw new NotFoundException('Fechamento nao encontrado');
    return c;
  }

  async validateDay(id: string, tenantId: string, userId: string, dto: ValidateDayDto) {
    const c = await this.prisma.cashClosing.findUnique({ where: { id } });
    if (!c || c.tenant_id !== tenantId) throw new NotFoundException('Fechamento nao encontrado');
    if (c.status === 'ABERTO') throw new BadRequestException('Feche o caixa antes de validar.');
    await this.prisma.cashClosing.update({
      where: { id },
      data: { status: 'VALIDADO', validated_by_id: userId, validated_at: new Date(), validation_notes: dto.validation_notes ?? null },
    });
    await this.logAction(userId, 'CAIXA_VALIDADO', id, { obs: dto.validation_notes });
    return this.getClosing(id, tenantId);
  }

  // Admin devolve pra recepção corrigir: reabre o dia (ABERTO) mantendo o motivo.
  async returnDay(id: string, tenantId: string, userId: string, dto: ValidateDayDto) {
    const c = await this.prisma.cashClosing.findUnique({ where: { id } });
    if (!c || c.tenant_id !== tenantId) throw new NotFoundException('Fechamento nao encontrado');
    if (c.status === 'VALIDADO') throw new BadRequestException('Dia ja validado — nao da pra devolver.');
    await this.prisma.cashClosing.update({
      where: { id },
      data: { status: 'ABERTO', closed_at: null, closed_by_id: null, validation_notes: dto.validation_notes ?? c.validation_notes },
    });
    await this.logAction(userId, 'CAIXA_DEVOLVIDO', id, { obs: dto.validation_notes });
    return this.getClosing(id, tenantId);
  }
}
