'use client';

/**
 * Visão Geral · Financeiro (Onda 17.1).
 *
 * Painel gerencial dedicado: KPIs + graficos do modulo financeiro
 * num so lugar. Reaproveita charts existentes da pasta /dashboard
 * (RevenueTrendChart, FinancialAgingChart) + os 4 KPIs novos do
 * /financeiro/dashboard (Onda 16) + widgets Top atrasos / Entrada
 * do dia / Proximos vencimentos.
 *
 * NAO eh a aba "Resumo" do /atendimento/financeiro (que tem mesma
 * info mas em layout de cards compacto + tabela). Esta aqui eh
 * MAIS VISUAL, com graficos. Coexistem porque tem usuarios que
 * preferem cada estilo.
 *
 * Endpoints:
 *  - GET /financeiro/dashboard (KPIs + widgets)
 *  - GET /dashboard/revenue-trend (chart 12m)
 *  - GET /dashboard/financial-aging (chart aging)
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  DollarSign, Clock, AlertTriangle, TrendingUp, BarChart3, ExternalLink,
  CreditCard, ArrowRight,
} from 'lucide-react';
import api from '@/lib/api';
import { showError } from '@/lib/toast';
import { useRevenueTrend, useFinancialAging } from '../../dashboard/hooks/useAnalyticsData';
import { RevenueTrendChart } from '../../dashboard/components/charts/RevenueTrendChart';
import { FinancialAgingChart } from '../../dashboard/components/charts/FinancialAgingChart';

interface DashboardData {
  recebido_no_periodo: { value: number; count: number };
  a_receber_total: { value: number; count: number };
  atrasado: { value: number; count: number; dias_medio: number };
  a_vencer_7d: { value: number; count: number };
  proximos_vencimentos: {
    id: string;
    kind: string | null;
    amount: number;
    due_date: string;
    days_overdue: number;
    boleto_url: string | null;
    patient: { id: string; name: string | null; phone: string | null } | null;
  }[];
  top_atrasos: {
    id: string;
    kind: string | null;
    amount: number;
    due_date: string;
    days_overdue: number;
    boleto_url: string | null;
    patient: { id: string; name: string | null; phone: string | null } | null;
  }[];
  entrada_do_dia?: {
    value: number;
    count: number;
    items: {
      id: string;
      kind: string | null;
      amount: number;
      paid_at: string;
      billing_type: string;
      received_in_cash: boolean;
      patient: { id: string; name: string | null; phone: string | null } | null;
    }[];
  };
}

const fmt = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const PERIODS = [
  { label: 'Mês', value: 'mes' },
  { label: 'Trimestre', value: 'trimestre' },
  { label: 'Ano', value: 'ano' },
] as const;

function getPeriodRange(period: string): { startDate: string; endDate: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  let start: Date;
  let end: Date;
  switch (period) {
    case 'trimestre':
      start = new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1));
      end = new Date(Date.UTC(y, Math.floor(m / 3) * 3 + 3, 0, 23, 59, 59));
      break;
    case 'ano':
      start = new Date(Date.UTC(y, 0, 1));
      end = new Date(Date.UTC(y, 11, 31, 23, 59, 59));
      break;
    default: // mes
      start = new Date(Date.UTC(y, m, 1));
      end = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59));
      break;
  }
  return { startDate: start.toISOString(), endDate: end.toISOString() };
}

/* ───────────────────────────────────────────────────────────────
   KPI Card (mesma visual da aba Resumo)
─────────────────────────────────────────────────────────────── */
function KpiCard({
  icon: Icon, label, value, color, bgColor,
}: { icon: any; label: string; value: string; color: string; bgColor: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className={`w-8 h-8 rounded-lg ${bgColor} flex items-center justify-center mb-2`}>
        <Icon size={16} className={color} />
      </div>
      <p className={`text-xl font-bold ${color} tabular-nums`}>{value}</p>
      <p className="text-xs text-muted-foreground mt-0.5 font-semibold uppercase tracking-wide">{label}</p>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   PAGE
═══════════════════════════════════════════════════════════════ */
export default function VisaoGeralFinanceiroPage() {
  const router = useRouter();
  const [period, setPeriod] = useState<string>('mes');
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  // Hooks de analytics (charts)
  const { data: revenueTrend, loading: revenueLoading } = useRevenueTrend(12);
  const { data: agingData, loading: agingLoading } = useFinancialAging();

  // Fetch dashboard KPIs
  const fetchDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const { startDate, endDate } = getPeriodRange(period);
      const r = await api.get('/financeiro/dashboard', { params: { startDate, endDate } });
      setDashboard(r.data);
    } catch (e: any) {
      const status = e?.response?.status;
      const msg = e?.response?.data?.message || e?.message || 'erro desconhecido';
      if (status === 404) {
        showError('Endpoint /financeiro/dashboard não disponível. Backend ainda não deployou.');
      } else {
        showError(`Erro ao carregar dashboard (${status || 'sem status'}): ${msg}`);
      }
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="w-full p-4 md:p-6 space-y-5 pb-28 md:pb-6 max-w-screen-2xl mx-auto">

        {/* ─── Header ─── */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/15 flex items-center justify-center">
              <BarChart3 size={20} className="text-emerald-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Visão Geral · Financeiro</h1>
              <p className="text-xs text-muted-foreground">
                KPIs + gráficos do módulo. Para tabela detalhada, use{' '}
                <Link href="/atendimento/financeiro" className="text-primary hover:underline">
                  Financeiro
                </Link>{' '}
                ou{' '}
                <Link href="/atendimento/financeiro?tab=Boletos" className="text-primary hover:underline">
                  Boletos
                </Link>
                .
              </p>
            </div>
          </div>

          {/* Period selector */}
          <div className="flex items-center gap-1 bg-card border border-border rounded-xl p-1">
            {PERIODS.map((p) => (
              <button
                key={p.value}
                onClick={() => setPeriod(p.value)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  period === p.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent/30'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* ─── 4 KPIs ─── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard
            icon={DollarSign}
            label={dashboard ? `Recebido (${dashboard.recebido_no_periodo.count})` : 'Recebido'}
            value={fmt(dashboard?.recebido_no_periodo.value ?? 0)}
            color="text-emerald-400"
            bgColor="bg-emerald-500/15"
          />
          <KpiCard
            icon={Clock}
            label={dashboard ? `A receber (${dashboard.a_receber_total.count})` : 'A Receber'}
            value={fmt(dashboard?.a_receber_total.value ?? 0)}
            color="text-blue-400"
            bgColor="bg-blue-500/15"
          />
          <KpiCard
            icon={AlertTriangle}
            label={
              dashboard
                ? `Atrasado (${dashboard.atrasado.count}${dashboard.atrasado.dias_medio > 0 ? ` · ${dashboard.atrasado.dias_medio}d` : ''})`
                : 'Atrasado'
            }
            value={fmt(dashboard?.atrasado.value ?? 0)}
            color="text-red-400"
            bgColor="bg-red-500/15"
          />
          <KpiCard
            icon={TrendingUp}
            label={dashboard ? `Vencem 7d (${dashboard.a_vencer_7d.count})` : 'A vencer 7d'}
            value={fmt(dashboard?.a_vencer_7d.value ?? 0)}
            color="text-amber-400"
            bgColor="bg-amber-500/15"
          />
        </div>

        {/* ─── Charts: Receita + Aging ─── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <RevenueTrendChart data={revenueTrend} loading={revenueLoading} />
          <FinancialAgingChart data={agingData} loading={agingLoading} />
        </div>

        {/* ─── Widgets: Top atrasos + Entrada do dia ─── */}
        {dashboard && (dashboard.top_atrasos.length > 0 || (dashboard.entrada_do_dia?.count ?? 0) > 0) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* Top atrasos */}
            {dashboard.top_atrasos.length > 0 && (
              <div className="bg-card border border-red-500/20 rounded-xl p-4">
                <h3 className="text-sm font-bold text-red-400 mb-3 flex items-center gap-2">
                  <AlertTriangle size={14} />
                  Top atrasos ({dashboard.top_atrasos.length})
                </h3>
                <div className="space-y-2">
                  {dashboard.top_atrasos.slice(0, 5).map((c) => (
                    <button
                      key={c.id}
                      onClick={() => c.patient?.id && router.push(`/atendimento/pacientes/${c.patient.id}`)}
                      className="w-full flex items-center justify-between text-sm hover:bg-accent/10 -mx-2 px-2 py-1 rounded transition-colors text-left"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-bold text-red-400 shrink-0">{c.days_overdue}d</span>
                        <span className="text-foreground truncate">{c.patient?.name || 'Sem nome'}</span>
                      </div>
                      <span className="text-xs font-bold text-red-400 tabular-nums shrink-0">{fmt(c.amount)}</span>
                    </button>
                  ))}
                </div>
                <Link
                  href="/atendimento/financeiro"
                  className="text-[10px] font-bold text-red-400 hover:underline mt-3 inline-flex items-center gap-1"
                >
                  Ver todos <ArrowRight size={11} />
                </Link>
              </div>
            )}

            {/* Entrada do dia */}
            {(dashboard.entrada_do_dia?.count ?? 0) > 0 ? (
              <div className="bg-card border border-emerald-500/20 rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-bold text-emerald-400 flex items-center gap-2">
                    <DollarSign size={14} />
                    Entrada do dia ({dashboard.entrada_do_dia?.count})
                  </h3>
                  <span className="text-sm font-bold text-emerald-400 tabular-nums">
                    {fmt(dashboard.entrada_do_dia?.value ?? 0)}
                  </span>
                </div>
                <div className="space-y-2">
                  {(dashboard.entrada_do_dia?.items ?? []).slice(0, 5).map((c) => {
                    const hora = new Date(c.paid_at).toLocaleTimeString('pt-BR', {
                      hour: '2-digit', minute: '2-digit',
                    });
                    return (
                      <button
                        key={c.id}
                        onClick={() => c.patient?.id && router.push(`/atendimento/pacientes/${c.patient.id}`)}
                        className="w-full flex items-center justify-between text-sm hover:bg-accent/10 -mx-2 px-2 py-1 rounded transition-colors text-left"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-[10px] font-bold text-emerald-400 shrink-0 tabular-nums w-10">{hora}</span>
                          <span className="text-foreground truncate">{c.patient?.name || 'Sem nome'}</span>
                          <span className="text-[10px] text-muted-foreground shrink-0">
                            {c.received_in_cash ? 'Espécie' : c.billing_type}
                          </span>
                        </div>
                        <span className="text-xs font-bold text-emerald-400 tabular-nums shrink-0">{fmt(c.amount)}</span>
                      </button>
                    );
                  })}
                </div>
                <Link
                  href="/atendimento/financeiro?tab=Boletos"
                  className="text-[10px] font-bold text-emerald-400 hover:underline mt-3 inline-flex items-center gap-1"
                >
                  Ver todos <ArrowRight size={11} />
                </Link>
              </div>
            ) : (
              <div className="bg-card border border-border rounded-xl p-4 flex flex-col items-center justify-center text-center min-h-[140px]">
                <DollarSign size={20} className="text-muted-foreground/40 mb-2" />
                <p className="text-xs text-muted-foreground font-semibold">Entrada do dia</p>
                <p className="text-[11px] text-muted-foreground/60 mt-1">Nenhuma cobrança paga hoje ainda</p>
              </div>
            )}
          </div>
        )}

        {/* ─── Próximos vencimentos (full width) ─── */}
        {dashboard && dashboard.proximos_vencimentos.length > 0 && (
          <div className="bg-card border border-amber-500/20 rounded-xl p-4">
            <h3 className="text-sm font-bold text-amber-400 mb-3 flex items-center gap-2">
              <Clock size={14} />
              Próximos vencimentos (7 dias)
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2">
              {dashboard.proximos_vencimentos.slice(0, 10).map((c) => {
                const dt = new Date(c.due_date);
                const days = Math.ceil((dt.getTime() - Date.now()) / 86400000);
                return (
                  <button
                    key={c.id}
                    onClick={() => c.patient?.id && router.push(`/atendimento/pacientes/${c.patient.id}`)}
                    className="w-full flex items-center justify-between text-sm hover:bg-accent/10 -mx-2 px-2 py-1 rounded transition-colors text-left"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`text-xs font-bold shrink-0 ${days <= 3 ? 'text-red-400' : 'text-amber-400'}`}>{days}d</span>
                      <span className="text-foreground truncate">{c.patient?.name || 'Sem nome'}</span>
                    </div>
                    <span className="text-xs font-bold text-amber-400 tabular-nums shrink-0">{fmt(c.amount)}</span>
                  </button>
                );
              })}
            </div>
            <Link
              href="/atendimento/financeiro?tab=Boletos"
              className="text-[10px] font-bold text-amber-400 hover:underline mt-3 inline-flex items-center gap-1"
            >
              Ver todos <ArrowRight size={11} />
            </Link>
          </div>
        )}

        {/* ─── Estado vazio ─── */}
        {!loading && dashboard && dashboard.a_receber_total.count === 0 && dashboard.recebido_no_periodo.count === 0 && (
          <div className="bg-card border border-border rounded-xl p-12 text-center">
            <CreditCard size={36} className="mx-auto text-muted-foreground/40 mb-3" />
            <p className="text-sm font-bold text-foreground mb-1">Nenhuma cobrança registrada ainda</p>
            <p className="text-xs text-muted-foreground max-w-md mx-auto">
              Quando você emitir cobranças via "Aprovar e cobrar" na ficha do paciente,
              elas vão aparecer aqui automaticamente.
            </p>
            <Link
              href="/atendimento/pacientes"
              className="inline-flex items-center gap-2 mt-4 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-xs font-semibold hover:opacity-90 transition-opacity"
            >
              Ir para pacientes <ExternalLink size={12} />
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
