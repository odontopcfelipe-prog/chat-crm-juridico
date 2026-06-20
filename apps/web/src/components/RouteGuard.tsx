'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shield, Home } from 'lucide-react';
import { useRole, AppRole } from '@/lib/useRole';

interface RouteGuardProps {
  /** Roles que têm acesso. Se vazio, qualquer usuário autenticado passa. */
  allowedRoles: AppRole[];
  /** Para onde o botão "Voltar ao Início" leva quando o acesso é negado.
   *  Default: /atendimento/dashboard (a home "Início" de balões). */
  redirectTo?: string;
  children: React.ReactNode;
}

/**
 * Protege uma rota por role no client-side.
 * Renderiza children somente se o usuário logado tiver um dos roles permitidos.
 *
 * Onda 17.58 — em caso de acesso NEGADO não redireciona mais (antes jogava o
 * usuário no chat `/atendimento` sem explicação — ele "caía na agenda/WhatsApp"
 * do nada ao clicar num balão admin-only, ex.: Equipe). Agora mostra uma
 * mensagem clara de "Sem autorização" + botão pra voltar ao Início.
 */
export function RouteGuard({
  allowedRoles,
  redirectTo = '/atendimento/dashboard',
  children,
}: RouteGuardProps) {
  const router = useRouter();
  const { role, roles } = useRole();
  const [checked, setChecked] = useState(false);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    if (!role && roles.length === 0) {
      // Sem role → não autenticado → redireciona para login
      router.replace('/atendimento/login');
      return;
    }
    // Multi-role: verifica se QUALQUER role do usuário está na lista permitida
    const hasAccess = allowedRoles.length === 0 || roles.some(r => allowedRoles.includes(r));
    setAllowed(hasAccess);
    setChecked(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!checked) return null;

  if (!allowed) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center p-8">
        <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center">
          <Shield className="w-8 h-8 text-destructive/60" />
        </div>
        <div>
          <h3 className="text-base font-bold text-foreground">Sem autorização</h3>
          <p className="text-[13px] text-muted-foreground mt-1 max-w-sm">
            Você não tem permissão para acessar esta página. Solicite o desbloqueio
            com o administrador da clínica.
          </p>
        </div>
        <button
          type="button"
          onClick={() => router.push(redirectTo)}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-bold rounded-lg border border-border hover:bg-accent transition-colors"
        >
          <Home size={14} /> Voltar ao Início
        </button>
      </div>
    );
  }

  return <>{children}</>;
}
