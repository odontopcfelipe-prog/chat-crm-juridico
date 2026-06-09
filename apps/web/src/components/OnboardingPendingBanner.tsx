'use client';

/**
 * Onda 17.32.125 — Banner persistente no menu inicial pra quem fechou
 * o OnboardingWizard com etapas pendentes. Mostra contagem + lista
 * curta + botao "Continuar configuracao" que reabre o wizard via
 * window event ('onboarding:open').
 *
 * NAO renderiza se:
 *  - tenant nao esta em TRIAL
 *  - onboarding.completed_at preenchido
 *  - todas as etapas estao 'done' ou 'skipped'
 */
import { useEffect, useState, useCallback } from 'react';
import { Sparkles, ArrowRight, MessageSquare, CreditCard, UserPlus, Users, CheckCircle2, Tag, Building2 } from 'lucide-react';
import api from '@/lib/api';
import { useTenant, useIsTenantOwner } from '@/lib/useTenant';

type StepKey = 'clinic_profile' | 'whatsapp' | 'asaas' | 'first_patient' | 'team' | 'pricing';
type StepStatus = 'done' | 'skipped' | 'pending';

interface OnboardingState {
  steps: Record<StepKey, StepStatus>;
  completed_at: string | null;
  required_pending: number;
  optional_pending: number;
}

const STEP_META: Record<StepKey, { label: string; Icon: any; required: boolean }> = {
  clinic_profile:{ label: 'Identidade da clínica', Icon: Building2,   required: true  },
  whatsapp:      { label: 'WhatsApp',           Icon: MessageSquare, required: true  },
  asaas:         { label: 'Cobrança Asaas',     Icon: CreditCard,    required: true  },
  first_patient: { label: '1° paciente',         Icon: UserPlus,      required: false },
  team:          { label: 'Convidar equipe',     Icon: Users,         required: false },
  pricing:       { label: 'Tabela de preços',    Icon: Tag,           required: false },
};

export function OnboardingPendingBanner() {
  const tenant = useTenant();
  // Onda 17.32.150 — Banner so aparece pro ADMIN principal
  const isOwner = useIsTenantOwner();
  const [state, setState] = useState<OnboardingState | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchState = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<OnboardingState>('/tenants/me/onboarding');
      setState(res.data);
    } catch {
      // ignora
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchState(); }, [fetchState]);

  // Re-fetch quando o wizard fecha (caso user tenha completado etapa)
  useEffect(() => {
    const handler = () => fetchState();
    window.addEventListener('onboarding:state-changed', handler);
    return () => window.removeEventListener('onboarding:state-changed', handler);
  }, [fetchState]);

  // Auto-refresh em foco — pega mudanças quando o user volta de configurar
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'visible') fetchState();
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [fetchState]);

  if (loading) return null;
  if (!tenant) return null;
  if (tenant.status !== 'TRIAL') return null;
  // Onda 17.32.150 — Apenas pro ADMIN principal (signatario)
  if (!isOwner) return null;
  if (!state) return null;
  if (state.completed_at) return null;
  // Se nada pendente, esconde
  if (state.required_pending === 0 && state.optional_pending === 0) return null;

  const handleOpen = () => {
    try {
      window.dispatchEvent(new Event('onboarding:open'));
    } catch { /* ignora */ }
  };

  const pendingSteps = (['clinic_profile', 'whatsapp', 'asaas', 'first_patient', 'team', 'pricing'] as StepKey[])
    .filter(k => state.steps[k] === 'pending');
  const doneCount = (['clinic_profile', 'whatsapp', 'asaas', 'first_patient', 'team', 'pricing'] as StepKey[])
    .filter(k => state.steps[k] === 'done').length;
  const progress = Math.round((doneCount / 6) * 100);

  return (
    <div className="relative overflow-hidden rounded-2xl border border-violet-500/30 bg-gradient-to-r from-violet-500/10 via-violet-500/5 to-emerald-500/5 p-5 mb-6">
      {/* Glow decorativo */}
      <div className="absolute -top-12 -right-12 w-40 h-40 bg-emerald-400/20 rounded-full blur-3xl pointer-events-none" />

      <div className="relative flex items-start gap-4 flex-wrap">
        {/* Ícone */}
        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-violet-500 to-violet-700 grid place-items-center text-white shrink-0 shadow-lg">
          <Sparkles size={22} />
        </div>

        {/* Texto */}
        <div className="flex-1 min-w-[260px]">
          <h3 className="text-sm font-bold text-foreground tracking-tight flex items-center gap-2 flex-wrap">
            Termine de configurar seu sistema
            <span className="text-[10px] font-extrabold bg-violet-600/20 text-violet-700 dark:text-violet-300 px-2 py-0.5 rounded-full">
              {doneCount}/6 prontos
            </span>
          </h3>

          {/* Barra de progresso */}
          <div className="h-1.5 bg-violet-500/10 rounded-full mt-2.5 mb-3 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-violet-500 to-emerald-500 rounded-full transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>

          {/* Pendências em chips */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {pendingSteps.length > 0 ? (
              pendingSteps.slice(0, 4).map(k => {
                const meta = STEP_META[k];
                const Icon = meta.Icon;
                return (
                  <span
                    key={k}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold ${
                      meta.required
                        ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/30'
                        : 'bg-violet-500/10 text-violet-700 dark:text-violet-300 border border-violet-500/20'
                    }`}
                  >
                    <Icon size={11} />
                    {meta.label}
                    {meta.required && <span className="text-[9px] opacity-80">(recomendado)</span>}
                  </span>
                );
              })
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
                <CheckCircle2 size={11} />
                Tudo configurado — só finalizar
              </span>
            )}
          </div>
        </div>

        {/* CTA */}
        <button
          type="button"
          onClick={handleOpen}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-700 text-white font-bold text-sm shadow-[0_6px_18px_-4px_rgba(124,58,237,0.5)] transition-all hover:-translate-y-0.5 shrink-0"
        >
          Continuar configuração
          <ArrowRight size={14} />
        </button>
      </div>
    </div>
  );
}
