'use client';

/**
 * Progresso — Jornada do paciente PÓS-VENDA (central de vendas / pipeline).
 *
 * Cada venda FECHADA (orçamento aceito) vira um card e caminha por 4 etapas.
 * O ponto é NÃO PERDER o paciente depois que ele fecha: a coluna "A agendar"
 * grita quem fechou e ainda não tem consulta marcada.
 *
 *  ┌─ KPIs ───────────────────────────────────────────────────────┐
 *  │ ⚠ A agendar | Em aberto | Fechado no mês | Ticket médio      │
 *  └───────────────────────────────────────────────────────────────┘
 *  ┌──────────────┬───────────┬───────────────┬───────────────────┐
 *  │ A agendar ⚠  │ Agendado  │ Em tratamento │ Concluído          │
 *  ├──────────────┼───────────┼───────────────┼───────────────────┤
 *  │  cards…       │  cards…   │  cards…       │  cards…            │
 *  └──────────────┴───────────┴───────────────┴───────────────────┘
 *
 * Endpoint: GET /quotes/journey-board (commercial.controller.ts)
 * Recebe: { summary, by_stage: { A_AGENDAR: [...], AGENDADO, EM_TRATAMENTO, CONCLUIDO } }
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2, AlertTriangle, CalendarPlus, CalendarClock, Activity,
  CircleCheck, Clock, Layers, Check, Settings, X,
} from 'lucide-react';
import api from '@/lib/api';
import { showError } from '@/lib/toast';
import { PatientAvatar } from '@/components/PatientAvatar';

// ─── Tipos ──────────────────────────────────────────────────────────────────

type StageKey = 'A_AGENDAR' | 'AGENDADO' | 'EM_TRATAMENTO' | 'CONCLUIDO';

interface Dentist {
  id: string;
  name: string;
}

interface JourneyCard {
  quote_id: string;
  plan_id: string | null;
  patient: { id: string; name: string | null; phone: string | null; avatar_url: string | null };
  accepted_at: string | null;
  dentist: { id: string; name: string } | null;
  primary_dentist: { id: string; name: string } | null; // atendendo (editável)
  created_by: { id: string; name: string } | null; // quem orçou
  closed_by: { id: string; name: string } | null;  // quem fechou
  stage: StageKey;
  next_appointment_at: string | null;
  has_future_appt: boolean;
  days_stalled: number | null;
  items_done: number;
  items_total: number;
}

interface BoardData {
  summary: {
    count_total: number;
    open_count: number;
    to_schedule_count: number;
    agendado_count: number;
    em_tratamento_count: number;
    stalled_count: number;
    month_count: number;
    concluido_total: number;
  };
  by_stage: Record<StageKey, JourneyCard[]>;
}

const EMPTY_BOARD: BoardData = {
  summary: {
    count_total: 0, open_count: 0, to_schedule_count: 0, agendado_count: 0,
    em_tratamento_count: 0, stalled_count: 0, month_count: 0, concluido_total: 0,
  },
  by_stage: { A_AGENDAR: [], AGENDADO: [], EM_TRATAMENTO: [], CONCLUIDO: [] },
};

const COLUMNS: Array<{
  key: StageKey;
  label: string;
  icon: React.ElementType;
  accent: string; // header (borda + fundo + texto)
  urgent?: boolean;
}> = [
  { key: 'A_AGENDAR', label: 'A agendar', icon: CalendarPlus, accent: 'border-amber-400 bg-amber-50 text-amber-900', urgent: true },
  { key: 'AGENDADO', label: 'Agendado', icon: CalendarClock, accent: 'border-sky-400 bg-sky-50 text-sky-900' },
  { key: 'EM_TRATAMENTO', label: 'Em tratamento', icon: Activity, accent: 'border-violet-400 bg-violet-50 text-violet-900' },
  { key: 'CONCLUIDO', label: 'Concluído', icon: CircleCheck, accent: 'border-emerald-400 bg-emerald-50 text-emerald-900' },
];

// ─── Formatação ─────────────────────────────────────────────────────────────

/** Data de fechamento (accepted_at = instante real; tz do navegador). */
function formatCloseDate(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  } catch { return null; }
}

