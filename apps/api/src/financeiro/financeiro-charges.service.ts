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
    search?: string; // busca por nome/telefone/CPF do paciente (server-side, atravessa toda a carteira)
    status?: string; // PENDING|RECEIVED|OVERDUE|CONFIRMED|...
    // Onda 18.x — 'negativados': TODAS as cobranças em aberto (a vencer + atrasadas)
    // dos pacientes que têm ≥1 atrasada. O front agrupa por paciente (ordem
    // alfabética) — visão "quem está devendo e quanto".
    // 'all_patients': a carteira INTEIRA (inclusive canceladas/apagadas) — a aba "Todos"
    // agrupa por paciente no front, com tudo que ele já negociou.
    statusGroup?: 'open' | 'paid' | 'overdue' | 'upcoming' | 'negativados' | 'all_patients' | 'all';
    kind?: string; // SINAL|ENTRADA|INSTALLMENT
    billingType?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
    offset?: number;
  }) {
    const { tenantId, dentistId, patientId, search, status, statusGroup, kind, billingType, startDate, endDate } = opts;
    // Negativados precisa da carteira INTEIRA dos devedores (agrupa no front) — teto maior.
    const limit = Math.min(opts.limit || 100, statusGroup === 'negativados' ? 2000 : statusGroup === 'all_patients' ? 5000 : 500);
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

    // Busca por paciente (server-side → atravessa TODA a carteira, não só as 200
    // carregadas). Casa nome (case-insensitive) + telefone/CPF (só dígitos), e
    // procura o paciente pelos TRÊS caminhos de vínculo que uma charge pode ter:
    //   1) direto: patient_id (boletos importados do Asaas COM vínculo)
    //   2) via plano: treatment_plan.patient
    //   3) órfão: customer_external_id → PaymentGatewayCustomer.lead_id → Patient.lead_id
    //      (importados SEM plano e SEM patient_id — resolvidos só pela cadeia do gateway)
    // Vai em AND separado pra não colidir com o OR do statusGroup='paid'.
    const term = (search || '').trim();
    if (term) {
      const digits = term.replace(/\D/g, '');
      const nameCond = { name: { contains: term, mode: 'insensitive' as const } };
      // Telefone/CPF: a coluna guarda formatos MISTOS ((82) 9..., 82..., 123.456...).
      // Prisma nao normaliza a coluna, entao casamos por DOIS lados: o termo como
      // digitado (pega os salvos COM mascara) e so os digitos (pega os SEM mascara).
      // So entra quando o termo parece telefone/CPF (>=3 digitos) — busca por nome
      // nao carrega essas clausulas atoa.
      const phoneCpfConds: any[] = [];
      if (digits.length >= 3) {
        phoneCpfConds.push({ phone: { contains: term } }, { cpf: { contains: term } });
        if (digits !== term) phoneCpfConds.push({ phone: { contains: digits } }, { cpf: { contains: digits } });
      }
      const patientMatch = { OR: [nameCond, ...phoneCpfConds] };

      const patientOr: any[] = [
        { patient: patientMatch },        // 1) direto
        { treatment_plan: { patient: patientMatch } }, // 2) via plano
      ];

      // 3) órfãos: acha os pacientes que casam → seus leads → os external_ids do
      // gateway → charges por customer_external_id. Só quando buscando (2 queries extra).
      const matchedPatients = await this.prisma.patient.findMany({
        where: { ...(tenantId ? { tenant_id: tenantId } : {}), lead_id: { not: null }, ...patientMatch },
        select: { lead_id: true },
        take: 500,
      });
      const leadIds = [...new Set(matchedPatients.map((p) => p.lead_id).filter(Boolean) as string[])];
      if (leadIds.length) {
        const custs = await this.prisma.paymentGatewayCustomer.findMany({
          where: { lead_id: { in: leadIds }, ...(tenantId ? { tenant_id: tenantId } : {}) },
          select: { external_id: true },
        });
        const extIds = [...new Set(custs.map((c) => c.external_id).filter(Boolean) as string[])];
        if (extIds.length) patientOr.push({ customer_external_id: { in: extIds } });
      }

      if (!where.AND) where.AND = [];
      where.AND.push({ OR: patientOr });
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
    } else if (statusGroup === 'negativados') {
      // Passo 1: quem tem cobrança ATRASADA (pelos 3 caminhos de vínculo do paciente —
      // direto, via plano, ou órfão pelo cliente do gateway).
      const overdue = await this.prisma.paymentGatewayCharge.findMany({
        where: {
          ...(tenantId ? { tenant_id: tenantId } : {}),
          status: { in: OPEN_STATUSES },
          received_in_cash: false,
          due_date: { lt: now },
        },
        select: { patient_id: true, customer_external_id: true, treatment_plan: { select: { patient_id: true } } },
      });
      const patIds = new Set<string>();
      const orphanExt = new Set<string>();
      for (const c of overdue as any[]) {
        const pid = c.patient_id || c.treatment_plan?.patient_id;
        if (pid) patIds.add(pid);
        else if (c.customer_external_id) orphanExt.add(c.customer_external_id);
      }
      // Passo 2: TODAS as cobranças em aberto (a vencer + atrasadas) desses pacientes.
      where.status = { in: OPEN_STATUSES };
      where.received_in_cash = false;
      const who: any[] = [];
      if (patIds.size) {
        const ids = [...patIds];
        who.push({ patient_id: { in: ids } }, { treatment_plan: { patient_id: { in: ids } } });
      }
      if (orphanExt.size) who.push({ customer_external_id: { in: [...orphanExt] } });
      where.AND = where.AND || [];
      // Sem devedor nenhum → nada (condição impossível, evita listar a carteira toda).
      where.AND.push(who.length ? { OR: who } : { id: { in: [] } });
    } else if (statusGroup === 'all_patients') {
      // Tudo, sem filtro de status (canceladas/apagadas entram — o front mostra "Cancelado").
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
          // Onda 18.x — vinculo direto (boletos importados do Asaas sem treatment_plan).
          patient: { select: { id: true, name: true, phone: true, cpf: true, avatar_url: true } },
        },
        // Pagos: do pagamento mais RECENTE ao mais antigo (senão, com o teto de 200,
        // a aba mostrava só os pagamentos mais velhos da carteira). Demais: por vencimento.
        orderBy: statusGroup === 'paid'
          ? [{ paid_at: { sort: 'desc' as const, nulls: 'last' as const } }, { payment_date: { sort: 'desc' as const, nulls: 'last' as const } }, { due_date: 'desc' as const }]
          : { due_date: 'asc' as const },
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
   * Onda 18.x — KPIs do dashboard da aba Boletos (por chip). Calculado sobre a
   * CARTEIRA INTEIRA do tenant (não só as linhas carregadas), em memória, a partir
   * do mesmo serializador da listagem (mesma régua de PAGO/ATRASADO/EM_ABERTO).
   *
   * Expectativa de recebimento (Negativados/Atrasados): cada boleto vencido vale
   *   amount × comportamento do paciente × decaimento pela idade do atraso
   *   - comportamento r = pagos / (pagos + vencidos abertos) do paciente (sem
   *     histórico = 0,5). Quem "sempre atrasa mas paga" tem r alto; quem nunca
   *     pagou nada tem r = 0.
   *   - decaimento: ≤30d 1,0 · ≤60d 0,75 · ≤90d 0,5 · ≤180d 0,25 · >180d 0,10
   * Perfis (por paciente devedor):
   *   - "atrasa mas paga": r ≥ 0,6 (já pagou a maioria do que venceu)
   *   - "risco": 0,3 ≤ r < 0,6, ou sem histórico
   *   - "não paga": r < 0,3 (nunca/quase nunca pagou o que venceu)
   */
  async getChargesKpis(opts: { tenantId?: string; dentistId?: string }) {
    const { tenantId, dentistId } = opts;
    const { data } = await this.findCharges({ tenantId, dentistId, statusGroup: 'all_patients', limit: 5000 });
    type C = ReturnType<FinanceiroChargesService['serializeCharge']>;
    const rows = data as C[];
    const now = new Date();
    const sum = (arr: C[]) => arr.reduce((s, c) => s + (Number(c.amount) || 0), 0);
    const round2 = (v: number) => Math.round(v * 100) / 100;
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
    const dayMs = 86_400_000;

    const live = rows.filter((c) => c.computed_status !== 'CANCELADO');
    const cancelled = rows.filter((c) => c.computed_status === 'CANCELADO');
    const paid = live.filter((c) => c.computed_status === 'PAGO');
    const overdue = live.filter((c) => c.computed_status === 'ATRASADO');
    const open = live.filter((c) => c.computed_status === 'EM_ABERTO');
    const pid = (c: C) => c.patient?.id || null;

    // ── Comportamento por paciente ────────────────────────────────────────
    type Beh = { paid: number; paidLate: number; overdue: number; overdueTotal: number; maxDays: number; lateDaysSum: number };
    const beh = new Map<string, Beh>();
    const getB = (id: string) => {
      let b = beh.get(id);
      if (!b) { b = { paid: 0, paidLate: 0, overdue: 0, overdueTotal: 0, maxDays: 0, lateDaysSum: 0 }; beh.set(id, b); }
      return b;
    };
    for (const c of live) {
      const id = pid(c); if (!id) continue;
      const b = getB(id);
      if (c.computed_status === 'PAGO') {
        b.paid++;
        const paidAt = c.paid_at || c.payment_date;
        if (paidAt && new Date(paidAt).getTime() > new Date(c.due_date).getTime() + dayMs) {
          b.paidLate++;
          b.lateDaysSum += Math.floor((new Date(paidAt).getTime() - new Date(c.due_date).getTime()) / dayMs);
        }
      } else if (c.computed_status === 'ATRASADO') {
        b.overdue++; b.overdueTotal += Number(c.amount) || 0; b.maxDays = Math.max(b.maxDays, c.days_overdue || 0);
      }
    }
    const rateOf = (id: string | null) => {
      if (!id) return 0.5;
      const b = beh.get(id); if (!b) return 0.5;
      const n = b.paid + b.overdue; return n === 0 ? 0.5 : b.paid / n;
    };
    const decay = (d: number) => (d <= 30 ? 1 : d <= 60 ? 0.75 : d <= 90 ? 0.5 : d <= 180 ? 0.25 : 0.1);
    const expectedOf = (c: C) => (Number(c.amount) || 0) * rateOf(pid(c)) * decay(c.days_overdue || 0);

    // ── Base de pacientes ─────────────────────────────────────────────────
    const patientsWithCharges = new Set(live.map(pid).filter(Boolean) as string[]);
    const debtors = new Set(overdue.map(pid).filter(Boolean) as string[]);
    const withOpen = new Set([...overdue, ...open].map(pid).filter(Boolean) as string[]);
    const settled = [...patientsWithCharges].filter((id) => !withOpen.has(id)); // sem nada em aberto
    const upToDate = [...withOpen].filter((id) => !debtors.has(id)); // tem a vencer, nada atrasado

    // ── Perfis dos devedores ──────────────────────────────────────────────
    const profiles = { paga_atrasado: { patients: 0, total: 0 }, risco: { patients: 0, total: 0 }, nao_paga: { patients: 0, total: 0 } };
    for (const id of debtors) {
      const b = beh.get(id)!; const n = b.paid + b.overdue; const r = n === 0 ? 0.5 : b.paid / n;
      const k = b.paid === 0 && b.overdue > 0 && b.maxDays > 90 ? 'nao_paga' : r >= 0.6 ? 'paga_atrasado' : r >= 0.3 ? 'risco' : 'nao_paga';
      profiles[k].patients++; profiles[k].total += b.overdueTotal;
    }

    // ── Atrasados: faixas de idade ────────────────────────────────────────
    const bucket = (lo: number, hi: number) => {
      const arr = overdue.filter((c) => (c.days_overdue || 0) >= lo && (c.days_overdue || 0) <= hi);
      return { count: arr.length, total: round2(sum(arr)), expected: round2(arr.reduce((s, c) => s + expectedOf(c), 0)) };
    };
    const overdueExpected = overdue.reduce((s, c) => s + expectedOf(c), 0);
    const overdueDaysAvg = overdue.length ? Math.round(overdue.reduce((s, c) => s + (c.days_overdue || 0), 0) / overdue.length) : 0;
    const oldest = overdue.reduce((m, c) => Math.max(m, c.days_overdue || 0), 0);

    // ── Vencem 7d ─────────────────────────────────────────────────────────
    const in7 = new Date(now.getTime() + 7 * dayMs);
    const upcoming = open.filter((c) => { const d = new Date(c.due_date); return d >= now && d <= in7; });
    // Taxa histórica de pagamento EM DIA (pagos no prazo / pagos) — expectativa de quem vence agora.
    const paidOnTime = paid.filter((c) => { const p = c.paid_at || c.payment_date; return !p || new Date(p).getTime() <= new Date(c.due_date).getTime() + dayMs; });
    const onTimeRate = paid.length ? paidOnTime.length / paid.length : 0.7;
    const upcomingExpected = upcoming.reduce((s, c) => s + (Number(c.amount) || 0) * (0.5 + rateOf(pid(c)) / 2) * (0.6 + onTimeRate * 0.4), 0);
    const upcomingByDay: Record<string, { count: number; total: number }> = {};
    for (const c of upcoming) { const k = new Date(c.due_date).toISOString().slice(0, 10); (upcomingByDay[k] ||= { count: 0, total: 0 }); upcomingByDay[k].count++; upcomingByDay[k].total = round2(upcomingByDay[k].total + Number(c.amount)); }

    // ── Pagos ─────────────────────────────────────────────────────────────
    const paidIso = (c: C) => c.paid_at || c.payment_date || null;
    const y = now.getFullYear(), m = now.getMonth();
    const inMonth = (c: C, yy: number, mm: number) => { const p = paidIso(c); if (!p) return false; const d = new Date(p); return d.getFullYear() === yy && d.getMonth() === mm; };
    const paidThisMonth = paid.filter((c) => inMonth(c, y, m));
    const pm = m === 0 ? 11 : m - 1, py = m === 0 ? y - 1 : y;
    const paidPrevMonth = paid.filter((c) => inMonth(c, py, pm));
    const last30 = paid.filter((c) => { const p = paidIso(c); return p && now.getTime() - new Date(p).getTime() <= 30 * dayMs; });
    const lateDays = paid.map((c) => { const p = paidIso(c); return p ? Math.max(0, Math.floor((new Date(p).getTime() - new Date(c.due_date).getTime()) / dayMs)) : 0; });
    const avgLateDays = lateDays.length ? Math.round(lateDays.reduce((a, b) => a + b, 0) / lateDays.length) : 0;
    const paidByMethod: Record<string, { count: number; total: number }> = {};
    for (const c of paidThisMonth) { const k = c.received_in_cash ? 'CLINICA' : (c.billing_type || 'OUTRO'); (paidByMethod[k] ||= { count: 0, total: 0 }); paidByMethod[k].count++; paidByMethod[k].total = round2(paidByMethod[k].total + Number(c.amount)); }

    const totalCarteira = sum(live);
    return {
      generated_at: now.toISOString(),
      base: {
        charges: live.length,
        cancelled: cancelled.length,
        patients_with_charges: patientsWithCharges.size,
        patients_debtors: debtors.size,
        patients_up_to_date: upToDate.length,
        patients_settled: settled.length,
      },
      negativados: {
        patients: debtors.size,
        pct_of_patients: pct(debtors.size, patientsWithCharges.size),
        overdue_total: round2(sum(overdue)),
        overdue_count: overdue.length,
        open_total_of_debtors: round2(sum([...overdue, ...open].filter((c) => pid(c) && debtors.has(pid(c)!)))),
        expected_recovery: round2(overdueExpected),
        expected_recovery_pct: pct(overdueExpected, sum(overdue)),
        profiles: {
          paga_atrasado: { ...profiles.paga_atrasado, total: round2(profiles.paga_atrasado.total) },
          risco: { ...profiles.risco, total: round2(profiles.risco.total) },
          nao_paga: { ...profiles.nao_paga, total: round2(profiles.nao_paga.total) },
        },
      },
      atrasados: {
        count: overdue.length,
        total: round2(sum(overdue)),
        patients: debtors.size,
        avg_days: overdueDaysAvg,
        oldest_days: oldest,
        expected_recovery: round2(overdueExpected),
        expected_recovery_pct: pct(overdueExpected, sum(overdue)),
        buckets: { d1_30: bucket(0, 30), d31_60: bucket(31, 60), d61_90: bucket(61, 90), d91_180: bucket(91, 180), d180p: bucket(181, 1e9) },
      },
      upcoming: {
        count: upcoming.length,
        total: round2(sum(upcoming)),
        patients: new Set(upcoming.map(pid).filter(Boolean)).size,
        expected: round2(upcomingExpected),
        expected_pct: pct(upcomingExpected, sum(upcoming)),
        on_time_rate_pct: Math.round(onTimeRate * 1000) / 10,
        by_day: upcomingByDay,
      },
      pagos: {
        month_total: round2(sum(paidThisMonth)),
        month_count: paidThisMonth.length,
        prev_month_total: round2(sum(paidPrevMonth)),
        prev_month_count: paidPrevMonth.length,
        month_delta_pct: paidPrevMonth.length || paidThisMonth.length ? pct(sum(paidThisMonth) - sum(paidPrevMonth), sum(paidPrevMonth) || sum(paidThisMonth)) : 0,
        last30_total: round2(sum(last30)),
        last30_count: last30.length,
        on_time_pct: Math.round(onTimeRate * 1000) / 10,
        avg_late_days: avgLateDays,
        avg_ticket: paid.length ? round2(sum(paid) / paid.length) : 0,
        all_time_total: round2(sum(paid)),
        all_time_count: paid.length,
        by_method_month: paidByMethod,
      },
      todos: {
        carteira_total: round2(totalCarteira),
        received_total: round2(sum(paid)),
        received_pct: pct(sum(paid), totalCarteira),
        open_total: round2(sum(open)),
        overdue_total: round2(sum(overdue)),
        cancelled_count: cancelled.length,
        patients_with_charges: patientsWithCharges.size,
        patients_settled: settled.length,
        patients_up_to_date: upToDate.length,
        patients_debtors: debtors.size,
        pct_settled: pct(settled.length, patientsWithCharges.size),
        pct_debtors: pct(debtors.size, patientsWithCharges.size),
      },
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
      patient: r.treatment_plan?.patient || (r as any).patient || (r as any)._resolvedPatient || null,
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
