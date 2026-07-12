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

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2, AlertTriangle, CalendarPlus, CalendarClock, Activity,
  CircleCheck, Clock, Layers, Check,
} from 'lucide-react';
import api from '@/lib/api';
import { showError } from '@/lib/toast';
import { PatientAvatar } from '@/components/PatientAvatar';

// ─── Tipos ──────────────────────────────────────────────────────────────────

type StageKey = 'A_AGENDAR' | 'AGENDADO' | 'EM_TRATAMENTO' | 'CONCLUIDO';

interface JourneyCard {
  quote_id: string;
  plan_id: string | null;
  patient: { id: string; name: string | null; phone: string | null; avatar_url: string | null };
  accepted_at: string | null;
  dentist: { id: string; name: string } | null;
  created_by: { id: string; name: string } | null; // quem orçou
  closed_by: { id: string; name: string } | null;  // quem fechou
  stage: StageKey;
  next_appointment_at: string | null;
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
    month_count: number;
    concluido_total: number;
  };
  by_stage: Record<StageKey, JourneyCard[]>;
}

const EMPTY_BOARD: BoardData = {
  summary: {
    count_total: 0, open_count: 0, to_schedule_count: 0,
    agendado_count: 0, em_tratamento_count: 0, month_count: 0, concluido_total: 0,
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

export default function ProgressoPage() {
  const router = useRouter();
  const [board, setBoard] = useState<BoardData>(EMPTY_BOARD);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

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

  const { summary, by_stage } = board;

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
        <button
          onClick={load}
          disabled={loading}
          className="px-3 py-1.5 text-sm border rounded-lg hover:bg-muted transition-colors disabled:opacity-50 flex items-center gap-2 shrink-0"
        >
          {loading && <Loader2 size={14} className="animate-spin" />}
          Atualizar
        </button>
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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          icon={AlertTriangle}
          label="A agendar"
          value={String(summary.to_schedule_count)}
          sub={summary.to_schedule_count > 0 ? 'aguardando agenda' : 'tudo agendado'}
          accent={summary.to_schedule_count > 0 ? 'text-amber-600' : 'text-emerald-600'}
          highlight={summary.to_schedule_count > 0}
        />
        <KpiCard
          icon={Layers}
          label="Em aberto"
          value={String(summary.open_count)}
          sub="em andamento"
          accent="text-sky-600"
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
          return (
            <div key={col.key} className="flex flex-col bg-card border rounded-xl overflow-hidden">
              {/* Header da coluna */}
              <div className={`px-3 py-2 border-b-2 ${col.accent} flex items-center justify-between`}>
                <div className="flex items-center gap-2 min-w-0">
                  <Icon size={16} className="shrink-0" />
                  <span className="font-semibold text-sm truncate">{col.label}</span>
                </div>
                <span className="text-xs font-mono opacity-70 shrink-0">{cards.length}</span>
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
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── KPI ────────────────────────────────────────────────────────────────────

function KpiCard({
  icon: Icon, label, value, sub, accent, highlight,
}: {
  icon: React.ElementType; label: string; value: string; sub?: string;
  accent: string; highlight?: boolean;
}) {
  return (
    <div className={`p-3 border rounded-xl bg-card ${highlight ? 'border-amber-300 bg-amber-50/40' : ''}`}>
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
  card: c, onOpen, onSchedule,
}: {
  card: JourneyCard; onOpen: () => void; onSchedule: () => void;
}) {
  const closeDate = formatCloseDate(c.accepted_at);
  const apptStr = formatApptMaceio(c.next_appointment_at);
  const pct = c.items_total > 0 ? Math.round((c.items_done / c.items_total) * 100) : 0;
  const isToSchedule = c.stage === 'A_AGENDAR';
  const daysWaiting = daysSince(c.accepted_at);

  return (
    <div
      className={`rounded-xl p-3 bg-card border transition-shadow hover:shadow-md ${
        isToSchedule ? 'border-amber-300' : 'border-border'
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
            <div className="text-[11px] text-muted-foreground mt-1 tabular-nums">
              {c.items_done} de {c.items_total} procedimentos
            </div>
          </>
        ) : (
          <div className="text-[11px] text-muted-foreground italic">Plano ainda não montado</div>
        )}
      </div>

      {/* Dentista responsável — fallback: quem fez a avaliação (criou o
          orçamento); senão "Sem dentista". */}
      <div className="text-[11px] text-muted-foreground mt-1.5 truncate">
        {c.dentist?.name || c.created_by?.name || 'Sem dentista'}
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

      {c.stage === 'CONCLUIDO' && (
        <div className="flex items-center gap-1.5 mt-2.5 text-xs text-emerald-600 font-medium">
          <Check size={13} className="shrink-0" /> Tratamento finalizado
        </div>
      )}
    </div>
  );
}
