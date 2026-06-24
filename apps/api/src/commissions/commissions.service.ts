import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@crm/shared';
import {
  CreateCommissionDto, PayCommissionDto, UpdateCommissionDto,
} from './dto/commission.dto';

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ─── Faixas (trilha) — Onda 17.62 Fase 2b ────────────────────────────────────
type FaixaTier = { nome: string; emoji: string; ate: number | null; percentual: number };
type TiersConfig = { enabled: boolean; tiers: FaixaTier[] };

// Faixas SUGERIDAS (exemplo editável). enabled=false → a trilha é só PREVIEW e NÃO muda o
// pagamento; a clínica revisa os números e ativa depois (front+regra na mesma fonte).
const DEFAULT_TIERS: TiersConfig = {
  enabled: false,
  tiers: [
    { nome: 'Bronze', emoji: '🥉', ate: 4000, percentual: 6 },
    { nome: 'Prata', emoji: '🥈', ate: 9000, percentual: 8 },
    { nome: 'Ouro', emoji: '🥇', ate: 15000, percentual: 10 },
    { nome: 'Diamante', emoji: '💎', ate: null, percentual: 12 },
  ],
};

/** Monta a trilha (done/cur/locked) a partir das faixas + produção do mês do profissional. */
function buildTrilha(tiers: FaixaTier[], producao: number) {
  const intl = (n: number) => n.toLocaleString('pt-BR');
  let curIdx = tiers.findIndex((t) => t.ate == null || producao <= t.ate);
  if (curIdx < 0) curIdx = Math.max(0, tiers.length - 1);
  let lo = 0;
  return tiers.map((t, i) => {
    const faixaInfo = t.ate == null ? `R$ ${intl(lo)}+ /mês` : `R$ ${intl(lo)}–${intl(t.ate)} /mês`;
    if (t.ate != null) lo = t.ate;
    return {
      nome: t.nome,
      emoji: t.emoji ?? '',
      percentual: t.percentual,
      estado: i < curIdx ? 'done' : i === curIdx ? 'cur' : 'locked',
      faixaInfo,
    };
  });
}

