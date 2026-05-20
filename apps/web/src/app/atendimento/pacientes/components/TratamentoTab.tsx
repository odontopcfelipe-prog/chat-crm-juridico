'use client';

/**
 * TratamentoTab — aba "Tratamento" da ficha do paciente.
 * Onda 5e v38 (Fase 25).
 *
 * Lista todos os procedimentos fechados (de quotes ACCEPTED -> TreatmentPlan)
 * com opcao de "Validar" item-a-item conforme dentista responsavel realiza.
 *
 * Validar marca:
 *   - status = DONE
 *   - executed_at = now
 *   - executed_by_user_id = user logado (precisa ser dentista/admin)
 *
 * Endpoints:
 *   GET  /patients/:id/treatment-items     (lista + KPIs achatados)
 *   POST /treatment-plan-items/:id/execute (valida item)
 *
 * Substitui versao antiga (Fase 4) que era lista de planos + drill-down.
 * Esta versao mostra tudo achatado, agrupado por plano, com botao Validar
 * em cada linha — UX mais direta pro fluxo clinico dia-a-dia.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2, FileText, Stethoscope, Loader2,
  RefreshCw, Calendar, AlertCircle, Activity,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useRole } from '@/lib/useRole';

interface ItemRow {
  plan_id: string;
  plan_status: string;
  plan_total: number;
  quote_id: string | null;
  quote_title: string | null;
  quote_accepted_at: string | null;
  item: {
    id: string;
    procedure_id: string;
    procedure_name: string;
    procedure_code: string | null;
    tooth_fdi: string | null;
    quantity: number;
    unit_price: number;
    total_price: number;
    status: string;
    scheduled_at: string | null;
    scheduled_appointment_id: string | null;
    scheduled_appointment_title: string | null;
    executed_at: string | null;
    executed_by: { id: string; name: string } | null;
    notes: string | null;
  };
}

interface Data {
  kpis: {
    total: number;
    feitos: number;
    pendentes: number;
    valorTotal: number;
    valorFeito: number;
  };
  items: ItemRow[];
}

function brl(v: number) {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
}

const STATUS_STYLE: Record<string, { label: string; color: string; bg: string; border: string }> = {
  PENDING:     { label: 'Pendente',     color: 'text-amber-700 dark:text-amber-400',     bg: 'bg-amber-50 dark:bg-amber-950/30',     border: 'border-amber-200 dark:border-amber-900' },
  SCHEDULED:   { label: 'Agendado',     color: 'text-sky-700 dark:text-sky-400',         bg: 'bg-sky-50 dark:bg-sky-950/30',         border: 'border-sky-200 dark:border-sky-900' },
  IN_PROGRESS: { label: 'Em andamento', color: 'text-blue-700 dark:text-blue-400',       bg: 'bg-blue-50 dark:bg-blue-950/30',       border: 'border-blue-200 dark:border-blue-900' },
  DONE:        { label: 'Concluído',    color: 'text-emerald-700 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950/30', border: 'border-emerald-200 dark:border-emerald-900' },
  CANCELLED:   { label: 'Cancelado',    color: 'text-rose-700 dark:text-rose-400',       bg: 'bg-rose-50 dark:bg-rose-950/30',       border: 'border-rose-200 dark:border-rose-900' },
};

interface Props {
  patientId: string;
}

export default function TratamentoTab({ patientId }: Props) {
  const router = useRouter();
  const role = useRole();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<Data | null>(null);
  const [validatingId, setValidatingId] = useState<string | null>(null);
  const [hideDone, setHideDone] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/patients/${patientId}/treatment-items`);
      setData(res.data);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao carregar plano de tratamento');
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const validateItem = async (row: ItemRow) => {
    const procedureLabel = row.item.tooth_fdi
      ? `${row.item.procedure_name} (dente ${row.item.tooth_fdi})`
      : row.item.procedure_name;
    if (!confirm(
      `Validar "${procedureLabel}" como concluído?\n\n` +
      `• Marca status = DONE\n` +
      `• Registra você como dentista executante\n` +
      `• Data de execução = agora`,
    )) return;
    setValidatingId(row.item.id);
    try {
      await api.post(`/treatment-plan-items/${row.item.id}/execute`, {});
      showSuccess('Procedimento validado');
      await fetchData();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao validar');
    } finally {
      setValidatingId(null);
    }
  };

  const grouped = useMemo(() => {
    if (!data) return [] as { plan_id: string; quote_title: string | null; quote_accepted_at: string | null; plan_status: string; plan_total: number; items: ItemRow[] }[];
    const map = new Map<string, ItemRow[]>();
    for (const row of data.items) {
      if (!map.has(row.plan_id)) map.set(row.plan_id, []);
      map.get(row.plan_id)!.push(row);
    }
    return Array.from(map.entries()).map(([plan_id, items]) => ({
      plan_id,
      quote_title: items[0].quote_title,
      quote_accepted_at: items[0].quote_accepted_at,
      plan_status: items[0].plan_status,
      plan_total: items[0].plan_total,
      items: hideDone ? items.filter((i) => i.item.status !== 'DONE') : items,
    })).filter((g) => g.items.length > 0);
  }, [data, hideDone]);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" />
        Carregando plano de tratamento…
      </div>
    );
  }

  const kpis = data?.kpis ?? { total: 0, feitos: 0, pendentes: 0, valorTotal: 0, valorFeito: 0 };
  const progressPct = kpis.total > 0 ? Math.round((kpis.feitos / kpis.total) * 100) : 0;
  const canValidate = role.isDentist || role.isAdmin;

  return (
    <div className="space-y-5 p-1">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
            <Activity size={18} className="text-emerald-600" />
            Plano de Tratamento
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Procedimentos fechados — dentista responsável valida cada um quando realizado.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={hideDone}
              onChange={(e) => setHideDone(e.target.checked)}
              className="accent-emerald-600"
            />
            Esconder feitos
          </label>
          <button
            onClick={fetchData}
            disabled={loading}
            className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent"
            title="Atualizar"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* KPIs + barra de progresso */}
      {kpis.total > 0 && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-3 mb-2">
            <span className="text-xs font-bold text-foreground">
              Progresso do tratamento
            </span>
            <span className="text-xs tabular-nums text-muted-foreground">
              {kpis.feitos} de {kpis.total} ({progressPct}%)
            </span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4 text-xs">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Pendentes</p>
              <p className="text-lg font-bold text-amber-700 dark:text-amber-400 tabular-nums">{kpis.pendentes}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Concluídos</p>
              <p className="text-lg font-bold text-emerald-700 dark:text-emerald-400 tabular-nums">{kpis.feitos}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Valor realizado</p>
              <p className="text-lg font-bold text-foreground tabular-nums">{brl(kpis.valorFeito)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Valor total</p>
              <p className="text-lg font-bold text-foreground tabular-nums">{brl(kpis.valorTotal)}</p>
            </div>
          </div>
        </div>
      )}

      {/* Sem procedimentos */}
      {kpis.total === 0 ? (
        <div className="rounded-xl border border-border bg-card px-4 py-12 text-center text-muted-foreground">
          <FileText size={32} className="mx-auto mb-2 opacity-40" />
          <p className="text-sm font-medium">Nenhum procedimento fechado ainda</p>
          <p className="text-xs mt-1">
            Quando um orçamento for aceito pelo paciente, os procedimentos aparecem aqui.
          </p>
        </div>
      ) : (
        grouped.map((plan) => (
          <section key={plan.plan_id} className="rounded-xl border border-border bg-card overflow-hidden">
            <header className="flex items-center justify-between gap-3 px-4 py-3 bg-muted/30 border-b border-border">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <FileText size={14} className="text-emerald-600" />
                  <h3 className="text-sm font-bold text-foreground truncate">
                    {plan.quote_title || 'Plano de tratamento'}
                  </h3>
                  <PlanStatusBadge status={plan.plan_status} />
                </div>
                {plan.quote_accepted_at && (
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Aceito em {formatDate(plan.quote_accepted_at)} · Total {brl(plan.plan_total)}
                  </p>
                )}
              </div>
            </header>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/20 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 text-left font-bold">Procedimento</th>
                    <th className="px-4 py-2 text-center font-bold">Dente</th>
                    <th className="px-4 py-2 text-right font-bold">Valor</th>
                    <th className="px-4 py-2 text-center font-bold">Status</th>
                    <th className="px-4 py-2 text-left font-bold">Executado por</th>
                    <th className="px-4 py-2 text-center font-bold">Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.items.map((row) => {
                    const it = row.item;
                    const done = it.status === 'DONE';
                    const cancelled = it.status === 'CANCELLED';
                    const style = STATUS_STYLE[it.status] || STATUS_STYLE.PENDING;
                    return (
                      <tr
                        key={it.id}
                        className={`border-t border-border ${done ? 'opacity-70' : ''} ${cancelled ? 'opacity-40 line-through' : ''} hover:bg-accent/30`}
                      >
                        <td className="px-4 py-2.5">
                          <div className="font-semibold text-foreground">{it.procedure_name}</div>
                          {it.procedure_code && (
                            <div className="text-[10px] text-muted-foreground font-mono">{it.procedure_code}</div>
                          )}
                          {it.notes && (
                            <div className="text-[11px] text-muted-foreground mt-0.5 italic">{it.notes}</div>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-center font-mono text-xs">
                          {it.tooth_fdi || '—'}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-foreground">
                          {brl(it.total_price)}
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          <span className={`inline-block text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${style.color} ${style.bg} ${style.border}`}>
                            {style.label}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-xs">
                          {it.executed_by ? (
                            <div>
                              <div className="text-foreground font-semibold inline-flex items-center gap-1">
                                <Stethoscope size={11} /> {it.executed_by.name}
                              </div>
                              {it.executed_at && (
                                <div className="text-[10px] text-muted-foreground">
                                  {formatDate(it.executed_at)}
                                </div>
                              )}
                            </div>
                          ) : it.scheduled_appointment_id ? (
                            <button
                              onClick={() => router.push(`/atendimento/agenda`)}
                              className="inline-flex items-center gap-1 text-[11px] text-sky-700 dark:text-sky-400 hover:underline"
                              title="Ver na agenda"
                            >
                              <Calendar size={11} />
                              {it.scheduled_appointment_title || 'Agendado'}
                            </button>
                          ) : (
                            <span className="text-muted-foreground italic text-[11px]">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          {!done && !cancelled && (
                            <button
                              onClick={() => validateItem(row)}
                              disabled={validatingId === it.id || !canValidate}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                              title={
                                canValidate
                                  ? 'Validar — marca este procedimento como feito'
                                  : 'Apenas dentistas/admin podem validar'
                              }
                            >
                              {validatingId === it.id ? (
                                <Loader2 size={11} className="animate-spin" />
                              ) : (
                                <CheckCircle2 size={11} />
                              )}
                              Validar
                            </button>
                          )}
                          {done && (
                            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400 font-bold">
                              <CheckCircle2 size={12} /> Validado
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}

      {/* Aviso permissao */}
      {kpis.total > 0 && !canValidate && (
        <div className="rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/30 p-3 text-xs text-blue-900 dark:text-blue-300 flex items-start gap-2">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <div>
            Apenas <strong>dentistas</strong> e <strong>admin</strong> podem validar procedimentos como feitos.
            Sua visão é somente leitura.
          </div>
        </div>
      )}
    </div>
  );
}

function PlanStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    PENDING_SIGNATURE: { label: 'Aguardando assinatura', cls: 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900' },
    ACTIVE:            { label: 'Ativo',                 cls: 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900' },
    PAUSED:            { label: 'Pausado',               cls: 'text-slate-700 dark:text-slate-400 bg-slate-50 dark:bg-slate-950/40 border-slate-200 dark:border-slate-800' },
    COMPLETED:         { label: 'Concluído',             cls: 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900' },
    CANCELLED:         { label: 'Cancelado',             cls: 'text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-900' },
  };
  const m = map[status] || { label: status, cls: 'text-muted-foreground bg-muted border-border' };
  return (
    <span className={`inline-block text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${m.cls}`}>
      {m.label}
    </span>
  );
}
