'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  BarChart3, Loader2, TrendingUp, TrendingDown, Calendar, Wallet,
  Users, Sparkles, Package, Banknote, Target, ChevronRight,
} from 'lucide-react';
import api from '@/lib/api';
import { showError } from '@/lib/toast';

interface DashboardData {
  period: { start: string; end: string; preset: string };
  sales: { revenue: number; accepted_quotes: number; sent_quotes: number; conversion_pct: number };
  schedule: { total: number; confirmed: number; cancelled: number; no_show: number; misses_pct: number };
  financial: {
    paid: { total: number; count: number };
    open: { total: number; count: number };
    overdue: { total: number; count: number };
  };
  commissions: {
    due: { total: number; count: number };
    available: { total: number; count: number };
    paid: { total: number; count: number };
  };
  patients: { new: number; first_consultations: number };
  top_procedures: Array<{ procedure_id: string; name: string; category: string | null; revenue: number; count: number }>;
  patient_origins: Array<{ origin: string; count: number }>;
}

interface CatalogItem { id: string; group: string; name: string }

const PRESETS = [
  { v: 'today',      label: 'Hoje' },
  { v: 'week',       label: '7 dias' },
  { v: 'month',      label: 'Este mes' },
  { v: 'last_month', label: 'Mes passado' },
  { v: 'last_30',    label: '30 dias' },
  { v: 'last_90',    label: '90 dias' },
  { v: 'year',       label: 'Este ano' },
];

const fmtBRL = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

