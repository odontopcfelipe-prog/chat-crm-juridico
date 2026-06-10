'use client';

/**
 * Onda 17.32.124/166/168 — Wizard full-screen de primeiro acesso
 * (skill design-odonto-system). Fundo escuro com glow de acento;
 * cards BRANCOS nas fases de preenchimento (boas-vindas, passos 1-6,
 * tudo pronto) e card dark no carrossel de vantagens. Um acento de
 * cor por passo (LIGHT = variantes claras; ACCENTS = variantes dark
 * do carrossel/glow).
 *
 * Fluxo em 3 fases:
 *   0    Boas-vindas
 *   1-6  Configuracao inicial (clinica, WhatsApp, Asaas, paciente,
 *        equipe, tabela de precos) — stepper de pilulas que viram check
 *   7    Apresentacao das vantagens (AdvantagesCarousel — explosao de
 *        cor, um acento por card; o glow do shell acompanha)
 *   8    Tudo pronto
 *
 * Pode minimizar com "Continuar configurando depois" — vira badge
 * persistente no menu inicial. Cada etapa tem auto-detect do backend:
 * se o user ja fez do lado, marca como done.
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import {
  ArrowRight, ArrowLeft, X, CheckCircle2, Loader2,
  Sparkles, CreditCard, Users, UserPlus, QrCode,
  AlertCircle, Smartphone, RefreshCw, Table, Building2, Check,
} from 'lucide-react';
import Link from 'next/link';
import api from '@/lib/api';
// Onda 17.32.148 — form completo de paciente (em arquivo separado)
import PatientFullCreate from './onboarding/PatientFullCreate';
// Onda 17.32.151 — revisao da tabela de precos
import PricingQuickReview from './onboarding/PricingQuickReview';
// Onda 17.32.152 — revisao da identidade da clinica (passo 1)
import ClinicIdentityReview from './onboarding/ClinicIdentityReview';
// Onda 17.32.165 — fase "conhecimento ao admin" (skill design-odonto-system)
import AdvantagesCarousel, { ACCENTS, type AccentKey } from './onboarding/AdvantagesCarousel';

type StepKey = 'clinic_profile' | 'whatsapp' | 'asaas' | 'first_patient' | 'team' | 'pricing';
type StepStatus = 'done' | 'skipped' | 'pending';

interface OnboardingState {
  steps: Record<StepKey, StepStatus>;
  completed_at: string | null;
  dismissed_at: string | null;
  required_pending: number;
  optional_pending: number;
}

interface StepDef {
  key: StepKey;
  index: number; // posicao no wizard (1-6)
  required: boolean;
  icon: typeof Building2;
  // Onda 17.32.167 — um acento por passo (como o carrossel de
  // vantagens): glow, tile, eyebrow e botoes acompanham a cor
  accent: AccentKey;
  eyebrow: string;
  title: string;
  description: string;
  cta: { label: string; href: string };
}

// Onda 17.32.166 — Copys no tom da skill design-odonto-system:
// beneficio pro dono da clinica, sentence case, uma frase.
const STEPS: StepDef[] = [
  {
    key: 'clinic_profile',
    index: 1,
    required: true,
    icon: Building2,
    accent: 'emerald',
    eyebrow: 'Dados da clínica',
    title: 'Confirme os dados da clínica',
    description: 'Esses dados aparecem em recibos, contratos e mensagens. Revise e ajuste o que precisar.',
    cta: { label: 'Editar identidade', href: '/atendimento/settings/identidade' },
  },
  {
    key: 'whatsapp',
    index: 2,
    required: true,
    icon: QrCode,
    accent: 'cyan',
    eyebrow: 'Conectar WhatsApp',
    title: 'Conecte o WhatsApp da clínica',
    description: 'É por aqui que o sistema atende leads, manda lembretes e confirma consultas.',
    cta: { label: 'Conectar agora', href: '/atendimento/settings/whatsapp' },
  },
  {
    key: 'asaas',
    index: 3,
    required: true,
    icon: CreditCard,
    accent: 'rose',
    eyebrow: 'Cobrança',
    title: 'Configure a cobrança (Asaas)',
    description: 'Conecte sua conta para emitir PIX, boleto e cartão direto do sistema.',
    cta: { label: 'Configurar Asaas', href: '/atendimento/settings/payment-gateway' },
  },
  {
    key: 'first_patient',
    index: 4,
    required: false,
    icon: UserPlus,
    accent: 'blue',
    eyebrow: 'Primeiro paciente',
    title: 'Cadastre seu primeiro paciente',
    description: 'Só pra você ver como é rápido. Depois dá pra cadastrar a base inteira.',
    cta: { label: 'Cadastrar paciente', href: '/atendimento/pacientes' },
  },
  {
    key: 'team',
    index: 5,
    required: false,
    icon: Users,
    accent: 'violet',
    eyebrow: 'Equipe',
    title: 'Adicione um membro da equipe',
    description: 'Cada perfil — Recepção, Dentista, CRC, Financeiro, Admin — vê só o que importa.',
    cta: { label: 'Convidar equipe', href: '/atendimento/settings/users' },
  },
  {
    key: 'pricing',
    index: 6,
    required: false,
    icon: Table,
    accent: 'amber',
    eyebrow: 'Tabela de preços',
    title: 'Configure a tabela de preços',
    description: 'É a base dos orçamentos e propostas. Comece pela sugestão e ajuste à vontade.',
    cta: { label: 'Abrir tabela completa', href: '/atendimento/settings/procedures' },
  },
];

// Onda 17.32.168 — variantes CLARAS dos acentos (cards brancos na
// configuracao; o carrossel de vantagens continua dark). Strings
// literais — nao montar classe dinamica (Tailwind compilado).
const LIGHT: Record<AccentKey, { text: string; btn: string; soft: string; tile: string; pill: string }> = {
  emerald: { text: 'text-emerald-600', btn: 'bg-emerald-600 hover:bg-emerald-500 text-white', soft: 'bg-emerald-50 text-emerald-700 ring-emerald-200 hover:bg-emerald-100', tile: 'bg-emerald-100 ring-emerald-200', pill: 'bg-emerald-100 text-emerald-700 ring-emerald-300' },
  cyan:    { text: 'text-cyan-600',    btn: 'bg-cyan-600 hover:bg-cyan-500 text-white',       soft: 'bg-cyan-50 text-cyan-700 ring-cyan-200 hover:bg-cyan-100',             tile: 'bg-cyan-100 ring-cyan-200',       pill: 'bg-cyan-100 text-cyan-700 ring-cyan-300' },
  blue:    { text: 'text-blue-600',    btn: 'bg-blue-600 hover:bg-blue-500 text-white',       soft: 'bg-blue-50 text-blue-700 ring-blue-200 hover:bg-blue-100',             tile: 'bg-blue-100 ring-blue-200',       pill: 'bg-blue-100 text-blue-700 ring-blue-300' },
  violet:  { text: 'text-violet-600',  btn: 'bg-violet-600 hover:bg-violet-500 text-white',   soft: 'bg-violet-50 text-violet-700 ring-violet-200 hover:bg-violet-100',     tile: 'bg-violet-100 ring-violet-200',   pill: 'bg-violet-100 text-violet-700 ring-violet-300' },
  amber:   { text: 'text-amber-600',   btn: 'bg-amber-500 hover:bg-amber-400 text-white',     soft: 'bg-amber-50 text-amber-700 ring-amber-200 hover:bg-amber-100',         tile: 'bg-amber-100 ring-amber-200',     pill: 'bg-amber-100 text-amber-700 ring-amber-300' },
  rose:    { text: 'text-rose-600',    btn: 'bg-rose-600 hover:bg-rose-500 text-white',       soft: 'bg-rose-50 text-rose-700 ring-rose-200 hover:bg-rose-100',             tile: 'bg-rose-100 ring-rose-200',       pill: 'bg-rose-100 text-rose-700 ring-rose-300' },
};

interface Props {
  open: boolean;
  state: OnboardingState | null;
  onClose: () => void;
  onComplete: () => void;
  onDismiss: () => void;
  onStepUpdate: (step: StepKey, status: 'done' | 'skipped') => Promise<void>;
}

export function OnboardingWizard({
  open, state, onClose, onComplete, onDismiss, onStepUpdate,
}: Props) {
  // 0 = boas-vindas, 1-6 = etapas, 7 = final
  const [screen, setScreen] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // Onda 17.32.162 — Ao reabrir o wizard (banner "Continuar
  // configurando"), volta pra tela de boas-vindas. Antes o screen
  // persistia entre open/close — reabrir mostrava o ultimo passo
  // visitado (ou ate a tela final), confundindo o user.
  useEffect(() => {
    if (open) setScreen(0);
  }, [open]);

  // Onda 17.32.145 — Auto-advance SO quando a etapa atual transicionou
  // de !done -> done ENQUANTO o user estava nela. Antes:
  //   v143: avancava sempre que detectava done -> pulava sem deixar
  //         o user clicar.
  //   v144: tentou rastrear "status anterior" via ref mas o ref
  //         guardava status de step_X quando o user pulava pra
  //         step_Y — comparacao errada disparava o avance.
  //
  // Solucao definitiva: o ref guarda PAR { screen, status }. So
  // compara se ambos sao do MESMO screen. Mudou de screen ->
  // primeira render do novo screen so registra, nao avanca.
  // Onda 17.32.166 — Glow dinamico: emerald na configuracao, troca
  // pro acento do card na fase de vantagens (skill design-odonto-system)
  const [glowClass, setGlowClass] = useState<string>(ACCENTS.emerald.glow);

  const prevRef = useRef<{ screen: number; status: StepStatus } | null>(null);
  useEffect(() => {
    if (!state || !open) return;
    if (screen === 0 || screen >= 7) {
      prevRef.current = null;
      return;
    }
    const stepKey = STEPS[screen - 1]?.key;
    if (!stepKey) return;
    const curr = state.steps[stepKey];

    const prev = prevRef.current;
    prevRef.current = { screen, status: curr };

    // 1. Primeira render desse passo (prev nao existe ou e de outro
    //    screen) -> nao avanca, so registra
    if (!prev || prev.screen !== screen) return;

    // 2. Mesmo screen, mas transicao de !done -> done -> avanca
    if (prev.status !== 'done' && curr === 'done') {
      const t = setTimeout(() => setScreen((s) => Math.min(s + 1, 8)), 800);
      return () => clearTimeout(t);
    }
  }, [state, screen, open]);

  // Onda 17.32.167 — Glow acompanha o acento do passo atual (como o
  // carrossel). Na fase de vantagens (screen 7) quem dirige e o
  // proprio carrossel via onAccentChange.
  useEffect(() => {
    if (screen >= 1 && screen <= 6) {
      setGlowClass(ACCENTS[STEPS[screen - 1].accent].glow);
    } else if (screen !== 7) {
      setGlowClass(ACCENTS.emerald.glow);
    }
  }, [screen]);

  if (!open || !state) return null;

  const handleSkip = async (step: StepKey) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onStepUpdate(step, 'skipped');
      setScreen((s) => Math.min(s + 1, 8));
    } catch {
      // Onda 17.32.160 — PATCH falhou (Loader ja logou e re-sincronizou).
      // NAO avanca a tela — evita "avanco fantasma" que voltava pra
      // pending no proximo refetch.
    } finally {
      setSubmitting(false);
    }
  };

  const handleNext = () => setScreen((s) => Math.min(s + 1, 8));
  const handlePrev = () => setScreen((s) => Math.max(s - 1, 0));

  const handleFinish = async () => {
    setSubmitting(true);
    try {
      await onComplete();
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  // Screens: 0=boas-vindas · 1-6=configuracao · 7=vantagens · 8=tudo pronto
  // Onda 17.32.168 — cards BRANCOS nas fases de preenchimento (0-6, 8);
  // o carrossel de vantagens (7) mantem o card dark.
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center overflow-y-auto bg-gradient-to-b from-zinc-950 via-zinc-950 to-black p-4 font-sans antialiased">
      <style>{`
        @keyframes cardIn { from { opacity:0; transform: translateY(14px) scale(.985);} to { opacity:1; transform: translateY(0) scale(1);} }
        @media (prefers-reduced-motion: reduce){ .anim-card{ animation:none !important; } }
        .anim-card{ animation: cardIn .42s cubic-bezier(.22,1,.36,1) both; }
      `}</style>

      {/* Botao "Continuar configurando depois" no canto */}
      <button
        type="button"
        onClick={() => { onDismiss(); onClose(); }}
        className="absolute right-5 top-5 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
      >
        Continuar configurando depois
        <X size={12} />
      </button>

      <div className="relative my-8 w-full max-w-xl">
        {/* Glow de acento (troca de cor na fase de vantagens) */}
        <div className={'pointer-events-none absolute -inset-10 rounded-[40px] blur-3xl transition-colors duration-700 ' + glowClass} />

        <div className={
          screen === 7
            ? 'relative overflow-hidden rounded-3xl border border-white/10 bg-zinc-900/70 shadow-2xl backdrop-blur-xl'
            : 'relative overflow-hidden rounded-3xl bg-white shadow-2xl'
        }>
          {/* Header da fase de configuracao: eyebrow + stepper de pilulas */}
          {screen >= 1 && screen <= 6 && (() => {
            const L = LIGHT[STEPS[screen - 1].accent];
            return (
              <div className="px-6 pt-6">
                <div className="flex items-center justify-between">
                  <span className={'text-xs font-semibold uppercase tracking-wider transition-colors duration-500 ' + L.text}>Configuração inicial</span>
                  <span className="text-xs tabular-nums text-zinc-400">Passo {screen} de {STEPS.length}</span>
                </div>
                <div className="mt-3 flex items-center gap-1.5">
                  {STEPS.map((s, i) => {
                    const done = state.steps[s.key] === 'done';
                    const isCur = i === screen - 1;
                    return (
                      <div
                        key={s.key}
                        className={
                          'flex h-6 flex-1 items-center justify-center rounded-full text-[10px] font-semibold ring-1 transition ' +
                          (done
                            ? 'bg-emerald-100 text-emerald-700 ring-emerald-300'
                            : isCur
                            ? LIGHT[s.accent].pill
                            : 'bg-zinc-100 text-zinc-400 ring-zinc-200')
                        }
                      >
                        {done ? <Check className="h-3 w-3" /> : i + 1}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {screen === 0 && <WelcomeScreen onStart={handleNext} />}

          {screen >= 1 && screen <= 6 && (() => {
            const step = STEPS[screen - 1];
            const status = state.steps[step.key];
            return (
              <StepScreen
                step={step}
                status={status}
                submitting={submitting}
                onSkip={() => handleSkip(step.key)}
                onPrev={handlePrev}
                onStepUpdate={onStepUpdate}
                onClose={onClose}
              />
            );
          })()}

          {/* Onda 17.32.165 — Fase 2: conhecimento ao admin */}
          {screen === 7 && (
            <AdvantagesCarousel
              onFinish={handleNext}
              onSkip={handleNext}
              onAccentChange={setGlowClass}
            />
          )}

          {screen === 8 && (
            <FinalScreen
              state={state}
              submitting={submitting}
              onFinish={handleFinish}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Tela 0: Boas-vindas ─────────────────────────────────────────
function WelcomeScreen({ onStart }: { onStart: () => void }) {
  return (
    <div className="anim-card flex flex-col items-center px-6 py-12 text-center">
      <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-100 ring-1 ring-emerald-200">
        <Sparkles className="h-6 w-6 text-emerald-600" />
      </div>
      <span className="text-xs font-semibold uppercase tracking-wider text-emerald-600">
        Primeiro acesso
      </span>
      <h1 className="mt-2 text-2xl font-bold leading-tight text-zinc-900">
        Bem-vindo ao Odonto System
      </h1>
      <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-zinc-500">
        Em 6 passos rápidos sua clínica fica pronta pra atender, cobrar e
        fidelizar pacientes. Leva uns 5 minutos.
      </p>
      <button
        type="button"
        onClick={onStart}
        className="mt-8 flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg transition hover:bg-emerald-500 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
      >
        Vamos começar
        <ArrowRight size={16} />
      </button>
    </div>
  );
}

// ─── Telas 1-4: Etapas ────────────────────────────────────────────
function StepScreen({
  step, status, submitting, onSkip, onPrev, onStepUpdate, onClose,
}: {
  step: StepDef;
  status: StepStatus;
  submitting: boolean;
  onSkip?: () => void;
  onPrev?: () => void;
  onStepUpdate: (step: StepKey, status: 'done' | 'skipped') => Promise<void>;
  onClose: () => void;
}) {
  const isDone = status === 'done';
  // Onda 17.32.137 — WhatsApp ganha QR inline (em vez de Link redirect)
  const isWhatsapp = step.key === 'whatsapp';
  // Onda 17.32.141 — Asaas tambem ganha setup inline
  const isAsaas = step.key === 'asaas';
  // Onda 17.32.143 — Paciente e Equipe tambem ganham formularios inline
  const isFirstPatient = step.key === 'first_patient';
  const isTeam = step.key === 'team';
  // Onda 17.32.151 — Tabela de precos com revisao inline
  const isPricing = step.key === 'pricing';
  // Onda 17.32.152 — Identidade da clinica (passo 1)
  const isClinicProfile = step.key === 'clinic_profile';
  const hasInlineForm = isClinicProfile || isWhatsapp || isAsaas || isFirstPatient || isTeam || isPricing;
  const Icon = step.icon;
  const L = LIGHT[step.accent];

  return (
    <div key={step.key} className="anim-card flex flex-col px-6 pb-6 pt-5">
      {/* Cabecalho do passo: tile de icone + eyebrow + titulo */}
      <div className="mb-5 flex items-start gap-4">
        <div className={'flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ring-1 ' + L.tile}>
          <Icon className={'h-5 w-5 ' + L.text} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={'text-xs font-semibold uppercase tracking-wider ' + L.text}>{step.eyebrow}</span>
            {isDone ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-300">
                <CheckCircle2 size={10} />
                Pronto
              </span>
            ) : !step.required ? (
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500 ring-1 ring-zinc-200">
                Opcional
              </span>
            ) : null}
          </div>
          <h2 className="mt-1 text-[19px] font-bold leading-tight text-zinc-900">{step.title}</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-zinc-500">{step.description}</p>
        </div>
      </div>

      {/* Onda 17.32.152 — Identidade da clinica (passo 1, sempre
          visivel mesmo se ja "done" — user pode querer revisar) */}
      {isClinicProfile && (
        <ClinicIdentityReview
          alreadyDone={isDone}
          onSaved={async () => { await onStepUpdate('clinic_profile', 'done'); }}
        />
      )}

      {/* Onda 17.32.137 — WhatsApp Quick Connect inline (QR no proprio
          card do wizard, sem precisar sair pra outra tela) */}
      {isWhatsapp && !isDone && (
        <WhatsappQuickConnect
          onConnected={async () => { await onStepUpdate('whatsapp', 'done'); }}
        />
      )}

      {/* Onda 17.32.141 — Asaas Quick Setup inline.
          (Quando ja done: nao mostra form pra nao confundir — pra trocar
          chave usa /atendimento/settings/payment-gateway) */}
      {isAsaas && !isDone && (
        <AsaasQuickSetup
          onConfigured={async () => { await onStepUpdate('asaas', 'done'); }}
        />
      )}

      {/* Onda 17.32.146/148 — Paciente Full Create (form completo,
          arquivo separado pra nao inflar este componente) */}
      {isFirstPatient && (
        <PatientFullCreate
          alreadyDone={isDone}
          onCreated={async () => { await onStepUpdate('first_patient', 'done'); }}
        />
      )}

      {/* Onda 17.32.146 — Equipe Quick Invite inline (sempre visivel) */}
      {isTeam && (
        <TeamQuickInvite
          alreadyDone={isDone}
          onInvited={async () => { await onStepUpdate('team', 'done'); }}
        />
      )}

      {/* Onda 17.32.163 — Tabela de Precos INLINE no proprio passo
          (sem modal/iframe). Editar/remover/adicionar NAO avancam o
          wizard; so o botao "Concluir revisao" marca como done. */}
      {isPricing && (
        <PricingQuickReview
          alreadyDone={isDone}
          onConcluded={async () => { await onStepUpdate('pricing', 'done'); }}
        />
      )}

      {/* Rodape de navegacao */}
      <div className="mt-6 flex items-center justify-between gap-3 border-t border-zinc-100 pt-4">
        <button
          type="button"
          onClick={onPrev}
          disabled={!onPrev || submitting}
          className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2.5 text-sm font-medium text-zinc-400 transition hover:text-zinc-600 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300"
        >
          <ArrowLeft size={14} />
          Voltar
        </button>

        <div className="flex items-center gap-2">
          {!step.required && !isDone && (
            <button
              type="button"
              onClick={onSkip}
              disabled={submitting}
              className="rounded-xl px-3 py-2.5 text-sm font-medium text-zinc-400 transition hover:text-zinc-600 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300"
            >
              Pular por agora
            </button>
          )}

          {isDone ? (
            <button
              type="button"
              onClick={onSkip /* aproveita a logica de avanco */}
              className={'flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold shadow-lg transition active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 ' + L.btn}
            >
              Continuar
              <ArrowRight size={14} />
            </button>
          ) : hasInlineForm ? (
            // Onda 17.32.139/141/143 — Todos os passos com form inline
            // (Whatsapp, Asaas, Paciente, Equipe) ganham botao "Seguir"
            // pra avancar mesmo sem ter completado. Quando configurar
            // de verdade, o auto-detect marca como done.
            <button
              type="button"
              onClick={onSkip}
              disabled={submitting}
              className={'flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold ring-1 transition disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 ' + L.soft}
            >
              Seguir
              <ArrowRight size={14} />
            </button>
          ) : (
            <Link
              href={step.cta.href}
              // Onda 17.32.142 — Fecha o wizard antes de navegar
              // (senao o overlay z-200 fica em cima da tela destino
              // e parece que nada aconteceu)
              onClick={onClose}
              className={'flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold shadow-lg transition active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 ' + L.btn}
            >
              {step.cta.label}
              <ArrowRight size={14} />
            </Link>
          )}
        </div>
      </div>

      {step.required && !isDone && (
        <p className="mt-3 text-center text-[11px] text-amber-600">
          Recomendado configurar agora — sem isso o sistema perde recursos importantes.
        </p>
      )}
    </div>
  );
}

// ─── Tela final: Tudo pronto ─────────────────────────────────────
function FinalScreen({
  state, submitting, onFinish,
}: {
  state: OnboardingState;
  submitting: boolean;
  onFinish: () => void;
}) {
  const allDone = state.required_pending === 0 && state.optional_pending === 0;

  return (
    <div className="anim-card flex flex-col items-center px-6 py-10 text-center">
      <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-100 ring-1 ring-emerald-200">
        <Check className="h-7 w-7 text-emerald-600" />
      </div>
      <h1 className="text-2xl font-bold leading-tight text-zinc-900">
        {allDone ? 'Tudo pronto!' : 'Bom o suficiente pra começar'}
      </h1>
      <p className="mt-2 max-w-sm text-[15px] leading-relaxed text-zinc-500">
        {allDone
          ? 'Sua clínica está configurada e pronta pra atender, cobrar e fidelizar.'
          : 'Você pode terminar a configuração depois — fica um lembrete no menu inicial.'}
      </p>

      {/* Resumo das etapas */}
      <div className="mt-6 w-full max-w-sm space-y-2 rounded-2xl bg-zinc-50 p-4 ring-1 ring-zinc-200">
        {STEPS.map((s) => {
          const status = state.steps[s.key];
          return (
            <div key={s.key} className="flex items-center justify-between gap-2 text-[13px]">
              <span className="truncate text-zinc-700">{s.title}</span>
              {status === 'done' ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-emerald-600">
                  <CheckCircle2 size={12} /> Pronto
                </span>
              ) : status === 'skipped' ? (
                <span className="shrink-0 text-xs font-medium text-zinc-400">Pulada</span>
              ) : (
                <span className="shrink-0 text-xs font-medium text-amber-600">Pendente</span>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onFinish}
        disabled={submitting}
        className="mt-6 flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg transition hover:bg-emerald-500 active:scale-[0.98] disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
      >
        {submitting ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
        Começar a usar o sistema
      </button>
    </div>
  );
}

// ─── WhatsApp Quick Connect inline (Onda 17.32.137) ───────────────
interface QrPayload {
  base64?: string;
  code?: string;
  pairingCode?: string;
}

interface MyNumber {
  instanceName: string;
  displayName: string;
  status: string;
}

const CONNECTED_STATUSES = ['open', 'connected', 'online', 'authenticated'];

function WhatsappQuickConnect({ onConnected }: { onConnected: () => Promise<void> }) {
  const [generating, setGenerating] = useState(false);
  const [instanceName, setInstanceName] = useState<string | null>(null);
  const [qr, setQr] = useState<QrPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async () => {
    setGenerating(true); setError(null);
    try {
      // Onda 17.32.140 — Verifica primeiro se ja tem instancia.
      // Se tem e esta conectada -> done direto.
      // Se tem e desconectada -> chama /reconnect (gera novo QR
      //                          da mesma instancia).
      // Se nao tem -> cria nova via /connect.
      const existingRes = await api.get<MyNumber[]>('/whatsapp/my-numbers').catch(() => ({ data: [] }));
      const existing = (existingRes.data || [])[0];

      if (existing) {
        const s = (existing.status || '').toLowerCase();
        if (CONNECTED_STATUSES.includes(s)) {
          await onConnected();
          return;
        }
        // Desconectada — reconecta
        const recRes = await api.post<QrPayload>(
          `/whatsapp/my-numbers/${encodeURIComponent(existing.instanceName)}/reconnect`,
        );
        setInstanceName(existing.instanceName);
        setQr(recRes.data);
        return;
      }

      // Nao tem instancia — cria nova
      const res = await api.post<{ instanceName: string; qr: QrPayload | null }>(
        '/whatsapp/my-numbers/connect',
        { displayName: 'WhatsApp da clinica' },
      );
      setInstanceName(res.data.instanceName);
      setQr(res.data.qr);
    } catch (e: any) {
      const raw = e?.response?.data?.message || '';
      if (typeof raw === 'string' && raw.startsWith('Cannot')) {
        setError('O servidor ainda nao reconhece essa funcionalidade. Deploy em andamento?');
      } else {
        setError('Nao foi possivel gerar o QR. Tente de novo em alguns segundos.');
      }
    } finally {
      setGenerating(false);
    }
  }, [onConnected]);

  // Polling 2s: detecta quando o user escaneou e ficou conectado
  useEffect(() => {
    if (!instanceName) return;
    const t = setInterval(async () => {
      try {
        const res = await api.get<MyNumber[]>('/whatsapp/my-numbers');
        const me = (res.data || []).find((n) => n.instanceName === instanceName);
        if (!me) return;
        const s = (me.status || '').toLowerCase();
        if (CONNECTED_STATUSES.includes(s)) {
          clearInterval(t);
          await onConnected();
        }
      } catch { /* tenta de novo no proximo tick */ }
    }, 2000);
    return () => clearInterval(t);
  }, [instanceName, onConnected]);

  // Estado: ainda nao gerou QR
  if (!qr && !generating) {
    return (
      <div className="flex flex-col items-center rounded-2xl bg-zinc-50 p-6 text-center ring-1 ring-zinc-200">
        <button
          type="button"
          onClick={generate}
          className="flex items-center gap-2 rounded-xl bg-cyan-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg transition hover:bg-cyan-500 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          <QrCode size={16} />
          Gerar QR Code
        </button>
        {error && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-rose-600">
            <AlertCircle size={12} /> {error}
          </p>
        )}
      </div>
    );
  }

  // Estado: gerando QR
  if (generating) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-2xl bg-zinc-50 p-8 ring-1 ring-zinc-200">
        <Loader2 className="animate-spin text-cyan-600" size={28} />
        <p className="text-xs text-zinc-500">Conectando ao servidor…</p>
      </div>
    );
  }

  // Estado: QR pronto pra escanear
  const base64 = qr?.base64;
  return (
    <div className="flex flex-col items-center rounded-2xl bg-zinc-50 p-5 text-center ring-1 ring-zinc-200">
      <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-cyan-700">
        <Smartphone size={14} />
        <span>WhatsApp → Aparelhos conectados → Conectar aparelho</span>
      </div>
      <div className="rounded-xl bg-white p-2.5 shadow-lg ring-1 ring-zinc-200">
        {base64 ? (
          <img
            src={base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`}
            alt="QR Code WhatsApp"
            className="w-44 h-44 rounded-lg"
          />
        ) : qr?.code ? (
          <code className="text-[10px] break-all block max-w-[180px] p-2 text-zinc-700">{qr.code}</code>
        ) : qr?.pairingCode ? (
          <div className="text-center px-4">
            <p className="text-[10px] text-zinc-600 mb-1">Codigo de pareamento:</p>
            <div className="text-xl font-mono font-bold tracking-widest text-zinc-900">{qr.pairingCode}</div>
          </div>
        ) : (
          <p className="text-xs text-zinc-500 p-4">QR nao disponivel. Tente regenerar.</p>
        )}
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-[11px] text-zinc-500 animate-pulse">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-cyan-500" />
        Aguardando voce escanear…
      </p>
      <button
        type="button"
        onClick={generate}
        className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-cyan-600 transition hover:text-cyan-500"
      >
        <RefreshCw size={10} /> Gerar novo QR
      </button>
    </div>
  );
}

// ─── Asaas Quick Setup inline (Onda 17.32.141) ────────────────────
function AsaasQuickSetup({ onConfigured }: { onConfigured: () => Promise<void> }) {
  const [apiKey, setApiKey] = useState('');
  const [sandbox, setSandbox] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null); setSubmitting(true);
    try {
      await api.post('/payment-gateway/setup', { apiKey: apiKey.trim(), sandbox });
      await onConfigured();
    } catch (e: any) {
      const raw = e?.response?.data?.message || '';
      if (typeof raw === 'string' && raw.startsWith('Cannot')) {
        setError('Servidor ainda nao reconhece — deploy em andamento?');
      } else if (raw) {
        setError(raw);
      } else {
        setError('Nao foi possivel validar a chave. Tente de novo.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = apiKey.trim().length >= 20 && !submitting;

  return (
    <div className="rounded-2xl bg-zinc-50 p-5 ring-1 ring-zinc-200">
      <label className="mb-1 block text-[12px] font-medium text-zinc-600">
        Cole sua chave de API do Asaas
      </label>
      <input
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder="$aact_… (cole sua chave completa)"
        className="w-full rounded-lg bg-white px-3 py-2.5 text-sm font-mono text-zinc-900 ring-1 ring-zinc-200 placeholder:text-zinc-400 transition focus:outline-none focus:ring-2 focus:ring-rose-400/60"
        autoFocus
        autoComplete="off"
        spellCheck={false}
      />
      <p className="mt-2 text-[11px] text-zinc-500">
        Painel Asaas → <b className="text-zinc-700">Integrações</b> → <b className="text-zinc-700">API</b> → copie a chave de produção.
        <a
          href="https://www.asaas.com/api"
          target="_blank"
          rel="noopener noreferrer"
          className="ml-1 text-rose-600 hover:underline"
        >
          Não tenho conta ↗
        </a>
      </p>

      <label className="mt-3 flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={sandbox}
          onChange={(e) => setSandbox(e.target.checked)}
          className="accent-rose-600"
        />
        <span className="text-xs text-zinc-500">
          Estou usando conta <b className="text-zinc-700">sandbox</b> (teste — não cobra de verdade)
        </span>
      </label>

      <button
        type="button"
        disabled={!canSubmit}
        onClick={submit}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg transition hover:bg-rose-500 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
      >
        {submitting ? <Loader2 className="animate-spin" size={16} /> : <CheckCircle2 size={16} />}
        {submitting ? 'Validando…' : 'Conectar conta Asaas'}
      </button>

      {error && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-rose-600">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

// ─── Equipe Quick Invite inline (Onda 17.32.143) ──────────────────
const TEAM_ROLES = [
  { value: 'DENTIST',    label: '🦷 Dentista' },
  { value: 'OPERADOR',   label: '🛎️ Recepção' },
  { value: 'ASSISTANT',  label: '🧤 ACD / ASB' },
  { value: 'COMERCIAL',  label: '💬 CRC (Atendimento)' },
  { value: 'FINANCEIRO', label: '💰 Financeiro' },
  { value: 'ADMIN',      label: '👑 Administrador' },
];

function TeamQuickInvite({
  onInvited, alreadyDone = false,
}: {
  onInvited: () => Promise<void>;
  alreadyDone?: boolean;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('DENTIST');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Onda 17.32.147 — feedback de sucesso
  const [successInfo, setSuccessInfo] = useState<{ name: string; email: string } | null>(null);

  const submit = async () => {
    setError(null); setSubmitting(true);
    try {
      await api.post('/users', {
        name: name.trim(),
        email: email.trim(),
        password: password.trim(),
        roles: [role],
      });
      setSuccessInfo({ name: name.trim(), email: email.trim() });
      setName(''); setEmail(''); setPassword('');
      await onInvited();
      setTimeout(() => setSuccessInfo(null), 4000);
    } catch (e: any) {
      const raw = e?.response?.data?.message || '';
      if (typeof raw === 'string' && raw.startsWith('Cannot')) {
        setError('Servidor ainda nao reconhece — deploy em andamento?');
      } else if (Array.isArray(raw)) {
        setError(raw.join(', '));
      } else {
        setError(raw || 'Nao foi possivel criar o usuario.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit =
    name.trim().length >= 2 &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) &&
    password.trim().length >= 6 &&
    !submitting;

  const fieldCls = 'w-full rounded-lg bg-white px-3 py-2.5 text-sm text-zinc-900 ring-1 ring-zinc-200 placeholder:text-zinc-400 transition focus:outline-none focus:ring-2 focus:ring-violet-400/60';

  return (
    <div className="rounded-2xl bg-zinc-50 p-5 ring-1 ring-zinc-200">
      {/* Onda 17.32.147 — Banner de sucesso */}
      {successInfo && (
        <div className="mb-4 flex items-center gap-3 rounded-xl bg-emerald-50 p-3 ring-1 ring-emerald-200">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
            <CheckCircle2 size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-emerald-700">
              Convite enviado!
            </p>
            <p className="truncate text-xs text-emerald-700/80">
              "{successInfo.name}" pode entrar com o e-mail {successInfo.email} e a senha que você definiu.
            </p>
          </div>
        </div>
      )}
      {alreadyDone && !successInfo && (
        <p className="mb-3 flex items-center gap-1.5 text-xs text-emerald-600">
          <CheckCircle2 size={12} />
          Voce ja tem outros usuarios. Quer convidar mais um?
        </p>
      )}
      <p className="mb-3 text-[11px] text-zinc-500">
        Adicione 1 pessoa agora. Você cadastra os demais a qualquer momento em
        <b className="text-zinc-700"> Configurações → Usuários</b>.
      </p>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-[12px] font-medium text-zinc-600">Nome</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex: Dr. João"
            className={fieldCls}
            autoFocus
          />
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-medium text-zinc-600">Cargo</label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className={fieldCls + ' cursor-pointer'}
          >
            {TEAM_ROLES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-[12px] font-medium text-zinc-600">E-mail</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="joao@suaclinica.com.br"
            className={fieldCls}
            autoComplete="off"
          />
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-medium text-zinc-600">Senha temporária</label>
          <input
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Mínimo 6 caracteres"
            className={fieldCls + ' font-mono'}
            autoComplete="off"
          />
        </div>
      </div>

      <button
        type="button"
        disabled={!canSubmit}
        onClick={submit}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg transition hover:bg-violet-500 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
      >
        {submitting ? <Loader2 className="animate-spin" size={16} /> : <Users size={16} />}
        {submitting ? 'Convidando…' : 'Convidar membro'}
      </button>

      {error && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-rose-600">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
