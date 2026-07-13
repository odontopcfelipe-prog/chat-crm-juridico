'use client';

// Ala de Ortodontia (Jornada do paciente). Quadro POR DENTISTA responsável — cada
// dentista é uma coluna; filtro de status no topo + selo por card. Fonte:
// GET /quotes/ortho-board. Status: agendado / não agendado / concluído / saiu.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CalendarDays, CalendarClock, CalendarPlus, CheckCircle2, Loader2, RefreshCw, Stethoscope,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

type OrthoStatus = 'agendado' | 'nao_agendado' | 'concluido' | 'saiu';

interface OrthoCard {
  patient: { id: string; name: string | null; phone: string | null; avatar_url: string | null };
  dentist: { id: string; name: string } | null;
  status: OrthoStatus;
  weekday: number | null;
  next_appointment_at: string | null;
  last_visit_at: string | null;
  archived: boolean;
  inativo: boolean;
  plan_ids: string[];
}
interface OrthoBoard {
  summary: { total: number; agendado: number; nao_agendado: number; concluido: number; saiu: number };
  patients: OrthoCard[];
}

const STATUS_META: Record<OrthoStatus, { label: string; badge: string }> = {
  agendado: { label: 'Agendado', badge: 'bg-blue-500/15 text-blue-500' },
  nao_agendado: { label: 'Não agendado', badge: 'bg-amber-500/15 text-amber-500' },
  concluido: { label: 'Concluído', badge: 'bg-emerald-500/15 text-emerald-500' },
  saiu: { label: 'Saiu', badge: 'bg-red-500/15 text-red-500' },
};

const FILTERS: Array<{ key: 'todos' | OrthoStatus; label: string }> = [
  { key: 'todos', label: 'Todos' },
  { key: 'agendado', label: 'Agendados' },
  { key: 'nao_agendado', label: 'Não agendados' },
  { key: 'concluido', label: 'Concluídos' },
  { key: 'saiu', label: 'Saíram' },
];

// Ortô é fixo no dia da semana; cada dia pode ter um ortodontista diferente.
const DAYS: Array<{ key: 'todos' | number; label: string }> = [
  { key: 'todos', label: 'Todos os dias' },
  { key: 1, label: 'Seg' },
  { key: 2, label: 'Ter' },
  { key: 3, label: 'Qua' },
  { key: 4, label: 'Qui' },
  { key: 5, label: 'Sex' },
  { key: 6, label: 'Sáb' },
];
const WD_LABEL: Record<number, string> = { 0: 'Dom', 1: 'Seg', 2: 'Ter', 3: 'Qua', 4: 'Qui', 5: 'Sex', 6: 'Sáb' };

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('pt-BR') : '—');
const fmtDateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
const initials = (name: string | null) =>
  (name || '?').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

