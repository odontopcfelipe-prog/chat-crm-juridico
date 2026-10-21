'use client';

/**
 * Painel de entrada do DENTISTA (out/2026 — visual de referência do dono).
 *
 *  - Topo próprio: logo da clínica (a mesma da barra lateral, Tenant.logo_url),
 *    busca SÓ nos pacientes dele (GET /patients já vem filtrado pela carteira do
 *    dentista na API — ownPatientsWhere) e a conta.
 *  - Boas-vindas + relógio com a fila "Próximos" do dia: quem a recepção marcou
 *    "Chegou" sobe pro topo; 3 por vez, passando sozinha pro lado.
 *  - Os mesmos cards do setor (resolveHomeActions + badges my_*), com ilustração.
 *  - Resumo do dia (agenda dele), procedimentos do mês (GET /my-procedures) e
 *    tarefas de hoje (as dele + confirmar atendimentos pendentes).
 *
 * Com o profissional não se fala em dinheiro: só contagens e pontos.
 * Out/2026 — visual NEUTRO multi-clínica: paleta fixa clara + saudação grafite; a
 * única cor é a da clínica (Tenant.theme_color → --dh-accent). Cabe numa tela só.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Search, Calendar, Users, Activity, Trophy, Clock, ArrowRight, Sun, CloudSun, Moon,
  BarChart3, CheckSquare, Circle, CheckCircle2, CalendarDays, CalendarX2, Loader2, UserRound,
  ChevronDown, TrendingUp, ClipboardCheck, type LucideIcon,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { resolveHomeActions, PONTO_BALAO, type HomeAction, type Permission } from '@crm/shared';
import api from '@/lib/api';
import { useTenant } from '@/lib/useTenant';
import { tenantAccent } from '@/lib/tenant-accent';
import { useRole } from '@/lib/useRole';
import { useModuleBadges } from '@/lib/useModuleBadges';
import { usePontoStatus } from '@/lib/usePontoStatus';
import { PatientAvatar } from '@/components/PatientAvatar';
import { AccountMenu } from '@/app/atendimento/components/AccountMenu';
import {
  CalendarArt, PatientCardsArt, ToothRingArt, TrophyArt, ClockArt, HeroArt, LeavesArt, ValidateArt,
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
  patient?: { id: string; name: string; avatar_url?: string | null } | null;
  lead?: { id?: string; name: string | null; profile_picture_url?: string | null } | null;
  appointment_type?: { name?: string | null } | null;
}

/** Ainda na fila do dia (não atendido, não faltou/desmarcou). */
const NA_FILA = ['AGENDADO', 'CONFIRMADO', 'COMPARECEU', 'EM_ATENDIMENTO'];
/** A recepção já registrou a chegada. */
const CHEGOU = ['COMPARECEU', 'EM_ATENDIMENTO'];

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
    // 30s: a chegada que a recepção marca aparece na fila sem o dentista recarregar.
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const summary = useMemo(() => {
    const list = events ?? [];
    return {
      done: list.filter((e) => e.status === 'CONCLUIDO' || !!e.validated_at).length,
      toConfirm: pending.length,
      scheduled: list.filter((e) => e.status !== 'CANCELADO').length,
      missed: list.filter((e) => e.status === 'CANCELADO' || e.status === 'NO_SHOW').length,
    };
  }, [events, pending]);

  // Fila "Próximos": quem chegou primeiro; o resto pelo horário.
  const queue = useMemo(() => (events ?? [])
    .filter((e) => NA_FILA.includes(e.status) && !e.validated_at)
    .sort((a, b) => (Number(CHEGOU.includes(b.status)) - Number(CHEGOU.includes(a.status)))
      || a.start_at.localeCompare(b.start_at)), [events]);

  return { loading: events === null, summary, queue };
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
      <Search size={17} className="dh-search-ico" />
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
      {/* Sem sino de notificações: regra do dono — o dentista não recebe as
          notificações da clínica (o layout também esconde pro setor dentista). */}
      <div className="dh-top-right">
        <AccountMenu name={userName} subtitle="Dentista" />
      </div>
    </header>
  );
}

// ─── Boas-vindas (grafite) + relógio com a fila ──────────────────────────────