export default function RelatoriosPage() {
  const [period, setPeriod] = useState('month');
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<DashboardData | null>(null);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [dash, cat] = await Promise.all([
        api.get<DashboardData>(`/reports/dashboard?period=${period}`),
        api.get<CatalogItem[]>('/reports/catalog'),
      ]);
      setData(dash.data);
      setCatalog(cat.data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar relatorios');
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  const groupedCatalog = catalog
    .filter((r) => !search || r.name.toLowerCase().includes(search.toLowerCase()))
    .reduce((acc, r) => {
      (acc[r.group] = acc[r.group] || []).push(r);
      return acc;
    }, {} as Record<string, CatalogItem[]>);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <BarChart3 size={26} className="text-primary" /> Relatorios
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Hub agregado de KPIs + catalogo de {catalog.length} relatorios disponiveis.
          </p>
        </div>
        <div className="flex gap-1 bg-card border border-border rounded-lg p-1">
          {PRESETS.map((p) => (
            <button
              key={p.v}
              onClick={() => setPeriod(p.v)}
              className={`px-3 py-1 text-xs rounded font-medium ${
                period === p.v
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : !data ? (
        <p className="text-sm text-muted-foreground">Sem dados.</p>
      ) : (
        <>
          {/* KPI cards (linha 1: vendas, agenda, financeiro, comissoes) */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <KPICard
              icon={<Banknote size={14} />}
              label="Vendas (Quote ACCEPTED)"
              value={fmtBRL(data.sales.revenue)}
              subValue={`${data.sales.accepted_quotes} aprovados / ${data.sales.sent_quotes} enviados`}
              extra={`${data.sales.conversion_pct.toFixed(1)}% conversao`}
              color="text-primary"
            />
            <KPICard
              icon={<Calendar size={14} />}
              label="Consultas"
              value={data.schedule.total.toString()}
              subValue={`${data.schedule.confirmed} confirmadas`}
              extra={`${data.schedule.misses_pct.toFixed(1)}% faltas`}
              color="text-blue-600"
            />
            <KPICard
              icon={<Wallet size={14} />}
              label="Inadimplencia"
              value={fmtBRL(data.financial.overdue.total)}
              subValue={`${data.financial.overdue.count} parcela(s)`}
              extra={`Aberto: ${fmtBRL(data.financial.open.total)}`}
              color={data.financial.overdue.total > 0 ? 'text-destructive' : 'text-green-700'}
            />
            <KPICard
              icon={<Banknote size={14} />}
              label="Comissoes a pagar"
              value={fmtBRL(data.commissions.available.total)}
              subValue={`${data.commissions.available.count} comissao(oes)`}
              extra={`Devida: ${fmtBRL(data.commissions.due.total)}`}
              color="text-amber-600"
            />
          </div>

          {/* Linha 2: pacientes + recebido */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
            <KPICard
              icon={<Users size={14} />}
              label="Novos pacientes"
              value={data.patients.new.toString()}
              subValue={`${data.patients.first_consultations} primeiras consultas`}
              color="text-green-700"
            />
            <KPICard
              icon={<TrendingUp size={14} />}
              label="Recebido no periodo"
              value={fmtBRL(data.financial.paid.total)}
              subValue={`${data.financial.paid.count} parcela(s) pagas`}
              color="text-green-700"
            />
            <KPICard
              icon={<TrendingDown size={14} />}
              label="Faltas + adiamentos"
              value={(data.schedule.cancelled + data.schedule.no_show).toString()}
              subValue={`${data.schedule.cancelled} cancelados + ${data.schedule.no_show} adiados`}
              color="text-red-600"
            />
          </div>

          {/* Top procedimentos + Origem */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
            <div className="bg-card border border-border rounded-xl p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3 flex items-center gap-1">
                <Sparkles size={11} /> Top procedimentos
              </h3>
              {data.top_procedures.length === 0 ? (
                <p className="text-sm text-muted-foreground py-3 text-center">Sem dados no periodo.</p>
              ) : (
                <ul className="space-y-1.5">
                  {data.top_procedures.slice(0, 8).map((p, i) => (
                    <li key={p.procedure_id} className="flex items-center justify-between gap-2 text-sm">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <span className="text-xs text-muted-foreground w-4">{i + 1}.</span>
                        <span className="truncate">{p.name}</span>
                        {p.category && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
                            {p.category}
                          </span>
                        )}
                      </div>
                      <div className="text-right text-xs">
                        <div className="font-mono font-bold">{fmtBRL(p.revenue)}</div>
                        <div className="text-muted-foreground">{p.count}x</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="bg-card border border-border rounded-xl p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3 flex items-center gap-1">
                <Users size={11} /> Origem dos pacientes (leads)
              </h3>
              {data.patient_origins.length === 0 ? (
                <p className="text-sm text-muted-foreground py-3 text-center">Sem leads no periodo.</p>
              ) : (
                <ul className="space-y-1.5">
                  {data.patient_origins.map((o) => {
                    const total = data.patient_origins.reduce((s, x) => s + x.count, 0);
                    const pct = total > 0 ? (o.count / total) * 100 : 0;
                    return (
                      <li key={o.origin} className="flex items-center gap-2 text-sm">
                        <span className="flex-1 truncate">{o.origin}</span>
                        <div className="w-24 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-primary"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-xs font-mono w-10 text-right">{o.count}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </>
      )}

      {/* Catalogo */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold">Catalogo de relatorios</h2>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar..."
            className="px-3 py-1.5 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 max-w-xs"
          />
        </div>

        {Object.keys(groupedCatalog).length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Nenhum relatorio encontrado.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {Object.entries(groupedCatalog).map(([group, items]) => (
              <div key={group} className="bg-card border border-border rounded-xl p-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  {group} <span className="text-[10px] opacity-60">({items.length})</span>
                </h3>
                <ul className="space-y-1">
                  {items.map((r) => (
                    <li key={r.id}>
                      <button
                        className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-accent flex items-center justify-between group"
                        onClick={() => alert(`Relatorio "${r.name}" — em breve. ID: ${r.id}`)}
                      >
                        <span>{r.name}</span>
                        <ChevronRight size={12} className="opacity-0 group-hover:opacity-50" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function KPICard({
  icon, label, value, subValue, extra, color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  subValue?: string;
  extra?: string;
  color: string;
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
        {icon} {label}
      </div>
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      {subValue && <div className="text-xs text-muted-foreground mt-0.5">{subValue}</div>}
      {extra && <div className="text-[10px] text-muted-foreground mt-1">{extra}</div>}
    </div>
  );
}
