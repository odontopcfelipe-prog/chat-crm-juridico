'use client';

/**
 * "Minha agenda" — a agenda do DENTISTA em LISTA (out/2026, pedido do dono).
 *
 * O dentista não usa o calendário da clínica: vê só os pacientes DELE do dia,
 * em lista, e marca o andamento — verde = Atendido, vermelho = Faltou — nas
 * MESMAS cores de status da agenda (EVENT_STATUSES em agenda/page.tsx).
 *
 * - GET /calendar/events já devolve só os eventos do próprio dentista (o
 *   backend força assigned_user_id = ele).
 * - "Atendido" = valida o atendimento (POST /events/:id/validate: CONCLUIDO +
 *   validado + última visita + vira paciente). Se já estava validado ou o
 *   evento não tem dentista atribuído, cai no PATCH de status.
 * - Demais status = PATCH /calendar/events/:id/status (mesmo da agenda).
 * - Sem telefone/WhatsApp do paciente (a API já apaga o contato pro dentista).
 * - Agenda é naive-UTC: hora de Maceió nos campos UTC → tudo lido via getUTC* e
 *   "hoje" = Date.now() - 3h.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Calendar, ChevronLeft, ChevronRight, Check, X, MoreHorizontal, Loader2, RefreshCw, Clock,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { PatientAvatar } from '@/components/PatientAvatar';

// Mesmas cores/rótulos da agenda (EVENT_STATUSES em agenda/page.tsx — Onda 17.61).
const STATUSES = [
  { id: 'AGENDADO',       label: 'Agendado',       color: '#E91E63' }, // rosa — não confirmado
  { id: 'CONFIRMADO',     label: 'Confirmado',     color: '#22c55e' },
  { id: 'COMPARECEU',     label: 'Chegou',         color: '#0ea5e9' },
  { id: 'EM_ATENDIMENTO', label: 'Em atendimento', color: '#f97316' }, // laranja
  { id: 'CONCLUIDO',      label: 'Atendido',       color: '#15803d' }, // verde escuro
  { id: 'CANCELADO',      label: 'Desmarcou',      color: '#eab308' }, // amarelo
  { id: 'NO_SHOW',        label: 'Faltou',         color: '#991b1b' }, // vermelho escuro
] as const;

const STATUS_BY_ID: Record<string, { id: string; label: string; color: string }> =
  Object.fromEntries(STATUSES.map((s) => [s.id, s]));

// Tipos de atendimento de PACIENTE (bloqueio/tarefa/outro não entram na lista).
// Mesma lista de AGENDA_PATIENT_TYPES (agenda-flags) — repetida aqui de propósito
// pra esta tela não depender de arquivo interno do calendário.
const PATIENT_TYPES = ['CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA'];

const TYPE_LABEL: Record<string, string> = {
  CONSULTA: 'Consulta', PROCEDIMENTO: 'Procedimento', RETORNO: 'Retorno', ORTODONTIA: 'Ortodontia',
};

const DAYS_PT = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const MONTHS_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

interface AgendaEvent {
  id: string;
  title: string | null;
  type: string;
  status: string;
  start_at: string;
  end_at: string | null;
  validated_at?: string | null;
  assigned_user_id?: string | null;
  patient?: { id: string; name: string; avatar_url?: string | null } | null;
  lead?: { id: string; name: string | null; profile_picture_url?: string | null } | null;
  appointment_type?: { name?: string | null } | null;
}

/** Dia de Maceió (YYYY-MM-DD) — modelo naive-UTC da agenda. */
function maceioTodayStr(): string {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function dayTitle(day: string): string {
  const d = new Date(`${day}T12:00:00.000Z`);
  return `${DAYS_PT[d.getUTCDay()]}, ${d.getUTCDate()} de ${MONTHS_PT[d.getUTCMonth()]}`;
}

function hhmm(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export default function MinhaAgendaPage() {
  const [day, setDay] = useState<string>(() => maceioTodayStr());
  const [events, setEvents] = useState<AgendaEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const today = maceioTodayStr();
  const reqRef = useRef(0);

  const load = useCallback(async (silent = false) => {
    const reqId = ++reqRef.current;
    if (!silent) setLoading(true);
    try {
      const { data } = await api.get<AgendaEvent[]>('/calendar/events', {
        params: { start: `${day}T00:00:00.000Z`, end: `${day}T23:59:59.999Z` },
      });
      if (reqId !== reqRef.current) return;
      const list = (Array.isArray(data) ? data : [])
        .filter((e) => PATIENT_TYPES.includes(e.type))
        .sort((a, b) => a.start_at.localeCompare(b.start_at));
      setEvents(list);
    } catch {
      if (reqId === reqRef.current && !silent) setEvents([]);
    } finally {
      if (reqId === reqRef.current) setLoading(false);
    }
  }, [day]);

  useEffect(() => { load(); }, [load]);
  // Atualiza sozinho (recepção pode marcar "Chegou" enquanto o dentista olha a lista).
  useEffect(() => {
    const t = setInterval(() => load(true), 60_000);
    return () => clearInterval(t);
  }, [load]);
  // Fecha o menu de status ao clicar fora.
  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuFor]);

  const setStatus = async (ev: AgendaEvent, status: string) => {
    if (savingId) return;
    setMenuFor(null);
    setSavingId(ev.id);
    const prev = ev.status;
    setEvents((list) => list.map((e) => (e.id === ev.id ? { ...e, status } : e)));
    try {
      let validated = false;
      if (status === 'CONCLUIDO' && !ev.validated_at && ev.assigned_user_id) {
        try {
          await api.post(`/calendar/events/${ev.id}/validate`, {});
          validated = true;
        } catch { /* cai no PATCH de status abaixo */ }
      }
      if (!validated) await api.patch(`/calendar/events/${ev.id}/status`, { status });
      if (validated) {
        setEvents((list) => list.map((e) => (e.id === ev.id ? { ...e, validated_at: new Date().toISOString() } : e)));
      }
      toast.success(`${STATUS_BY_ID[status]?.label ?? status} ✓`, { id: `st-${ev.id}` });
    } catch {
      setEvents((list) => list.map((e) => (e.id === ev.id ? { ...e, status: prev } : e)));
      toast.error('Não consegui salvar. Tente de novo.');
    } finally {
      setSavingId(null);
    }
  };

  const counts = useMemo(() => {
    const c = { total: 0, atendidos: 0, faltas: 0, pendentes: 0 };
    for (const e of events) {
      if (e.status === 'CANCELADO') continue;
      c.total += 1;
      if (e.status === 'CONCLUIDO') c.atendidos += 1;
      else if (e.status === 'NO_SHOW') c.faltas += 1;
      else c.pendentes += 1;
    }
    return c;
  }, [events]);

  return (
    // RAIZ rolável: o <main> do layout é overflow-hidden.
    <div className="h-full overflow-y-auto">
      {/* pb-24 no celular: o último paciente não fica atrás do menu inferior. */}
      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-5 sm:pt-6 pb-24 md:pb-6">
        <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <Calendar size={24} className="text-primary shrink-0" /> Minha agenda
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {dayTitle(day)}{day === today ? ' · hoje' : ''}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setDay((d) => shiftDay(d, -1))}
              className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-border bg-card hover:bg-accent"
              aria-label="Dia anterior"
            >
              <ChevronLeft size={18} />
            </button>
            <button
              type="button"
              onClick={() => setDay(today)}
              disabled={day === today}
              className="h-9 px-3 rounded-lg border border-border bg-card text-sm font-semibold hover:bg-accent disabled:opacity-50"
            >
              Hoje
            </button>
            <button
              type="button"
              onClick={() => setDay((d) => shiftDay(d, 1))}
              className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-border bg-card hover:bg-accent"
              aria-label="Próximo dia"
            >
              <ChevronRight size={18} />
            </button>
            <input
              type="date"
              value={day}
              onChange={(e) => e.target.value && setDay(e.target.value)}
              className="h-9 px-2 rounded-lg border border-border bg-card text-sm text-foreground"
              aria-label="Escolher dia"
            />
            <button
              type="button"
              onClick={() => load()}
              className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-border bg-card hover:bg-accent"
              aria-label="Atualizar"
              title="Atualizar"
            >
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {/* Resumo do dia */}
        <div className="flex flex-wrap gap-2 mb-4">
          <Chip label={counts.total === 1 ? 'paciente' : 'pacientes'} value={counts.total} color="#64748b" />
          <Chip label="a atender" value={counts.pendentes} color={STATUS_BY_ID.AGENDADO.color} />
          <Chip label={counts.atendidos === 1 ? 'atendido' : 'atendidos'} value={counts.atendidos} color={STATUS_BY_ID.CONCLUIDO.color} />
          <Chip label={counts.faltas === 1 ? 'faltou' : 'faltaram'} value={counts.faltas} color={STATUS_BY_ID.NO_SHOW.color} />
        </div>

        {loading && events.length === 0 ? (
          <div className="p-12 flex items-center justify-center text-muted-foreground">
            <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
          </div>
        ) : events.length === 0 ? (
          <div className="bg-card border border-border rounded-xl p-12 text-center text-sm text-muted-foreground">
            <Calendar size={28} className="mx-auto mb-2 opacity-50" />
            Nenhum paciente na sua agenda neste dia.
          </div>
        ) : (
          <ul className="space-y-2.5">
            {events.map((ev) => {
              const st = STATUS_BY_ID[ev.status] ?? STATUS_BY_ID.AGENDADO;
              const name = ev.patient?.name || ev.lead?.name || ev.title || 'Paciente';
              const what = ev.appointment_type?.name || TYPE_LABEL[ev.type] || ev.type;
              const isDone = ev.status === 'CONCLUIDO';
              // Recepção marcou "Atendido" mas o dentista ainda não confirmou: o botão
              // segue clicável e VALIDA (some do quadrante "Confirmar atendimentos").
              const needsConfirm = isDone && !ev.validated_at && !!ev.assigned_user_id;
              const isNoShow = ev.status === 'NO_SHOW';
              const cancelled = ev.status === 'CANCELADO';
              const busy = savingId === ev.id;
              return (
                <li
                  key={ev.id}
                  className={`relative bg-card border border-border rounded-xl overflow-visible ${cancelled ? 'opacity-60' : ''}`}
                  style={{ borderLeft: `5px solid ${st.color}` }}
                >
                  <div className="flex flex-wrap items-center gap-3 p-3 sm:p-3.5">
                    {/* Horário */}
                    <div className="w-[64px] shrink-0">
                      <div className="text-base font-bold text-foreground tabular-nums leading-tight">{hhmm(ev.start_at)}</div>
                      {ev.end_at && (
                        <div className="text-[11px] text-muted-foreground tabular-nums flex items-center gap-0.5">
                          <Clock size={10} /> {hhmm(ev.end_at)}
                        </div>
                      )}
                    </div>

                    {/* Paciente */}
                    <div className="flex items-center gap-2.5 min-w-0 flex-1 basis-[180px]">
                      <PatientAvatar
                        patientId={ev.patient?.id ?? ev.lead?.id ?? ev.id}
                        patientName={name}
                        avatarUrl={ev.patient?.avatar_url ?? null}
                        fallbackPhotoUrl={ev.lead?.profile_picture_url}
                        size={36}
                        shape="circle"
                      />
                      <div className="min-w-0">
                        {ev.patient ? (
                          <Link
                            href={`/atendimento/pacientes/${ev.patient.id}`}
                            className="block text-sm font-semibold text-foreground truncate hover:underline"
                          >
                            {name}
                          </Link>
                        ) : (
                          <span className="block text-sm font-semibold text-foreground truncate">{name}</span>
                        )}
                        <div className="text-xs text-muted-foreground truncate">{what}</div>
                      </div>
                    </div>

                    {/* Status + ações */}
                    <div className="flex items-center gap-1.5 ml-auto">
                      <span
                        className="hidden sm:inline-flex items-center gap-1.5 text-[11px] font-bold px-2 py-1 rounded-full"
                        style={{ background: `${st.color}1f`, color: st.color }}
                      >
                        <span className="w-2 h-2 rounded-full" style={{ background: st.color }} />
                        {st.label}
                      </span>
                      <button
                        type="button"
                        disabled={busy || (isDone && !needsConfirm)}
                        onClick={() => setStatus(ev, 'CONCLUIDO')}
                        className="h-9 px-3 inline-flex items-center gap-1 rounded-lg text-sm font-semibold border transition-colors disabled:cursor-default"
                        style={isDone
                          ? { background: STATUS_BY_ID.CONCLUIDO.color, color: '#fff', borderColor: STATUS_BY_ID.CONCLUIDO.color }
                          : { color: STATUS_BY_ID.CONCLUIDO.color, borderColor: `${STATUS_BY_ID.CONCLUIDO.color}66` }}
                        title={needsConfirm ? 'Confirmar que você atendeu' : 'Marcar como atendido'}
                      >
                        {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {needsConfirm ? 'Confirmar' : 'Atendido'}
                      </button>
                      <button
                        type="button"
                        disabled={busy || isNoShow}
                        onClick={() => setStatus(ev, 'NO_SHOW')}
                        className="h-9 px-3 inline-flex items-center gap-1 rounded-lg text-sm font-semibold border transition-colors disabled:cursor-default"
                        style={isNoShow
                          ? { background: STATUS_BY_ID.NO_SHOW.color, color: '#fff', borderColor: STATUS_BY_ID.NO_SHOW.color }
                          : { color: STATUS_BY_ID.NO_SHOW.color, borderColor: `${STATUS_BY_ID.NO_SHOW.color}66` }}
                        title="Marcar que o paciente faltou"
                      >
                        <X size={15} /> Faltou
                      </button>
                      <div className="relative">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={(e) => { e.stopPropagation(); setMenuFor((m) => (m === ev.id ? null : ev.id)); }}
                          className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-border hover:bg-accent"
                          aria-label="Outros status"
                          title="Outros status"
                        >
                          <MoreHorizontal size={16} />
                        </button>
                        {menuFor === ev.id && (
                          <div
                            className="absolute right-0 top-full mt-1 z-20 w-44 bg-card border border-border rounded-xl shadow-lg py-1"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {STATUSES.map((s) => (
                              <button
                                key={s.id}
                                type="button"
                                onClick={() => setStatus(ev, s.id)}
                                className={`w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent ${s.id === ev.status ? 'font-bold' : ''}`}
                              >
                                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: s.color }} />
                                {s.label}
                                {s.id === ev.status && <Check size={14} className="ml-auto text-muted-foreground" />}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function Chip({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border"
      style={{ borderColor: `${color}55`, color }}
    >
      <span className="text-sm font-bold tabular-nums">{value}</span> {label}
    </span>
  );
}
