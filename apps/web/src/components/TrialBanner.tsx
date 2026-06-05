'use client';

/**
 * Onda 17.32.86 — Banner global de status do trial / assinatura.
 *
 * Aparece no topo do sistema quando:
 *  - Trial: faltam <= 7 dias pra expirar
 *  - Subscription: PAST_DUE
 *  - Trial expirou (não deve ter logado, mas se logou, força ir pra billing)
 *
 * Usa useTenant() pra ler status. Botao CTA leva pra /atendimento/billing.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, Sparkles, ArrowRight, X } from 'lucide-react';
import { useTenant } from '@/lib/useTenant';

export function TrialBanner() {
  const tenant = useTenant();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(sessionStorage.getItem('trial_banner_dismissed') === '1');
  }, []);

  if (!tenant || dismissed) return null;
  if (tenant.status === 'ACTIVE') return null; // só mostra em situações especiais

  const trialEnds = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
  const daysLeft = trialEnds ? Math.ceil((trialEnds.getTime() - Date.now()) / (1000 * 60 * 60 * 24)) : 0;

  let label = '';
  let tone: 'amber' | 'red' = 'amber';
  let cta = 'Escolher plano';

  if (tenant.status === 'TRIAL' && daysLeft > 0 && daysLeft <= 7) {
    label = daysLeft === 1
      ? '⚠ Sua avaliação termina amanhã. Escolha um plano pra não perder o acesso.'
      : `Sua avaliação termina em ${daysLeft} dias. Escolha um plano antecipadamente.`;
    tone = daysLeft <= 3 ? 'red' : 'amber';
  } else if (tenant.status === 'TRIAL' && daysLeft <= 0) {
    label = 'Sua avaliação expirou. Assine agora pra continuar usando.';
    tone = 'red';
    cta = 'Assinar agora';
  } else if (tenant.status === 'SUSPENDED') {
    label = 'Sua conta está suspensa. Regularize a mensalidade pra reativar.';
    tone = 'red';
    cta = 'Regularizar';
  } else {
    return null;
  }

  const handleDismiss = () => {
    sessionStorage.setItem('trial_banner_dismissed', '1');
    setDismissed(true);
  };

  const cls = tone === 'red'
    ? 'bg-red-500/10 border-red-500/30 text-red-700'
    : 'bg-amber-500/10 border-amber-500/30 text-amber-700';

  return (
    <div className={`border-b ${cls} px-4 py-2.5 flex items-center gap-3 text-xs font-semibold`}>
      {tone === 'red' ? <AlertCircle size={14} className="shrink-0" /> : <Sparkles size={14} className="shrink-0" />}
      <span className="flex-1">{label}</span>
      <Link
        href="/atendimento/billing"
        className={`inline-flex items-center gap-1 px-3 py-1 rounded-md text-white font-bold whitespace-nowrap ${
          tone === 'red' ? 'bg-red-600 hover:bg-red-700' : 'bg-amber-600 hover:bg-amber-700'
        }`}
      >
        {cta}
        <ArrowRight size={11} />
      </Link>
      {/* So permite dismiss em TRIAL — suspenso nao pode ignorar */}
      {tenant.status === 'TRIAL' && daysLeft > 3 && (
        <button
          type="button"
          onClick={handleDismiss}
          className="p-1 hover:bg-black/10 rounded shrink-0"
          title="Dispensar"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
