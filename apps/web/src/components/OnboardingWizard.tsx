'use client';

/**
 * Onda 17.32.124 — Wizard full-screen de onboarding (estilo Windows OOBE).
 *
 * Aparece automaticamente na 1a vez do user no sistema (trial ativo +
 * onboarding nao completo). Cobre tela inteira com 6 telas:
 *   0. Boas-vindas
 *   1. Conectar WhatsApp   (obrigatorio — sem botao Pular)
 *   2. Configurar Asaas    (obrigatorio — sem botao Pular)
 *   3. Cadastrar paciente  (opcional — pode pular)
 *   4. Convidar equipe     (opcional — pode pular)
 *   5. Tudo pronto!
 *
 * Pode minimizar com "Continuar configurando depois" — vira badge
 * persistente no menu inicial. Cada etapa tem auto-detect do backend:
 * se o user ja fez do lado, marca como done.
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Sparkles, ArrowRight, ArrowLeft, X, CheckCircle2, Loader2,
  MessageSquare, CreditCard, Users, UserPlus, Rocket, QrCode,
  AlertCircle, Smartphone, RefreshCw, Tag, Building2,
} from 'lucide-react';
import Link from 'next/link';
import api from '@/lib/api';
// Onda 17.32.148 — form completo de paciente (em arquivo separado)
import PatientFullCreate from './onboarding/PatientFullCreate';
// Onda 17.32.151 — revisao da tabela de precos
import PricingQuickReview from './onboarding/PricingQuickReview';
// Onda 17.32.152 — revisao da identidade da clinica (passo 1)
import ClinicIdentityReview from './onboarding/ClinicIdentityReview';

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
  index: number; // posicao no wizard (1-4)
  required: boolean;
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  description: string;
  cta: { label: string; href: string };
}

const STEPS: StepDef[] = [
  // Onda 17.32.152 — Identidade da clinica (primeiro passo).
  {
    key: 'clinic_profile',
    index: 1,
    required: true,
    icon: <Building2 size={36} />,
    iconBg: 'from-emerald-500 to-emerald-700',
    title: 'Confirme os dados da clínica ou consultório',
    description: 'Os dados que aparecem em recibos, contratos e notas fiscais. Você já preencheu no cadastro inicial — vamos só confirmar e completar o que faltar.',
    cta: { label: 'Editar identidade', href: '/atendimento/settings/identidade' },
  },
  {
    key: 'whatsapp',
    index: 2,
    required: true,
    icon: <MessageSquare size={36} />,
    iconBg: 'from-emerald-500 to-emerald-700',
    title: 'Conecte o número principal da clínica ou consultório',
    description: 'Em 2 minutos seu sistema atende pacientes pelo WhatsApp. Sem isso, eles não recebem confirmação de consulta, lembrete de retorno, nem link de anamnese.',
    cta: { label: 'Conectar agora', href: '/atendimento/settings/whatsapp' },
  },
  {
    key: 'asaas',
    index: 3,
    required: true,
    icon: <CreditCard size={36} />,
    iconBg: 'from-violet-500 to-violet-700',
    title: 'Configure cobrança Asaas',
    description: 'PIX, boleto e cartão automatizados. Cole sua chave do Asaas (grátis pra abrir conta) e o sistema gera as cobranças sozinho — paciente paga e o status muda na hora.',
    cta: { label: 'Configurar Asaas', href: '/atendimento/settings/payment-gateway' },
  },
  {
    key: 'first_patient',
    index: 4,
    required: false,
    icon: <UserPlus size={36} />,
    iconBg: 'from-sky-500 to-sky-700',
    title: 'Cadastre seu 1° paciente',
    description: 'Comece a explorar o prontuário, agenda e propostas com um paciente real. Pode pular se preferir cadastrar depois.',
    cta: { label: 'Cadastrar paciente', href: '/atendimento/pacientes' },
  },
  {
    key: 'team',
    index: 5,
    required: false,
    icon: <Users size={36} />,
    iconBg: 'from-amber-500 to-amber-700',
    title: 'Convide sua equipe',
    description: 'Cadastre dentistas, recepção, ACD/ASB e financeiro. Cada um vê só o que tem permissão — você controla.',
    cta: { label: 'Convidar equipe', href: '/atendimento/settings/users' },
  },
  // Onda 17.32.151 — Tabela de precos (opcional, mas valioso)
  {
    key: 'pricing',
    index: 6,
    required: false,
    icon: <Tag size={36} />,
    iconBg: 'from-violet-500 to-violet-700',
    title: 'Revise a tabela de preços',
    description: 'Mostramos a tabela padrão pra sua clínica. Edite preços, remova procedimentos que não usa, adicione novos. Tudo em segundos.',
    cta: { label: 'Abrir tabela completa', href: '/atendimento/settings/procedures' },
  },
];

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
  // 0 = boas-vindas, 1-4 = etapas, 5 = final
  const [screen, setScreen] = useState(0);
  const [submitting, setSubmitting] = useState(false);

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
  const prevRef = useRef<{ screen: number; status: StepStatus } | null>(null);
  useEffect(() => {
    if (!state || !open) return;
    if (screen === 0 || screen === 7) {
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
      const t = setTimeout(() => setScreen((s) => Math.min(s + 1, 7)), 800);
      return () => clearTimeout(t);
    }
  }, [state, screen, open]);

  if (!open || !state) return null;

  const handleSkip = async (step: StepKey) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onStepUpdate(step, 'skipped');
      setScreen((s) => Math.min(s + 1, 7));
    } finally {
      setSubmitting(false);
    }
  };

  const handleNext = () => setScreen((s) => Math.min(s + 1, 7));
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

  return (
    <div className="fixed inset-0 z-[200] bg-gradient-to-br from-violet-900 via-violet-950 to-indigo-950 flex items-center justify-center p-4">
      {/* Background ornamento */}
      <div className="absolute inset-0 opacity-30 pointer-events-none">
        <div className="absolute top-1/4 -left-32 w-96 h-96 bg-emerald-500/30 rounded-full blur-[120px]" />
        <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-violet-500/30 rounded-full blur-[120px]" />
      </div>

      {/* Botao "Continuar configurando depois" no canto */}
      <button
        type="button"
        onClick={() => { onDismiss(); onClose(); }}
        className="absolute top-5 right-5 inline-flex items-center gap-1.5 text-xs font-bold text-white/60 hover:text-white transition-colors px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 border border-white/10"
      >
        Continuar configurando depois
        <X size={12} />
      </button>

      <div className="relative w-full max-w-3xl bg-white/95 dark:bg-card backdrop-blur-md rounded-3xl shadow-2xl overflow-hidden">
        {/* Progress dots */}
        <div className="px-8 pt-6 pb-2 flex items-center justify-center gap-2">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((s) => (
            <div
              key={s}
              className={`h-1.5 rounded-full transition-all ${
                s === screen   ? 'w-10 bg-violet-600' :
                s <  screen    ? 'w-6  bg-violet-300' :
                                 'w-6  bg-gray-200'
              }`}
            />
          ))}
        </div>

        {/* Conteúdo das telas */}
        <div className="px-8 pb-8 pt-2 min-h-[440px] flex flex-col">
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
                // Onda 17.32.138 — Voltar sempre habilitado.
                // No passo 1 volta pra tela 0 (boas-vindas) — antes
                // ficava desabilitado e nao tinha como sair sem
                // dismiss.
                onPrev={handlePrev}
                onStepUpdate={onStepUpdate}
                // Onda 17.32.142 — Ao clicar em links de redirect
                // (passos 3 e 4 que ainda nao tem fluxo inline),
                // fechar o wizard ANTES de navegar — senao ele
                // continua coberto e parece que nada acontece.
                onClose={onClose}
              />
            );
          })()}

          {screen === 7 && (
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
    <div className="flex-1 flex flex-col items-center justify-center text-center py-6">
      <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-violet-500 to-emerald-500 grid place-items-center text-white shadow-lg mb-6">
        <Sparkles size={36} />
      </div>
      <span className="text-[10px] font-bold uppercase tracking-widest text-violet-700 bg-violet-100 px-3 py-1 rounded-full mb-4">
        Vamos preparar seu sistema em 4 passos
      </span>
      <h1 className="text-3xl md:text-4xl font-extrabold text-foreground tracking-tight max-w-xl mb-3">
        Bem-vindo ao Odonto System!
      </h1>
      <p className="text-base text-muted-foreground max-w-lg mb-8">
        Antes de você começar, vamos configurar o essencial pra sua clínica funcionar
        de verdade. Leva 5 minutos.
      </p>
      <button
        type="button"
        onClick={onStart}
        className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-violet-600 hover:bg-violet-700 text-white font-bold text-base shadow-[0_10px_28px_-8px_rgba(124,58,237,0.6)] hover:shadow-[0_14px_32px_-8px_rgba(124,58,237,0.7)] transition-all hover:-translate-y-0.5"
      >
        Vamos começar
        <ArrowRight size={18} />
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

  return (
    <div className="flex-1 flex flex-col py-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6 text-xs text-muted-foreground font-semibold">
        <span>Passo {step.index} de 6</span>
        {step.required ? (
          <span className="text-amber-600 dark:text-amber-400">• Recomendado</span>
        ) : (
          <span className="text-emerald-600 dark:text-emerald-400">• Opcional</span>
        )}
      </div>

      {/* Ilustração */}
      <div className="flex items-start gap-4 mb-6">
        <div className={`w-20 h-20 rounded-2xl bg-gradient-to-br ${step.iconBg} grid place-items-center text-white shrink-0 shadow-lg`}>
          {step.icon}
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-2xl font-extrabold text-foreground mb-2 tracking-tight flex items-center gap-2 flex-wrap">
            {step.title}
            {isDone && (
              <span className="inline-flex items-center gap-1 text-xs bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 px-2.5 py-1 rounded-full font-bold">
                <CheckCircle2 size={12} />
                Pronto
              </span>
            )}
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">{step.description}</p>
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

      {/* Onda 17.32.151/155 — Tabela de Precos: card resumo com botao
          que abre a tela completa. NAO marca como done direto — o
          auto-detect do backend (>=1 procedimento editado) faz isso
          quando o user voltar da tela completa. */}
      {isPricing && (
        <PricingQuickReview
          alreadyDone={isDone}
          onClose={onClose}
        />
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Footer com ações */}
      <div className="flex items-center justify-between gap-3 pt-4 border-t border-border">
        <button
          type="button"
          onClick={onPrev}
          disabled={!onPrev || submitting}
          className="inline-flex items-center gap-1.5 text-sm font-bold text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
              className="text-sm font-bold text-muted-foreground hover:text-foreground px-4 py-2.5 rounded-xl hover:bg-accent/40 transition-colors disabled:opacity-50"
            >
              Pular essa etapa
            </button>
          )}

          {isDone ? (
            <button
              type="button"
              onClick={onSkip /* aproveita a logica de avanco */}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm transition-colors"
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
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-700 text-white font-bold text-sm shadow-[0_6px_18px_-4px_rgba(124,58,237,0.5)] transition-all disabled:opacity-50"
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
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-700 text-white font-bold text-sm shadow-[0_6px_18px_-4px_rgba(124,58,237,0.5)] transition-all"
            >
              {step.cta.label}
              <ArrowRight size={14} />
            </Link>
          )}
        </div>
      </div>

      {step.required && !isDone && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400 text-center mt-3">
          ⚠ Recomendado configurar agora — sem isso seu sistema perde funcionalidade chave.
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
    <div className="flex-1 flex flex-col items-center justify-center text-center py-6">
      <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-700 grid place-items-center text-white shadow-lg mb-6">
        <Rocket size={36} />
      </div>
      <h1 className="text-3xl md:text-4xl font-extrabold text-foreground tracking-tight mb-3">
        {allDone ? 'Tudo pronto!' : 'Bom o suficiente pra começar!'}
      </h1>
      <p className="text-base text-muted-foreground max-w-lg mb-6">
        {allDone
          ? 'Seu Odonto System está configurado e pronto pra atender seus pacientes. Vamos lá!'
          : 'Você pode terminar a configuração depois — vou deixar um lembrete no menu inicial.'}
      </p>

      {/* Resumo das etapas */}
      <div className="bg-muted/30 rounded-xl p-4 max-w-md w-full mb-6 space-y-2">
        {STEPS.map((s) => {
          const status = state.steps[s.key];
          return (
            <div key={s.key} className="flex items-center justify-between text-sm">
              <span className="text-foreground font-medium">{s.title}</span>
              {status === 'done' ? (
                <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-bold text-xs">
                  <CheckCircle2 size={12} /> Pronto
                </span>
              ) : status === 'skipped' ? (
                <span className="text-xs text-muted-foreground font-bold">Pulada</span>
              ) : (
                <span className="text-xs text-amber-600 dark:text-amber-400 font-bold">Pendente</span>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onFinish}
        disabled={submitting}
        className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-violet-600 hover:bg-violet-700 text-white font-bold text-base shadow-[0_10px_28px_-8px_rgba(124,58,237,0.6)] transition-all hover:-translate-y-0.5 disabled:opacity-60"
      >
        {submitting ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}
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
      <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-2xl p-6 flex flex-col items-center text-center">
        <button
          type="button"
          onClick={generate}
          className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-violet-600 hover:bg-violet-700 text-white font-bold text-sm shadow-[0_6px_18px_-4px_rgba(124,58,237,0.5)] transition-all"
        >
          <QrCode size={16} />
          Gerar QR Code
        </button>
        {error && (
          <p className="mt-3 text-xs text-rose-600 dark:text-rose-400 flex items-center gap-1.5">
            <AlertCircle size={12} /> {error}
          </p>
        )}
      </div>
    );
  }

  // Estado: gerando QR
  if (generating) {
    return (
      <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-2xl p-8 flex flex-col items-center justify-center gap-3">
        <Loader2 className="animate-spin text-violet-500" size={28} />
        <p className="text-xs text-muted-foreground">Conectando ao servidor…</p>
      </div>
    );
  }

  // Estado: QR pronto pra escanear
  const base64 = qr?.base64;
  return (
    <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-2xl p-5 flex flex-col items-center text-center">
      <div className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-400 font-semibold mb-3">
        <Smartphone size={14} />
        <span>WhatsApp → Aparelhos conectados → Conectar aparelho</span>
      </div>
      <div className="bg-white rounded-xl p-3 ring-4 ring-emerald-500/20">
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
      <p className="mt-3 text-[11px] text-muted-foreground flex items-center gap-1.5 animate-pulse">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
        Aguardando voce escanear…
      </p>
      <button
        type="button"
        onClick={generate}
        className="mt-2 text-[11px] font-bold text-violet-600 hover:text-violet-700 inline-flex items-center gap-1"
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
    <div className="bg-violet-500/5 border border-violet-500/20 rounded-2xl p-5">
      <label className="block mb-2 text-xs font-bold text-foreground">
        Cole sua chave de API do Asaas
      </label>
      <input
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder="$aact_… (cole sua chave completa)"
        className="w-full bg-white dark:bg-card border border-border rounded-xl px-4 py-2.5 text-sm font-mono outline-none focus:border-violet-500 transition-all"
        autoFocus
        autoComplete="off"
        spellCheck={false}
      />
      <p className="mt-2 text-[11px] text-muted-foreground">
        Painel Asaas → <b>Integrações</b> → <b>API</b> → copie a chave de produção.
        <a
          href="https://www.asaas.com/api"
          target="_blank"
          rel="noopener noreferrer"
          className="ml-1 text-violet-600 hover:underline"
        >
          Não tenho conta ↗
        </a>
      </p>

      <label className="mt-3 flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={sandbox}
          onChange={(e) => setSandbox(e.target.checked)}
          className="accent-violet-600"
        />
        <span className="text-xs text-muted-foreground">
          Estou usando conta <b>sandbox</b> (teste — não cobra de verdade)
        </span>
      </label>

      <button
        type="button"
        disabled={!canSubmit}
        onClick={submit}
        className="mt-4 w-full inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-violet-600 hover:bg-violet-700 text-white font-bold text-sm shadow-[0_6px_18px_-4px_rgba(124,58,237,0.5)] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? <Loader2 className="animate-spin" size={16} /> : <CheckCircle2 size={16} />}
        {submitting ? 'Validando…' : 'Conectar Asaas'}
      </button>

      {error && (
        <p className="mt-3 text-xs text-rose-600 dark:text-rose-400 flex items-start gap-1.5">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

// ─── Paciente Quick Create inline (Onda 17.32.143/146/147) ────────
function PatientQuickCreate({
  onCreated, alreadyDone = false,
}: {
  onCreated: () => Promise<void>;
  alreadyDone?: boolean;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Onda 17.32.147 — feedback visual claro de sucesso
  const [successName, setSuccessName] = useState<string | null>(null);

  const submit = async () => {
    setError(null); setSubmitting(true);
    try {
      const payload: any = { name: name.trim() };
      if (phone.trim()) payload.phone = phone.trim();
      if (birthDate) payload.birth_date = birthDate;
      await api.post('/patients', payload);
      setSuccessName(name.trim());
      // Limpa o form pra cadastrar outro se quiser
      setName(''); setPhone(''); setBirthDate('');
      // Marca step como done (avanca depois de mostrar confirmacao)
      await onCreated();
      // Tira a confirmacao apos 4s (caso user nao tenha avancado)
      setTimeout(() => setSuccessName(null), 4000);
    } catch (e: any) {
      const raw = e?.response?.data?.message || '';
      if (typeof raw === 'string' && raw.startsWith('Cannot')) {
        setError('Servidor ainda nao reconhece — deploy em andamento?');
      } else if (Array.isArray(raw)) {
        setError(raw.join(', '));
      } else {
        setError(raw || 'Nao foi possivel criar o paciente.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = name.trim().length >= 2 && !submitting;

  return (
    <div className="bg-sky-500/5 border border-sky-500/20 rounded-2xl p-5">
      {/* Onda 17.32.147 — Banner de sucesso visivel apos cadastrar */}
      {successName && (
        <div className="mb-4 bg-emerald-500/15 border border-emerald-500/40 rounded-xl p-3 flex items-center gap-3 animate-in slide-in-from-top-2 duration-300">
          <div className="w-8 h-8 rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0">
            <CheckCircle2 size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-emerald-700 dark:text-emerald-400">
              ✓ Paciente cadastrado com sucesso!
            </p>
            <p className="text-xs text-emerald-700/80 dark:text-emerald-400/80 truncate">
              "{successName}" foi salvo. Cadastre outro ou clique em "Continuar".
            </p>
          </div>
        </div>
      )}
      {alreadyDone && !successName && (
        <p className="mb-3 text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
          <CheckCircle2 size={12} />
          Voce ja tem pacientes. Quer cadastrar mais um agora?
        </p>
      )}
      <label className="block mb-2 text-xs font-bold text-foreground">
        Nome completo do paciente
      </label>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Ex: Maria da Silva"
        className="w-full bg-white dark:bg-card border border-border rounded-xl px-4 py-2.5 text-sm outline-none focus:border-sky-500 transition-all"
        autoFocus
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
        <div>
          <label className="block mb-1 text-xs font-bold text-foreground">
            Telefone <span className="text-muted-foreground font-normal">(opcional)</span>
          </label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(11) 99999-9999"
            className="w-full bg-white dark:bg-card border border-border rounded-xl px-4 py-2.5 text-sm outline-none focus:border-sky-500 transition-all"
          />
        </div>
        <div>
          <label className="block mb-1 text-xs font-bold text-foreground">
            Data de nascimento <span className="text-muted-foreground font-normal">(opcional)</span>
          </label>
          <input
            type="date"
            value={birthDate}
            onChange={(e) => setBirthDate(e.target.value)}
            className="w-full bg-white dark:bg-card border border-border rounded-xl px-4 py-2.5 text-sm outline-none focus:border-sky-500 transition-all"
          />
        </div>
      </div>

      <button
        type="button"
        disabled={!canSubmit}
        onClick={submit}
        className="mt-4 w-full inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-sky-600 hover:bg-sky-700 text-white font-bold text-sm shadow-[0_6px_18px_-4px_rgba(14,165,233,0.5)] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? <Loader2 className="animate-spin" size={16} /> : <UserPlus size={16} />}
        {submitting ? 'Salvando…' : 'Cadastrar paciente'}
      </button>

      {error && (
        <p className="mt-3 text-xs text-rose-600 dark:text-rose-400 flex items-start gap-1.5">
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

  return (
    <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-5">
      {/* Onda 17.32.147 — Banner de sucesso */}
      {successInfo && (
        <div className="mb-4 bg-emerald-500/15 border border-emerald-500/40 rounded-xl p-3 flex items-center gap-3 animate-in slide-in-from-top-2 duration-300">
          <div className="w-8 h-8 rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0">
            <CheckCircle2 size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-emerald-700 dark:text-emerald-400">
              ✓ Convite enviado!
            </p>
            <p className="text-xs text-emerald-700/80 dark:text-emerald-400/80 truncate">
              "{successInfo.name}" pode entrar com o e-mail {successInfo.email} e a senha que você definiu.
            </p>
          </div>
        </div>
      )}
      {alreadyDone && !successInfo && (
        <p className="mb-3 text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
          <CheckCircle2 size={12} />
          Voce ja tem outros usuarios. Quer convidar mais um?
        </p>
      )}
      <p className="text-[11px] text-muted-foreground mb-3">
        Adicione 1 pessoa agora. Você cadastra os demais a qualquer momento em
        <b> Configurações → Usuários</b>.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block mb-1 text-xs font-bold text-foreground">Nome</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex: Dr. João"
            className="w-full bg-white dark:bg-card border border-border rounded-xl px-4 py-2.5 text-sm outline-none focus:border-amber-500 transition-all"
            autoFocus
          />
        </div>
        <div>
          <label className="block mb-1 text-xs font-bold text-foreground">Cargo</label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="w-full bg-white dark:bg-card border border-border rounded-xl px-4 py-2.5 text-sm outline-none focus:border-amber-500 transition-all cursor-pointer"
          >
            {TEAM_ROLES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
        <div>
          <label className="block mb-1 text-xs font-bold text-foreground">E-mail</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="joao@suaclinica.com.br"
            className="w-full bg-white dark:bg-card border border-border rounded-xl px-4 py-2.5 text-sm outline-none focus:border-amber-500 transition-all"
            autoComplete="off"
          />
        </div>
        <div>
          <label className="block mb-1 text-xs font-bold text-foreground">Senha temporária</label>
          <input
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Mínimo 6 caracteres"
            className="w-full bg-white dark:bg-card border border-border rounded-xl px-4 py-2.5 text-sm outline-none focus:border-amber-500 transition-all font-mono"
            autoComplete="off"
          />
        </div>
      </div>

      <button
        type="button"
        disabled={!canSubmit}
        onClick={submit}
        className="mt-4 w-full inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-sm shadow-[0_6px_18px_-4px_rgba(245,158,11,0.5)] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? <Loader2 className="animate-spin" size={16} /> : <Users size={16} />}
        {submitting ? 'Convidando…' : 'Convidar membro'}
      </button>

      {error && (
        <p className="mt-3 text-xs text-rose-600 dark:text-rose-400 flex items-start gap-1.5">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
