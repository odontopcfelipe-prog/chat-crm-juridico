'use client';

/**
 * Visão geral — Central de Comando (Onda 17).
 *
 * Substitui a antiga dashboard rica (que virou /atendimento/dashboard-completo)
 * por um MENU DE ATALHOS focado no que o operador faz no dia a dia:
 *  - Saudacao personalizada com nome + hora (Bom dia/tarde/noite + data)
 *  - Mascote dente animado
 *  - 4 atalhos principais (Novo paciente / Nova avaliacao / Agendar / Metas)
 *  - 4 pilulas secundarias (Agenda do dia / Pagamento / Confirmar / WhatsApp)
 *  - Checklist de afazeres do dia (localStorage, persiste por usuario+dia)
 *  - Bloco de anotacoes rapidas (localStorage, autosave)
 *  - Botao "Dashboard completo" no canto pra acessar a antiga (charts/KPIs)
 *
 * Inspirado em Clinicorp / inicio.html (template Sorrir).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  UserPlus, FileText, Calendar, Target,
  Calendar as CalendarIcon, CreditCard, CheckCircle2, MessageCircle,
  Check, BookOpen, Sparkles,
} from 'lucide-react';
// useRole nao expoe nome do usuario — leio direto do JWT (forma usada
// em outros lugares da app). Helper local pra nao acoplar.
function getUserNameFromJWT(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const token = localStorage.getItem('token');
    if (!token) return null;
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64));
    return payload?.name || payload?.user?.name || null;
  } catch {
    return null;
  }
}

/* ───────────────────────────────────────────────────────────────
   Saudacao por hora do dia
─────────────────────────────────────────────────────────────── */
function getSalutation(hour: number) {
  if (hour >= 5 && hour < 12) return { text: 'Bom dia', period: 'morning' as const };
  if (hour >= 12 && hour < 18) return { text: 'Boa tarde', period: 'afternoon' as const };
  return { text: 'Boa noite', period: 'night' as const };
}

const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* ───────────────────────────────────────────────────────────────
   Versiculo do dia — rotaciona com base no day-of-year, igual o
   dia todo, muda automaticamente quando o calendario vira. Lista
   curada com 30 versiculos curtos e encorajadores.
─────────────────────────────────────────────────────────────── */
const VERSES: Array<{ text: string; ref: string }> = [
  { text: 'Tudo posso naquele que me fortalece.', ref: 'Filipenses 4:13' },
  { text: 'O Senhor é o meu pastor; nada me faltará.', ref: 'Salmos 23:1' },
  { text: 'A alegria do Senhor é a vossa força.', ref: 'Neemias 8:10' },
  { text: 'Se Deus é por nós, quem será contra nós?', ref: 'Romanos 8:31' },
  { text: 'Confia no Senhor de todo o teu coração.', ref: 'Provérbios 3:5' },
  { text: 'Aquietai-vos, e sabei que eu sou Deus.', ref: 'Salmos 46:10' },
  { text: 'Não temas, porque eu sou contigo.', ref: 'Isaías 41:10' },
  { text: 'Em tudo dai graças.', ref: '1 Tessalonicenses 5:18' },
  { text: 'Buscai primeiro o reino de Deus.', ref: 'Mateus 6:33' },
  { text: 'Sede fortes e corajosos.', ref: 'Deuteronômio 31:6' },
  { text: 'Tudo coopera para o bem daqueles que amam a Deus.', ref: 'Romanos 8:28' },
  { text: 'O Senhor te abençoe e te guarde.', ref: 'Números 6:24' },
  { text: 'Lança o teu cuidado sobre o Senhor.', ref: 'Salmos 55:22' },
  { text: 'Bom é dar graças ao Senhor.', ref: 'Salmos 92:1' },
  { text: 'Tudo tem o seu tempo determinado.', ref: 'Eclesiastes 3:1' },
  { text: 'Tudo o que fizerdes, fazei-o como ao Senhor.', ref: 'Colossenses 3:23' },
  { text: 'O Senhor é a minha luz e a minha salvação.', ref: 'Salmos 27:1' },
  { text: 'Que o Deus da esperança vos encha de alegria.', ref: 'Romanos 15:13' },
  { text: 'O ferro com o ferro se afia.', ref: 'Provérbios 27:17' },
  { text: 'Bem-aventurado o homem que confia no Senhor.', ref: 'Jeremias 17:7' },
  { text: 'Vinde a mim, todos vós que estais cansados.', ref: 'Mateus 11:28' },
  { text: 'O amor cobre uma multidão de pecados.', ref: '1 Pedro 4:8' },
  { text: 'Renovai-vos pelo espírito da vossa mente.', ref: 'Efésios 4:23' },
  { text: 'Não vos canseis de fazer o bem.', ref: '2 Tessalonicenses 3:13' },
  { text: 'Tudo é possível àquele que crê.', ref: 'Marcos 9:23' },
  { text: 'Não pelo poder, mas pelo meu Espírito.', ref: 'Zacarias 4:6' },
  { text: 'O Senhor pelejará por vós.', ref: 'Êxodo 14:14' },
  { text: 'O meu auxílio vem do Senhor.', ref: 'Salmos 121:2' },
  { text: 'Ainda que eu andasse pelo vale da sombra, não temeria mal algum.', ref: 'Salmos 23:4' },
  { text: 'Esperai no Senhor; sede fortes.', ref: 'Salmos 27:14' },
];