/** Próxima consulta (start_at = naive-UTC = hora local Maceió; ler via UTC
 *  pra NÃO deslocar pela tz do navegador — mesmo cuidado da agenda). */
function formatApptMaceio(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      timeZone: 'UTC', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  } catch { return null; }
}

/** Dias corridos desde uma data (para "dias sem agendamento"). */
function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.floor(ms / 86400000));
}

// ─── Página ─────────────────────────────────────────────────────────────────

interface PlanItem {
  id: string;
  status: string; // PENDING|SCHEDULED|IN_PROGRESS|DONE|CANCELLED
  tooth_fdi: string | null;
  procedure: { name: string };
}

/** Modal por card: procedimentos do plano separados em Feitos / Falta fazer
 *  (execução real — status DONE). Aberto pela engrenagem do card. */
function ProceduresModal({ planId, patientName, onClose }: {
  planId: string; patientName: string; onClose: () => void;
}) {
  const [items, setItems] = useState<PlanItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get<{ items?: PlanItem[] }>(`/treatment-plans/${planId}`)
      .then((r) => { if (!cancelled) setItems(r.data?.items || []); })
      .catch(() => { if (!cancelled) setItems([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [planId]);
  const feitos = (items || []).filter((i) => i.status === 'DONE');
  const faltam = (items || []).filter((i) => i.status !== 'DONE' && i.status !== 'CANCELLED');
  const totalExec = feitos.length + faltam.length;
  const pct = totalExec ? Math.round((feitos.length / totalExec) * 100) : 0;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border bg-muted/30 shrink-0">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-foreground truncate">Procedimentos</h2>
            <p className="text-[11px] text-muted-foreground truncate">{patientName}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-accent/40 text-muted-foreground hover:text-foreground transition-colors shrink-0"
            title="Fechar"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="py-8 flex items-center justify-center text-muted-foreground">
              <Loader2 size={16} className="animate-spin mr-2" /> Carregando...
            </div>
          ) : totalExec === 0 ? (
            <p className="text-sm text-muted-foreground italic text-center py-8">Nenhum procedimento no plano.</p>
          ) : (
            <div className="space-y-4">
              {/* Resumo */}
              <div>
                <div className="flex items-center justify-between text-[11px] mb-1">
                  <span className="font-bold text-foreground">{feitos.length} de {totalExec} feitos</span>
                  <span className="text-muted-foreground">{pct}%</span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                </div>
              </div>
              {/* Feitos */}
              <div>
                <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-emerald-700 mb-1.5">
                  <Check size={13} strokeWidth={3} /> Feitos ({feitos.length})
                </div>
                {feitos.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground italic pl-1">Nenhum procedimento feito ainda.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {feitos.map((it) => (
                      <li key={it.id} className="flex items-start gap-2 text-sm">
                        <Check size={13} strokeWidth={3} className="text-emerald-600 mt-1 shrink-0" />
                        <span className="text-foreground">
                          {it.procedure.name}
                          {it.tooth_fdi && <span className="text-[11px] text-muted-foreground"> · Dente {it.tooth_fdi}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {/* Falta fazer */}
              <div>
                <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-amber-700 mb-1.5">
                  <Clock size={13} /> Falta fazer ({faltam.length})
                </div>
                {faltam.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground italic pl-1">Tudo feito!</p>
                ) : (
                  <ul className="space-y-1.5">
                    {faltam.map((it) => (
                      <li key={it.id} className="flex items-start gap-2 text-sm">
                        <Clock size={13} className="text-amber-600 mt-1 shrink-0" />
                        <span className="text-foreground">
                          {it.procedure.name}
                          {it.tooth_fdi && <span className="text-[11px] text-muted-foreground"> · Dente {it.tooth_fdi}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ProgressoPage() {
  const router = useRouter();
  const [board, setBoard] = useState<BoardData>(EMPTY_BOARD);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Modal de procedimentos (feito / falta fazer) por card — aberto pela engrenagem.
  const [procModal, setProcModal] = useState<{ planId: string; patientName: string } | null>(null);
  // Dentistas do tenant, pro seletor "quem está atendendo".
  const [dentists, setDentists] = useState<Dentist[]>([]);
  // Filtro do quadro por dentista ('' = todos, '__none__' = sem dentista).
  const [dentistFilter, setDentistFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const r = await api.get<BoardData>('/quotes/journey-board');
      if (!r.data || !r.data.summary || !r.data.by_stage) {
        setErrorMsg('A API retornou um formato inesperado. Tente novamente em instantes.');
        return;
      }
      setBoard(r.data);
    } catch (e: any) {
      const apiMsg = e?.response?.data?.message;
      const status = e?.response?.status;
      const msg = apiMsg
        ? `${apiMsg}${status ? ` (HTTP ${status})` : ''}`
        : (status ? `Erro HTTP ${status}` : 'Erro ao carregar o progresso');
      setErrorMsg(msg);
      showError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Lista de dentistas pro seletor "quem está atendendo" (tenant-scoped).
  useEffect(() => {
    api.get<Dentist[]>('/users/lawyers')
      .then((r) => setDentists(r.data || []))
      .catch(() => { /* silencioso: seletor fica só com "Sem dentista" */ });
  }, []);

  // Define/atualiza o dentista que está atendendo (salva no paciente).
  // Otimista: atualiza TODOS os cards do mesmo paciente na hora.
  const setDentist = useCallback(async (patientId: string, dentist: Dentist | null) => {
    setBoard((b) => {
      const by = { ...b.by_stage };
      (Object.keys(by) as StageKey[]).forEach((k) => {
        by[k] = by[k].map((c) => (c.patient.id === patientId ? { ...c, primary_dentist: dentist } : c));
      });
      return { ...b, by_stage: by };
    });
    try {
      await api.patch(`/patients/${patientId}`, { primary_dentist_id: dentist?.id ?? null });
    } catch {
      showError('Não foi possível salvar o dentista');
      load();
    }
  }, [load]);

  const goToPatient = (c: JourneyCard) =>
    router.push(`/atendimento/pacientes/${c.patient.id}?tab=tratamento`);

  // "Agendar" abre a agenda com o paciente já pré-preenchido (deep-link
  // suportado pela agenda: ?new=1&patient_id=…&patient_name=…&phone=…).
  const goToSchedule = (c: JourneyCard) => {
    const params = new URLSearchParams({ new: '1', patient_id: c.patient.id });
    if (c.patient.name) params.set('patient_name', c.patient.name);
    if (c.patient.phone) params.set('phone', c.patient.phone);
    params.set('from', '/atendimento/progresso'); // botão "Voltar" na agenda
    router.push(`/atendimento/agenda?${params.toString()}`);
  };

  // Filtro por dentista (client-side). Sem filtro → usa board/summary do backend
  // (concluido_total exato). Com filtro → recomputa a partir dos cards visíveis.
  const view = useMemo(() => {
    if (!dentistFilter) return board;
    const match = (c: JourneyCard) => {
      const did = c.primary_dentist?.id || c.dentist?.id || null;
      return dentistFilter === '__none__' ? !did : did === dentistFilter;
    };
    const by = {} as Record<StageKey, JourneyCard[]>;
    (['A_AGENDAR', 'AGENDADO', 'EM_TRATAMENTO', 'CONCLUIDO'] as StageKey[]).forEach((k) => {
      by[k] = (board.by_stage[k] || []).filter(match);
    });
    const all = [...by.A_AGENDAR, ...by.AGENDADO, ...by.EM_TRATAMENTO, ...by.CONCLUIDO];
    const now = new Date(Date.now() - 3 * 3600 * 1000);
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const monthCount = all.filter((c) => c.accepted_at && new Date(c.accepted_at).getTime() >= monthStart).length;
    return {
      summary: {
        count_total: all.length,
        open_count: by.A_AGENDAR.length + by.AGENDADO.length + by.EM_TRATAMENTO.length,
        to_schedule_count: by.A_AGENDAR.length,
        agendado_count: by.AGENDADO.length,
        em_tratamento_count: by.EM_TRATAMENTO.length,
        stalled_count: by.EM_TRATAMENTO.filter((c) => !c.has_future_appt).length,
        month_count: monthCount,
        concluido_total: by.CONCLUIDO.length,
      },
      by_stage: by,
    };
  }, [board, dentistFilter]);

  const { summary, by_stage } = view;

  return (
    <div className="p-6 space-y-6 min-h-screen bg-background">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Progresso</h1>
          <p className="text-sm text-muted-foreground mt-1">
            A jornada de cada paciente depois que a venda fecha — do agendamento à conclusão.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <select
            value={dentistFilter}
            onChange={(e) => setDentistFilter(e.target.value)}
            className="px-2.5 py-1.5 text-sm border rounded-lg bg-card text-foreground hover:bg-muted transition-colors outline-none cursor-pointer max-w-[190px]"
            title="Filtrar o quadro por dentista"
          >
            <option value="">Todos os dentistas</option>
            <option value="__none__">Sem dentista</option>
            {dentists.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          <button
            onClick={load}
            disabled={loading}
            className="px-3 py-1.5 text-sm border rounded-lg hover:bg-muted transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {loading && <Loader2 size={14} className="animate-spin" />}
            Atualizar
          </button>
        </div>
      </div>

      {/* Erro inline */}
      {errorMsg && (
        <div className="border border-red-300 bg-red-50 text-red-800 rounded-lg p-3 flex items-start gap-3">
          <AlertTriangle size={18} className="text-red-600 mt-0.5 shrink-0" />
          <div className="flex-1 text-sm">
            <div className="font-medium">Não foi possível carregar o progresso</div>
            <div className="text-red-700/80 mt-0.5">{errorMsg}</div>
          </div>
          <button
            onClick={load}
            className="text-xs px-2 py-1 rounded border border-red-300 hover:bg-red-100"
          >
            Tentar novamente
          </button>
        </div>
      )}

      {/* KPIs — só contagens (processo), sem valores monetários */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KpiCard
          icon={AlertTriangle}
          label="A agendar"
          value={String(summary.to_schedule_count)}
          sub={summary.to_schedule_count > 0 ? 'aguardando agenda' : 'tudo agendado'}
          accent={summary.to_schedule_count > 0 ? 'text-amber-600' : 'text-emerald-600'}
          highlight={summary.to_schedule_count > 0 ? 'amber' : undefined}
        />
        <KpiCard
          icon={Layers}
          label="Em aberto"
          value={String(summary.open_count)}
          sub="em andamento"
          accent="text-sky-600"
        />
        <KpiCard
          icon={AlertTriangle}
          label="Parados"
          value={String(summary.stalled_count)}
          sub="em trat. sem consulta"
          accent={summary.stalled_count > 0 ? 'text-red-600' : 'text-emerald-600'}
          highlight={summary.stalled_count > 0 ? 'red' : undefined}
        />
        <KpiCard
          icon={CalendarClock}
          label="Fechados no mês"
          value={String(summary.month_count)}
          sub="neste mês"
          accent="text-emerald-600"
        />
        <KpiCard
          icon={CircleCheck}
          label="Concluídos"
          value={String(summary.concluido_total)}
          sub="no total"
          accent="text-violet-600"
        />
      </div>

      {/* Kanban de 4 colunas */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {COLUMNS.map((col) => {
          const cards = by_stage[col.key] || [];
          const Icon = col.icon;
          const colStalled = col.key === 'EM_TRATAMENTO'
            ? cards.filter((c) => !c.has_future_appt).length
            : 0;
          return (
            <div key={col.key} className="flex flex-col bg-card border rounded-xl overflow-hidden">
              {/* Header da coluna */}
              <div className={`px-3 py-2 border-b-2 ${col.accent} flex items-center justify-between`}>
                <div className="flex items-center gap-2 min-w-0">
                  <Icon size={16} className="shrink-0" />
                  <span className="font-semibold text-sm truncate">{col.label}</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {colStalled > 0 && (
                    <span className="text-[10px] font-bold text-red-700 bg-red-100 border border-red-200 rounded-full px-1.5 py-0.5">
                      {colStalled} parado{colStalled > 1 ? 's' : ''}
                    </span>
                  )}
                  <span className="text-xs font-mono opacity-70">{cards.length}</span>
                </div>
              </div>
              {/* Nota "+N concluídos anteriores" (Concluído mostra só os
                  recentes). Sem totais em R$ — foco no processo, não no valor. */}
              {col.key === 'CONCLUIDO' && summary.concluido_total > cards.length && (
                <div className="px-3 py-1.5 text-xs text-muted-foreground border-b bg-background/50">
                  +{summary.concluido_total - cards.length} concluídos anteriores
                </div>
              )}
              {/* Cards */}
              <div className="flex-1 p-2 space-y-2 min-h-[200px] max-h-[calc(100vh-20rem)] overflow-y-auto">
                {cards.length === 0 ? (
                  <div className="text-xs text-muted-foreground text-center py-6 italic">
                    {col.urgent ? 'Ninguém esperando 🎉' : 'Vazio'}
                  </div>
                ) : (
                  cards.map((c) => (
                    <JourneyCardItem
                      key={c.quote_id}
                      card={c}
                      onOpen={() => goToPatient(c)}
                      onSchedule={() => goToSchedule(c)}
                      onProcedures={() => c.plan_id && setProcModal({ planId: c.plan_id, patientName: c.patient.name || 'Paciente' })}
                      dentists={dentists}
                      onSetDentist={(d) => setDentist(c.patient.id, d)}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {procModal && (
        <ProceduresModal
          planId={procModal.planId}
          patientName={procModal.patientName}
          onClose={() => setProcModal(null)}
        />
      )}
    </div>
  );
}

// ─── KPI ────────────────────────────────────────────────────────────────────

function KpiCard({
  icon: Icon, label, value, sub, accent, highlight,
}: {
  icon: React.ElementType; label: string; value: string; sub?: string;
  accent: string; highlight?: 'amber' | 'red';
}) {
  return (
    <div className={`p-3 border rounded-xl bg-card ${
      highlight === 'red' ? 'border-red-300 bg-red-50/50'
        : highlight === 'amber' ? 'border-amber-300 bg-amber-50/40' : ''
    }`}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon size={14} className={accent} />
        <span className="truncate">{label}</span>
      </div>
      <div className={`text-lg font-bold mt-1 ${accent}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

// ─── Card ───────────────────────────────────────────────────────────────────

function JourneyCardItem({
  card: c, onOpen, onSchedule, onProcedures, dentists, onSetDentist,
}: {
  card: JourneyCard;
  onOpen: () => void; onSchedule: () => void; onProcedures: () => void;
  dentists: Dentist[];
  onSetDentist: (d: Dentist | null) => void;
}) {
  const closeDate = formatCloseDate(c.accepted_at);
  const apptStr = formatApptMaceio(c.next_appointment_at);
  const pct = c.items_total > 0 ? Math.round((c.items_done / c.items_total) * 100) : 0;
  const isToSchedule = c.stage === 'A_AGENDAR';
  const daysWaiting = daysSince(c.accepted_at);
  // Em tratamento SEM próxima consulta = risco de esquecer (abandono no meio).
  const isStalled = c.stage === 'EM_TRATAMENTO' && !c.has_future_appt;

  return (
    <div
      className={`rounded-xl p-3 bg-card border transition-shadow hover:shadow-md ${
        isToSchedule ? 'border-amber-300' : isStalled ? 'border-red-300' : 'border-border'
      }`}
    >
      {/* Nome + miniatura vermelha de dias sem agendamento (só "A agendar") */}
      <div className="flex items-center gap-2">
        <button
          onClick={onOpen}
          className="flex items-center gap-2 flex-1 min-w-0 text-left group"
          title={c.patient.name || 'Sem nome'}
        >
          <PatientAvatar
            patientId={c.patient.id}
            patientName={c.patient.name || 'Sem nome'}
            avatarUrl={c.patient.avatar_url}
            size={26}
          />
          <span className="font-medium text-[13px] text-foreground truncate min-w-0 group-hover:text-blue-600">
            {c.patient.name || 'Sem nome'}
          </span>
        </button>
        {isToSchedule && daysWaiting != null && (
          <span
            className="shrink-0 inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-200"
            title={`${daysWaiting} ${daysWaiting === 1 ? 'dia' : 'dias'} sem agendamento`}
          >
            {daysWaiting}d
          </span>
        )}
        {isStalled && c.days_stalled != null && c.days_stalled > 0 && (
          <span
            className="shrink-0 inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-200"
            title={`Parado há ${c.days_stalled} ${c.days_stalled === 1 ? 'dia' : 'dias'}`}
          >
            parado {c.days_stalled}d
          </span>
        )}
      </div>

      {/* Progresso do tratamento (no lugar do valor) — barra + X de N.
          O valor da venda continua no total da coluna e nos KPIs. */}
      <div className="mt-2">
        {c.items_total > 0 ? (
          <>
            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${pct === 100 ? 'bg-emerald-500' : 'bg-violet-500'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="flex items-center justify-between gap-2 mt-1">
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {c.items_done} de {c.items_total} procedimentos
              </span>
              {c.plan_id && (
                <button
                  onClick={(e) => { e.stopPropagation(); onProcedures(); }}
                  className="shrink-0 p-0.5 -mr-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
                  title="Ver procedimentos (feito / falta fazer)"
                >
                  <Settings size={13} />
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="text-[11px] text-muted-foreground italic">Plano ainda não montado</div>
        )}
      </div>

      {/* Dentista que está atendendo — seletor (salva no paciente). Default:
          o dentista já assinalado (atendendo) ou o do orçamento. */}
      <div className="mt-1.5">
        <select
          value={c.primary_dentist?.id || c.dentist?.id || ''}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            const id = e.target.value;
            onSetDentist(id ? (dentists.find((d) => d.id === id) || null) : null);
          }}
          className="w-full text-[11px] text-muted-foreground bg-transparent border-none outline-none cursor-pointer hover:text-foreground truncate py-0 focus:ring-0"
          title="Dentista que está atendendo"
        >
          <option value="">Sem dentista</option>
          {dentists.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </div>
      {c.closed_by?.name ? (
        <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
          Fechou <span className="text-foreground/75">{c.closed_by.name}</span>
          {closeDate && <span className="opacity-70"> · {closeDate}</span>}
        </div>
      ) : closeDate ? (
        <div className="text-[11px] text-muted-foreground mt-0.5 truncate opacity-70">
          Fechou em {closeDate}
        </div>
      ) : null}

      {/* Rodapé por etapa — ação/info (Em tratamento já mostra o progresso acima) */}
      {c.stage === 'A_AGENDAR' && (
        <button
          onClick={onSchedule}
          className="w-full mt-2.5 text-xs px-2 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-500 text-amber-950 font-medium flex items-center justify-center gap-1.5 transition-colors"
          title="Abrir a agenda com este paciente já selecionado"
        >
          <CalendarPlus size={13} /> Agendar
        </button>
      )}

      {c.stage === 'AGENDADO' && (
        <div className="flex items-center gap-1.5 mt-2.5 text-xs text-sky-600 font-medium">
          <Clock size={13} className="shrink-0" />
          <span className="truncate">{apptStr ? `Consulta ${apptStr}` : 'Consulta marcada'}</span>
        </div>
      )}

      {c.stage === 'EM_TRATAMENTO' && (
        c.has_future_appt ? (
          <div className="flex items-center gap-1.5 mt-2.5 text-xs text-sky-600 font-medium">
            <Clock size={13} className="shrink-0" />
            <span className="truncate">{apptStr ? `Próxima consulta ${apptStr}` : 'Consulta marcada'}</span>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-1.5 mt-2.5 text-xs text-red-600 font-medium">
              <AlertTriangle size={13} className="shrink-0" />
              <span>Sem próxima consulta</span>
            </div>
            <button
              onClick={onSchedule}
              className="w-full mt-2 text-xs px-2 py-1.5 rounded-lg bg-red-500 hover:bg-red-600 text-white font-medium flex items-center justify-center gap-1.5 transition-colors"
              title="Marcar a próxima consulta deste tratamento"
            >
              <CalendarPlus size={13} /> Agendar próxima
            </button>
          </>
        )
      )}

      {c.stage === 'CONCLUIDO' && (
        <div className="flex items-center gap-1.5 mt-2.5 text-xs text-emerald-600 font-medium">
          <Check size={13} className="shrink-0" /> Tratamento finalizado
        </div>
      )}
    </div>
  );
}
