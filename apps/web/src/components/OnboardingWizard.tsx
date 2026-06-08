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
import { useEffect, useState, useCallback } from 'react';
import {
  Sparkles, ArrowRight, ArrowLeft, X, CheckCircle2, Loader2,
  MessageSquare, CreditCard, Users, UserPlus, Rocket, QrCode,
  AlertCircle, Smartphone, RefreshCw,
} from 'lucide-react';
import Link from 'next/link';
import api from '@/lib/api';

type StepKey = 'whatsapp' | 'asaas' | 'first_patient' | 'team';
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
  {
    key: 'whatsapp',
    index: 1,
    required: true,
    icon: <MessageSquare size={36} />,
    iconBg: 'from-emerald-500 to-emerald-700',
    title: 'Conecte seu WhatsApp',
    description: 'Em 2 minutos seu sistema atende pacientes pelo WhatsApp. Sem isso, eles não recebem confirmação de consulta, lembrete de retorno, nem link de anamnese.',
    cta: { label: 'Conectar agora', href: '/atendimento/settings/whatsapp' },
  },
  {
    key: 'asaas',
    index: 2,
    required: true,
    icon: <CreditCard size={36} />,
    iconBg: 'from-violet-500 to-violet-700',
    title: 'Configure cobrança Asaas',
    description: 'PIX, boleto e cartão automatizados. Cole sua chave do Asaas (grátis pra abrir conta) e o sistema gera as cobranças sozinho — paciente paga e o status muda na hora.',
    cta: { label: 'Configurar Asaas', href: '/atendimento/settings/payment-gateway' },
  },
  {
    key: 'first_patient',
    index: 3,
    required: false,
    icon: <UserPlus size={36} />,
    iconBg: 'from-sky-500 to-sky-700',
    title: 'Cadastre seu 1° paciente',
    description: 'Comece a explorar o prontuário, agenda e propostas com um paciente real. Pode pular se preferir cadastrar depois.',
    cta: { label: 'Cadastrar paciente', href: '/atendimento/pacientes' },
  },
  {
    key: 'team',
    index: 4,
    required: false,
    icon: <Users size={36} />,
    iconBg: 'from-amber-500 to-amber-700',
    title: 'Convide sua equipe',
    description: 'Cadastre dentistas, recepção, ACD/ASB e financeiro. Cada um vê só o que tem permissão — você controla.',
    cta: { label: 'Convidar equipe', href: '/atendimento/settings/users' },
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

  // Avanca automaticamente quando uma etapa eh detectada como done
  useEffect(() => {
    if (!state || !open) return;
    if (screen === 0 || screen === 5) return;
    const stepKey = STEPS[screen - 1]?.key;
    if (stepKey && state.steps[stepKey] === 'done') {
      // Pequeno delay pra dar tempo de mostrar o check
      const t = setTimeout(() => setScreen((s) => Math.min(s + 1, 5)), 800);
      return () => clearTimeout(t);
    }
  }, [state, screen, open]);

  if (!open || !state) return null;

  const handleSkip = async (step: StepKey) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onStepUpdate(step, 'skipped');
      setScreen((s) => Math.min(s + 1, 5));
    } finally {
      setSubmitting(false);
    }
  };

  const handleNext = () => setScreen((s) => Math.min(s + 1, 5));
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
          {[0, 1, 2, 3, 4, 5].map((s) => (
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

          {screen >= 1 && screen <= 4 && (() => {
            const step = STEPS[screen - 1];
            const status = state.steps[step.key];
            return (
              <StepScreen
                step={step}
                status={status}
                submitting={submitting}
                onSkip={() => handleSkip(step.key)}
                onPrev={screen > 1 ? handlePrev : undefined}
                onStepUpdate={onStepUpdate}
              />
            );
          })()}

          {screen === 5 && (
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
  step, status, submitting, onSkip, onPrev, onStepUpdate,
}: {
  step: StepDef;
  status: StepStatus;
  submitting: boolean;
  onSkip?: () => void;
  onPrev?: () => void;
  onStepUpdate: (step: StepKey, status: 'done' | 'skipped') => Promise<void>;
}) {
  const isDone = status === 'done';
  // Onda 17.32.137 — WhatsApp ganha QR inline (em vez de Link redirect)
  const isWhatsapp = step.key === 'whatsapp';

  return (
    <div className="flex-1 flex flex-col py-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6 text-xs text-muted-foreground font-semibold">
        <span>Passo {step.index} de 4</span>
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

      {/* Onda 17.32.137 — WhatsApp Quick Connect inline (QR no proprio
          card do wizard, sem precisar sair pra outra tela) */}
      {isWhatsapp && !isDone && (
        <WhatsappQuickConnect
          onConnected={async () => { await onStepUpdate('whatsapp', 'done'); }}
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
          ) : isWhatsapp ? (
            // No WhatsApp o CTA principal vive dentro do QuickConnect.
            // Mostra um link discreto pra abrir a tela completa caso
            // queira (ex: gerenciar varios numeros depois).
            <Link
              href={step.cta.href}
              className="text-xs font-semibold text-violet-600 hover:text-violet-700 underline-offset-4 hover:underline"
            >
              Abrir tela completa
            </Link>
          ) : (
            <Link
              href={step.cta.href}
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

function WhatsappQuickConnect({ onConnected }: { onConnected: () => Promise<void> }) {
  const [generating, setGenerating] = useState(false);
  const [instanceName, setInstanceName] = useState<string | null>(null);
  const [qr, setQr] = useState<QrPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async () => {
    setGenerating(true); setError(null);
    try {
      const res = await api.post<{ instanceName: string; qr: QrPayload | null }>(
        '/whatsapp/my-numbers/connect',
        { displayName: 'WhatsApp da clinica' },
      );
      setInstanceName(res.data.instanceName);
      setQr(res.data.qr);
    } catch (e: any) {
      const raw = e?.response?.data?.message || '';
      if (typeof raw === 'string' && raw.includes('ja possui')) {
        // Ja tinha 1 conectado — marca como done direto
        await onConnected();
        return;
      }
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
        if (['open', 'connected', 'online', 'authenticated'].includes(s)) {
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