function getVerseOfDay(date: Date): { text: string; ref: string } {
  // Dia do ano (1-365/366) — determinístico, igual o dia todo
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date.getTime() - start.getTime();
  const dayOfYear = Math.floor(diff / 86_400_000);
  return VERSES[dayOfYear % VERSES.length];
}

/* ───────────────────────────────────────────────────────────────
   Atalhos principais — 4 cards
─────────────────────────────────────────────────────────────── */
const PRIMARY_ACTIONS = [
  {
    label: 'Novo paciente',
    description: 'Cadastrar uma nova ficha',
    href: '/atendimento/pacientes?new=1',
    icon: UserPlus,
    color: 'orange', // brand
  },
  {
    label: 'Nova avaliação',
    description: 'Anamnese + odontograma',
    href: '/atendimento/pacientes?new=1&tab=avaliacao',
    icon: FileText,
    color: 'teal',
  },
  {
    label: 'Agendar',
    description: 'Marcar na agenda',
    href: '/atendimento/agenda',
    icon: Calendar,
    color: 'indigo',
  },
  {
    label: 'Metas',
    description: 'Acompanhe seu progresso',
    href: '/atendimento/metas',
    icon: Target,
    color: 'violet',
  },
] as const;

const SECONDARY_ACTIONS = [
  { label: 'Agenda do dia', href: '/atendimento/agenda', icon: CalendarIcon },
  { label: 'Registrar pagamento', href: '/atendimento/financeiro', icon: CreditCard },
  { label: 'Confirmar consultas', href: '/atendimento/agenda', icon: CheckCircle2 },
  { label: 'Lembrete no WhatsApp', href: '/atendimento', icon: MessageCircle },
] as const;

const COLOR_CLASSES = {
  orange: {
    iconBg: 'bg-orange-100 dark:bg-orange-500/15',
    iconText: 'text-orange-600 dark:text-orange-400',
    glow: 'hover:shadow-orange-500/20',
    ring: 'group-hover:ring-orange-500/20',
  },
  teal: {
    iconBg: 'bg-teal-100 dark:bg-teal-500/15',
    iconText: 'text-teal-600 dark:text-teal-400',
    glow: 'hover:shadow-teal-500/20',
    ring: 'group-hover:ring-teal-500/20',
  },
  indigo: {
    iconBg: 'bg-indigo-100 dark:bg-indigo-500/15',
    iconText: 'text-indigo-600 dark:text-indigo-400',
    glow: 'hover:shadow-indigo-500/20',
    ring: 'group-hover:ring-indigo-500/20',
  },
  violet: {
    iconBg: 'bg-violet-100 dark:bg-violet-500/15',
    iconText: 'text-violet-600 dark:text-violet-400',
    glow: 'hover:shadow-violet-500/20',
    ring: 'group-hover:ring-violet-500/20',
  },
} as const;

/* ───────────────────────────────────────────────────────────────
   Afazeres padrao (template — vira persistente no localStorage)
─────────────────────────────────────────────────────────────── */
interface Task {
  id: string;
  text: string;
  detail: string;
  tag?: 'hoje' | 'atrasado' | 'retorno';
  done: boolean;
}

