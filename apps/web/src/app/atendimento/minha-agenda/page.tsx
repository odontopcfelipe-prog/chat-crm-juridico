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
 * - "Atendido" abre a CONFIRMAÇÃO (ConfirmarAtendimentoModal): o dentista escreve o
 *   que fez + marca os procedimentos do plano → evolução no prontuário + itens
 *   executados + atendimento validado. Agenda e validação num passo só (out/2026).
 * - Atendimentos de dias anteriores sem confirmação aparecem no topo (antes era a
 *   tela separada "Confirmar atendimentos").
 * - Demais status = PATCH /calendar/events/:id/status (mesmo da agenda).
 * - Sem telefone/WhatsApp do paciente (a API já apaga o contato pro dentista).
 * - Agenda é naive-UTC: hora de Maceió nos campos UTC → tudo lido via getUTC* e
 *   "hoje" = Date.now() - 3h.
 * - Out/2026 — visual neutro multi-clínica (igual ao painel do dentista): topo
 *   grafite com os contadores, lista em linha do tempo com o marcador "Agora"; a
 *   única cor é a da clínica. Clicar na FOTO ou no NOME abre as boas-vindas (a ficha
 *   segue a um clique pelos atalhos de lá).
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, Calendar, CalendarDays, ChevronLeft, ChevronRight, Check, X, MoreHorizontal, Loader2, RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { useRole } from '@/lib/useRole';
import { useTenant } from '@/lib/useTenant';
import { tenantAccent } from '@/lib/tenant-accent';
import { PatientAvatar } from '@/components/PatientAvatar';
// Out/2026 — agenda + validação juntas: "Atendido" abre a confirmação com o que
// foi feito (vai pro prontuário) e os procedimentos do plano executados.
import { ConfirmarAtendimentoModal } from './ConfirmarAtendimentoModal';
// Out/2026 — clicar no nome/foto abre a tela cheia de boas-vindas pro paciente.
import { BoasVindasPaciente } from './BoasVindasPaciente';
import './minha-agenda.css';

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

// Texto dos selos de status: tom mais escuro da mesma cor (o claro some no fundo claro).
const STATUS_INK: Record<string, string> = {
  AGENDADO: '#be185d', CONFIRMADO: '#15803d', COMPARECEU: '#0369a1', EM_ATENDIMENTO: '#c2410c',
  CONCLUIDO: '#15803d', CANCELADO: '#a16207', NO_SHOW: '#991b1b',
};
/** A recepção já registrou a chegada. */
const CHEGOU = ['COMPARECEU', 'EM_ATENDIMENTO'];

// Fase 0 — consulta já validada: Faltou/Desmarcou/Adiado só o ADMIN (a API barra com 403;
// aqui só não oferece o botão).
const STATUS_TRAVADOS_VALIDADA = ['NO_SHOW', 'CANCELADO', 'ADIADO'];

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

/**
 * Id do usuário logado (payload do JWT: sub/id). A Minha agenda é SEMPRE de quem
 * está logado — sem isso, quem tem papel de admin/recepção/assistente recebia a
 * agenda da clínica inteira (o backend só força "só os seus" pro dentista puro).
 */
function myUserId(): string | null {
  try {
    const t = localStorage.getItem('token') || '';
    const b64 = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const p = JSON.parse(atob(b64));
    return (p?.sub || p?.id || null) as string | null;
  } catch {
    return null;
  }
}

/** Pendentes de confirmação: só os dos últimos dias (não arrasta o histórico todo). */
const PENDENTES_DIAS = 7;

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

/** "Agora" no modelo naive-UTC (hora de Maceió nos campos UTC). */
function naiveNowIso(): string {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
}

