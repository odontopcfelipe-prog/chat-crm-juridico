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
  Users, LayoutGrid, Wallet, // Onda 17.17 — atalhos de secao
} from 'lucide-react';
import api from '@/lib/api';
// Onda 17.32.108 — Ceu dinamico atras da saudacao (Modo 1, skill ceu-saudacao)
import { SkyBackdrop } from '@/components/sky/SkyGreeting';
// Onda 17.32.119 — Home dirigida por setor (skill home-por-setor, plug Fase 4b)
import HomeBySector from '@/components/home/HomeBySector';
import { mapBackendRole, type Sector, type Permission } from '@crm/shared';
import { useRole } from '@/lib/useRole';
// Onda 17.32.125 — Lembrete persistente do onboarding pendente
import { OnboardingPendingBanner } from '@/components/OnboardingPendingBanner';
// O JWT NAO inclui o nome do usuario — payload backend tem so
// { email, sub, roles, tenant_id }. Pra pegar o nome real, usa o
// endpoint /users/me. Cacheamos em memoria na primeira carga.
// Onda 17.5.

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
  // Onda 17.32.119 — Setor do user logado pra Home por setor
  const [userSector, setUserSector] = useState<string | null>(null);
  // Onda 17.52 — permissões individuais do user (refletem nos balões da home)
  const [userGrants, setUserGrants] = useState<Permission[]>([]);
  const [userRevokes, setUserRevokes] = useState<Permission[]>([]);
  // Fallback: deriva setor de roles do JWT se /users/me ainda nao retornou
  const role = useRole();
  const resolvedSector: Sector = (userSector as Sector) || mapBackendRole(role?.roles ?? []);
  // Onda 17.6 — modal de seleção de paciente pra avaliação
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 60_000); // atualiza data a cada min

    // Onda 17.5 — busca nome real do usuario via /users/me. JWT nao
    // inclui name no payload, e nao queremos forcar relogin.
    // Onda 17.32.119 — Tambem captura sector pra Home dirigida por setor.
    api.get('/users/me')
      .then((r) => {
        setUserName(r.data?.name || null);
        setUserSector(r.data?.sector || null);
        setUserGrants(r.data?.extra_grants || []);
        setUserRevokes(r.data?.extra_revokes || []);
      })
      .catch(() => {/* falha silenciosa — usa fallback */});

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

  // Onda 17.15 — Background do "ceu" adaptativo a TODOS os temas
  // (light/dark + neon/solid/clay). Em light: cores vivas (sky/cyan
  // pra dia/tarde, indigo pra noite). Em dark/neon: opacidade
  // reduzida e tons mais discretos pra nao "iluminar" demais a tela
  // escura. Variantes com `dark:` adaptam automaticamente.
  const skyBg = useMemo(() => {
    switch (sal.period) {
      case 'morning':
        return 'bg-gradient-to-b from-sky-200 via-sky-100 to-transparent dark:from-sky-500/10 dark:via-sky-500/5 dark:to-transparent';
      case 'afternoon':
        return 'bg-gradient-to-b from-cyan-200 via-sky-100 to-transparent dark:from-cyan-500/10 dark:via-sky-500/5 dark:to-transparent';
      case 'night':
        // Noite: in light mode, indigo medio (nao tao escuro); em
        // dark mode ja eh discreto naturalmente.
        return 'bg-gradient-to-b from-indigo-300 via-purple-200 to-transparent dark:from-indigo-900 dark:via-purple-900 dark:to-transparent';
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

      <div className="relative z-10 max-w-7xl mx-auto p-4 md:p-6 pb-28 md:pb-12 space-y-6">

        {/* Onda 17.3 — botao "Dashboard completo" removido daqui.
            Acesso a esse conteudo agora pelo sidebar (Financeiro >
            Visao Geral). Mantem essa tela 100% focada em atalhos. */}

        {/* Onda 17.32.125 — Lembrete persistente do onboarding (so
          aparece pra tenant em TRIAL com etapas pendentes). Clique
          reabre o OnboardingWizard via window event. */}
        <OnboardingPendingBanner />

        {/* ─── HERO por setor (Onda 17.32.119) ─────────────────────
          Substitui a saudacao+mascote+versiculo pelo HomeBySector
          (skill home-por-setor). Cada setor ve persona + actions +
          afazeres especificos. Reaproveita SkyBackdrop ja em
          producao via skySlot. Rollback: restaurar o bloco antigo
          deste commit.
        */}
        <HomeBySector
          sector={resolvedSector}
          userName={userName ?? undefined}
          extraGrants={userGrants}
          extraRevokes={userRevokes}
          skySlot={<SkyBackdrop />}
          // Onda 17.32.121 — Admin pode trocar pra visualizar como cada setor ve
          allowSwitch={role?.isAdmin || role?.isSuperAdmin}
        />
        {/* Mantem secao legada (saudacao + mascote + versiculo) renderizada
          escondida pra rollback rapido se quiser voltar — basta substituir
          a chamada acima por esta. Inicialmente comentada inline pra ficar
          escondida sem renderizar nada. */}
        <section
          className="hidden"
          style={{ minHeight: 180 }}
        >
          <SkyBackdrop />
          <div className="relative z-[1]">
          <ToothMascot />

          {/* Eyebrow: data + hora atualizada */}
          {/* Onda 17.15 — Texto usa variaveis do tema (foreground/
              muted-foreground) que ja se adaptam light/dark. Antes
              forcava text-white em night, ficava ilegivel em light.
              Onda 17.32.108 — Agora sobre ceu colorido: texto ganha
              text-shadow leve pra legibilidade independente da fase. */}
          <div className="inline-flex items-center gap-2 text-xs font-semibold mb-2.5 text-white/95 drop-shadow">
            <span className="w-2 h-2 rounded-full bg-emerald-400 pulse-dot" />
            <span>{dateline}</span>
          </div>

          {/* Greeting */}
          <h1 className="text-3xl md:text-5xl font-serif font-semibold leading-tight tracking-tight text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.3)]">
            {sal.text},{' '}
            <span className="italic text-amber-200">
              {/* Onda 17.13 — Mostra o nome EXATO do cadastro (primeiro
                  nome), sem prefixo Dr./Dra. Antes acrescentava
                  automaticamente, o que ficava errado pra perfis nao
                  dentistas (Admin, Operador, Recepcao, etc).
                  Onda 17.32.108 — Cor amber-200 pra contraste sobre
                  qualquer fase do ceu (manha/tarde/noite). */}
              {userName ? userName.split(' ')[0] : 'visitante'}
            </span>{' '}
            <span className="wave-hand">👋</span>
          </h1>

          <p className="mt-3 text-sm md:text-base max-w-lg text-white/95 drop-shadow">
            {sal.period === 'morning'
              ? <>Bom começo de dia. Aqui estão seus atalhos pra acelerar a rotina.</>
              : sal.period === 'afternoon'
                ? <>Continue firme. Use os atalhos abaixo pra fechar o dia bem.</>
                : <>Boa noite! Hora de revisar pendências ou descansar — você escolhe.</>
            }
          </p>

          {/* Onda 17.4 — Versiculo do dia, rotaciona por day-of-year.
              Substituiu o badge mock "Bom trabalho — você está em ritmo".
              Onda 17.32.108 — Glassmorphism (backdrop-blur) pra ficar
              legivel sobre o ceu sem perder o efeito de profundidade. */}
          {now && (() => {
            const verse = getVerseOfDay(now);
            return (
              <div className="inline-flex items-start gap-2.5 mt-4 px-3 py-2 rounded-xl text-xs md:text-sm font-medium border max-w-xl bg-white/20 border-white/30 text-white backdrop-blur-md shadow-lg">
                <span className="w-7 h-7 rounded-md bg-gradient-to-br from-amber-300 to-amber-500 grid place-items-center flex-none shadow">
                  <BookOpen size={14} className="text-white" />
                </span>
                <span className="leading-snug">
                  <span className="italic">&ldquo;{verse.text}&rdquo;</span>
                  <span className="block text-[10px] md:text-[11px] font-semibold mt-0.5 not-italic text-white/85">
                    — {verse.ref}
                  </span>
                </span>
              </div>
            );
          })()}
          </div>
        </section>

        {/* ─── Grid 2 colunas: Afazeres + Anotacoes ─── */}
        <div className="grid grid-cols-1 md:grid-cols-[1.15fr_0.85fr] gap-4 mt-4">

          {/* Afazeres do dia */}
          <section className="bg-card border border-border rounded-xl shadow-sm">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
              <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
                <CheckCircle2 size={16} className="text-sky-500" />
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
                    stroke="#0EA5E9"
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

          {/* Anotações — Onda 17.14: paleta alinhada com tema (sky em
              vez de amber/yellow). Mantém a sensação de "caderno" mas
              com tons frios que combinam com a sidebar. */}
          <section className="bg-gradient-to-b from-sky-50/80 to-blue-50/60 dark:from-sky-500/10 dark:to-blue-500/5 border border-sky-200/50 dark:border-sky-500/20 rounded-xl shadow-sm relative overflow-hidden">
            {/* Fita decorativa no topo */}
            <div className="absolute top-[-12px] left-1/2 -translate-x-1/2 w-24 h-6 bg-sky-500/15 border border-dashed border-sky-500/30 rounded-sm" />

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
                backgroundImage: 'repeating-linear-gradient(transparent, transparent 29px, rgba(186, 230, 253, 0.5) 29px, rgba(186, 230, 253, 0.5) 30px)',
                fontFamily: 'inherit',
              }}
            />
          </section>
        </div>
      </div>
    </div>
  );
}