const DEFAULT_TASKS: Task[] = [
  { id: '1', text: 'Confirmar agendamentos de amanhã', detail: 'Revise quem precisa confirmar presença', tag: 'hoje', done: false },
  { id: '2', text: 'Cobrar parcelas atrasadas', detail: 'Veja inadimplência no Financeiro', tag: 'atrasado', done: false },
  { id: '3', text: 'Alertar pacientes de retorno', detail: 'Últimas visitas há 6+ meses', tag: 'retorno', done: false },
  { id: '4', text: 'Follow-up de orçamentos pendentes', detail: 'Quem foi enviado mas sem resposta', done: false },
];

const TAG_STYLES: Record<NonNullable<Task['tag']>, string> = {
  hoje: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
  atrasado: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400',
  retorno: 'bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-400',
};

const TAG_LABEL: Record<NonNullable<Task['tag']>, string> = {
  hoje: 'Hoje',
  atrasado: 'Atrasado',
  retorno: 'Retorno',
};

/* ───────────────────────────────────────────────────────────────
   Mascote dente — SVG simples animado
─────────────────────────────────────────────────────────────── */
function ToothMascot({ onClick }: { onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="absolute top-0 right-4 w-24 md:w-28 cursor-pointer transition-transform hover:scale-110"
      style={{ animation: 'bob 3.6s ease-in-out infinite' }}
      title="Oi!"
      aria-label="Mascote"
    >
      <svg viewBox="0 0 120 130" className="w-full drop-shadow-lg">
        <path
          d="M60 8C36 8 18 20 18 46c0 22 6 34 11 50 4 13 7 26 13 26 7 0 7-20 12-20s5 20 12 20c6 0 9-13 13-26 5-16 11-28 11-50 0-26-18-38-42-38Z"
          fill="#fff"
          stroke="#F0E6D2"
          strokeWidth="2"
        />
        <ellipse cx="46" cy="52" rx="5" ry="7" fill="#2A2622" style={{ animation: 'blink 4.5s infinite' }} />
        <ellipse cx="74" cy="52" rx="5" ry="7" fill="#2A2622" style={{ animation: 'blink 4.5s infinite' }} />
        <circle cx="44" cy="50" r="1.6" fill="#fff" />
        <circle cx="72" cy="50" r="1.6" fill="#fff" />
        <ellipse cx="38" cy="64" rx="6" ry="4" fill="#FFC9A6" opacity=".8" />
        <ellipse cx="82" cy="64" rx="6" ry="4" fill="#FFC9A6" opacity=".8" />
        <path d="M50 66c3 4 17 4 20 0" fill="none" stroke="#2A2622" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </button>
  );
}

