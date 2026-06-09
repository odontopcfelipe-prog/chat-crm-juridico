'use client';

/**
 * Onda 17.32.124 — Wrapper que carrega estado do onboarding e abre
 * o OnboardingWizard quando relevante.
 *
 * Logica de exibir:
 *  - tenant.status === 'TRIAL' (so durante trial)
 *  - onboarding_state.completed_at === null
 *  - onboarding_state.dismissed_at vazio OU mais antigo que 1h
 *  - tem pelo menos 1 etapa pendente
 */
import { useEffect, useState, useCallback } from 'react';
import api from '@/lib/api';
import { useTenant, useIsTenantOwner } from '@/lib/useTenant';
import { OnboardingWizard } from './OnboardingWizard';

type StepKey = 'whatsapp' | 'asaas' | 'first_patient' | 'team';
type StepStatus = 'done' | 'skipped' | 'pending';

interface OnboardingState {
  steps: Record<StepKey, StepStatus>;
  completed_at: string | null;
  dismissed_at: string | null;
  required_pending: number;
  optional_pending: number;
}

const DISMISS_LOCAL_KEY = 'onboarding_dismissed_local';

export function OnboardingWizardLoader() {
  const tenant = useTenant();
  // Onda 17.32.150 — Wizard so aparece pro ADMIN principal do tenant
  const isOwner = useIsTenantOwner();
  const [state, setState] = useState<OnboardingState | null>(null);
  const [open, setOpen] = useState(false);

  const fetchState = useCallback(async () => {
    try {
      const res = await api.get<OnboardingState>('/tenants/me/onboarding');
      setState(res.data);
      return res.data;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!tenant) return;
    // Só pra tenants em TRIAL (depois do trial, modal nao aparece)
    if (tenant.status !== 'TRIAL') return;
    // Onda 17.32.150 — Apenas pro ADMIN principal (signatario)
    if (!isOwner) return;

    let cancelled = false;
    fetchState().then((s) => {
      if (cancelled || !s) return;
      if (s.completed_at) return; // ja completou alguma vez

      // Se nada pendente, considera completo automaticamente
      if (s.required_pending === 0 && s.optional_pending === 0) return;

      // Dismiss recente: pula por 4h (nao volta a cada navegacao)
      try {
        const localDismiss = sessionStorage.getItem(DISMISS_LOCAL_KEY);
        if (localDismiss) {
          const when = parseInt(localDismiss, 10);
          if (Date.now() - when < 4 * 60 * 60 * 1000) return; // 4h
        }
      } catch { /* SSR ignore */ }

      // Mostra com pequeno delay pra layout estabilizar
      const t = setTimeout(() => setOpen(true), 500);
      return () => clearTimeout(t);
    });
    return () => { cancelled = true; };
  }, [tenant, isOwner, fetchState]);

  // Onda 17.32.125 — Permite reabrir o wizard de qualquer lugar
  // (ex: banner persistente no menu inicial) via window event.
  useEffect(() => {
    const handler = () => {
      // Refresh estado antes de abrir
      fetchState().then(() => {
        try { sessionStorage.removeItem(DISMISS_LOCAL_KEY); } catch {}
        setOpen(true);
      });
    };
    window.addEventListener('onboarding:open', handler);
    return () => window.removeEventListener('onboarding:open', handler);
  }, [fetchState]);

  const handleStepUpdate = useCallback(async (step: StepKey, status: 'done' | 'skipped') => {
    try {
      const res = await api.patch<OnboardingState>(
        '/tenants/me/onboarding/step',
        { step, status },
      );
      setState(res.data);
    } catch {
      // ignora — frontend continua avancando mesmo se backend falhar
    }
  }, []);

  const handleComplete = useCallback(async () => {
    try {
      await api.post('/tenants/me/onboarding/complete');
    } catch { /* ignora */ }
    setOpen(false);
  }, []);

  const handleDismiss = useCallback(async () => {
    try {
      sessionStorage.setItem(DISMISS_LOCAL_KEY, String(Date.now()));
      await api.post('/tenants/me/onboarding/dismiss');
    } catch { /* ignora */ }
  }, []);

  return (
    <OnboardingWizard
      open={open}
      state={state}
      onClose={() => setOpen(false)}
      onComplete={handleComplete}
      onDismiss={handleDismiss}
      onStepUpdate={handleStepUpdate}
    />
  );
}
