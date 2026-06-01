'use client';

/**
 * PacientesSummaryTab — Onda 16 (Sistema Financeiro Completo).
 *
 * Visão "conta corrente" por paciente: agrega TreatmentPlan + charges e
 * mostra total contratado / recebido / em aberto / atrasado.
 *
 * Ordenavel: maior inadimplencia (default), maior em aberto, maior recebido.
 *
 * Endpoint: GET /financeiro/patients-summary
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Search, ExternalLink, AlertTriangle, Users, ArrowUpDown } from 'lucide-react';
import api from '@/lib/api';
import { showError } from '@/lib/toast';

interface PatientRow {
  patient_id: string;
  patient_name: string | null;
  patient_phone: string | null;
  total_contratado: number;
  recebido: number;
  em_aberto: number;
  atrasado: number;
  plans_count: number;
}

interface Props {
  dentistId?: string;
}

const fmtBRL = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const ORDER_OPTIONS = [
  { key: 'atrasado', label: 'Maior em atraso' },
  { key: 'em_aberto', label: 'Maior em aberto' },
  { key: 'recebido', label: 'Maior recebido' },
] as const;

export default function PacientesSummaryTab({ dentistId }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<PatientRow[]>([]);
  const [orderBy, setOrderBy] = useState<typeof ORDER_OPTIONS[number]['key']>('atrasado');
  const [search, setSearch] = useState('');

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params: any = { orderBy, limit: 200 };
      if (dentistId) params.dentistId = dentistId;
      const r = await api.get('/financeiro/patients-summary', { params });
      setRows(r.data?.data || []);
    } catch (e: any) {
      const status = e?.response?.status;
      const msg = e?.response?.data?.message || e?.message || 'erro desconhecido';
      if (status === 404) {
        showError('Endpoint /financeiro/patients-summary não disponível. Backend ainda não deployou.');
      } else {
        showError(`Erro ao carregar resumo (${status || 'sem status'}): ${msg}`);
      }
    } finally {
      setLoading(false);
    }
  }, [orderBy, dentistId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const s = search.toLowerCase();
    return rows.filter((r) => r.patient_name?.toLowerCase().includes(s));
  }, [rows, search]);

  const totals = useMemo(() => {
    return filtered.reduce(
      (acc, p) => {
        acc.contratado += p.total_contratado;
        acc.recebido += p.recebido;
        acc.em_aberto += p.em_aberto;
        acc.atrasado += p.atrasado;
        return acc;
      },
      { contratado: 0, recebido: 0, em_aberto: 0, atrasado: 0 },
    );
  }, [filtered]);

  return (
    <div className="space-y-4">
      {/* Header com filtros + totais */}
      <div className="bg-card border border-border rounded-xl p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-background border border-border rounded-lg flex-1 min-w-[200px]">
            <Search size={13} className="text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar paciente..."
              className="flex-1 bg-transparent text-xs focus:outline-none"
            />
          </div>
          <select
            value={orderBy}
            onChange={(e) => setOrderBy(e.target.value as any)}
            className="px-3 py-1.5 text-xs bg-background border border-border rounded-lg focus:outline-none"
          >
            {ORDER_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {/* Totais agregados */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pt-2 border-t border-border/50">
          <Stat label="Contratado total" value={fmtBRL(totals.contratado)} color="text-foreground" />
          <Stat label="Recebido" value={fmtBRL(totals.recebido)} color="text-emerald-400" />
          <Stat label="Em aberto" value={fmtBRL(totals.em_aberto)} color="text-blue-400" />
          <Stat label="Atrasado" value={fmtBRL(totals.atrasado)} color="text-red-400" />
        </div>
      </div>

      {/* Lista */}
      {loading ? (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <Loader2 size={24} className="mx-auto animate-spin text-primary" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <Users size={32} className="mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">Nenhum paciente com cobranças</p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Paciente</th>
                  <th className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide text-right">Contratado</th>
                  <th className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide text-right">Recebido</th>
                  <th className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide text-right">Em aberto</th>
                  <th className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide text-right">Atrasado</th>
                  <th className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide text-right">% Pago</th>
                  <th className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide text-center">Ação</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const pctPaid =
                    p.total_contratado > 0
                      ? Math.round((p.recebido / p.total_contratado) * 100)
                      : 0;
                  return (
                    <tr key={p.patient_id} className="border-b border-border/50 hover:bg-accent/10 transition-colors">
                      <td className="px-3 py-2.5">
                        <div className="flex flex-col">
                          <span className="text-sm font-semibold text-foreground">
                            {p.patient_name || 'Sem nome'}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {p.plans_count} plano(s)
                            {p.patient_phone && ` · ${p.patient_phone}`}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <span className="text-xs font-semibold text-foreground tabular-nums">
                          {fmtBRL(p.total_contratado)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <span className="text-xs font-semibold text-emerald-400 tabular-nums">
                          {fmtBRL(p.recebido)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <span className="text-xs font-semibold text-blue-400 tabular-nums">
                          {fmtBRL(p.em_aberto)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {p.atrasado > 0 ? (
                          <span className="inline-flex items-center gap-1 text-xs font-bold text-red-400 tabular-nums">
                            <AlertTriangle size={11} />
                            {fmtBRL(p.atrasado)}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground tabular-nums">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="inline-flex flex-col items-end gap-1">
                          <span className="text-xs font-bold text-foreground tabular-nums">{pctPaid}%</span>
                          <div className="w-14 h-1 bg-muted rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${pctPaid === 100 ? 'bg-emerald-500' : pctPaid >= 50 ? 'bg-blue-500' : 'bg-amber-500'}`}
                              style={{ width: `${pctPaid}%` }}
                            />
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <button
                          onClick={() => router.push(`/atendimento/pacientes/${p.patient_id}`)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded-md text-primary border border-primary/20 hover:bg-primary/10 transition-colors"
                        >
                          <ExternalLink size={11} />
                          Ficha
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[9px] text-muted-foreground uppercase tracking-wider font-bold">{label}</span>
      <span className={`text-sm font-bold tabular-nums ${color}`}>{value}</span>
    </div>
  );
}