/* ═══════════════════════════════════════════════════════════════
   PAGE
═══════════════════════════════════════════════════════════════ */
export default function VisaoGeralPage() {
  const router = useRouter();

  // Hidratacao do horario + nome — evita mismatch SSR/CSR
  const [now, setNow] = useState<Date | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  useEffect(() => {
    setNow(new Date());
    setUserName(getUserNameFromJWT());
    const id = setInterval(() => setNow(new Date()), 60_000); // atualiza data a cada min
    return () => clearInterval(id);
  }, []);

  // Tasks + Note persistem por dia (key = YYYY-MM-DD)
  const todayKey = now ? now.toISOString().slice(0, 10) : '';
  const [tasks, setTasks] = useState<Task[]>(DEFAULT_TASKS);
  const [note, setNote] = useState('');
  const [noteSaved, setNoteSaved] = useState(true);

  useEffect(() => {
    if (!todayKey) return;
    try {
      const t = localStorage.getItem(`dashboard:tasks:${todayKey}`);
      if (t) setTasks(JSON.parse(t));
      else setTasks(DEFAULT_TASKS);
      const n = localStorage.getItem(`dashboard:note:${todayKey}`);
      if (n) setNote(n);
    } catch {/* ignore */}
  }, [todayKey]);

  const persistTasks = (next: Task[]) => {
    setTasks(next);
    try { localStorage.setItem(`dashboard:tasks:${todayKey}`, JSON.stringify(next)); } catch {/* ignore */}
  };

  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onNoteChange = (v: string) => {
    setNote(v);
    setNoteSaved(false);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => {
      try { localStorage.setItem(`dashboard:note:${todayKey}`, v); } catch {/* ignore */}
      setNoteSaved(true);
    }, 600);
  };

  const toggleTask = (id: string) => {
    persistTasks(tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  };

  const doneCount = tasks.filter((t) => t.done).length;
  const allDone = doneCount === tasks.length && tasks.length > 0;
  const ringPct = tasks.length > 0 ? (doneCount / tasks.length) * 100 : 0;

  // Saudacao
  const hour = now?.getHours() ?? 8;
  const sal = getSalutation(hour);
  const dateline = now
    ? `${cap(DIAS[now.getDay()])}, ${now.getDate()} de ${MESES[now.getMonth()]} · ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    : '—';

  // Background do "ceu" baseado no periodo
  const skyBg = useMemo(() => {
    switch (sal.period) {
      case 'morning':
        return 'bg-gradient-to-b from-orange-200 via-orange-100 to-transparent';
      case 'afternoon':
        return 'bg-gradient-to-b from-amber-200 via-amber-100 to-transparent';
      case 'night':
        return 'bg-gradient-to-b from-indigo-900 via-purple-900 to-transparent';
    }
  }, [sal.period]);

  return (
    <div className="h-full overflow-y-auto bg-background relative">
      {/* CSS local pras animacoes que Tailwind nao tem out-of-the-box */}
      <style jsx>{`
        @keyframes bob {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-9px); }
        }
        @keyframes blink {
          0%, 94%, 100% { transform: scaleY(1); }
          97% { transform: scaleY(0.1); }
        }
        @keyframes wave {
          0%, 60%, 100% { transform: rotate(0); }
          10% { transform: rotate(16deg); }
          20% { transform: rotate(-8deg); }
          30% { transform: rotate(16deg); }
          40% { transform: rotate(-4deg); }
          50% { transform: rotate(10deg); }
        }
        @keyframes flicker {
          0%, 100% { transform: scale(1) rotate(-2deg); }
          50% { transform: scale(1.12) rotate(3deg); }
        }
        @keyframes twinkle {
          0%, 100% { opacity: 0.25; transform: scale(0.7); }
          50% { opacity: 1; transform: scale(1.2); }
        }
        @keyframes pulse-soft {
          0% { box-shadow: 0 0 0 0 rgba(43, 166, 74, 0.5); }
          70% { box-shadow: 0 0 0 9px rgba(43, 166, 74, 0); }
          100% { box-shadow: 0 0 0 0 rgba(43, 166, 74, 0); }
        }
        .wave-hand { display: inline-block; transform-origin: 70% 70%; animation: wave 2.6s ease-in-out infinite; }
        .pulse-dot { animation: pulse-soft 2.4s infinite; }
        .flicker { animation: flicker 0.9s ease-in-out infinite; }
        .twinkle { animation: twinkle 3s ease-in-out infinite; }
      `}</style>

      {/* Sky background — fica atras do conteudo */}
      <div className={`absolute inset-x-0 top-0 h-[360px] ${skyBg} pointer-events-none transition-colors duration-1000`}>
        {/* Sol / Lua */}
        {sal.period !== 'night' ? (
          <div
            className="absolute top-[-26px] right-[80px] w-[120px] h-[120px] rounded-full"
            style={{
              background: sal.period === 'morning'
                ? 'radial-gradient(circle, #FFCF66, #FF8A3D)'
                : 'radial-gradient(circle, #FFE08A, #FFC24D)',
              boxShadow: '0 0 100px 40px rgba(255, 210, 90, 0.45)',
            }}
          />
        ) : (
          <>
            <div
              className="absolute top-[40px] right-[140px] w-[74px] h-[74px] rounded-full"
              style={{
                background: '#FFF4D6',
                boxShadow: '0 0 60px 18px rgba(255, 240, 200, 0.45), inset -16px -8px 0 0 #F1E2B4',
              }}
            />
            {/* Estrelas */}
            {Array.from({ length: 20 }).map((_, i) => (
              <div
                key={i}
                className="absolute rounded-full bg-white twinkle"
                style={{
                  left: `${(i * 41) % 100}%`,
                  top: `${30 + ((i * 17) % 200)}px`,
                  width: `${1.5 + ((i * 7) % 3)}px`,
                  height: `${1.5 + ((i * 7) % 3)}px`,
                  animationDelay: `${(i * 0.3) % 3}s`,
                }}
              />
            ))}
          </>
        )}
      </div>

      <div className="relative z-10 max-w-6xl mx-auto p-4 md:p-6 pb-28 md:pb-12 space-y-6">

        {/* Onda 17.3 — botao "Dashboard completo" removido daqui.
            Acesso a esse conteudo agora pelo sidebar (Financeiro >
            Visao Geral). Mantem essa tela 100% focada em atalhos. */}

        {/* ─── HERO: saudacao + mascote ─── */}
        <section className="relative mb-6">
          <ToothMascot />

          {/* Eyebrow: data + hora atualizada */}
          <div className={`inline-flex items-center gap-2 text-xs font-semibold mb-2.5 ${sal.period === 'night' ? 'text-white/80' : 'text-muted-foreground'}`}>
            <span className="w-2 h-2 rounded-full bg-emerald-500 pulse-dot" />
            <span>{dateline}</span>
          </div>

          {/* Greeting */}
          <h1 className={`text-3xl md:text-5xl font-serif font-semibold leading-tight tracking-tight ${sal.period === 'night' ? 'text-white' : 'text-foreground'}`}>
            {sal.text},{' '}
            <span className="italic text-orange-600 dark:text-orange-400">
              {userName ? `Dr${userName.endsWith('a') ? 'a' : ''}. ${userName.split(' ')[0]}` : 'Doutor(a)'}
            </span>{' '}
            <span className="wave-hand">👋</span>
          </h1>

          <p className={`mt-3 text-sm md:text-base max-w-lg ${sal.period === 'night' ? 'text-white/70' : 'text-muted-foreground'}`}>
            {sal.period === 'morning'
              ? <>Bom começo de dia. Aqui estão seus atalhos pra acelerar a rotina.</>
              : sal.period === 'afternoon'
                ? <>Continue firme. Use os atalhos abaixo pra fechar o dia bem.</>
                : <>Boa noite! Hora de revisar pendências ou descansar — você escolhe.</>
            }
          </p>

          {/* Onda 17.4 — Versiculo do dia, rotaciona por day-of-year.
              Substituiu o badge mock "Bom trabalho — você está em ritmo". */}
          {now && (() => {
            const verse = getVerseOfDay(now);
            return (
              <div className={`inline-flex items-start gap-2.5 mt-4 px-3 py-2 rounded-xl text-xs md:text-sm font-medium border shadow-sm max-w-xl ${
                sal.period === 'night'
                  ? 'bg-white/10 border-white/20 text-white'
                  : 'bg-card border-border text-foreground'
              }`}>
                <span className="w-7 h-7 rounded-md bg-gradient-to-br from-amber-400 to-orange-500 grid place-items-center flex-none shadow">
                  <BookOpen size={14} className="text-white" />
                </span>
                <span className="leading-snug">
                  <span className="italic">&ldquo;{verse.text}&rdquo;</span>
                  <span className={`block text-[10px] md:text-[11px] font-semibold mt-0.5 not-italic ${sal.period === 'night' ? 'text-white/60' : 'text-muted-foreground'}`}>
                    — {verse.ref}
                  </span>
                </span>
              </div>
            );
          })()}
        </section>

        {/* ─── Atalhos principais ─── */}
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-bold text-foreground">O que vamos fazer agora?</h2>
            <span className="text-xs text-muted-foreground font-semibold flex items-center gap-1.5">
              <Sparkles size={12} />
              Atalhos rápidos · 1 clique
            </span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {PRIMARY_ACTIONS.map((a) => {
              const c = COLOR_CLASSES[a.color];
              const Icon = a.icon;
              return (
                <button
                  key={a.label}
                  onClick={() => router.push(a.href)}
                  className={`group relative overflow-hidden bg-card border border-border rounded-xl p-4 md:p-5 text-left shadow-sm hover:shadow-lg hover:-translate-y-1 transition-all duration-200 ${c.glow}`}
                >
                  <div className={`w-12 h-12 rounded-xl ${c.iconBg} grid place-items-center mb-8 transition-transform group-hover:scale-110 group-hover:-rotate-6`}>
                    <Icon size={22} className={c.iconText} />
                  </div>
                  <h3 className="text-sm md:text-base font-bold text-foreground flex items-center justify-between">
                    {a.label}
                    <span className="opacity-0 group-hover:opacity-100 transition-opacity">→</span>
                  </h3>
                  <p className="text-xs text-muted-foreground mt-0.5">{a.description}</p>
                </button>
              );
            })}
          </div>
        </section>

        {/* ─── Pilulas secundarias ─── */}
        <section className="flex flex-wrap gap-2">
          {SECONDARY_ACTIONS.map((a) => {
            const Icon = a.icon;
            return (
              <Link
                key={a.label}
                href={a.href}
                className="inline-flex items-center gap-2 px-3 py-2 bg-card border border-border rounded-xl text-xs md:text-sm font-semibold text-foreground shadow-sm hover:shadow hover:-translate-y-0.5 transition-all"
              >
                <Icon size={15} className="text-muted-foreground" />
                {a.label}
              </Link>
            );
          })}
        </section>

        {/* ─── Grid 2 colunas: Afazeres + Anotacoes ─── */}
        <div className="grid grid-cols-1 md:grid-cols-[1.15fr_0.85fr] gap-4 mt-4">

          {/* Afazeres do dia */}
          <section className="bg-card border border-border rounded-xl shadow-sm">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
              <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
                <CheckCircle2 size={16} className="text-orange-500" />
                Afazeres do dia
              </h3>
              <div className="flex items-center gap-2 text-xs font-bold text-muted-foreground">
                <span>{doneCount}/{tasks.length}</span>
                <svg width="32" height="32" viewBox="0 0 36 36" className="-rotate-90">
                  <circle cx="18" cy="18" r="15" stroke="hsl(var(--border))" strokeWidth="4" fill="none" />
                  <circle
                    cx="18"
                    cy="18"
                    r="15"
                    stroke="#FF6A1A"
                    strokeWidth="4"
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray={`${2 * Math.PI * 15}`}
                    strokeDashoffset={`${2 * Math.PI * 15 * (1 - ringPct / 100)}`}
                    style={{ transition: 'stroke-dashoffset 0.6s cubic-bezier(0.34, 1.56, 0.4, 1)' }}
                  />
                </svg>
              </div>
            </div>

            {allDone ? (
              <div className="px-5 py-8 text-center">
                <div className="text-4xl mb-2" style={{ animation: 'bob 2s ease-in-out infinite' }}>🎉</div>
                <p className="text-sm font-bold text-foreground">Tudo resolvido por hoje!</p>
                <p className="text-xs text-muted-foreground mt-1">Sua clínica está em dia. Mandou bem!</p>
              </div>
            ) : (
              <div className="p-2">
                {tasks.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => toggleTask(t.id)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-accent/20 transition-colors text-left"
                  >
                    <span
                      className={`w-[22px] h-[22px] rounded-md border-2 flex-none grid place-items-center transition-all ${
                        t.done
                          ? 'bg-emerald-500 border-emerald-500 text-white'
                          : 'border-border bg-background'
                      }`}
                    >
                      {t.done && <Check size={13} strokeWidth={3.5} />}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className={`text-sm font-semibold transition-colors ${t.done ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                        {t.text}
                      </div>
                      <div className="text-xs text-muted-foreground/70 mt-0.5">{t.detail}</div>
                    </div>
                    {t.tag && (
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md ${TAG_STYLES[t.tag]} ${t.done ? 'opacity-40' : ''}`}>
                        {TAG_LABEL[t.tag]}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* Anotacoes — post-it style */}
          <section className="bg-gradient-to-b from-amber-50/80 to-yellow-50/60 dark:from-amber-500/10 dark:to-yellow-500/5 border border-amber-200/50 dark:border-amber-500/20 rounded-xl shadow-sm relative overflow-hidden">
            {/* Fita decorativa no topo */}
            <div className="absolute top-[-12px] left-1/2 -translate-x-1/2 w-24 h-6 bg-orange-500/15 border border-dashed border-orange-500/30 rounded-sm" />

            <div className="flex items-center justify-between px-5 py-5">
              <h3 className="text-lg font-serif font-semibold text-foreground">Anotações</h3>
              <span className={`flex items-center gap-1.5 text-[11px] font-bold transition-colors ${noteSaved ? 'text-emerald-500' : 'text-muted-foreground/60'}`}>
                <Check size={13} strokeWidth={2.5} />
                {noteSaved ? 'Salvo' : 'Salvando...'}
              </span>
            </div>
            <textarea
              value={note}
              onChange={(e) => onNoteChange(e.target.value)}
              placeholder={`Anote algo rápido…\n• Ligar para o protético sobre a coroa da Dona Cida\n• Repor anestésico no estoque`}
              className="w-full px-5 py-2 pb-5 text-sm leading-[30px] text-foreground placeholder:text-muted-foreground/40 bg-transparent border-0 outline-none resize-none min-h-[200px]"
              style={{
                backgroundImage: 'repeating-linear-gradient(transparent, transparent 29px, rgba(240, 230, 204, 0.5) 29px, rgba(240, 230, 204, 0.5) 30px)',
                fontFamily: 'inherit',
              }}
            />
          </section>
        </div>
      </div>
    </div>
  );
}