function Hero({ name, clinicName, today }: { name: string; clinicName?: string; today: Date }) {
  const { text } = salutation(today.getHours());
  return (
    <section className="dh-hero">
      <span className="dh-hero-glow" aria-hidden />
      <svg className="dh-hero-rings" viewBox="0 0 600 600" aria-hidden="true">
        <circle cx="300" cy="300" r="290" />
        <circle cx="300" cy="300" r="220" />
        <circle cx="300" cy="300" r="150" />
      </svg>
      <div className="dh-hero-art"><HeroArt /></div>
      <p className="dh-hero-script" aria-hidden>Mais sorrisos,<br />mais histórias!</p>
      <div className="dh-hero-text">
        <p className="dh-hero-hello">{text},</p>
        {name
          ? <h1 className={`dh-hero-name ${name.length > 20 ? 'is-long' : ''}`}>{name}!</h1>
          : <h1 className="dh-hero-name dh-hero-name-wait" aria-hidden>&nbsp;</h1>}
        <span className="dh-hero-bar" aria-hidden />
        <p className="dh-hero-lead">Que tal fazer mais sorrisos hoje? <span aria-hidden>😊</span></p>
        <div className="dh-hero-sign">
          <p className="dh-hero-quote">&ldquo;{QUOTES[dayOfYear(today) % QUOTES.length]}&rdquo;</p>
          {clinicName && <p className="dh-hero-clinic">{clinicName}</p>}
        </div>
      </div>
    </section>
  );
}

function ClockCard({ queue, loading }: { queue: AgendaEvent[]; loading: boolean }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);
  if (!now) return <section className="dh-clock" />;
  const { text, Icon } = salutation(now.getHours());
  return (
    <section className="dh-clock">
      <svg className="dh-clock-face" viewBox="0 0 200 200" aria-hidden="true">
        <circle cx="100" cy="100" r="96" fill="none" stroke="#F0EDE7" strokeWidth="1.5" />
        <circle className="dh-afaint" cx="100" cy="100" r="70" />
        <path d="M100 44v56l34 20" fill="none" stroke="#E4E0D8" strokeWidth="4" strokeLinecap="round" />
      </svg>
      <div className="dh-clock-leaves"><LeavesArt /></div>
      <div className="dh-clock-date">
        <span className="dh-clock-ico"><CalendarDays size={18} /></span>
        <div>
          <strong>{DIAS[now.getDay()]}</strong>
          <span>{now.getDate()} de {MESES[now.getMonth()]} de {now.getFullYear()}</span>
        </div>
      </div>
      <div className="dh-clock-main">
        <div className="dh-clock-time">
          {String(now.getHours()).padStart(2, '0')}:{String(now.getMinutes()).padStart(2, '0')}
        </div>
        <div className="dh-clock-greet">
          <span className="dh-clock-greet-ico"><Icon size={15} /></span>
          <div>
            <strong>{text}!</strong>
            <span>{PHRASES[dayOfYear(now) % PHRASES.length]}</span>
          </div>
        </div>
      </div>
      <NextQueue queue={queue} loading={loading} />
    </section>
  );
}

// ─── Fila "Próximos" (3 por vez, passando sozinha) ───────────────────────────

const POR_PAGINA = 3;
const QUEUE_ST: Record<string, { label: string; tone: string }> = {
  COMPARECEU: { label: 'Chegou', tone: 'arrived' },
  EM_ATENDIMENTO: { label: 'Em atendimento', tone: 'busy' },
  CONFIRMADO: { label: 'Confirmado', tone: 'ok' },
  AGENDADO: { label: 'Agendado', tone: 'wait' },
};

