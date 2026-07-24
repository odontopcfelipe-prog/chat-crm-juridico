import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
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
  PIX_MAQUININHA: 'pix', // venda rápida manda esse valor (PIX na maquininha)
  MAQUININHA: 'card',
  TRANSFERENCIA: 'transfer',
  BOLETO: undefined, // gateway/online — não entra na conferência física
};

const OPEN_STATES = ['ABERTO', 'DEVOLVIDO']; // dia editável (lançar / re-fechar)
const CLOSEABLE = ['ABERTO', 'FECHADO', 'DEVOLVIDO']; // pode virar FECHADO (nunca VALIDADO)
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

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
  private windowFor(cashDate: Date) {
    const startUTC = new Date(cashDate.getTime() + 3 * 60 * 60 * 1000); // 00:00 local = 03:00 UTC
    const endUTC = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000);
    return { startUTC, endUTC };
  }
  private dayWindow(d: Date = new Date()) {
    const maceio = new Date(d.getTime() - 3 * 60 * 60 * 1000);
    const ymd = maceio.toISOString().slice(0, 10); // YYYY-MM-DD local
    const cashDate = new Date(ymd + 'T00:00:00.000Z');
    return { ymd, cashDate, ...this.windowFor(cashDate) };
  }

  // Escopo do que É caixa: movimento manual (account_id), recebimento de cobrança
  // (gateway_charge) ou já vinculado a um fechamento (cash_closing_id). Exclui
  // despesa/receita avulsa do financeiro (aluguel, diária, comissão) — que NÃO é
  // conferência de caixa.
  private caixaWhere(tenantId: string, startUTC: Date, endUTC: Date) {
    return {
      tenant_id: tenantId,
      status: 'PAGO',
      date: { gte: startUTC, lt: endUTC },
      OR: [
        { account_id: { not: null } },
        { cash_closing_id: { not: null } },
        { gateway_charge: { isNot: null } },
      ],
    } as any;
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
    const key = { tenant_id_cash_date: { tenant_id: tenantId, cash_date: cashDate } };
    const existing = await this.prisma.cashClosing.findUnique({ where: key });
    if (existing) return existing;
    try {
      return await this.prisma.cashClosing.create({
        data: { tenant_id: tenantId, cash_date: cashDate, status: 'ABERTO', opened_by_id: userId },
      });
    } catch (e: any) {
      // Corrida: outro request criou o dia primeiro (viola @@unique). Refaz o find.
      if (e?.code === 'P2002') {
        const again = await this.prisma.cashClosing.findUnique({ where: key });
        if (again) return again;
      }
      throw e;
    }
  }

  // Balde por ONDE o dinheiro entrou (não pela origem da venda). Recebimento com
  // gateway_charge e SEM received_in_cash = online (balde gateway, fora da gaveta);
  // received_in_cash (dá baixa/venda rápida) e manual = balde físico da forma.
  private summarize(
    txns: Array<{ amount: any; type: string; payment_method: string | null; gateway_charge?: { received_in_cash: boolean } | null }>,
  ) {
    const by = { cash: 0, card: 0, pix: 0, transfer: 0, gateway: 0 };
    let entradas = 0, saidas = 0;
    for (const t of txns) {
      const amt = Number(t.amount) || 0;
      const signed = t.type === 'DESPESA' ? -amt : amt;
      if (t.type === 'DESPESA') saidas += amt; else entradas += amt;
      const online = !!t.gateway_charge && !t.gateway_charge.received_in_cash;
      const bucket = online ? undefined : METHOD_BUCKET[t.payment_method || ''];
      if (bucket) by[bucket] += signed;
      else by.gateway += signed;
    }
    (Object.keys(by) as Array<keyof typeof by>).forEach((k) => { by[k] = r2(by[k]); });
    return { by, entradas: r2(entradas), saidas: r2(saidas), saldo: r2(entradas - saidas) };
  }

  private movementInclude = {
    account: { select: { id: true, name: true, kind: true } },
    lead: { select: { id: true, name: true, profile_picture_url: true } },
    gateway_charge: { select: { received_in_cash: true } },
  };

  private dayMovements(tenantId: string, startUTC: Date, endUTC: Date) {
    return this.prisma.financialTransaction.findMany({
      where: this.caixaWhere(tenantId, startUTC, endUTC),
      orderBy: { date: 'desc' },
      include: this.movementInclude,
    });
  }

  async getToday(tenantId: string, userId: string) {
    await this.ensureDefaultAccounts(tenantId);
    const { cashDate, startUTC, endUTC } = this.dayWindow();
    const [closing, accounts, movements] = await Promise.all([
      this.prisma.cashClosing.findUnique({
        where: { tenant_id_cash_date: { tenant_id: tenantId, cash_date: cashDate } },
        include: this.closingInclude,
      }),
      this.listAccounts(tenantId),
      this.dayMovements(tenantId, startUTC, endUTC),
    ]);
    const totals = this.summarize(movements as any);
    return { cash_date: cashDate, closing, accounts, movements, totals };
  }

  async addMovement(tenantId: string, userId: string, dto: AddMovementDto) {
    if (!(dto.amount > 0)) throw new BadRequestException('Valor deve ser maior que zero.');
    const acc = await this.prisma.cashAccount.findUnique({ where: { id: dto.account_id } });
    if (!acc || acc.tenant_id !== tenantId) throw new NotFoundException('Conta nao encontrada');
    // Anti-IDOR: lead informado tem que ser do próprio tenant (senão ignora).
    let leadId: string | null = null;
    if (dto.lead_id) {
      const lead = await this.prisma.lead.findFirst({ where: { id: dto.lead_id, tenant_id: tenantId }, select: { id: true } });
      if (!lead) throw new BadRequestException('Paciente/lead invalido.');
      leadId = lead.id;
    }
    const closing = await this.ensureTodayClosing(tenantId, userId);
    if (!OPEN_STATES.includes(closing.status)) {
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
        amount: r2(dto.amount),
        date: new Date(),
        paid_at: new Date(),
        payment_method: dto.method,
        status: 'PAGO',
        account_id: dto.account_id,
        cash_closing_id: closing.id,
        lead_id: leadId,
      } as any,
    });
    await this.logAction(userId, dto.direction === 'SAIDA' ? 'CAIXA_SAIDA' : 'CAIXA_ENTRADA', tx.id, {
      valor: r2(dto.amount), forma: dto.method, conta: acc.name,
    });
    return tx;
  }

  // Só remove lançamento MANUAL do caixa (tem account_id, sem cobrança), enquanto
  // o dia está aberto/devolvido. Recebimento de cobrança (gateway_charge/reference_id)
  // NUNCA é removível aqui (apagá-lo quebraria a idempotência do Asaas — SetNull).
  async deleteMovement(id: string, tenantId: string, userId: string) {
    const tx = await this.prisma.financialTransaction.findUnique({
      where: { id },
      include: { cash_closing: true, gateway_charge: { select: { id: true } } },
    });
    if (!tx || tx.tenant_id !== tenantId || !tx.cash_closing_id) throw new NotFoundException('Lancamento nao encontrado');
    if (tx.gateway_charge || tx.reference_id) {
      throw new BadRequestException('Esse recebimento veio de cobranca/Asaas — nao da pra remover pelo caixa.');
    }
    if (tx.cash_closing && !OPEN_STATES.includes(tx.cash_closing.status)) {
      throw new BadRequestException('Caixa ja fechado — nao da pra remover lancamento.');
    }
    await this.prisma.financialTransaction.delete({ where: { id } });
    await this.logAction(userId, 'CAIXA_LANCAMENTO_REMOVIDO', id, { valor: Number(tx.amount) });
    return { ok: true };
  }

  // Fecha um caixa. Sem closingId = o de hoje. Com closingId = aquele dia
  // específico (permite re-fechar um dia DEVOLVIDO/esquecido). Transição atômica:
  // só fecha se o status ainda for fechável (nunca rebaixa um VALIDADO).
  async closeDay(tenantId: string, userId: string, dto: CloseDayDto) {
    let closing;
    if (dto.closing_id) {
      closing = await this.prisma.cashClosing.findUnique({ where: { id: dto.closing_id } });
      if (!closing || closing.tenant_id !== tenantId) throw new NotFoundException('Fechamento nao encontrado');
    } else {
      closing = await this.ensureTodayClosing(tenantId, userId);
    }
    if (closing.status === 'VALIDADO') throw new BadRequestException('Dia ja validado — nao da pra fechar de novo.');
    const { startUTC, endUTC } = this.windowFor(closing.cash_date);
    const movements = await this.prisma.financialTransaction.findMany({
      where: this.caixaWhere(tenantId, startUTC, endUTC),
      select: { id: true, amount: true, type: true, payment_method: true, gateway_charge: { select: { received_in_cash: true } } },
    });
    const { by } = this.summarize(movements as any);

    const ok = await this.prisma.$transaction(async (txp) => {
      const upd = await txp.cashClosing.updateMany({
        where: { id: closing.id, status: { in: CLOSEABLE } },
        data: {
          status: 'FECHADO',
          closed_by_id: userId,
          closed_at: new Date(),
          expected_cash: by.cash, expected_card: by.card, expected_pix: by.pix, expected_transfer: by.transfer,
          counted_cash: dto.counted_cash ?? null, counted_card: dto.counted_card ?? null,
          counted_pix: dto.counted_pix ?? null, counted_transfer: dto.counted_transfer ?? null,
          closing_notes: dto.closing_notes ?? null,
        },
      });
      if (upd.count === 0) return false;
      await txp.financialTransaction.updateMany({
        where: this.caixaWhere(tenantId, startUTC, endUTC),
        data: { cash_closing_id: closing.id },
      });
      return true;
    });
    if (!ok) throw new ConflictException('O caixa mudou de estado — recarregue a tela.');
    await this.logAction(userId, 'CAIXA_FECHADO', closing.id, { esperado: by, contado: dto });
    return this.getClosing(closing.id, tenantId);
  }

  // ─── Fechamentos (admin valida) ────────────────────────────────
  // Etapa 1 — "o caixa nao apaga": garante que TODO dia com dinheiro no caixa
  // (manual OU recebimento do sistema — venda rapida/Asaas/boleto/pix/parcelado)
  // tenha um CashClosing, mesmo que ninguem tenha aberto manualmente. Assim
  // nenhum dia com movimento some do historico. Idempotente e limitado a N dias.
  async ensureClosingsForRecentDays(tenantId: string, days = 120) {
    const now = new Date();
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const txns = await this.prisma.financialTransaction.findMany({
      where: this.caixaWhere(tenantId, since, new Date(now.getTime() + 60 * 1000)),
      select: { date: true },
    });
    // dias (Maceio) distintos que tem dinheiro
    const dias = new Set<string>();
    for (const t of txns) {
      const maceio = new Date(new Date(t.date).getTime() - 3 * 60 * 60 * 1000);
      dias.add(maceio.toISOString().slice(0, 10));
    }
    if (dias.size === 0) return;
    const cashDates = [...dias].map((d) => new Date(d + 'T00:00:00.000Z'));
    const existentes = await this.prisma.cashClosing.findMany({
      where: { tenant_id: tenantId, cash_date: { in: cashDates } },
      select: { cash_date: true },
    });
    const tem = new Set(existentes.map((c) => c.cash_date.toISOString().slice(0, 10)));
    for (const d of dias) {
      if (tem.has(d)) continue;
      await this.prisma.cashClosing
        .create({ data: { tenant_id: tenantId, cash_date: new Date(d + 'T00:00:00.000Z'), status: 'ABERTO' } })
        .catch(() => undefined); // corrida (@@unique) — segue
    }
  }

  async listClosings(tenantId: string, status?: string) {
    await this.ensureClosingsForRecentDays(tenantId);
    const closings = await this.prisma.cashClosing.findMany({
      where: { tenant_id: tenantId, ...(status ? { status } : {}) },
      orderBy: { cash_date: 'desc' },
      take: 120,
      include: this.closingInclude,
    });
    if (closings.length === 0) return closings;
    // Totais por dia numa query so (janela do mais antigo ao mais novo), agrupado
    // em Node pelo dia de Maceio — pra cada linha do historico mostrar o valor.
    const startUTC = this.windowFor(closings[closings.length - 1].cash_date).startUTC;
    const endUTC = this.windowFor(closings[0].cash_date).endUTC;
    const txns = await this.prisma.financialTransaction.findMany({
      where: this.caixaWhere(tenantId, startUTC, endUTC),
      select: { amount: true, type: true, payment_method: true, date: true, gateway_charge: { select: { received_in_cash: true } } },
    });
    const byDay = new Map<string, any[]>();
    for (const t of txns) {
      const key = new Date(new Date(t.date).getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(t);
    }
    return closings.map((c) => ({
      ...c,
      totals: this.summarize(byDay.get(c.cash_date.toISOString().slice(0, 10)) || []),
    }));
  }

  // Detalhe: recalcula o ESPERADO ao vivo a partir dos movimentos reais do dia
  // (mesma janela), então o esperado sempre bate com a lista mostrada — resolve o
  // TOCTOU (lançamento tardio) e o recebimento físico que chegou depois do fechar.
  async getClosing(id: string, tenantId: string) {
    const c = await this.prisma.cashClosing.findUnique({ where: { id }, include: this.closingInclude });
    if (!c || c.tenant_id !== tenantId) throw new NotFoundException('Fechamento nao encontrado');
    const { startUTC, endUTC } = this.windowFor(c.cash_date);
    const movements = await this.dayMovements(tenantId, startUTC, endUTC);
    const s = this.summarize(movements as any);
    return {
      ...c,
      // esperado ao vivo (o gravado fica como snapshot histórico interno)
      expected_cash: s.by.cash, expected_card: s.by.card, expected_pix: s.by.pix, expected_transfer: s.by.transfer,
      // Etapa 2 — dia COMPLETO: recebido online (boleto/Asaas, concilia com extrato,
      // fora da conferência física) + o total do dia inteiro.
      online_total: s.by.gateway,
      day_entradas: s.entradas, day_saidas: s.saidas, day_saldo: s.saldo,
      transactions: movements,
    };
  }

  async validateDay(id: string, tenantId: string, userId: string, dto: ValidateDayDto) {
    const upd = await this.prisma.cashClosing.updateMany({
      where: { id, tenant_id: tenantId, status: 'FECHADO' },
      data: { status: 'VALIDADO', validated_by_id: userId, validated_at: new Date(), validation_notes: dto.validation_notes ?? null },
    });
    if (upd.count === 0) throw new BadRequestException('So da pra validar um caixa FECHADO (e ainda nao validado).');
    await this.logAction(userId, 'CAIXA_VALIDADO', id, { obs: dto.validation_notes });
    return this.getClosing(id, tenantId);
  }

  // Admin devolve pra recepção corrigir: FECHADO -> DEVOLVIDO (estado próprio,
  // distinto de "nunca fechado"). Recepção corrige e re-fecha (closeDay by id).
  async returnDay(id: string, tenantId: string, userId: string, dto: ValidateDayDto) {
    const current = await this.prisma.cashClosing.findUnique({ where: { id } });
    if (!current || current.tenant_id !== tenantId) throw new NotFoundException('Fechamento nao encontrado');
    const upd = await this.prisma.cashClosing.updateMany({
      where: { id, tenant_id: tenantId, status: 'FECHADO' },
      data: { status: 'DEVOLVIDO', validation_notes: dto.validation_notes ?? current.validation_notes },
    });
    if (upd.count === 0) throw new BadRequestException('So da pra devolver um caixa FECHADO.');
    await this.logAction(userId, 'CAIXA_DEVOLVIDO', id, { obs: dto.validation_notes });
    return this.getClosing(id, tenantId);
  }
}
