import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface PeriodRange {
  start: Date;
  end: Date;
}

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);
  constructor(private prisma: PrismaService) {}

  /**
   * Resolve periodo a partir de string preset OU custom from/to.
   * Presets:
   *   today, yesterday, week, month, last_month, quarter, year, last_30, last_90
   */
  private resolvePeriod(preset?: string, from?: string, to?: string): PeriodRange {
    if (from && to) {
      return { start: new Date(from), end: new Date(`${to}T23:59:59.999Z`) };
    }
    const now = new Date();
    const start = new Date(now);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);

    switch (preset || 'month') {
      case 'today':
        start.setHours(0, 0, 0, 0);
        break;
      case 'yesterday':
        start.setDate(start.getDate() - 1);
        start.setHours(0, 0, 0, 0);
        end.setDate(end.getDate() - 1);
        end.setHours(23, 59, 59, 999);
        break;
      case 'week':
        start.setDate(start.getDate() - 7);
        start.setHours(0, 0, 0, 0);
        break;
      case 'month':
        start.setDate(1);
        start.setHours(0, 0, 0, 0);
        break;
      case 'last_month': {
        const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lmEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
        return { start: lm, end: lmEnd };
      }
      case 'quarter':
        start.setMonth(start.getMonth() - 3);
        start.setHours(0, 0, 0, 0);
        break;
      case 'year':
        start.setMonth(0);
        start.setDate(1);
        start.setHours(0, 0, 0, 0);
        break;
      case 'last_30':
        start.setDate(start.getDate() - 30);
        start.setHours(0, 0, 0, 0);
        break;
      case 'last_90':
        start.setDate(start.getDate() - 90);
        start.setHours(0, 0, 0, 0);
        break;
      default:
        throw new BadRequestException(`Preset invalido: ${preset}`);
    }
    return { start, end };
  }

  /**
   * Dashboard agregado: KPIs principais para gestor abrir e ver tudo
   * em 5 segundos. Cobre vendas, agenda, financeiro, comissoes,
   * pacientes, top procedimentos, origem.
   */
  async dashboard(
    tenantId: string,
    opts: { period?: string; from?: string; to?: string } = {},
  ) {
    const { start, end } = this.resolvePeriod(opts.period, opts.from, opts.to);

    const [
      // Vendas
      quotesAccepted,
      quotesSent,
      // Agenda
      apptsTotal,
      apptsConfirmed,
      apptsCancelled,
      apptsNoShow,
      // Financeiro
      installmentsPaid,
      installmentsOpen,
      installmentsOverdue,
      // Comissoes
      commissionsDue,
      commissionsAvailable,
      commissionsPaid,
      // Pacientes
      newPatients,
      firstConsultations,
      // Top
      topProcedures,
      patientOrigins,
    ] = await Promise.all([
      this.prisma.quote.aggregate({
        where: {
          patient: { tenant_id: tenantId },
          status: 'ACCEPTED',
          accepted_at: { gte: start, lte: end },
        },
        _sum: { total_value: true },
        _count: { _all: true },
      }),
      this.prisma.quote.count({
        where: {
          patient: { tenant_id: tenantId },
          sent_at: { gte: start, lte: end },
        },
      }),
      this.prisma.calendarEvent.count({
        where: {
          tenant_id: tenantId,
          type: 'CONSULTA',
          start_at: { gte: start, lte: end },
        },
      }),
      this.prisma.calendarEvent.count({
        where: {
          tenant_id: tenantId,
          type: 'CONSULTA',
          status: 'CONFIRMADO',
          start_at: { gte: start, lte: end },
        },
      }),
      this.prisma.calendarEvent.count({
        where: {
          tenant_id: tenantId,
          type: 'CONSULTA',
          status: 'CANCELADO',
          start_at: { gte: start, lte: end },
        },
      }),
      this.prisma.calendarEvent.count({
        where: {
          tenant_id: tenantId,
          type: 'CONSULTA',
          status: 'ADIADO',
          start_at: { gte: start, lte: end },
        },
      }),
      this.prisma.installment.aggregate({
        where: {
          tenant_id: tenantId,
          status: 'PAGA',
          paid_at: { gte: start, lte: end },
        },
        _sum: { amount_paid: true },
        _count: { _all: true },
      }),
      this.prisma.installment.aggregate({
        where: {
          tenant_id: tenantId,
          status: { in: ['ABERTA', 'PARCIAL'] },
          due_date: { gte: new Date() },
        },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.installment.aggregate({
        where: {
          tenant_id: tenantId,
          status: { in: ['ABERTA', 'PARCIAL', 'ATRASADA'] },
          due_date: { lt: new Date() },
        },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.commission.aggregate({
        where: {
          tenant_id: tenantId,
          status: 'DEVIDA',
          created_at: { gte: start, lte: end },
        },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.commission.aggregate({
        where: {
          tenant_id: tenantId,
          status: 'DISPONIVEL',
        },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.commission.aggregate({
        where: {
          tenant_id: tenantId,
          status: 'PAGA',
          paid_at: { gte: start, lte: end },
        },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.patient.count({
        where: {
          tenant_id: tenantId,
          created_at: { gte: start, lte: end },
        },
      }),
      this.prisma.patient.count({
        where: {
          tenant_id: tenantId,
          first_visit_at: { gte: start, lte: end },
        },
      }),
      // Top 10 procedures by quote items revenue (ACCEPTED no periodo)
      this.prisma.quoteItem.groupBy({
        by: ['procedure_id'],
        where: {
          quote: {
            patient: { tenant_id: tenantId },
            status: 'ACCEPTED',
            accepted_at: { gte: start, lte: end },
          },
        },
        _sum: { total_price: true },
        _count: { _all: true },
        orderBy: { _sum: { total_price: 'desc' } },
        take: 10,
      }),
      // Origem de novos leads via Lead.origin no periodo
      this.prisma.lead.groupBy({
        by: ['origin'],
        where: {
          tenant_id: tenantId,
          created_at: { gte: start, lte: end },
          NOT: { origin: null },
        },
        _count: { _all: true },
        orderBy: { _count: { origin: 'desc' } },
        take: 10,
      }),
    ]);

    // Hidrata top procedures com nomes
    const procedureIds = topProcedures.map((t: any) => t.procedure_id).filter(Boolean) as string[];
    const procs = procedureIds.length
      ? await this.prisma.procedure.findMany({
          where: { id: { in: procedureIds } },
          select: { id: true, name: true, category: true },
        })
      : [];
    const procMap = new Map(procs.map((p) => [p.id, p]));
    const topProceduresEnriched = topProcedures.map((t: any) => ({
      procedure_id: t.procedure_id,
      name: procMap.get(t.procedure_id)?.name || 'Sem nome',
      category: procMap.get(t.procedure_id)?.category || null,
      revenue: Number(t._sum?.total_price || 0),
      count: t._count?._all || 0,
    }));

    // Conversao
    const sent = quotesSent;
    const accepted = quotesAccepted._count._all;
    const conversionPct = sent > 0 ? (accepted / sent) * 100 : 0;
    // Taxa de faltas
    const missesPct = apptsTotal > 0 ? (apptsCancelled / apptsTotal) * 100 : 0;

    return {
      period: { start, end, preset: opts.period || (opts.from && opts.to ? 'custom' : 'month') },
      sales: {
        revenue: Number(quotesAccepted._sum.total_value || 0),
        accepted_quotes: accepted,
        sent_quotes: sent,
        conversion_pct: Number(conversionPct.toFixed(1)),
      },
      schedule: {
        total: apptsTotal,
        confirmed: apptsConfirmed,
        cancelled: apptsCancelled,
        no_show: apptsNoShow,
        misses_pct: Number(missesPct.toFixed(1)),
      },
      financial: {
        paid: { total: Number(installmentsPaid._sum.amount_paid || 0), count: installmentsPaid._count._all },
        open: { total: Number(installmentsOpen._sum.amount || 0), count: installmentsOpen._count._all },
        overdue: { total: Number(installmentsOverdue._sum.amount || 0), count: installmentsOverdue._count._all },
      },
      commissions: {
        due: { total: Number(commissionsDue._sum.amount || 0), count: commissionsDue._count._all },
        available: { total: Number(commissionsAvailable._sum.amount || 0), count: commissionsAvailable._count._all },
        paid: { total: Number(commissionsPaid._sum.amount || 0), count: commissionsPaid._count._all },
      },
      patients: {
        new: newPatients,
        first_consultations: firstConsultations,
      },
      top_procedures: topProceduresEnriched,
      patient_origins: patientOrigins.map((o: any) => ({
        origin: o.origin || 'Nao informado',
        count: o._count._all,
      })),
    };
  }

  /** Lista catalogo de relatorios disponiveis (50+ no plano original Clinicorp). */
  async catalog() {
    return [
      // Agenda
      { id: 'appointments_by_day',       group: 'Agenda',     name: 'Consultas por dia' },
      { id: 'appointments_by_pro',       group: 'Agenda',     name: 'Consultas por profissional' },
      { id: 'cancellations',             group: 'Agenda',     name: 'Cancelamentos e faltas' },
      { id: 'occupation',                group: 'Agenda',     name: 'Ocupacao da agenda' },
      { id: 'first_consultations',       group: 'Agenda',     name: 'Primeiras consultas' },
      { id: 'birthdays',                 group: 'Agenda',     name: 'Aniversariantes do mes' },
      { id: 'last_visit',                group: 'Agenda',     name: 'Ultima consulta (sem retorno)' },
      { id: 'return_alerts',             group: 'Agenda',     name: 'Alertas de retorno' },
      { id: 'markers',                   group: 'Agenda',     name: 'Por marcadores' },
      // Financeiro basico
      { id: 'revenue',                   group: 'Financeiro', name: 'Faturamento' },
      { id: 'revenue_by_pro',            group: 'Financeiro', name: 'Faturamento por profissional' },
      { id: 'revenue_by_specialty',      group: 'Financeiro', name: 'Faturamento por especialidade' },
      { id: 'revenue_by_procedure',      group: 'Financeiro', name: 'Faturamento por procedimento' },
      { id: 'paid_installments',         group: 'Financeiro', name: 'Parcelas pagas' },
      { id: 'overdue_installments',      group: 'Financeiro', name: 'Parcelas em atraso' },
      { id: 'open_installments',         group: 'Financeiro', name: 'Parcelas em aberto' },
      // Financeiro avancado
      { id: 'cashflow',                  group: 'Financeiro', name: 'Fluxo de caixa' },
      { id: 'avg_ticket',                group: 'Financeiro', name: 'Ticket medio' },
      { id: 'avg_installments',          group: 'Financeiro', name: 'Parcelamento medio' },
      { id: 'collection_rate',           group: 'Financeiro', name: 'Taxa de cobranca (regua)' },
      { id: 'invoices_issued',           group: 'Financeiro', name: 'Notas fiscais emitidas' },
      // Orcamento
      { id: 'quotes_sent',               group: 'Orcamento',  name: 'Orcamentos enviados' },
      { id: 'quotes_accepted',           group: 'Orcamento',  name: 'Orcamentos aprovados' },
      { id: 'quotes_rejected',           group: 'Orcamento',  name: 'Orcamentos recusados' },
      { id: 'conversion_rate',           group: 'Orcamento',  name: 'Taxa de conversao' },
      { id: 'pending_followup',          group: 'Orcamento',  name: 'Pendentes de follow-up' },
      // Comissoes
      { id: 'commissions_summary',       group: 'Comissoes',  name: 'Resumo mensal' },
      { id: 'commissions_payable',       group: 'Comissoes',  name: 'A pagar (DISPONIVEL)' },
      { id: 'commissions_history',       group: 'Comissoes',  name: 'Historico pagas' },
      // Pacientes / Captacao
      { id: 'new_patients',              group: 'Captacao',   name: 'Novos pacientes' },
      { id: 'patient_origins',           group: 'Captacao',   name: 'Origem de pacientes' },
      { id: 'patient_locations',         group: 'Captacao',   name: 'Localizacao geografica' },
      { id: 'patient_age',               group: 'Captacao',   name: 'Faixa etaria' },
      { id: 'patient_referrals',         group: 'Captacao',   name: 'Indicacoes' },
      { id: 'leads_funnel',              group: 'Captacao',   name: 'Funil de leads' },
      { id: 'campaign_performance',      group: 'Captacao',   name: 'Performance de campanhas' },
      // Estetica facial
      { id: 'esthetic_applications',     group: 'Estetica',   name: 'Aplicacoes esteticas' },
      { id: 'esthetic_revisits_due',     group: 'Estetica',   name: 'Retornos esteticos previstos' },
      { id: 'esthetic_by_product',       group: 'Estetica',   name: 'Aplicacoes por produto' },
      { id: 'esthetic_by_pro',           group: 'Estetica',   name: 'Aplicacoes por profissional' },
      { id: 'adverse_reactions',         group: 'Estetica',   name: 'Reacoes adversas' },
      // Estoque
      { id: 'stock_low',                 group: 'Estoque',    name: 'Produtos em baixa' },
      { id: 'stock_expiring',            group: 'Estoque',    name: 'Produtos vencendo' },
      { id: 'stock_movements',           group: 'Estoque',    name: 'Movimentacoes' },
      { id: 'stock_consumption',         group: 'Estoque',    name: 'Consumo por procedimento' },
      { id: 'stock_anvisa_traceability', group: 'Estoque',    name: 'Rastreabilidade ANVISA por lote' },
      // Operacional
      { id: 'goals',                     group: 'Operacional', name: 'Metas e projecao' },
      { id: 'productivity_pro',          group: 'Operacional', name: 'Produtividade por profissional' },
      { id: 'audit_log',                 group: 'Operacional', name: 'Log de auditoria' },
      { id: 'ai_usage',                  group: 'Operacional', name: 'Uso de IA' },
    ];
  }
}