function NextQueue({ queue, loading }: { queue: AgendaEvent[]; loading: boolean }) {
  const pages = useMemo(() => {
    const out: AgendaEvent[][] = [];
    for (let i = 0; i < queue.length; i += POR_PAGINA) out.push(queue.slice(i, i + POR_PAGINA));
    return out;
  }, [queue]);
  const [page, setPage] = useState(0);
  const [paused, setPaused] = useState(false);

  // A fila muda (chegou alguém, atendeu alguém): não deixa a página apontar pro vazio.
  useEffect(() => { if (page >= pages.length) setPage(0); }, [page, pages.length]);
  // Passa sozinha a cada 5s; com o mouse em cima, para.
  useEffect(() => {
    if (paused || pages.length < 2) return;
    const t = setInterval(() => setPage((p) => (p + 1) % pages.length), 5000);
    return () => clearInterval(t);
  }, [paused, pages.length]);

  const chegaram = queue.filter((e) => CHEGOU.includes(e.status)).length;
  const info = [chegaram ? `${chegaram} ${chegaram === 1 ? 'chegou' : 'chegaram'}` : '', `${queue.length} a atender`]
    .filter(Boolean).join(' · ');

  return (
    <div className="dh-queue">
      <div className="dh-queue-head">
        <span>Próximos</span>
        {!loading && queue.length > 0 && <span>{info}</span>}
      </div>
      {loading ? (
        <div className="dh-empty"><Loader2 size={15} className="animate-spin" /> Carregando…</div>
      ) : queue.length === 0 ? (
        <div className="dh-queue-empty">Ninguém na fila agora.</div>
      ) : (
        <>
          <div className="dh-queue-view" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
            <div className="dh-queue-track" style={{ transform: `translateX(-${page * 100}%)` }}>
              {pages.map((rows, i) => (
                <div key={i} className="dh-queue-page" aria-hidden={i !== page}>
                  {rows.map((ev) => <QueueRow key={ev.id} ev={ev} hidden={i !== page} />)}
                </div>
              ))}
            </div>
          </div>
          {pages.length > 1 && (
            <div className="dh-queue-dots">
              {pages.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  className={i === page ? 'is-on' : ''}
                  onClick={() => setPage(i)}
                  aria-label={`Página ${i + 1} da fila`}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function QueueRow({ ev, hidden }: { ev: AgendaEvent; hidden: boolean }) {
  const st = QUEUE_ST[ev.status] ?? QUEUE_ST.AGENDADO;
  const name = ev.patient?.name || ev.lead?.name || 'Paciente';
  const what = ev.appointment_type?.name || TYPE_LABEL[ev.type] || '';
  return (
    <Link href="/atendimento/minha-agenda" className={`dh-q is-${st.tone}`} tabIndex={hidden ? -1 : undefined}>
      <span className="dh-q-time">{hhmmNaive(ev.start_at)}</span>
      <span className="dh-q-av">
        <PatientAvatar
          patientId={ev.patient?.id ?? ev.lead?.id ?? ev.id}
          patientName={name}
          avatarUrl={ev.patient?.avatar_url ?? null}
          fallbackPhotoUrl={ev.lead?.profile_picture_url}
          size={26}
          shape="circle"
        />
      </span>
      <span className="dh-q-who">
        <b>{name}</b>
        {what && <small>{what}</small>}
      </span>
      <span className="dh-q-chip">{st.tone === 'arrived' && <i aria-hidden />}{st.label}</span>
    </Link>
  );
}

// ─── Cards dos módulos (mesmos do setor, com ilustração) ──────────────────────

const ICONS: Record<string, LucideIcon> = { Calendar, Users, Activity, Trophy, Clock, ClipboardCheck };

function artFor(a: HomeAction) {
  // Antes do teste de href: "Validar atendimento" também leva à Minha agenda.
  if (a.badgeKey === 'my_to_validate') return <ValidateArt />;
  if (a.href.startsWith('/atendimento/minha-agenda')) return <CalendarArt />;
  if (a.href.includes('plano=ativo')) return <ToothRingArt />;
  if (a.href.startsWith('/atendimento/pacientes')) return <PatientCardsArt />;
  if (a.href.startsWith('/atendimento/meu-jogo')) return <TrophyArt />;
  return <ClockArt />;
}

function ModuleCards({ actions, badges, toValidate }: {
  actions: HomeAction[];
  badges: Record<string, { value: string }>;
  /** Atendimentos que já passaram e falta validar (null = ainda carregando). */
  toValidate: number | null;
}) {
  return (
    <div className="dh-cards">
      {actions.map((a) => {
        const Icon = (a.lucide && ICONS[a.lucide]) || Calendar;
        // "Validar atendimento": o número vem do próprio painel (pending-validation);
        // com pendência o selo fica vermelho, sem nenhuma vira "Tudo validado".
        const validar = a.badgeKey === 'my_to_validate';
        const badge = validar
          ? (toValidate === null ? undefined : { value: toValidate > 0 ? `${toValidate} a validar` : 'Tudo validado ✓' })
          : (a.badgeKey ? badges[a.badgeKey] : undefined);
        const tone = a.badgeKey === 'my_agenda_today' ? 'is-strong'
          : validar ? (toValidate ? 'is-alert' : 'is-ok') : '';
        return (
          <Link key={a.label} href={a.href} className="dh-card">
            <span className="dh-card-halo" aria-hidden />
            <div className="dh-card-head">
              <span className="dh-card-ico"><Icon size={20} strokeWidth={2} /></span>
              {badge && (
                <span className={`dh-card-badge ${tone}`}>
                  {a.badgeKey === 'my_game_points' ? '🏅 ' : ''}{badge.value}
                </span>
              )}
            </div>
            <h3>{a.label}</h3>
            {a.desc && <p>{a.desc}</p>}
            <span className="dh-card-go" aria-hidden><ArrowRight size={18} /></span>
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
      <h2><span className="dh-panel-ico"><BarChart3 size={15} /></span> Resumo do dia</h2>
      <div className="dh-sum">
        {tiles.map(({ label, value, Icon, tone }) => (
          <Link key={label} href="/atendimento/minha-agenda" className="dh-sum-tile" data-tone={tone}>
            <span className="dh-sum-ico"><Icon size={15} /></span>
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
        <h2><span className="dh-panel-ico"><TrendingUp size={15} /></span> Procedimentos do mês</h2>
        <label className="dh-select">
          <select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Mês">
            {months.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
          <ChevronDown size={13} />
        </label>
      </div>
      {!data ? (
        <div className="dh-empty"><Loader2 size={16} className="animate-spin" /> Carregando…</div>
      ) : data.items.length === 0 ? (
        <div className="dh-empty">Nenhum procedimento registrado neste mês ainda.</div>
      ) : (
        <div className="dh-bars">
          {data.items.map((it) => (
            <div key={it.label} className={`dh-bar ${it.count === max ? 'is-top' : ''}`} title={`${it.label}: ${it.count}`}>
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
  // Compacto (o painel cabe numa tela): 2 tarefas + a de confirmar, ou 3 sem ela.
  const shown = (tasks ?? []).slice(0, toConfirm > 0 ? 2 : 3);
  const empty = tasks !== null && tasks.length === 0 && toConfirm === 0;

  return (
    <section className="dh-panel">
      <h2><span className="dh-panel-ico"><CheckSquare size={15} /></span> Tarefas de hoje</h2>
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
                  {busy === t.id ? <Loader2 size={17} className="animate-spin" /> : <Circle size={17} />}
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
  const { loading, summary, queue } = useMyDay(role.userId);
  const [today, setToday] = useState<Date | null>(null);
  useEffect(() => { setToday(new Date()); }, []);

  const actions = [
    ...resolveHomeActions('dentista', extraGrants, extraRevokes),
    ...(ponto.member ? [PONTO_BALAO] : []),
  ];
  // Nome COMPLETO como está no cadastro (ex.: "Dra. Rayane ..."). Vazio até o
  // /users/me chegar (evita piscar "Doutor(a)" antes do nome).
  const fullName = (userName || '').trim().replace(/\s+/g, ' ');
  // A única cor do painel é a da clínica (cinza se ela não cadastrou).
  const accent = useMemo(() => tenantAccent(tenant?.theme_color), [tenant?.theme_color]);

  return (
    <div className="dh" style={{ '--dh-accent': accent } as CSSProperties}>
      <TopBar userName={userName} />
      <div className="dh-row1">
        {today ? <Hero name={fullName} clinicName={tenant?.name} today={today} /> : <section className="dh-hero" />}
        <ClockCard queue={queue} loading={loading} />
      </div>
      <ModuleCards actions={actions} badges={badgesData?.badges ?? {}} toValidate={loading ? null : summary.toConfirm} />
      <div className="dh-row3">
        <DaySummary loading={loading} s={summary} />
        <MonthProcedures />
        <TodayTasks userId={role.userId} toConfirm={summary.toConfirm} />
      </div>
      <p className="dh-foot"><UserRound size={12} /> Você vê só os seus pacientes e a sua agenda.</p>
    </div>
  );
}
