'use client';

/**
 * Onda 17.32.102 — Modal de boas-vindas pra tenant em TRIAL.
 *
 * Aparece 1x por dia (controlado por sessionStorage com a data) quando
 * o usuario entra no sistema. Mostra:
 *  - Quantos dias restam do trial
 *  - Data exata de expiracao
 *  - 4 atalhos pra o que fazer primeiro (WhatsApp/Paciente/Cobranca/Equipe)
 *  - CTA pra ver planos
 *
 * Fechavel pelo X, pelo botao "Comecar a usar", ou clicando fora do card.
 * Renderizado no AtendimentoLayout — o TrialBanner (sticky no topo) segue
 * la pra avisar quando faltar pouco tempo. Esse modal eh so pra orientar
 * no inicio.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Sparkles, X, ArrowRight, CalendarDays, ShieldCheck,
  MessageSquare, CreditCard, Users,
} from 'lucide-react';
import { useTenant, useIsTenantOwner } from '@/lib/useTenant';

const DISMISS_KEY = 'trial_welcome_dismissed_at';

export function TrialWelcomeModal() {
  const tenant = useTenant();
  // Onda 17.32.150 — Modal so pra ADMIN principal (signatario)
  const isOwner = useIsTenantOwner();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!tenant) return;
    if (tenant.status !== 'TRIAL') return;
    if (!isOwner) return;
    // Onda 17.32.157 — Nunca abrir dentro de iframe (o modal da tabela
    // de precos do wizard embeda paginas que herdam este layout)
    try {
      if (typeof window !== 'undefined' && window.self !== window.top) return;
    } catch { return; /* cross-origin = iframe */ }

    // So aparece 1x por dia — chave salva a data (YYYY-MM-DD)
    const today = new Date().toISOString().slice(0, 10);
    let dismissed: string | null = null;
    try {
      dismissed = sessionStorage.getItem(DISMISS_KEY);
    } catch {
      // Privacy mode / SSR: ignora
    }
    if (dismissed === today) return;

    // Onda 17.32.158 — So abre DEPOIS do onboarding completado.
    //
    // Antes (Onda 149) abria quando completed_at == null — as MESMAS
    // condicoes do OnboardingWizard. Ambos abriam juntos: o wizard
    // (z-200) cobria este modal (z-110), e ao fechar o wizard o modal
    // "aparecia do nada" (card fantasma reportado pelo user).
    //
    // Agora: pre-onboarding o wizard E a tela de boas-vindas; este
    // modal vira lembrete diario do trial apenas pos-onboarding.
    // Em erro do fetch: NAO abre (conservador — evita duplicar).
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    (async () => {
      try {
        const { default: api } = await import('@/lib/api');
        const res = await api.get<{ completed_at: string | null }>('/tenants/me/onboarding');
        if (cancelled) return;
        if (!res.data?.completed_at) return; // onboarding em andamento -> wizard cuida
        // Pequeno delay pra dar tempo do dashboard montar
        timer = setTimeout(() => { if (!cancelled) setOpen(true); }, 600);
      } catch {
        // fetch falhou -> nao abre (wizard pode estar prestes a abrir)
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [tenant, isOwner]);

  const handleClose = () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      sessionStorage.setItem(DISMISS_KEY, today);
    } catch {
      // ignore
    }
    setOpen(false);
  };

  if (!tenant || !open || tenant.status !== 'TRIAL') return null;

  const trialEnds = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
  const daysLeft = trialEnds
    ? Math.max(0, Math.ceil((trialEnds.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : 14;

  const SHORTCUTS = [
    {
      Icon: MessageSquare,
      label: 'Conectar seu WhatsApp',
      sub: 'Em 2 min você atende pacientes pelo sistema',
      href: '/atendimento/settings/whatsapp',
    },
    {
      Icon: CalendarDays,
      label: 'Cadastrar 1° paciente',
      sub: 'Use o atalho rápido no menu inicial',
      href: '/atendimento/pacientes',
    },
    {
      Icon: CreditCard,
      label: 'Configurar cobrança Asaas',
      sub: 'PIX, boleto e cartão automatizados',
      href: '/atendimento/settings/payment-gateway',
    },
    {
      Icon: Users,
      label: 'Convidar sua equipe',
      sub: 'Dentistas, secretária, financeiro',
      href: '/atendimento/settings/users',
    },
  ];

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={handleClose}
    >
      <div
        className="bg-card border border-border rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="trial-welcome-title"
      >
        {/* Header com gradient violet -> emerald */}
        <div className="relative overflow-hidden bg-gradient-to-br from-violet-600 via-violet-700 to-violet-900 text-white p-6">
          {/* Glow emerald de canto */}
          <div className="absolute -top-16 -right-16 w-44 h-44 bg-emerald-400/30 rounded-full blur-3xl pointer-events-none" />
          <div
            className="absolute inset-0 opacity-[0.06] pointer-events-none"
            style={{
              backgroundImage:
                'radial-gradient(circle at 1px 1px, white 1px, transparent 0)',
              backgroundSize: '20px 20px',
            }}
          />

          <button
            type="button"
            onClick={handleClose}
            className="absolute top-4 right-4 w-8 h-8 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center transition-colors z-10"
            aria-label="Fechar"
          >
            <X size={15} />
          </button>

          <div className="relative z-10">
            <div className="inline-flex items-center gap-1.5 bg-white/15 border border-white/20 rounded-full px-2.5 py-1 text-[10px] font-bold mb-3 backdrop-blur-sm uppercase tracking-wider">
              <Sparkles size={11} />
              Trial ativo
            </div>
            <h2 id="trial-welcome-title" className="text-2xl font-black mb-2 tracking-tight leading-tight">
              Bem-vindo ao Odonto System!
            </h2>
            <p className="text-sm text-violet-50/90 leading-relaxed">
              Você tem{' '}
              <strong className="text-emerald-300 font-extrabold">
                {daysLeft} {daysLeft === 1 ? 'dia' : 'dias'}
              </strong>{' '}
              grátis pra usar tudo sem limite.
              {trialEnds && (
                <> Seu trial vai até{' '}
                  <strong className="text-white font-bold whitespace-nowrap">
                    {trialEnds.toLocaleDateString('pt-BR')}
                  </strong>.
                </>
              )}
            </p>
          </div>
        </div>

        {/* Body — atalhos pra começar */}
        <div className="p-5 space-y-1">
          <p className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider px-2 pb-2">
            Comece por aqui:
          </p>
          {SHORTCUTS.map(({ Icon, label, sub, href }) => (
            <Link
              key={label}
              href={href}
              onClick={handleClose}
              className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-accent/40 transition-colors group"
            >
              <div className="w-10 h-10 rounded-lg bg-violet-500/10 border border-violet-500/20 flex items-center justify-center group-hover:bg-violet-500/15 group-hover:border-violet-500/30 transition-colors shrink-0">
                <Icon size={16} className="text-violet-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground truncate">{label}</p>
                <p className="text-[11px] text-muted-foreground truncate">{sub}</p>
              </div>
              <ArrowRight
                size={14}
                className="text-muted-foreground group-hover:translate-x-0.5 group-hover:text-violet-600 transition-all shrink-0"
              />
            </Link>
          ))}
        </div>

        {/* Footer com 2 ações */}
        <div className="px-5 py-4 bg-muted/30 border-t border-border flex items-center justify-between gap-3">
          <Link
            href="/atendimento/billing"
            onClick={handleClose}
            className="inline-flex items-center gap-1.5 text-xs font-bold text-violet-700 hover:text-violet-900 hover:underline transition-colors"
          >
            <ShieldCheck size={13} />
            Ver planos e preços
          </Link>
          <button
            type="button"
            onClick={handleClose}
            className="text-sm font-bold px-4 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white shadow-[0_4px_12px_-2px_rgba(124,58,237,0.4)] hover:shadow-[0_6px_16px_-2px_rgba(124,58,237,0.5)] transition-all"
          >
            Começar a usar
          </button>
        </div>
      </div>
    </div>
  );
}