export default function MinhaAgendaPage() {
  const router = useRouter();
  const role = useRole();
  const tenant = useTenant();
  // A única cor da tela é a da clínica (cinza se ela não cadastrou).
  const accent = useMemo(() => tenantAccent(tenant?.theme_color), [tenant?.theme_color]);
  // Fase 0 — mesmo critério da API: ADMIN ou SUPER_ADMIN passa a trava pós-validação.
  const souAdmin = role.isAdmin || role.isSuperAdmin;
  const travado = (ev: AgendaEvent, statusId: string) =>
    !!ev.validated_at && !souAdmin && statusId !== ev.status && STATUS_TRAVADOS_VALIDADA.includes(statusId);
  const [day, setDay] = useState<string>(() => maceioTodayStr());
  const [events, setEvents] = useState<AgendaEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const today = maceioTodayStr();
  const reqRef = useRef(0);
  const [confirming, setConfirming] = useState<AgendaEvent | null>(null);
  // Atendimentos de DIAS ANTERIORES ainda não confirmados (antes era a tela
  // separada "Confirmar atendimentos" — agora fica aqui, junto da agenda).
  const [pendentes, setPendentes] = useState<AgendaEvent[]>([]);
  // Boas-vindas: id do atendimento aberto em tela cheia + nome de quem atende (rodapé).
  const [welcomeId, setWelcomeId] = useState<string | null>(null);
  const [myName, setMyName] = useState<string | null>(null);
  useEffect(() => {
    api.get<{ name?: string | null }>('/users/me').then((r) => setMyName(r.data?.name?.trim() || null)).catch(() => {});
  }, []);

  const loadPendentes = useCallback(async () => {
    const me = myUserId();
    if (!me) { setPendentes([]); return; }
    try {
      // onlyMine: admin-dentista também vê só os DELE (sem isso vinham os de todos).
      const { data } = await api.get<AgendaEvent[]>('/calendar/events/pending-validation', {
        params: { onlyMine: 'true', daysBack: PENDENTES_DIAS },
      });
      const hoje0 = `${maceioTodayStr()}T00:00:00.000Z`;
      setPendentes(
        (Array.isArray(data) ? data : [])
          .filter((e) => PATIENT_TYPES.includes(e.type) && e.start_at < hoje0 && e.assigned_user_id === me)
          .map((e) => ({ ...e, assigned_user_id: e.assigned_user_id ?? null }))
          .sort((a, b) => b.start_at.localeCompare(a.start_at)),
      );
    } catch {
      /* sem pendentes visíveis — a lista do dia segue funcionando */
    }
  }, []);
  useEffect(() => { loadPendentes(); }, [loadPendentes]);

  const load = useCallback(async (silent = false) => {
    const reqId = ++reqRef.current;
    if (!silent) setLoading(true);
    const me = myUserId();
    try {
      // userId = o próprio usuário: cada dentista com a SUA agenda (admin/recepção/
      // assistente receberiam a clínica inteira sem isso).
      const { data } = await api.get<AgendaEvent[]>('/calendar/events', {
        params: { start: `${day}T00:00:00.000Z`, end: `${day}T23:59:59.999Z`, ...(me ? { userId: me } : {}) },
      });
      if (reqId !== reqRef.current) return;
      const list = (Array.isArray(data) ? data : [])
        .filter((e) => PATIENT_TYPES.includes(e.type))
        // Defesa no front: só consultas DELE (ou sem dentista que ele mesmo criou).
        .filter((e) => !me || e.assigned_user_id === me || !e.assigned_user_id)
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
    const t = setInterval(() => { load(true); loadPendentes(); }, 60_000);
    return () => clearInterval(t);
  }, [load, loadPendentes]);
  // Fecha o menu de status ao clicar fora.
  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuFor]);

  const patchLocal = (id: string, patch: Partial<AgendaEvent>) => {
    setEvents((list) => list.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  };

  // "Atendido" = confirmar o atendimento (o que foi feito + procedimentos → prontuário).
  // Já confirmado antes: só ajusta o status.
  const pedirAtendido = (ev: AgendaEvent) => {
    setMenuFor(null);
    if (ev.validated_at) { setStatus(ev, 'CONCLUIDO'); return; }
    setConfirming(ev);
  };

  const setStatus = async (ev: AgendaEvent, status: string) => {
    if (savingId) return;
    setMenuFor(null);
    setSavingId(ev.id);
    const prev = ev.status;
    patchLocal(ev.id, { status });
    try {
      await api.patch(`/calendar/events/${ev.id}/status`, { status });
      // Falta/desmarcou não precisa confirmar: sai da lista de pendentes.
      if (['NO_SHOW', 'CANCELADO'].includes(status)) setPendentes((l) => l.filter((e) => e.id !== ev.id));
      toast.success(`${STATUS_BY_ID[status]?.label ?? status} ✓`, { id: `st-${ev.id}` });
    } catch (e: any) {
      patchLocal(ev.id, { status: prev });
      // Fase 0 — mostra o motivo da API (ex.: consulta validada só o admin marca Faltou).
      toast.error(e?.response?.data?.message || 'Não consegui salvar. Tente de novo.');
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

  const confirmModal = confirming ? (
    <ConfirmarAtendimentoModal
      event={confirming}
      onClose={() => setConfirming(null)}
      onConfirmed={(patch) => {
        const id = confirming.id;
        patchLocal(id, patch);
        setPendentes((l) => l.filter((e) => e.id !== id));
        setConfirming(null);
      }}
    />
  ) : null;

  // Marcador "Agora" (só no dia de hoje): antes do primeiro atendimento que ainda não começou.
  const nowIso = naiveNowIso();
  const agoraIdx = day === today && events.length > 0
    ? (() => { const i = events.findIndex((e) => e.start_at > nowIso); return i === -1 ? events.length : i; })()
    : -1;
  const agoraMarker = (
    <li className="ma-now" aria-label={`Agora, ${hhmm(nowIso)}`}>
      <span className="ma-now-label">Agora</span>
      <span className="ma-now-dot" aria-hidden />
      <span className="ma-now-line" aria-hidden><i /><b>{hhmm(nowIso)}</b></span>
    </li>
  );
  const resolvidos = counts.atendidos + counts.faltas;

  return (
    // RAIZ rolável: o <main> do layout é overflow-hidden.
    <div className="h-full overflow-y-auto ma" style={{ '--ma-accent': accent } as CSSProperties}>
      {/* pb-24 no celular: o último paciente não fica atrás do menu inferior. */}
      <div className="ma-wrap">
        {/* Voltar — pra tela de onde veio (histórico); sem histórico (link direto) cai
            no Início. Mesmo padrão da ficha do paciente. */}
        <button
          type="button"
          onClick={() => {
            if (typeof window !== 'undefined' && window.history.length > 1) router.back();
            else router.push('/atendimento/dashboard');
          }}
          className="ma-back"
        >
          <ArrowLeft size={14} /> Voltar
        </button>

        {/* Topo grafite: dia + navegação + resumo do dia */}
        <section className="ma-hero">
          <span className="ma-hero-glow" aria-hidden />
          <svg className="ma-hero-rings" viewBox="0 0 600 600" aria-hidden="true">
            <circle cx="300" cy="300" r="290" />
            <circle cx="300" cy="300" r="210" />
            <circle cx="300" cy="300" r="130" />
          </svg>
          <div className="ma-hero-top">
            <div className="ma-hero-title">
              <span className="ma-hero-ico"><Calendar size={22} /></span>
              <div>
                <p className="ma-eyebrow">Minha agenda</p>
                <h1>{dayTitle(day)}</h1>
              </div>
              {day === today && <span className="ma-today">hoje</span>}
            </div>
            <div className="ma-nav">
              <button type="button" onClick={() => setDay((d) => shiftDay(d, -1))} className="ma-hbtn is-icon" aria-label="Dia anterior">
                <ChevronLeft size={17} />
              </button>
              <button type="button" onClick={() => setDay(today)} disabled={day === today} className="ma-hbtn">
                Hoje
              </button>
              <button type="button" onClick={() => setDay((d) => shiftDay(d, 1))} className="ma-hbtn is-icon" aria-label="Próximo dia">
                <ChevronRight size={17} />
              </button>
              <label className="ma-hbtn ma-date">
                <CalendarDays size={15} />
                <input
                  type="date"
                  value={day}
                  onChange={(e) => e.target.value && setDay(e.target.value)}
                  aria-label="Escolher dia"
                />
              </label>
              <button type="button" onClick={() => load()} className="ma-hbtn is-icon" aria-label="Atualizar" title="Atualizar">
                <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>

          {/* Resumo do dia */}
          <div className="ma-stats">
            <Stat label={counts.total === 1 ? 'paciente' : 'pacientes'} value={counts.total} dot="#c3c7ce" />
            <Stat label="a atender" value={counts.pendentes} dot={STATUS_BY_ID.AGENDADO.color} />
            <Stat label={counts.atendidos === 1 ? 'atendido' : 'atendidos'} value={counts.atendidos} dot="#22c55e" />
            <Stat label={counts.faltas === 1 ? 'faltou' : 'faltaram'} value={counts.faltas} dot="#ef4444" />
          </div>
          {counts.total > 0 && (
            <div className="ma-progress">
              <span className="ma-progress-bar"><i style={{ width: `${Math.round((resolvidos / counts.total) * 100)}%` }} /></span>
              <span>{resolvidos} de {counts.total} resolvidos</span>
            </div>
          )}
        </section>

        {/* Dias anteriores ainda sem confirmação — confirma aqui mesmo. */}
        {pendentes.length > 0 && (
          <section className="ma-pend">
            <div className="ma-pend-head">
              <span className="ma-pend-ico"><AlertTriangle size={16} /></span>
              <b>{pendentes.length === 1 ? '1 atendimento' : `${pendentes.length} atendimentos`} dos últimos {PENDENTES_DIAS} dias a confirmar</b>
            </div>
            <ul>
              {pendentes.map((ev) => {
                const nomeP = ev.patient?.name || ev.lead?.name || ev.title || 'Paciente';
                return (
                  <li key={ev.id} className="ma-pend-row">
                    <span className="ma-pend-when">{ev.start_at.slice(8, 10)}/{ev.start_at.slice(5, 7)} · {hhmm(ev.start_at)}</span>
                    <span className="ma-pend-name">{nomeP}</span>
                    <button type="button" onClick={() => pedirAtendido(ev)} className="ma-btn is-ok-solid">
                      <Check size={14} /> Confirmar
                    </button>
                    <button type="button" onClick={() => setStatus(ev, 'NO_SHOW')} className="ma-btn is-miss">
                      <X size={14} /> Faltou
                    </button>
                    {/* Ocupa o lugar do "…" das linhas do dia: os botões ficam alinhados com os de lá. */}
                    <span className="ma-pend-spacer" aria-hidden />

                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {loading && events.length === 0 ? (
          <div className="ma-empty">
            <Loader2 size={20} className="animate-spin" /> Carregando...
          </div>
        ) : events.length === 0 ? (
          <div className="ma-empty">
            <Calendar size={28} />
            Nenhum paciente na sua agenda neste dia.
          </div>
        ) : (
          <ul className="ma-list">
            {events.map((ev, idx) => {
              const st = STATUS_BY_ID[ev.status] ?? STATUS_BY_ID.AGENDADO;
              const name = ev.patient?.name || ev.lead?.name || ev.title || 'Paciente';
              const what = ev.appointment_type?.name || TYPE_LABEL[ev.type] || ev.type;
              const cancelled = ev.status === 'CANCELADO';
              const arrived = CHEGOU.includes(ev.status);
              const past = ev.status === 'CONCLUIDO' || ev.status === 'NO_SHOW';
              const busy = savingId === ev.id;
              const who = (
                <>
                  <span className="ma-av">
                    <PatientAvatar
                      patientId={ev.patient?.id ?? ev.lead?.id ?? ev.id}
                      patientName={name}
                      avatarUrl={ev.patient?.avatar_url ?? null}
                      fallbackPhotoUrl={ev.lead?.profile_picture_url}
                      size={42}
                      shape="circle"
                    />
                  </span>
                  <span className="ma-who-txt">
                    <b>{name}</b>
                    {/* Status embaixo do nome (não na coluna dos botões): os botões ficam
                        com largura fixa e alinhados em todas as linhas. */}
                    <span className="ma-who-sub">
                      <small>{what}</small>
                      <span className="ma-chip" style={{ color: STATUS_INK[ev.status] ?? st.color }}>
                        <i className={arrived ? 'is-pulse' : ''} />
                        {st.label}
                      </span>
                    </span>
                  </span>
                </>
              );
              return (
                <Fragment key={ev.id}>
                  {idx === agoraIdx && agoraMarker}
                  <li
                    className={`ma-item${arrived ? ' is-arrived' : ''}${past ? ' is-past' : ''}${cancelled ? ' is-cancelled' : ''}${menuFor === ev.id ? ' is-menu' : ''}`}
                    style={{ '--ma-st': st.color } as CSSProperties}
                  >
                    <div className="ma-when">
                      <b>{hhmm(ev.start_at)}</b>
                      {ev.end_at && <span>até {hhmm(ev.end_at)}</span>}
                    </div>
                    <div className="ma-rail" aria-hidden><i /></div>
                    <div className="ma-card">
                      {/* Foto + nome abrem as boas-vindas (a ficha fica a um clique pelos atalhos de lá). */}
                      {cancelled ? (
                        <div className="ma-who">{who}</div>
                      ) : (
                        <button
                          type="button"
                          className="ma-who"
                          onClick={() => setWelcomeId(ev.id)}
                          aria-label={`Boas-vindas a ${name}`}
                          title="Abrir boas-vindas"
                        >
                          {who}
                        </button>
                      )}

                      <div className="ma-actions">
                        <BotoesAtendimento
                          ev={ev}
                          busy={busy}
                          travadoFaltou={travado(ev, 'NO_SHOW')}
                          onAtendido={() => pedirAtendido(ev)}
                          onFaltou={() => setStatus(ev, 'NO_SHOW')}
                        />
                        <div className="relative">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={(e) => { e.stopPropagation(); setMenuFor((m) => (m === ev.id ? null : ev.id)); }}
                            className="ma-more"
                            aria-label="Outros status"
                            title="Outros status"
                          >
                            <MoreHorizontal size={16} />
                          </button>
                          {menuFor === ev.id && (
                            <div className="ma-menu" onClick={(e) => e.stopPropagation()}>
                              {STATUSES.map((s) => (
                                <button
                                  key={s.id}
                                  type="button"
                                  disabled={travado(ev, s.id)}
                                  title={travado(ev, s.id) ? 'Atendimento já validado — só o administrador' : undefined}
                                  onClick={() => (s.id === 'CONCLUIDO' ? pedirAtendido(ev) : setStatus(ev, s.id))}
                                  className={s.id === ev.status ? 'is-current' : ''}
                                >
                                  <span className="ma-menu-dot" style={{ background: s.color }} />
                                  {s.label}
                                  {s.id === ev.status && <Check size={14} className="ma-menu-check" />}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </li>
                </Fragment>
              );
            })}
            {agoraIdx === events.length && agoraMarker}
          </ul>
        )}
      </div>
      {welcomeId && (
        <BoasVindasPaciente
          events={events.filter((e) => e.status !== 'CANCELADO')}
          startId={welcomeId}
          dentistName={myName}
          onClose={() => setWelcomeId(null)}
          pausado={!!confirming}
          acoes={(e) => (
            <BotoesAtendimento
              ev={e}
              busy={savingId === e.id}
              travadoFaltou={travado(e, 'NO_SHOW')}
              onAtendido={() => pedirAtendido(e)}
              onFaltou={() => setStatus(e, 'NO_SHOW')}
              big
            />
          )}
        />
      )}
      {/* Com as boas-vindas abertas (tela cheia, z 900) a confirmação sobe por cima dela. */}
      {confirmModal && (welcomeId ? createPortal(<div className="relative z-[950]">{confirmModal}</div>, document.body) : confirmModal)}
    </div>
  );
}

/**
 * "Atendido" + "Faltou" de um atendimento — na linha da lista e, maiores (`big`), na
 * tela de boas-vindas. Mesma regra nos dois lugares: "Atendido" abre a confirmação
 * (o que foi feito → prontuário); já confirmado trava; Faltou de consulta validada
 * só o admin.
 */
function BotoesAtendimento({ ev, busy, travadoFaltou, onAtendido, onFaltou, big = false }: {
  ev: AgendaEvent;
  busy: boolean;
  travadoFaltou: boolean;
  onAtendido: () => void;
  onFaltou: () => void;
  big?: boolean;
}) {
  const isDone = ev.status === 'CONCLUIDO';
  // Recepção marcou "Atendido" mas o dentista ainda não confirmou: o botão
  // segue clicável e VALIDA (some do quadrante "Confirmar atendimentos").
  const needsConfirm = isDone && !ev.validated_at && !!ev.assigned_user_id;
  const isNoShow = ev.status === 'NO_SHOW';
  const done = STATUS_BY_ID.CONCLUIDO.color;
  const miss = STATUS_BY_ID.NO_SHOW.color;
  const size = big ? 'h-11 px-5 gap-1.5 rounded-xl text-[15px]' : 'h-[38px] px-3.5 gap-1.5 rounded-xl text-[13.5px] justify-center';
  // Na lista, largura FIXA: "Atendido"/"Confirmar" e "Faltou" ficam alinhados em todas as linhas.
  const wAt = big ? '' : 'w-[124px]';
  const wFt = big ? '' : 'w-[96px]';
  const icon = big ? 17 : 15;
  const idle = '#ffffff';
  return (
    <>
      <button
        type="button"
        disabled={busy || (isDone && !needsConfirm)}
        onClick={onAtendido}
        className={`${size} ${wAt} inline-flex items-center font-semibold border transition-colors disabled:cursor-default`}
        style={isDone
          ? { background: done, color: '#fff', borderColor: done }
          : { background: idle, color: done, borderColor: `${done}66` }}
        title={needsConfirm ? 'Confirmar que você atendeu' : 'Marcar como atendido'}
      >
        {busy ? <Loader2 size={icon} className="animate-spin" /> : <Check size={icon} />} {needsConfirm ? 'Confirmar' : 'Atendido'}
      </button>
      <button
        type="button"
        disabled={busy || isNoShow || travadoFaltou}
        onClick={onFaltou}
        className={`${size} ${wFt} inline-flex items-center font-semibold border transition-colors disabled:cursor-default disabled:opacity-60`}
        style={isNoShow
          ? { background: miss, color: '#fff', borderColor: miss }
          : { background: idle, color: miss, borderColor: `${miss}66` }}
        title={travadoFaltou
          ? 'Atendimento já validado — só o administrador marca Faltou'
          : 'Marcar que o paciente faltou'}
      >
        <X size={icon} /> Faltou
      </button>
    </>
  );
}

/** Contador do resumo do dia, no topo grafite. */
function Stat({ label, value, dot }: { label: string; value: number; dot: string }) {
  return (
    <div className="ma-stat">
      <span><i style={{ background: dot }} />{label}</span>
      <b>{value}</b>
    </div>
  );
}