export default function OrtodontiaPage() {
  const router = useRouter();
  const [board, setBoard] = useState<OrthoBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'todos' | OrthoStatus>('todos');
  const [dayFilter, setDayFilter] = useState<'todos' | number>('todos');
  const [completing, setCompleting] = useState<string | null>(null);
  const [dentists, setDentists] = useState<{ id: string; name: string; ortho_days?: number[] }[]>([]);
  const [migrating, setMigrating] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<OrthoBoard>('/quotes/ortho-board');
      setBoard(r.data);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao carregar a ortodontia');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get<{ id: string; name: string; ortho_days?: number[] }[]>('/users/lawyers').then((r) => setDentists(r.data || [])).catch(() => {});
  }, []);

  // Colunas = dentistas presentes (+ "Sem dentista" por último). Filtra pelo status escolhido.
  const columns = useMemo(() => {
    if (!board) return [];
    let cards = board.patients;
    if (filter !== 'todos') cards = cards.filter((c) => c.status === filter);
    if (dayFilter !== 'todos') cards = cards.filter((c) => c.weekday === dayFilter);
    const byDentist = new Map<string, { id: string; name: string; cards: OrthoCard[] }>();
    for (const c of cards) {
      const key = c.dentist?.id || '__none__';
      const name = c.dentist?.name || 'Sem dentista';
      if (!byDentist.has(key)) byDentist.set(key, { id: key, name, cards: [] });
      byDentist.get(key)!.cards.push(c);
    }
    return Array.from(byDentist.values()).sort((a, b) => {
      if (a.id === '__none__') return 1;
      if (b.id === '__none__') return -1;
      return a.name.localeCompare(b.name);
    });
  }, [board, filter, dayFilter]);

  const conclude = async (card: OrthoCard) => {
    if (!card.plan_ids.length) { showError('Sem plano de ortodontia pra concluir'); return; }
    if (!confirm(`Concluir a ortodontia de ${card.patient.name}? Marca o tratamento como finalizado (alta).`)) return;
    setCompleting(card.patient.id);
    try {
      await Promise.all(card.plan_ids.map((id) => api.post(`/treatment-plans/${id}/complete`)));
      showSuccess('Ortodontia concluída (alta registrada)');
      load();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao concluir');
    } finally {
      setCompleting(null);
    }
  };

  // Migra o paciente pra outro dentista de ortô (override manual, prioridade máxima).
  const migrate = async (patientId: string, dentistId: string | null) => {
    setMigrating(patientId);
    try {
      await api.patch(`/patients/${patientId}`, { ortho_dentist_id: dentistId });
      showSuccess(dentistId ? 'Paciente migrado de dentista' : 'Voltou ao dentista automático');
      load();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao migrar');
    } finally {
      setMigrating(null);
    }
  };

  const s = board?.summary;

  return (
    <div className="h-full overflow-y-auto p-6 w-full space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Stethoscope size={20} className="text-primary" /> Ortodontia
          </h1>
          <p className="text-sm text-muted-foreground">
            Todos os pacientes de ortô, por dentista responsável — agendados, sem agendamento, concluídos e os que saíram.
          </p>
        </div>
        <button onClick={load} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-sm hover:bg-accent/30 shrink-0">
          <RefreshCw size={14} /> Atualizar
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="Total" value={s?.total ?? 0} color="text-foreground" />
        <Kpi label="Agendados" value={s?.agendado ?? 0} color="text-blue-500" />
        <Kpi label="Não agendados" value={s?.nao_agendado ?? 0} color="text-amber-500" />
        <Kpi label="Concluídos" value={s?.concluido ?? 0} color="text-emerald-500" />
        <Kpi label="Saíram" value={s?.saiu ?? 0} color="text-red-500" />
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {FILTERS.map((f) => (
          <button key={f.key} onClick={() => setFilter(f.key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              filter === f.key ? 'bg-primary text-primary-foreground' : 'bg-background border border-border text-muted-foreground hover:bg-accent/30'
            }`}>
            {f.label}
          </button>
        ))}
      </div>

      {/* Filtro Dia da Semana — cada dia pode ter um ortodontista diferente */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground mr-1">Dia da semana</span>
        {DAYS.map((d) => (
          <button key={String(d.key)} onClick={() => setDayFilter(d.key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              dayFilter === d.key ? 'bg-primary text-primary-foreground' : 'bg-background border border-border text-muted-foreground hover:bg-accent/30'
            }`}>
            {d.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="p-12 text-center"><Loader2 size={24} className="mx-auto animate-spin text-primary" /></div>
      ) : columns.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-12 text-center text-sm text-muted-foreground">
          Nenhum paciente de ortodontia{filter !== 'todos' ? ' nesse filtro' : ''}.
        </div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {columns.map((col) => {
            const dias = (dentists.find((d) => d.id === col.id)?.ortho_days || []).slice().sort((a, b) => a - b);
            return (
            <div key={col.id} className="shrink-0 w-[300px] bg-muted/30 rounded-xl border border-border flex flex-col">
              <div className="px-3 py-2.5 border-b border-border flex items-center justify-between bg-muted/40 rounded-t-xl gap-2">
                <div className="min-w-0">
                  <span className="text-sm font-bold text-foreground flex items-center gap-2 truncate">
                    <Stethoscope size={14} className="text-primary shrink-0" /> {col.name}
                  </span>
                  {dias.length > 0 && (
                    <span className="text-[10px] text-muted-foreground block ml-6">{dias.map((d) => WD_LABEL[d]).join(' · ')}</span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground shrink-0">{col.cards.length}</span>
              </div>
              <div className="p-2 space-y-2">
                {col.cards.length === 0 ? (
                  <div className="text-center text-xs text-muted-foreground py-6">Vazio</div>
                ) : (
                  col.cards.map((c) => (
                    <OrthoCardItem
                      key={c.patient.id}
                      card={c}
                      dentists={dentists}
                      completing={completing === c.patient.id}
                      migrating={migrating === c.patient.id}
                      onConclude={() => conclude(c)}
                      onOpen={() => router.push(`/atendimento/pacientes/${c.patient.id}`)}
                      onSchedule={() => router.push(`/atendimento/agenda?new=1&patient_id=${c.patient.id}&type=ORTODONTIA`)}
                      onMigrate={(did) => migrate(c.patient.id, did)}
                    />
                  ))
                )}
              </div>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-3">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</div>
    </div>
  );
}

function OrthoCardItem({ card, completing, dentists, migrating, onConclude, onOpen, onSchedule, onMigrate }: {
  card: OrthoCard; completing: boolean; dentists: { id: string; name: string }[]; migrating: boolean;
  onConclude: () => void; onOpen: () => void; onSchedule: () => void; onMigrate: (dentistId: string | null) => void;
}) {
  const meta = STATUS_META[card.status];
  return (
    <div className="bg-card border border-border rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-2">
        <button onClick={onOpen} className="w-8 h-8 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center shrink-0">
          {initials(card.patient.name)}
        </button>
        <button onClick={onOpen} className="font-semibold text-sm text-foreground hover:text-primary text-left truncate flex-1">
          {card.patient.name || 'Sem nome'}
        </button>
        {card.weekday != null && (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 bg-primary/10 text-primary" title="Dia de atendimento">{WD_LABEL[card.weekday]}</span>
        )}
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${meta.badge}`}>{meta.label}</span>
      </div>

      {card.status === 'agendado' && card.next_appointment_at ? (
        <div className="text-xs text-blue-500 flex items-center gap-1">
          <CalendarClock size={12} /> Próxima: {fmtDateTime(card.next_appointment_at)}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground flex items-center gap-1 flex-wrap">
          <CalendarDays size={12} /> Última: {fmtDate(card.last_visit_at)}
          {card.inativo && <span className="text-red-500 font-semibold">· inativo 12m+</span>}
          {card.archived && <span className="text-red-500 font-semibold">· arquivado</span>}
        </div>
      )}

      <div className="flex items-center gap-1.5 pt-0.5">
        {card.status !== 'agendado' && card.status !== 'concluido' && (
          <button onClick={onSchedule} className="flex-1 text-[11px] font-semibold px-2 py-1.5 rounded-md bg-amber-500 text-white hover:opacity-90 inline-flex items-center justify-center gap-1">
            <CalendarPlus size={12} /> Agendar
          </button>
        )}
        {card.status !== 'concluido' && card.plan_ids.length > 0 && (
          <button onClick={onConclude} disabled={completing}
            className="flex-1 text-[11px] font-semibold px-2 py-1.5 rounded-md border border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/10 disabled:opacity-50 inline-flex items-center justify-center gap-1">
            {completing ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />} Concluir
          </button>
        )}
      </div>

      {/* Migrar o paciente pra outro dentista de ortô */}
      <select
        value=""
        disabled={migrating}
        onChange={(e) => { const v = e.target.value; if (!v) return; onMigrate(v === '__auto__' ? null : v); }}
        className="w-full text-[11px] px-2 py-1 rounded-md border border-border bg-background text-muted-foreground focus:outline-none disabled:opacity-50"
      >
        <option value="">{migrating ? 'Migrando…' : '⇄ Migrar p/ outro dentista…'}</option>
        {dentists.filter((d) => d.id !== card.dentist?.id).map((d) => (
          <option key={d.id} value={d.id}>{d.name}</option>
        ))}
        <option value="__auto__">↺ Automático (inferir)</option>
      </select>
    </div>
  );
}
