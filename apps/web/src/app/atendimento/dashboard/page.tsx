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
 *  - Botao "Dashboard completo" no canto pra acessar a antiga (charts/KPIs)
 *
 * Inspirado em Clinicorp / inicio.html (template Sorrir).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  UserPlus, FileText, Calendar, Target,
  Calendar as CalendarIcon, CreditCard, MessageCircle,
  BookOpen, Sparkles,
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

  // Saudacao
  const hour = now?.getHours() ?? 8;
  const sal = getSalutation(hour);
  const dateline = now
    ? `${cap(DIAS[now.getDay()])}, ${now.getDate()} de ${MESES[now.getMonth()]} · ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    : '—';


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

      </div>
    </div>
  );
}
