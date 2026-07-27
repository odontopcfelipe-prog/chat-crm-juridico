/**
 * FinanceiroChargesService — Fase 25 (Onda 16).
 *
 * Serviço focado no dashboard ODONTOLOGICO de cobranças do paciente
 * (PaymentGatewayCharge): sinal, entrada, parcelas. Diferente do
 * FinanceiroService legado, que lida com FinancialTransaction (manual
 * + leads juridicos), aqui o foco é exclusivo no que está realmente
 * pingando do paciente via Asaas/CASH.
 *
 * Endpoints expostos no FinanceiroController:
 *  - GET /financeiro/dashboard    → KPIs (recebido/a-receber/atrasado/vencendo)
 *  - GET /financeiro/charges      → lista filtrável de PaymentGatewayCharge
 *  - GET /financeiro/patients-summary → agregação por paciente (inadimplência)
 *
 * Nada disso bate em FinancialTransaction — esse fluxo continua o caminho
 * do financeiro avulso/manual da clínica (luz, aluguel, etc).
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

type ChargeRow = {
  id: string;
  tenant_id: string | null;
  external_id: string;
  gateway: string;
  billing_type: string;
  kind: string | null;
  status: string;
  amount: any;
  net_value: any;
  due_date: Date;
  paid_at: Date | null;
  payment_date: Date | null;
  received_in_cash: boolean;
  description: string | null;
  boleto_url: string | null;
  pix_qr_code: string | null;
  pix_copy_paste: string | null;
  invoice_url: string | null;
  treatment_plan_id: string | null;
  installment_id: string | null;
  created_at: Date;
  // joined
  treatment_plan?: {
    id: string;
    patient_id: string;
    proposal_status: string;
    status: string;
    total_value: any;
    patient: { id: string; name: string | null; phone: string | null; cpf?: string | null } | null;
    quote: { id: string; quote_number: number | null; created_by: { id: string; name: string } | null } | null;
  } | null;
  installment?: {
    id: string;
    sequence: number;
    total_count: number;
  } | null;
};

const PAID_STATUSES = ['RECEIVED', 'CONFIRMED'];
const OPEN_STATUSES = ['PENDING', 'OVERDUE'];
const CANCELLED_STATUSES = ['REFUNDED', 'DELETED', 'CANCELLED'];

@Injectable()
export class FinanceiroChargesService {
  private readonly logger = new Logger(FinanceiroChargesService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * KPIs do dashboard. Pega "fotografia de hoje", mas o que é "pago"
   * filtra pelo paid_at dentro do range startDate/endDate. Aberto/atrasado/
   * vencendo são SEMPRE relativos a hoje (não respeitam range — não faz
   * sentido perguntar "o que está atrasado em março" no meio de maio).
   */
  async getDashboard(opts: {
    tenantId?: string;
    dentistId?: string;
    startDate?: string;
    endDate?: string;
  }) {
    const { tenantId, dentistId, startDate, endDate } = opts;
    const now = new Date();
    const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    // Janelas pra projeção de recebimento (cobranças em aberto com vencimento futuro).
    const in30d = new Date(now.getTime() + 30 * 86_400_000);
    const in60d = new Date(now.getTime() + 60 * 86_400_000);
    const in90d = new Date(now.getTime() + 90 * 86_400_000);

    const baseWhere: any = {};
    if (tenantId) baseWhere.tenant_id = tenantId;
    // Filtro por dentista: passa pelo plan.quote.created_by_id
    if (dentistId) {
      baseWhere.treatment_plan = { quote: { created_by_user_id: dentistId } };
    }

    // 1. RECEBIDO no período (filtra paid_at no range, ou criação se sem range)
    const receivedWhere: any = {
      ...baseWhere,
      OR: [
        { status: { in: PAID_STATUSES } },
        { received_in_cash: true },
      ],
    };
    if (startDate || endDate) {
      const range: any = {};
      if (startDate) range.gte = new Date(startDate);
      if (endDate) range.lte = new Date(endDate);
      // Considera paid_at, com fallback pra payment_date e received_at
      receivedWhere.AND = [
        {
          OR: [
            { paid_at: range },
            { payment_date: range },
            { received_at: range },
          ],
        },
      ];
    }

    // 2. ABERTO / ATRASADO / VENCENDO sempre relativos a hoje
    const openWhere: any = {
      ...baseWhere,
      status: { in: OPEN_STATUSES },
      received_in_cash: false, // se ja recebido em especie, nao é aberto
    };
    const overdueWhere: any = {
      ...openWhere,
      due_date: { lt: now },
    };
    const upcoming7dWhere: any = {
      ...openWhere,
      due_date: { gte: now, lte: in7d },
    };

    // Realização (contratado x recebido acumulado). Contratado = soma do total_value
    // dos planos que JÁ geraram cobrança (espelha a aba Pacientes); recebido = todas as
    // cobranças pagas (acumulado, não só o período).
    const planWhere: any = { charges: { some: {} } };
    if (tenantId) planWhere.patient = { tenant_id: tenantId };
    if (dentistId) planWhere.quote = { created_by_user_id: dentistId };
    const recebidoAcumWhere: any = {
      ...baseWhere,
      OR: [{ status: { in: PAID_STATUSES } }, { received_in_cash: true }],
    };

    const [receivedAgg, openAgg, overdueAgg, upcomingAgg, proj30Agg, proj60Agg, proj90Agg, contratadoAgg, recebidoAcumAgg] = await Promise.all([
      this.prisma.paymentGatewayCharge.aggregate({
        where: receivedWhere,
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.paymentGatewayCharge.aggregate({
        where: openWhere,
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.paymentGatewayCharge.aggregate({
        where: overdueWhere,
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.paymentGatewayCharge.aggregate({
        where: upcoming7dWhere,
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.paymentGatewayCharge.aggregate({
        where: { ...openWhere, due_date: { gt: now, lte: in30d } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.paymentGatewayCharge.aggregate({
        where: { ...openWhere, due_date: { gt: in30d, lte: in60d } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.paymentGatewayCharge.aggregate({
        where: { ...openWhere, due_date: { gt: in60d, lte: in90d } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.treatmentPlan.aggregate({
        where: planWhere,
        _sum: { total_value: true },
      }),
      this.prisma.paymentGatewayCharge.aggregate({
        where: recebidoAcumWhere,
        _sum: { amount: true },
      }),
    ]);

    const roundV = (v: number) => Math.round(v * 100) / 100;

    // 3. Dias médios de atraso + aging por faixa (0-7 / 8-30 / 31-60 / 60+).
    const overdueRows = await this.prisma.paymentGatewayCharge.findMany({
      where: overdueWhere,
      select: { due_date: true, amount: true },
      take: 2000,
    });
    const aging = {
      d0_7: { count: 0, value: 0 },
      d8_30: { count: 0, value: 0 },
      d31_60: { count: 0, value: 0 },
      d60_plus: { count: 0, value: 0 },
    };
    let sumDaysOverdue = 0;
    for (const c of overdueRows) {
      const days = Math.floor((now.getTime() - new Date(c.due_date).getTime()) / 86_400_000);
      sumDaysOverdue += days;
      const amt = Number(c.amount);
      const bucket =
        days <= 7 ? aging.d0_7 : days <= 30 ? aging.d8_30 : days <= 60 ? aging.d31_60 : aging.d60_plus;
      bucket.count += 1;
      bucket.value += amt;
    }
    const avgDaysOverdue =
      overdueRows.length > 0 ? Math.round(sumDaysOverdue / overdueRows.length) : 0;

    // 4. Cashflow últimos 30 dias (entradas REAIS — paid_at)
    const cashflowStart = new Date(now.getTime() - 30 * 86_400_000);
    const cashflowCharges = await this.prisma.paymentGatewayCharge.findMany({
      where: {
        ...baseWhere,
        OR: [
          { status: { in: PAID_STATUSES }, paid_at: { gte: cashflowStart } },
          { received_in_cash: true, received_at: { gte: cashflowStart } },
        ],
      },
      select: { amount: true, paid_at: true, payment_date: true, received_at: true },
    });

    const cashflowMap = new Map<string, number>();
    for (const c of cashflowCharges) {
      const when = c.paid_at || c.payment_date || c.received_at;
      if (!when) continue;
      const key = new Date(when).toISOString().slice(0, 10);
      cashflowMap.set(key, (cashflowMap.get(key) || 0) + Number(c.amount));
    }
    const cashflow_30d = Array.from(cashflowMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, value]) => ({ date, value: Math.round(value * 100) / 100 }));

    // 5. Próximos 10 vencimentos (lista curta pra widget)
    const proximos_vencimentos = await this.prisma.paymentGatewayCharge.findMany({
      // Os 10 vencimentos MAIS PRÓXIMOS a partir de hoje — SEM travar em 7 dias (o KPI
      // a_vencer_7d continua 7d; aqui é a lista de fluxo, pra ver o que vem por aí).
      where: { ...openWhere, due_date: { gte: now } },
      include: {
        treatment_plan: {
          select: {
            patient: { select: { id: true, name: true, phone: true } },
          },
        },
      },
      orderBy: { due_date: 'asc' },
      take: 10,
    });

    // 6. Top 10 atrasos (worst-first)
    const top_atrasos = await this.prisma.paymentGatewayCharge.findMany({
      where: overdueWhere,
      include: {
        treatment_plan: {
          select: {
            patient: { select: { id: true, name: true, phone: true } },
          },
        },
      },
      orderBy: { due_date: 'asc' },
      take: 10,
    });

    // 7. Entradas DE HOJE (charges efetivamente pagos no dia, Asaas ou especie)
    const hojeStart = new Date(now);
    hojeStart.setHours(0, 0, 0, 0);
    const hojeEnd = new Date(hojeStart);
    hojeEnd.setDate(hojeStart.getDate() + 1);

    const entradas_hoje = await this.prisma.paymentGatewayCharge.findMany({
      where: {
        ...baseWhere,
        OR: [
          { status: { in: PAID_STATUSES }, paid_at: { gte: hojeStart, lt: hojeEnd } },
          { received_in_cash: true, received_at: { gte: hojeStart, lt: hojeEnd } },
        ],
      },
      include: {
        treatment_plan: {
          select: {
            patient: { select: { id: true, name: true, phone: true } },
          },
        },
      },
      orderBy: { updated_at: 'desc' },
      take: 10,
    });

    const entradasHojeTotal = entradas_hoje.reduce(
      (s, c) => s + Number(c.amount),
      0,
    );

    // 8. VENDAS DE HOJE (produção): orçamentos FECHADOS/aceitos hoje. É o valor
    // VENDIDO hoje (mesmo que o dinheiro entre parcelado depois) — diferente da
    // entrada (recebimento). Quote não tem tenant_id → escopa por patient.
    const vendasWhere: any = {
      status: 'ACCEPTED',
      accepted_at: { gte: hojeStart, lt: hojeEnd },
      deleted_at: null,
    };
    if (tenantId) vendasWhere.patient = { tenant_id: tenantId };
    if (dentistId) vendasWhere.created_by_user_id = dentistId;
    const vendasAgg = await this.prisma.quote.aggregate({
      where: vendasWhere,
      _sum: { total_value: true },
      _count: { _all: true },
    });

    return {
      recebido_no_periodo: {
        value: Math.round(Number(receivedAgg._sum.amount || 0) * 100) / 100,
        count: receivedAgg._count._all,
      },
      a_receber_total: {
        value: Math.round(Number(openAgg._sum.amount || 0) * 100) / 100,
        count: openAgg._count._all,
      },
      atrasado: {
        value: Math.round(Number(overdueAgg._sum.amount || 0) * 100) / 100,
        count: overdueAgg._count._all,
        dias_medio: avgDaysOverdue,
        aging: {
          d0_7: { count: aging.d0_7.count, value: roundV(aging.d0_7.value) },
          d8_30: { count: aging.d8_30.count, value: roundV(aging.d8_30.value) },
          d31_60: { count: aging.d31_60.count, value: roundV(aging.d31_60.value) },
          d60_plus: { count: aging.d60_plus.count, value: roundV(aging.d60_plus.value) },
        },
      },
      a_vencer_7d: {
        value: Math.round(Number(upcomingAgg._sum.amount || 0) * 100) / 100,
        count: upcomingAgg._count._all,
      },
      realizacao: {
        contratado: roundV(Number(contratadoAgg._sum.total_value || 0)),
        recebido: roundV(Number(recebidoAcumAgg._sum.amount || 0)),
        pct: (() => {
          const c = Number(contratadoAgg._sum.total_value || 0);
          const r = Number(recebidoAcumAgg._sum.amount || 0);
          return c > 0 ? Math.round((r / c) * 100) : 0;
        })(),
      },
      projecao: {
        d30: { value: roundV(Number(proj30Agg._sum.amount || 0)), count: proj30Agg._count._all },
        d60: { value: roundV(Number(proj60Agg._sum.amount || 0)), count: proj60Agg._count._all },
        d90: { value: roundV(Number(proj90Agg._sum.amount || 0)), count: proj90Agg._count._all },
      },
      cashflow_30d,
      proximos_vencimentos: this.serializeChargeLight(proximos_vencimentos),
      top_atrasos: this.serializeChargeLight(top_atrasos),
      entrada_do_dia: {
        value: Math.round(entradasHojeTotal * 100) / 100,
        count: entradas_hoje.length,
        items: this.serializeChargeReceived(entradas_hoje),
      },
      vendas_do_dia: {
        value: Math.round(Number(vendasAgg._sum.total_value || 0) * 100) / 100,
        count: vendasAgg._count._all,
      },
      now: now.toISOString(),
    };
  }

  /**
   * Listagem detalhada de charges com filtros (pra aba "Boletos").
   */
  async findCharges(opts: {
    tenantId?: string;
    dentistId?: string;
    patientId?: string;
    status?: string; // PENDING|RECEIVED|OVERDUE|CONFIRMED|...
    statusGroup?: 'open' | 'paid' | 'overdue' | 'upcoming' | 'all';
    kind?: string; // SINAL|ENTRADA|INSTALLMENT
    billingType?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
    offset?: number;
  }) {
    const { tenantId, dentistId, patientId, status, statusGroup, kind, billingType, startDate, endDate } = opts;
    const limit = Math.min(opts.limit || 100, 500);
    const offset = opts.offset || 0;
    const now = new Date();
    const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const where: any = {};
    if (tenantId) where.tenant_id = tenantId;
    if (kind) where.kind = kind;
    if (billingType) where.billing_type = billingType;

    if (patientId) {
      where.treatment_plan = { patient_id: patientId };
    } else if (dentistId) {
      where.treatment_plan = { quote: { created_by_user_id: dentistId } };
    }

    if (status) {
      where.status = status;
    } else if (statusGroup === 'paid') {
      where.OR = [{ status: { in: PAID_STATUSES } }, { received_in_cash: true }];
    } else if (statusGroup === 'open') {
      where.status = { in: OPEN_STATUSES };
      where.received_in_cash = false;
    } else if (statusGroup === 'overdue') {
      where.status = { in: OPEN_STATUSES };
      where.received_in_cash = false;
      where.due_date = { lt: now };
    } else if (statusGroup === 'upcoming') {
      where.status = { in: OPEN_STATUSES };
      where.received_in_cash = false;
      where.due_date = { gte: now, lte: in7d };
    } else if (!statusGroup || statusGroup === 'all') {
      // Sem filtro — exclui cancelados por padrão
      where.status = { notIn: CANCELLED_STATUSES };
    }

    if (startDate || endDate) {
      const range: any = {};
      if (startDate) range.gte = new Date(startDate);
      if (endDate) range.lte = new Date(endDate);
      where.due_date = { ...(where.due_date || {}), ...range };
    }

    const [rows, total] = await Promise.all([
      this.prisma.paymentGatewayCharge.findMany({
        where,
        include: {
          treatment_plan: {
            select: {
              id: true,
              patient_id: true,
              proposal_status: true,
              status: true,
              total_value: true,
              patient: { select: { id: true, name: true, phone: true, cpf: true, avatar_url: true } },
              quote: {
                select: {
                  id: true,
                  quote_number: true,
                  created_by: { select: { id: true, name: true } },
                },
              },
            },
          },
          installment: { select: { id: true, sequence: true, total_count: true } },
        },
        orderBy: { due_date: 'asc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.paymentGatewayCharge.count({ where }),
    ]);

    // Onda 18.x — FALLBACK de nome pros boletos IMPORTADOS do Asaas: eles não têm
    // treatment_plan, então treatment_plan.patient = null e a lista mostrava "Sem nome".
    // Resolve o paciente pela cadeia do cliente do gateway:
    //   charge.customer_external_id → PaymentGatewayCustomer.lead_id → Patient.lead_id.
    const orphanExt = [...new Set(
      rows.filter((r: any) => !r.treatment_plan?.patient && r.customer_external_id).map((r: any) => r.customer_external_id as string),
    )];
    if (orphanExt.length) {
      const custs = await this.prisma.paymentGatewayCustomer.findMany({
        where: { external_id: { in: orphanExt }, ...(tenantId ? { tenant_id: tenantId } : {}) },
        select: { external_id: true, lead_id: true },
      });
      const leadIds = [...new Set(custs.map((c) => c.lead_id))];
      const pats = leadIds.length
        ? await this.prisma.patient.findMany({
            where: { lead_id: { in: leadIds }, ...(tenantId ? { tenant_id: tenantId } : {}) },
            select: { id: true, name: true, phone: true, cpf: true, avatar_url: true, lead_id: true },
          })
        : [];
      const patByLead = new Map(pats.map((p) => [p.lead_id as string, p]));
      const extToPatient = new Map<string, any>();
      for (const c of custs) { const p = patByLead.get(c.lead_id); if (p) extToPatient.set(c.external_id, p); }
      for (const r of rows as any[]) {
        if (!r.treatment_plan?.patient && r.customer_external_id) {
          r._resolvedPatient = extToPatient.get(r.customer_external_id) || null;
        }
      }
    }

    return {
      data: rows.map((r) => this.serializeCharge(r as any)),
      total,
      limit,
      offset,
    };
  }

  /**
   * Agregação por paciente: extrato simplificado tipo "conta-corrente".
   */
  async getPatientsSummary(opts: {
    tenantId?: string;
    dentistId?: string;
    orderBy?: 'atrasado' | 'em_aberto' | 'recebido';
    limit?: number;
  }) {
    const { tenantId, dentistId } = opts;
    const orderBy = opts.orderBy || 'atrasado';
    const limit = Math.min(opts.limit || 100, 500);
    const now = new Date();

    // Pega todos os planos com cobranças. SQL bruto seria mais eficiente
    // pra agregar em uma única query, mas Prisma não tem groupBy bom em
    // relations. Pra ~500 pacientes (escala da clínica média) o N+1 não
    // dói. Se virar gargalo, reescrevemos com $queryRaw.
    const planWhere: any = {};
    if (tenantId) planWhere.patient = { tenant_id: tenantId };
    if (dentistId) planWhere.quote = { created_by_user_id: dentistId };

    const plans = await this.prisma.treatmentPlan.findMany({
      where: planWhere,
      select: {
        id: true,
        patient_id: true,
        total_value: true,
        patient: { select: { id: true, name: true, phone: true, avatar_url: true } },
        charges: {
          select: {
            amount: true,
            status: true,
            due_date: true,
            received_in_cash: true,
          },
        },
      },
    });

    const map = new Map<
      string,
      {
        patient_id: string;
        patient_name: string | null;
        patient_phone: string | null;
        patient_avatar_url: string | null;
        total_contratado: number;
        recebido: number;
        em_aberto: number;
        atrasado: number;
        plans_count: number;
      }
    >();

    for (const p of plans) {
      if (!p.patient) continue;
      const id = p.patient.id;
      const cur =
        map.get(id) ||
        {
          patient_id: id,
          patient_name: p.patient.name,
          patient_phone: p.patient.phone,
          patient_avatar_url: p.patient.avatar_url,
          total_contratado: 0,
          recebido: 0,
          em_aberto: 0,
          atrasado: 0,
          plans_count: 0,
        };
      cur.total_contratado += Number(p.total_value);
      cur.plans_count += 1;
      for (const c of p.charges) {
        const amt = Number(c.amount);
        const isPaid = PAID_STATUSES.includes(c.status) || c.received_in_cash;
        const isCancelled = CANCELLED_STATUSES.includes(c.status);
        if (isPaid) {
          cur.recebido += amt;
        } else if (!isCancelled) {
          cur.em_aberto += amt;
          if (new Date(c.due_date) < now) cur.atrasado += amt;
        }
      }
      map.set(id, cur);
    }

    const arr = Array.from(map.values()).map((p) => ({
      ...p,
      total_contratado: Math.round(p.total_contratado * 100) / 100,
      recebido: Math.round(p.recebido * 100) / 100,
      em_aberto: Math.round(p.em_aberto * 100) / 100,
      atrasado: Math.round(p.atrasado * 100) / 100,
    }));

    arr.sort((a, b) => {
      const key = orderBy as keyof typeof a;
      const va = Number((a as any)[key]) || 0;
      const vb = Number((b as any)[key]) || 0;
      return vb - va;
    });

    return { data: arr.slice(0, limit), total: arr.length };
  }

  // ─── Helpers de serialização ──────────────────────────────

  private serializeCharge(r: ChargeRow) {
    const now = new Date();
    const isPaid =
      PAID_STATUSES.includes(r.status) || r.received_in_cash === true;
    const isCancelled = CANCELLED_STATUSES.includes(r.status);
    const isOverdue =
      !isPaid && !isCancelled && new Date(r.due_date) < now;
    const daysOverdue = isOverdue
      ? Math.floor((now.getTime() - new Date(r.due_date).getTime()) / 86_400_000)
      : 0;

    return {
      id: r.id,
      external_id: r.external_id,
      gateway: r.gateway,
      billing_type: r.billing_type,
      kind: r.kind,
      status: r.status,
      // Estado "calculado" — frontend usa esse, não precisa replicar lógica
      computed_status: isPaid
        ? 'PAGO'
        : isCancelled
          ? 'CANCELADO'
          : isOverdue
            ? 'ATRASADO'
            : 'EM_ABERTO',
      amount: Number(r.amount),
      net_value: r.net_value != null ? Number(r.net_value) : null,
      due_date: r.due_date,
      paid_at: r.paid_at,
      payment_date: r.payment_date,
      received_in_cash: r.received_in_cash,
      days_overdue: daysOverdue,
      description: r.description,
      boleto_url: r.boleto_url,
      pix_qr_code: r.pix_qr_code,
      pix_copy_paste: r.pix_copy_paste,
      invoice_url: r.invoice_url,
      // Identificadores pra frontend
      treatment_plan_id: r.treatment_plan_id,
      installment_id: r.installment_id,
      installment_label: r.installment
        ? `Parcela ${r.installment.sequence}/${r.installment.total_count}`
        : r.kind === 'SINAL'
          ? 'Sinal'
          : r.kind === 'ENTRADA'
            ? 'Entrada'
            : null,
      // Paciente + dentista pra mostrar na linha (fallback: cadeia do cliente p/ boletos Asaas importados)
      patient: r.treatment_plan?.patient || (r as any)._resolvedPatient || null,
      dentist: r.treatment_plan?.quote?.created_by || null,
      quote_number: r.treatment_plan?.quote?.quote_number || null,
      created_at: r.created_at,
    };
  }

  /** Versão leve pra widgets (Top 10 atrasos, próximos vencimentos). */
  private serializeChargeLight(rows: any[]) {
    const now = new Date();
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      amount: Number(r.amount),
      due_date: r.due_date,
      status: r.status,
      days_overdue:
        r.due_date && new Date(r.due_date) < now
          ? Math.floor((now.getTime() - new Date(r.due_date).getTime()) / 86_400_000)
          : 0,
      boleto_url: r.boleto_url || null,
      patient: r.treatment_plan?.patient || null,
    }));
  }

  /** Para o widget "Entrada do dia" — usa paid_at (quando entrou) em vez
   *  de due_date (quando deveria entrar). */
  private serializeChargeReceived(rows: any[]) {
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      amount: Number(r.amount),
      paid_at: r.paid_at || r.payment_date || r.received_at,
      billing_type: r.billing_type,
      received_in_cash: !!r.received_in_cash,
      patient: r.treatment_plan?.patient || null,
    }));
  }
}