@Injectable()
export class CommissionsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Cria comissao manualmente. Em fluxo automatico, isso seria chamado
   * pelo handler de execucao de TreatmentPlanItem.
   */
  async create(tenantId: string, dto: CreateCommissionDto) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente');

    const patient = await this.prisma.patient.findFirst({
      where: { id: dto.patient_id, tenant_id: tenantId },
    });
    if (!patient) throw new NotFoundException('Paciente nao encontrado');

    // Calcula amount se nao informado
    let amount = dto.amount;
    if (amount === undefined) {
      if (dto.percentage) amount = (dto.base_value * dto.percentage) / 100;
      else if (dto.fixed_value) amount = dto.fixed_value;
      else throw new BadRequestException('Informe amount, percentage ou fixed_value');
    }

    return this.prisma.commission.create({
      data: {
        tenant_id: tenantId,
        professional_user_id: dto.professional_user_id,
        patient_id: dto.patient_id,
        procedure_id: dto.procedure_id,
        treatment_plan_item_id: dto.treatment_plan_item_id,
        quote_id: dto.quote_id,
        base_value: new Prisma.Decimal(dto.base_value),
        percentage: dto.percentage ? new Prisma.Decimal(dto.percentage) : undefined,
        fixed_value: dto.fixed_value ? new Prisma.Decimal(dto.fixed_value) : undefined,
        amount: new Prisma.Decimal(amount),
        reference_month: dto.reference_month || monthKey(new Date()),
        notes: dto.notes,
      },
    });
  }

  async findAll(
    tenantId: string,
    opts: {
      professional_user_id?: string;
      patient_id?: string;
      status?: string;
      reference_month?: string;
      from?: string;
      to?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const page = Math.max(1, opts.page || 1);
    const limit = Math.min(200, Math.max(1, opts.limit || 50));
    const skip = (page - 1) * limit;

    const where: Prisma.CommissionWhereInput = {
      tenant_id: tenantId,
      ...(opts.professional_user_id ? { professional_user_id: opts.professional_user_id } : {}),
      ...(opts.patient_id ? { patient_id: opts.patient_id } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.reference_month ? { reference_month: opts.reference_month } : {}),
      ...(opts.from || opts.to
        ? {
            created_at: {
              ...(opts.from ? { gte: new Date(opts.from) } : {}),
              ...(opts.to ? { lte: new Date(opts.to) } : {}),
            },
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.commission.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        include: {
          professional: { select: { id: true, name: true } },
          patient: { select: { id: true, name: true } },
          procedure: { select: { id: true, name: true, category: true } },
        },
      }),
      this.prisma.commission.count({ where }),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  async findOne(tenantId: string, id: string) {
    const commission = await this.prisma.commission.findFirst({
      where: { id, tenant_id: tenantId },
      include: {
        professional: { select: { id: true, name: true, email: true } },
        patient: { select: { id: true, name: true, phone: true } },
        procedure: true,
        quote: { select: { id: true, total_value: true, status: true } },
        treatment_plan_item: { select: { id: true, executed_at: true, executed_by_user_id: true } },
      },
    });
    if (!commission) throw new NotFoundException('Comissao nao encontrada');
    return commission;
  }

  async update(tenantId: string, id: string, dto: UpdateCommissionDto) {
    await this.findOne(tenantId, id);
    return this.prisma.commission.update({
      where: { id },
      data: { status: dto.status, notes: dto.notes },
    });
  }

  /** Marca DEVIDA -> DISPONIVEL (paciente pagou). */
  async release(tenantId: string, id: string) {
    const c = await this.findOne(tenantId, id);
    if (c.status !== 'DEVIDA') {
      throw new BadRequestException(`Comissao esta ${c.status}, so pode liberar de DEVIDA`);
    }
    return this.prisma.commission.update({
      where: { id },
      data: { status: 'DISPONIVEL', available_at: new Date() },
    });
  }

  /** Marca DISPONIVEL -> PAGA (clinica liquidou com profissional). */
  async pay(tenantId: string, id: string, dto: PayCommissionDto) {
    const c = await this.findOne(tenantId, id);
    if (c.status !== 'DISPONIVEL') {
      throw new BadRequestException(`Comissao esta ${c.status}, so pode pagar de DISPONIVEL`);
    }
    return this.prisma.commission.update({
      where: { id },
      data: {
        status: 'PAGA',
        paid_at: dto.paid_at ? new Date(dto.paid_at) : new Date(),
        payment_method: dto.payment_method,
        notes: dto.notes,
      },
    });
  }

  /**
   * Resumo agrupado por profissional × reference_month, com totais por status.
   * Usado no relatorio "Comissoes a pagar".
   */
  async summary(tenantId: string, opts: { reference_month?: string } = {}) {
    const where: Prisma.CommissionWhereInput = { tenant_id: tenantId };
    if (opts.reference_month) where.reference_month = opts.reference_month;

    const commissions = await this.prisma.commission.findMany({
      where,
      select: {
        professional_user_id: true,
        professional: { select: { name: true } },
        reference_month: true,
        status: true,
        amount: true,
      },
    });

    type Row = {
      professional_user_id: string;
      professional_name: string;
      reference_month: string;
      devida: number;
      disponivel: number;
      paga: number;
      total: number;
    };
    const byKey = new Map<string, Row>();

    for (const c of commissions) {
      const key = `${c.professional_user_id}|${c.reference_month || ''}`;
      const existing = byKey.get(key) || {
        professional_user_id: c.professional_user_id,
        professional_name: c.professional?.name || 'Sem nome',
        reference_month: c.reference_month || '—',
        devida: 0,
        disponivel: 0,
        paga: 0,
        total: 0,
      };
      const amt = Number(c.amount);
      existing.total += amt;
      if (c.status === 'DEVIDA') existing.devida += amt;
      else if (c.status === 'DISPONIVEL') existing.disponivel += amt;
      else if (c.status === 'PAGA') existing.paga += amt;
      byKey.set(key, existing);
    }

    // Onda 17.61 — inclui TODOS os profissionais com regra de comissão ATIVA, mesmo sem
    // comissão no período (zerados). Assim o "Resumo mensal" mostra a lista completa
    // "por profissional cadastrado", não só quem já gerou comissão.
    const fillMonth = opts.reference_month || monthKey(new Date());
    const ruleProfs = await this.prisma.commissionRule.findMany({
      where: { tenant_id: tenantId, active: true },
      select: { professional_user_id: true, professional: { select: { name: true } } },
    });
    const seenProf = new Set<string>();
    for (const rp of ruleProfs) {
      if (seenProf.has(rp.professional_user_id)) continue;
      seenProf.add(rp.professional_user_id);
      const key = `${rp.professional_user_id}|${fillMonth}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          professional_user_id: rp.professional_user_id,
          professional_name: rp.professional?.name || 'Sem nome',
          reference_month: fillMonth,
          devida: 0,
          disponivel: 0,
          paga: 0,
          total: 0,
        });
      }
    }

    return Array.from(byKey.values()).sort((a, b) => {
      if (a.reference_month !== b.reference_month) return b.reference_month.localeCompare(a.reference_month);
      return a.professional_name.localeCompare(b.professional_name);
    });
  }

  /** Comissoes DISPONIVEIS agrupadas por profissional — fila de pagamento. */
  async payable(tenantId: string) {
    const list = await this.prisma.commission.findMany({
      where: { tenant_id: tenantId, status: 'DISPONIVEL' },
      orderBy: { available_at: 'asc' },
      include: {
        professional: { select: { id: true, name: true } },
      },
    });

    const byProfessional = new Map<string, { professional_user_id: string; name: string; total: number; count: number; commissions: typeof list }>();
    for (const c of list) {
      const key = c.professional_user_id;
      const existing = byProfessional.get(key) || {
        professional_user_id: c.professional_user_id,
        name: c.professional?.name || 'Sem nome',
        total: 0,
        count: 0,
        commissions: [] as typeof list,
      };
      existing.total += Number(c.amount);
      existing.count += 1;
      existing.commissions.push(c);
      byProfessional.set(key, existing);
    }

    return Array.from(byProfessional.values()).sort((a, b) => b.total - a.total);
  }

  /**
   * Onda 17.62 — "Modo Jogo": viewModel por profissional pra tela gamificada.
   * SÓ dado REAL: carteira (devida/disponivel/paga, do summary) + faixa (a % real da
   * regra geral do profissional) + ids resgatáveis (DISPONIVEL). meta/missoes/trilha/
   * conquistas = null/[] (dado novo, Fase 2) → o front rende estado vazio honesto.
   * O servidor é a fonte: o componente não calcula nada.
   */
  async gameView(tenantId: string, opts: { reference_month?: string } = {}) {
    const month = opts.reference_month || monthKey(new Date());
    const rows = await this.summary(tenantId, { reference_month: month });

    const rules = await this.prisma.commissionRule.findMany({
      where: { tenant_id: tenantId, active: true },
      select: { professional_user_id: true, percentage: true, procedure_id: true, procedure_category: true },
    });
    const disp = await this.prisma.commission.findMany({
      where: { tenant_id: tenantId, status: 'DISPONIVEL' },
      select: { id: true, professional_user_id: true, amount: true },
    });
    const dispByProf = new Map<string, { ids: string[]; total: number }>();
    for (const c of disp) {
      const e = dispByProf.get(c.professional_user_id) || { ids: [], total: 0 };
      e.ids.push(c.id);
      e.total += Number(c.amount);
      dispByProf.set(c.professional_user_id, e);
    }

    // Onda 17.62 Fase 2 — META MENSAL: reusa o Goal que JÁ existe (metric SALES_VALUE,
    // scope PROFESSIONAL, MONTHLY). alvo = target_value; atual = current_value (cache do
    // goals.recalculate / cron). Best-effort: sem meta → null → estado vazio honesto no front.
    const goalByProf = new Map<string, { id: string; alvo: number; atual: number }>();
    try {
      const [gy, gm] = month.split('-').map(Number);
      const mStart = new Date(Date.UTC(gy, gm - 1, 1));
      const mEnd = new Date(Date.UTC(gy, gm, 0, 23, 59, 59));
      const goals = await this.prisma.goal.findMany({
        where: {
          tenant_id: tenantId,
          active: true,
          metric: 'SALES_VALUE',
          scope: 'PROFESSIONAL',
          professional_user_id: { not: null },
          period_start: { lte: mEnd },
          period_end: { gte: mStart },
        },
        select: { id: true, professional_user_id: true, target_value: true, current_value: true },
      });
      for (const g of goals) {
        if (!g.professional_user_id) continue;
        goalByProf.set(g.professional_user_id, {
          id: g.id,
          alvo: Number(g.target_value),
          atual: Number(g.current_value ?? 0),
        });
      }
    } catch {
      /* sem metas (ou tabela ainda sem dados) → null → estado vazio honesto */
    }

    // Fase 2b — TRILHA DE FAIXAS: config (opt-in) + produção do mês por profissional
    // (orçamentos aceitos = mesma base do SALES_VALUE). Best-effort.
    const tiersCfg = await this.getTiers(tenantId);
    const prodByProf = new Map<string, number>();
    try {
      const [py, pm] = month.split('-').map(Number);
      const pStart = new Date(Date.UTC(py, pm - 1, 1));
      const pEnd = new Date(Date.UTC(py, pm, 0, 23, 59, 59));
      const quotes = await this.prisma.quote.findMany({
        where: { patient: { tenant_id: tenantId }, status: 'ACCEPTED', accepted_at: { gte: pStart, lte: pEnd } },
        select: { created_by_user_id: true, total_value: true },
      });
      for (const q of quotes) {
        if (!q.created_by_user_id) continue;
        prodByProf.set(q.created_by_user_id, (prodByProf.get(q.created_by_user_id) ?? 0) + Number(q.total_value));
      }
    } catch {
      /* sem produção → faixa base */
    }

    const players = rows.map((r) => {
      const profRules = rules.filter((x) => x.professional_user_id === r.professional_user_id);
      const geral = profRules.find((x) => !x.procedure_id && !x.procedure_category);
      const faixaPct = geral?.percentage != null ? Number(geral.percentage) : null;
      const faixaLabel =
        faixaPct != null ? `${faixaPct}% de comissão`
        : profRules.length > 0 ? 'Comissão por procedimento'
        : 'Sem regra cadastrada';
      const iniciais =
        r.professional_name.split(' ').filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join('') || '?';
      const d = dispByProf.get(r.professional_user_id);
      const meta = goalByProf.get(r.professional_user_id) ?? null;
      // Fase 2b — CONQUISTAS derivadas de dado REAL (carteira do mês + meta). Sem promessa
      // de dinheiro — são só selos. Bloqueadas (desbloqueada=false) aparecem em cinza no front.
      const totalMes = r.devida + r.disponivel + r.paga;
      const conquistas = [
        { emoji: '⚡', label: 'Comissão gerada', desbloqueada: totalMes > 0 },
        { emoji: '🪙', label: 'Primeiro resgate', desbloqueada: r.paga > 0 },
        { emoji: '🎯', label: 'Meta batida', desbloqueada: !!(meta && meta.alvo > 0 && meta.atual >= meta.alvo) },
        { emoji: '💰', label: 'R$ 1k no mês', desbloqueada: totalMes >= 1000 },
        { emoji: '🏆', label: 'R$ 5k no mês', desbloqueada: totalMes >= 5000 },
      ];
      return {
        professional_user_id: r.professional_user_id,
        nome: r.professional_name,
        iniciais,
        faixaPct,
        faixaLabel,
        temRegra: profRules.length > 0,
        carteira: { devida: r.devida, disponivel: r.disponivel, paga: r.paga },
        resgatavel: { total: d?.total ?? 0, ids: d?.ids ?? [] },
        // Fase 2 — meta mensal real (Goal SALES_VALUE); sem meta → null → estado vazio honesto:
        meta,
        streakSemanas: null as null | number,
        // Fase 2b — trilha de faixas (preview até a clínica ATIVAR no cálculo):
        producaoMes: prodByProf.get(r.professional_user_id) ?? 0,
        tiersAtivo: tiersCfg.enabled,
        trilha: buildTrilha(tiersCfg.tiers, prodByProf.get(r.professional_user_id) ?? 0),
        missoes: [] as { titulo: string; recompensa: string; alvo: number; progresso: number; concluida: boolean }[],
        conquistas,
      };
    });

    return { reference_month: month, players };
  }

  /** Fase 2b — lê a config de faixas (GlobalSetting por tenant). Default: sugeridas, OFF. */
  async getTiers(tenantId: string): Promise<TiersConfig> {
    try {
      const row = await this.prisma.globalSetting.findUnique({ where: { key: `COMMISSION_TIERS_${tenantId}` } });
      if (!row?.value) return DEFAULT_TIERS;
      const parsed = JSON.parse(row.value);
      if (!parsed || !Array.isArray(parsed.tiers)) return DEFAULT_TIERS;
      return { enabled: !!parsed.enabled, tiers: parsed.tiers };
    } catch {
      return DEFAULT_TIERS;
    }
  }

  /** Fase 2b — salva a config de faixas. enabled=true (opt-in) é o que liga o % no cálculo. */
  async setTiers(tenantId: string, cfg: { enabled?: boolean; tiers: FaixaTier[] }) {
    const value = JSON.stringify({ enabled: !!cfg.enabled, tiers: cfg.tiers });
    const key = `COMMISSION_TIERS_${tenantId}`;
    await this.prisma.globalSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    return this.getTiers(tenantId);
  }
}
