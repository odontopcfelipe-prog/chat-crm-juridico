'use client';

/**
 * Painel de entrada do DENTISTA (out/2026 — visual de referência do dono).
 *
 *  - Topo próprio: logo da clínica (a mesma da barra lateral, Tenant.logo_url),
 *    busca SÓ nos pacientes dele (GET /patients já vem filtrado pela carteira do
 *    dentista na API — ownPatientsWhere) e a conta.
 *  - Boas-vindas + relógio com o próximo paciente do dia.
 *  - Os mesmos cards do setor (resolveHomeActions + badges my_*), com ilustração.
 *  - Resumo do dia (agenda dele), procedimentos do mês (GET /my-procedures) e
 *    tarefas de hoje (as dele + confirmar atendimentos pendentes).
 *
 * Com o profissional não se fala em dinheiro: só contagens e pontos.
 * Paleta fixa e clara (como o resto da home), independente do tema.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Search, Calendar, Users, Activity, Trophy, Clock, ArrowRight, Sun, CloudSun, Moon,
  BarChart3, CheckSquare, Circle, CheckCircle2, CalendarDays, CalendarX2, Loader2, UserRound,
  ChevronDown, type LucideIcon,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { resolveHomeActions, PONTO_BALAO, type HomeAction, type Permission } from '@crm/shared';
import api from '@/lib/api';
import { useTenant } from '@/lib/useTenant';
import { useRole } from '@/lib/useRole';
import { useModuleBadges } from '@/lib/useModuleBadges';
import { usePontoStatus } from '@/lib/usePontoStatus';
import { AccountMenu } from '@/app/atendimento/components/AccountMenu';
import { NotificationCenter } from '@/app/atendimento/components/NotificationCenter';
import {
  CalendarArt, PatientCardsArt, ToothRingArt, TrophyArt, ClockArt, HeroArt, LeavesArt,
} from './dentist-illustrations';
import './dentist-home.css';

interface Props {
  userName?: string | null;
  extraGrants?: Permission[];
  extraRevokes?: Permission[];
}

// ─── Datas (agenda é naive-UTC: hora de Maceió gravada nos campos UTC) ─────────

const DIAS = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const PATIENT_TYPES = ['CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA'];
const TYPE_LABEL: Record<string, string> = {
  CONSULTA: 'Consulta', PROCEDIMENTO: 'Procedimento', RETORNO: 'Retorno', ORTODONTIA: 'Ortodontia',
};
const H3 = 3 * 60 * 60 * 1000;
const maceioToday = () => new Date(Date.now() - H3).toISOString().slice(0, 10);
const naiveNowIso = () => new Date(Date.now() - H3).toISOString();
const hhmmNaive = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};
const dayOfYear = (d: Date) => Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 0).getTime()) / 86_400_000);

const QUOTES = [
  'Sorrisos transformam histórias.',
  'Cada sorriso que você cuida muda o dia de alguém.',
  'Detalhe bem feito vira sorriso confiante.',
  'Paciente bem cuidado volta — e traz quem ama.',
  'Um sorriso de cada vez.',
  'Excelência é um hábito, não um ato.',
  'Cuidar bem é o melhor cartão de visita.',
];
const PHRASES = [
  'Disciplina hoje, resultados amanhã.',
  'Foco no próximo paciente.',
  'Pequenos cuidados, grandes resultados.',
  'Constância vence talento.',
  'Capricho é o que o paciente lembra.',
];

function salutation(h: number) {
  if (h >= 5 && h < 12) return { text: 'Bom dia', Icon: Sun };
  if (h >= 12 && h < 18) return { text: 'Boa tarde', Icon: CloudSun };
  return { text: 'Boa noite', Icon: Moon };
}

// ─── Dados do dia (agenda DELE) ───────────────────────────────────────────────

interface AgendaEvent {
  id: string;
  type: string;
  status: string;
  start_at: string;
  validated_at?: string | null;
  assigned_user_id?: string | null;
  patient?: { id: string; name: string } | null;
  lead?: { name: string | null } | null;
}

function useMyDay(userId: string | null) {
  const [events, setEvents] = useState<AgendaEvent[] | null>(null);
  const [pending, setPending] = useState<AgendaEvent[]>([]);

  const load = useCallback(async () => {
    if (!userId) return;
    const day = maceioToday();
    const mine = (e: AgendaEvent) => PATIENT_TYPES.includes(e.type) && (e.assigned_user_id === userId || !e.assigned_user_id);
    const [ev, pend] = await Promise.allSettled([
      api.get<AgendaEvent[]>('/calendar/events', {
        params: { start: `${day}T00:00:00.000Z`, end: `${day}T23:59:59.999Z`, userId },
      }),
      api.get<AgendaEvent[]>('/calendar/events/pending-validation', { params: { onlyMine: 'true', daysBack: 7 } }),
    ]);
    setEvents(ev.status === 'fulfilled' && Array.isArray(ev.value.data)
      ? ev.value.data.filter(mine).sort((a, b) => a.start_at.localeCompare(b.start_at))
      : []);
    setPending(pend.status === 'fulfilled' && Array.isArray(pend.value.data)
      ? pend.value.data.filter((e) => PATIENT_TYPES.includes(e.type) && e.assigned_user_id === userId)
      : []);
  }, [userId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const summary = useMemo(() => {
    const list = events ?? [];
    const now = naiveNowIso();
    return {
      done: list.filter((e) => e.status === 'CONCLUIDO' || !!e.validated_at).length,
      toConfirm: pending.length,
      scheduled: list.filter((e) => e.status !== 'CANCELADO').length,
      missed: list.filter((e) => e.status === 'CANCELADO' || e.status === 'NO_SHOW').length,
      next: list.find((e) => e.start_at >= now && !['CONCLUIDO', 'CANCELADO', 'NO_SHOW'].includes(e.status)) ?? null,
    };
  }, [events, pending]);

  return { loading: events === null, summary };
}

// ─── Topo: logo, busca nos pacientes dele, conta ──────────────────────────────

interface PatientHit { id: string; name: string }

function PatientSearch() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<PatientHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const reqRef = useRef(0);

  // "/" foca ESTA busca (e não abre o localizador do layout).
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== '/') return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      e.preventDefault();
      e.stopPropagation();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setHits([]); setLoading(false); return; }
    setLoading(true);
    const id = ++reqRef.current;
    const t = setTimeout(async () => {
      try {
        // A API já devolve só a carteira do dentista (pacientes DELE).
        const { data } = await api.get<{ data: PatientHit[] }>('/patients', { params: { search: term, limit: 8 } });
        if (id !== reqRef.current) return;
        setHits(Array.isArray(data?.data) ? data.data : []);
        setActive(0);
      } catch {
        if (id === reqRef.current) setHits([]);
      } finally {
        if (id === reqRef.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const go = (p?: PatientHit) => {
    if (!p) return;
    setOpen(false);
    setQ('');
    router.push(`/atendimento/pacientes/${p.id}`);
  };

  const showList = open && q.trim().length >= 2;

  return (
    <div className="dh-search">
      <Search size={18} className="dh-search-ico" />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === 'Enter') { e.preventDefault(); go(hits[active]); }
          else if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur(); }
        }}
        placeholder="Buscar entre os meus pacientes…"
        aria-label="Buscar entre os meus pacientes"
      />
      <kbd>/</kbd>
      {showList && (
        <div className="dh-search-list" role="listbox">
          {loading && hits.length === 0 ? (
            <div className="dh-search-empty"><Loader2 size={14} className="animate-spin" /> Buscando…</div>
          ) : hits.length === 0 ? (
            <div className="dh-search-empty">Nenhum paciente seu com esse nome.</div>
          ) : (
            hits.map((p, i) => (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={i === active}
                className={`dh-search-item ${i === active ? 'is-active' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); go(p); }}
                onMouseEnter={() => setActive(i)}
              >
                <span className="dh-search-av">{(p.name || '?').trim().charAt(0).toUpperCase()}</span>
                <span className="dh-search-name">{p.name}</span>
                <span className="dh-search-go">Abrir ficha <ArrowRight size={13} /></span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function TopBar({ userName }: { userName?: string | null }) {
  const tenant = useTenant();
  return (
    <header className="dh-top">
      <Link href="/atendimento/dashboard" className="dh-brand" title={tenant?.name || 'Início'}>
        {tenant?.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={tenant.logo_url} alt={tenant.name || 'Logo da clínica'} className="dh-brand-logo" />
        ) : (
          <span className="dh-brand-mark">{(tenant?.name || 'C').charAt(0)}</span>
        )}
        {tenant?.name && <span className="dh-brand-name">{tenant.name}</span>}
      </Link>
      <PatientSearch />
      <div className="dh-top-right">
        <span className="dh-bell"><NotificationCenter /></span>
        <AccountMenu name={userName} subtitle="Dentista" />
      </div>
    </header>
  );
}

// ─── Boas-vindas + relógio ────────────────────────────────────────────────────

function Hero({ name, clinicName, today }: { name: string; clinicName?: string; today: Date }) {
  const { text } = salutation(today.getHours());
  return (
    <section className="dh-hero">
      <div className="dh-hero-text">
        <p className="dh-hero-hello">{text},</p>
        {name
          ? <h1 className={`dh-hero-name ${name.length > 14 ? 'dh-hero-name-long' : ''}`}>{name}!</h1>
          : <h1 className="dh-hero-name dh-hero-name-wait" aria-hidden>&nbsp;</h1>}
        <p className="dh-hero-lead">Que tal fazer mais sorrisos hoje? <span aria-hidden>😊</span></p>
        <p className="dh-hero-quote">&ldquo;{QUOTES[dayOfYear(today) % QUOTES.length]}&rdquo;</p>
        {clinicName && <p className="dh-hero-clinic">{clinicName}</p>}
      </div>
      <div className="dh-hero-art"><HeroArt /></div>
      <p className="dh-hero-script">Mais sorrisos,<br />mais histórias!</p>
    </section>
  );
}

function ClockCard({ next }: { next: AgendaEvent | null }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);
  if (!now) return <section className="dh-clock" />;
  const { text, Icon } = salutation(now.getHours());
  const nextName = next ? (next.patient?.name || next.lead?.name || 'Paciente') : null;
  return (
    <section className="dh-clock">
      <div className="dh-clock-date">
        <CalendarDays size={26} />
        <div>
          <strong>{DIAS[now.getDay()]}</strong>
          <span>{now.getDate()} de {MESES[now.getMonth()]} de {now.getFullYear()}</span>
        </div>
      </div>
      <div className="dh-clock-time">
        {String(now.getHours()).padStart(2, '0')}:{String(now.getMinutes()).padStart(2, '0')}
      </div>
      <div className="dh-clock-greet">
        <Icon size={22} />
        <div>
          <strong>{text}!</strong>
          <span>{PHRASES[dayOfYear(now) % PHRASES.length]}</span>
        </div>
      </div>
      {next && nextName && (
        <Link href="/atendimento/minha-agenda" className="dh-clock-next">
          <Clock size={14} />
          <span>Próximo: <b>{hhmmNaive(next.start_at)}</b> · {nextName.split(' ').slice(0, 2).join(' ')}
            {TYPE_LABEL[next.type] ? ` · ${TYPE_LABEL[next.type]}` : ''}</span>
        </Link>
      )}
      <div className="dh-clock-leaves"><LeavesArt /></div>
    </section>
  );
}

// ─── Cards dos módulos (mesmos do setor, com ilustração) ──────────────────────

const ICONS: Record<string, LucideIcon> = { Calendar, Users, Activity, Trophy, Clock };

function artFor(a: HomeAction) {
  if (a.href.startsWith('/atendimento/minha-agenda')) return <CalendarArt />;
  if (a.href.includes('plano=ativo')) return <ToothRingArt />;
  if (a.href.startsWith('/atendimento/pacientes')) return <PatientCardsArt />;
  if (a.href.startsWith('/atendimento/meu-jogo')) return <TrophyArt />;
  return <ClockArt />;
}

function ModuleCards({ actions, badges }: { actions: HomeAction[]; badges: Record<string, { value: string }> }) {
  return (
    <div className="dh-cards">
      {actions.map((a) => {
        const Icon = (a.lucide && ICONS[a.lucide]) || Calendar;
        const badge = a.badgeKey ? badges[a.badgeKey] : undefined;
        return (
          <Link key={a.label} href={a.href} className="dh-card" data-tone={a.tone}>
            <div className="dh-card-head">
              <span className="dh-card-ico"><Icon size={26} strokeWidth={2} /></span>
              {badge && <span className="dh-card-badge">{a.badgeKey === 'my_game_points' ? '🏅 ' : ''}{badge.value}</span>}
            </div>
            <h3>{a.label}</h3>
            {a.desc && <p>{a.desc}</p>}
            <span className="dh-card-go" aria-hidden><ArrowRight size={22} /></span>
            <div className="dh-card-art">{artFor(a)}</div>
          </Link>
        );
      })}
    </div>
  );
}

// ─── Resumo do dia ────────────────────────────────────────────────────────────

function DaySummary({ loading, s }: { loading: boolean; s: ReturnType<typeof useMyDay>['summary'] }) {
  const tiles = [
    { label: 'Atendidos hoje', value: s.done, Icon: Users, tone: 'green' },
    { label: 'A confirmar', value: s.toConfirm, Icon: Clock, tone: 'orange' },
    { label: 'Na agenda hoje', value: s.scheduled, Icon: CalendarDays, tone: 'blue' },
    { label: 'Faltas e desmarcações', value: s.missed, Icon: CalendarX2, tone: 'red' },
  ];
  return (
    <section className="dh-panel">
      <h2><BarChart3 size={18} /> Resumo do dia</h2>
      <div className="dh-sum">
        {tiles.map(({ label, value, Icon, tone }) => (
          <Link key={label} href="/atendimento/minha-agenda" className="dh-sum-tile" data-tone={tone}>
            <Icon size={22} />
            <strong>{loading ? '–' : value}</strong>
            <span>{label}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

// ─── Procedimentos do mês (só contagem) ───────────────────────────────────────

function lastMonths(n: number) {
  const now = new Date(Date.now() - H3);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    const label = `${MESES[d.getUTCMonth()].charAt(0).toUpperCase()}${MESES[d.getUTCMonth()].slice(1)}/${d.getUTCFullYear()}`;
    return { key, label };
  });
}

function MonthProcedures() {
  const months = useMemo(() => lastMonths(6), []);
  const [month, setMonth] = useState(months[0].key);
  const [loaded, setLoaded] = useState<{ month: string; total: number; items: { label: string; count: number }[] } | null>(null);

  useEffect(() => {
    let alive = true;
    api.get('/my-procedures', { params: { month } })
      .then(({ data: d }) => {
        if (alive) setLoaded({ month, total: d?.total ?? 0, items: Array.isArray(d?.items) ? d.items : [] });
      })
      .catch(() => { if (alive) setLoaded({ month, total: 0, items: [] }); });
    return () => { alive = false; };
  }, [month]);

  // Enquanto o mês escolhido não chega, mostra "Carregando…" (não o mês anterior).
  const data = loaded?.month === month ? loaded : null;
  const max = Math.max(1, ...(data?.items ?? []).map((i) => i.count));
  return (
    <section className="dh-panel">
      <div className="dh-panel-head">
        <h2><BarChart3 size={18} /> Procedimentos do mês</h2>
        <label className="dh-select">
          <select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Mês">
            {months.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
          <ChevronDown size={14} />
        </label>
      </div>
      {!data ? (
        <div className="dh-empty"><Loader2 size={16} className="animate-spin" /> Carregando…</div>
      ) : data.items.length === 0 ? (
        <div className="dh-empty">Nenhum procedimento registrado neste mês ainda.</div>
      ) : (
        <div className="dh-bars">
          {data.items.map((it) => (
            <div key={it.label} className="dh-bar" title={`${it.label}: ${it.count}`}>
              <span className="dh-bar-val">{it.count}</span>
              <span className="dh-bar-fill" style={{ height: `${Math.max(6, (it.count / max) * 100)}%` }} />
              <span className="dh-bar-label">{it.label}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Tarefas de hoje ─────────────────────────────────────────────────────────

interface TaskRow { id: string; title: string; due_at: string | null; status: string }

function TodayTasks({ userId, toConfirm }: { userId: string | null; toConfirm: number }) {
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    api.get<{ data: TaskRow[] }>('/tasks', { params: { page: 1, limit: 50, assignedUserId: userId } })
      .then(({ data }) => {
        const end = new Date(); end.setHours(23, 59, 59, 999);
        setTasks((Array.isArray(data?.data) ? data.data : [])
          .filter((t) => !['CONCLUIDA', 'CANCELADA'].includes(t.status) && t.due_at && new Date(t.due_at) <= end)
          .sort((a, b) => (a.due_at || '').localeCompare(b.due_at || '')));
      })
      .catch(() => setTasks([]));
  }, [userId]);

  const complete = async (t: TaskRow) => {
    setBusy(t.id);
    try {
      await api.post(`/tasks/${t.id}/complete`, { note: '' });
      setTasks((list) => (list || []).filter((x) => x.id !== t.id));
      toast.success('Tarefa concluída');
    } catch {
      toast.error('Não foi possível concluir a tarefa');
    } finally {
      setBusy(null);
    }
  };

  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const shown = (tasks ?? []).slice(0, 5);
  const empty = tasks !== null && tasks.length === 0 && toConfirm === 0;

  return (
    <section className="dh-panel">
      <h2><CheckSquare size={18} /> Tarefas de hoje</h2>
      <ul className="dh-tasks">
        {toConfirm > 0 && (
          <li>
            <Link href="/atendimento/minha-agenda" className="dh-task is-auto">
              <CheckCircle2 size={18} />
              <span className="dh-task-title">
                Confirmar {toConfirm} atendimento{toConfirm > 1 ? 's' : ''} e registrar o que foi feito
              </span>
              <span className="dh-task-time">agora</span>
            </Link>
          </li>
        )}
        {shown.map((t) => {
          const due = t.due_at ? new Date(t.due_at) : null;
          const late = !!due && due < startOfToday;
          return (
            <li key={t.id}>
              <div className="dh-task">
                <button
                  type="button"
                  className="dh-task-check"
                  onClick={() => complete(t)}
                  disabled={busy === t.id}
                  title="Marcar como feita"
                >
                  {busy === t.id ? <Loader2 size={18} className="animate-spin" /> : <Circle size={18} />}
                </button>
                <span className="dh-task-title">{t.title}</span>
                <span className={`dh-task-time ${late ? 'is-late' : ''}`}>
                  {late ? 'atrasada' : due ? `${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}` : ''}
                </span>
              </div>
            </li>
          );
        })}
        {tasks === null && <li className="dh-empty"><Loader2 size={16} className="animate-spin" /> Carregando…</li>}
        {empty && <li className="dh-empty">Tudo em dia por hoje ✨</li>}
        {(tasks?.length ?? 0) > shown.length && (
          <li className="dh-task-more">+{(tasks?.length ?? 0) - shown.length} tarefa(s)</li>
        )}
      </ul>
    </section>
  );
}

// ─── Página ──────────────────────────────────────────────────────────────────

export default function DentistHome({ userName, extraGrants = [], extraRevokes = [] }: Props) {
  const role = useRole();
  const tenant = useTenant();
  const ponto = usePontoStatus();
  const { data: badgesData } = useModuleBadges('dentista');
  const { loading, summary } = useMyDay(role.userId);
  const [today, setToday] = useState<Date | null>(null);
  useEffect(() => { setToday(new Date()); }, []);

  const actions = [
    ...resolveHomeActions('dentista', extraGrants, extraRevokes),
    ...(ponto.member ? [PONTO_BALAO] : []),
  ];
  // Nome COMPLETO como está no cadastro (ex.: "Dra. Rayane ..."). Vazio até o
  // /users/me chegar (evita piscar "Doutor(a)" antes do nome).
  const fullName = (userName || '').trim().replace(/\s+/g, ' ');

  return (
    <div className="dh">
      <TopBar userName={userName} />
      <div className="dh-row1">
        {today ? <Hero name={fullName} clinicName={tenant?.name} today={today} /> : <section className="dh-hero" />}
        <ClockCard next={summary.next} />
      </div>
      <ModuleCards actions={actions} badges={badgesData?.badges ?? {}} />
      <div className="dh-row3">
        <DaySummary loading={loading} s={summary} />
        <MonthProcedures />
        <TodayTasks userId={role.userId} toConfirm={summary.toConfirm} />
      </div>
      <p className="dh-foot"><UserRound size={13} /> Você vê só os seus pacientes e a sua agenda.</p>
    </div>
  );
}
