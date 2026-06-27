'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Network, Loader2, Trophy, TrendingUp, Calendar, Banknote, Building2, MapPin, Award,
} from 'lucide-react';
import api from '@/lib/api';
import { showError } from '@/lib/toast';

interface RankingRow {
  clinic_id: string;
  name: string;
  city: string | null;
  type: string;
  revenue: number;
  quotes_count: number;
  appointments_count: number;
  commissions_paid: number;
}

interface RankingData {
  period: { start: string; end: string };
  total_clinics: number;
  total_revenue: number;
  ranking: RankingRow[];
}

const PRESETS = [
  { v: 'month',      label: 'Este mes',    days: null },
  { v: 'last_month', label: 'Mes passado', days: null },
  { v: 'last_30',    label: '30 dias',     days: 30 },
  { v: 'last_90',    label: '90 dias',     days: 90 },
  { v: 'year',       label: 'Este ano',    days: null },
];

const fmtBRL = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

function periodToDates(preset: string): { from: string; to: string } {
  const now = new Date();
  const today = new Date();
  today.setHours(23, 59, 59, 999);

  let start = new Date(now);

  switch (preset) {
    case 'month':
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'last_month': {
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
    }
    case 'last_30':
      start.setDate(start.getDate() - 30);
      break;
    case 'last_90':
      start.setDate(start.getDate() - 90);
      break;
    case 'year':
      start = new Date(now.getFullYear(), 0, 1);
      break;
  }
  start.setHours(0, 0, 0, 0);
  return { from: start.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) };
}

export default function MinhaRedePage() {
  const [period, setPeriod] = useState('month');
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<RankingData | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = periodToDates(period);
      const { data } = await api.get<RankingData>(`/clinics/ranking?from=${from}&to=${to}`);
      setData(data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar ranking');
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="h-full overflow-y-auto p-6 w-full">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Network size={26} className="text-primary" /> Minha rede
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Comparativo entre as unidades da sua rede no periodo selecionado.
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
      ) : !data || data.ranking.length === 0 ? (
        <div className="p-12 text-center text-sm text-muted-foreground bg-card border border-border rounded-xl">
          <Building2 size={28} className="mx-auto mb-2 opacity-50" />
          <p className="mb-2">Nenhuma unidade cadastrada.</p>
          <p className="text-xs">Cadastre suas unidades em Configuracoes &gt; Unidades / Salas para ver o ranking.</p>
        </div>
      ) : (
        <>
          {/* Topo: total */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
            <div className="bg-card border border-border rounded-xl p-4">
              <div className="text-[10px] uppercase text-muted-foreground flex items-center gap-1 mb-1">
                <Building2 size={11} /> Unidades ativas
              </div>
              <div className="text-2xl font-bold text-foreground">{data.total_clinics}</div>
            </div>
            <div className="bg-card border border-border rounded-xl p-4">
              <div className="text-[10px] uppercase text-muted-foreground flex items-center gap-1 mb-1">
                <Banknote size={11} /> Faturamento total
              </div>
              <div className="text-2xl font-bold text-primary">{fmtBRL(data.total_revenue)}</div>
            </div>
            <div className="bg-card border border-border rounded-xl p-4">
              <div className="text-[10px] uppercase text-muted-foreground flex items-center gap-1 mb-1">
                <TrendingUp size={11} /> Media por unidade
              </div>
              <div className="text-2xl font-bold text-green-700">
                {fmtBRL(data.total_clinics > 0 ? data.total_revenue / data.total_clinics : 0)}
              </div>
            </div>
          </div>

          {/* Podio top 3 */}
          {data.ranking.length >= 1 && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
              {data.ranking.slice(0, 3).map((r, i) => {
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
                const bgs = ['bg-amber-500/10 border-amber-500/30', 'bg-gray-500/10 border-gray-500/30', 'bg-orange-700/10 border-orange-700/30'];
                return (
                  <div key={r.clinic_id} className={`bg-card border rounded-xl p-4 ${bgs[i]}`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-2xl">{medal}</span>
                      <Award size={20} className="opacity-40" />
                    </div>
                    <h3 className="font-semibold text-foreground">{r.name}</h3>
                    {r.city && <p className="text-xs text-muted-foreground flex items-center gap-1"><MapPin size={10} /> {r.city}</p>}
                    <div className="text-xl font-bold text-primary mt-3">{fmtBRL(r.revenue)}</div>
                    <p className="text-[10px] text-muted-foreground">
                      {r.quotes_count} venda(s) · {r.appointments_count} consulta(s)
                    </p>
                  </div>
                );
              })}
            </div>
          )}

          {/* Tabela ranking completa */}
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center gap-2">
              <Trophy size={14} className="text-primary" />
              <h3 className="text-sm font-semibold">Ranking completo</h3>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 w-10">#</th>
                  <th className="px-3 py-2">Unidade</th>
                  <th className="px-3 py-2 text-right">Faturamento</th>
                  <th className="px-3 py-2 text-right">Vendas</th>
                  <th className="px-3 py-2 text-right">Consultas</th>
                  <th className="px-3 py-2 text-right">Comissoes pagas</th>
                </tr>
              </thead>
              <tbody>
                {data.ranking.map((r, i) => {
                  const pct = data.total_revenue > 0 ? (r.revenue / data.total_revenue) * 100 : 0;
                  return (
                    <tr key={r.clinic_id} className="border-b border-border last:border-0 hover:bg-accent/30">
                      <td className="px-3 py-2 text-xs font-bold text-muted-foreground">{i + 1}</td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{r.name}</div>
                        {r.city && <div className="text-[10px] text-muted-foreground">{r.city}</div>}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="font-mono font-semibold">{fmtBRL(r.revenue)}</div>
                        <div className="text-[10px] text-muted-foreground">{pct.toFixed(1)}% do total</div>
                      </td>
                      <td className="px-3 py-2 text-right text-xs">
                        {r.quotes_count}
                      </td>
                      <td className="px-3 py-2 text-right text-xs">
                        <span className="inline-flex items-center gap-1">
                          <Calendar size={10} /> {r.appointments_count}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        {fmtBRL(r.commissions_paid)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-[10px] text-muted-foreground mt-3 text-center">
            Periodo: {new Date(data.period.start).toLocaleDateString('pt-BR')} a {new Date(data.period.end).toLocaleDateString('pt-BR')}.
            Metricas baseadas nos usuarios atribuidos a cada unidade.
          </p>
        </>
      )}
    </div>
  );
}
