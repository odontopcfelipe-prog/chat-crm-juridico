'use client';

/**
 * Onda 17.32.172 — Página pública de confirmação de e-mail da equipe.
 *
 * O membro recebe o link /verificar-email?token=... no e-mail de boas-
 * vindas (criado pelo admin no cadastro da equipe ou no onboarding).
 * Aqui validamos o token na API (rota pública GET /users/verify-email)
 * e mostramos o resultado no padrão visual do primeiro acesso: fundo
 * roxo com glow + card branco.
 */
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { CheckCircle2, AlertCircle, Loader2, ArrowRight, MailCheck } from 'lucide-react';
import api from '@/lib/api';

type Status =
  | { kind: 'loading' }
  | { kind: 'ok'; name: string; email: string }
  | { kind: 'error'; message: string };

function VerificarEmailInner() {
  const params = useSearchParams();
  const token = params.get('token') || '';
  const [status, setStatus] = useState<Status>({ kind: 'loading' });

  useEffect(() => {
    if (!token) {
      setStatus({ kind: 'error', message: 'Link inválido — o endereço está incompleto.' });
      return;
    }
    let cancelled = false;
    api
      .get<{ ok: boolean; name: string; email: string }>('/users/verify-email', { params: { token } })
      .then((res) => {
        if (!cancelled) setStatus({ kind: 'ok', name: res.data.name, email: res.data.email });
      })
      .catch((e) => {
        if (cancelled) return;
        const raw = e?.response?.data?.message;
        setStatus({
          kind: 'error',
          message: typeof raw === 'string' && raw ? raw : 'Não foi possível confirmar o e-mail. Tente abrir o link de novo.',
        });
      });
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className="fixed inset-0 flex items-center justify-center overflow-y-auto bg-gradient-to-b from-violet-600 via-violet-800 to-indigo-950 p-4 font-sans antialiased">
      <div className="relative w-full max-w-md">
        <div className="pointer-events-none absolute -inset-10 rounded-[40px] bg-emerald-500/20 blur-3xl" />
        <div className="relative flex flex-col items-center overflow-hidden rounded-3xl bg-white px-6 py-12 text-center shadow-2xl">
          {status.kind === 'loading' && (
            <>
              <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-100 ring-1 ring-zinc-200">
                <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
              </div>
              <h1 className="text-2xl font-bold leading-tight text-zinc-900">Confirmando seu e-mail…</h1>
              <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-zinc-500">
                Só um instante enquanto validamos o seu link.
              </p>
            </>
          )}

          {status.kind === 'ok' && (
            <>
              <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-100 ring-1 ring-emerald-200">
                <MailCheck className="h-7 w-7 text-emerald-600" />
              </div>
              <span className="text-xs font-semibold uppercase tracking-wider text-emerald-600">E-mail confirmado</span>
              <h1 className="mt-2 text-2xl font-bold leading-tight text-zinc-900">Tudo certo, {status.name.split(' ')[0]}!</h1>
              <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-zinc-500">
                O endereço <b className="text-zinc-700">{status.email}</b> foi validado.
                Agora é só entrar com a senha que o administrador definiu pra você.
              </p>
              <Link
                href="/atendimento/login"
                className="mt-8 flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg transition hover:bg-emerald-500 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              >
                Ir para o login
                <ArrowRight size={16} />
              </Link>
            </>
          )}

          {status.kind === 'error' && (
            <>
              <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-100 ring-1 ring-rose-200">
                <AlertCircle className="h-7 w-7 text-rose-600" />
              </div>
              <h1 className="text-2xl font-bold leading-tight text-zinc-900">Não foi possível confirmar</h1>
              <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-zinc-500">{status.message}</p>
              <p className="mt-2 max-w-sm text-[12px] leading-relaxed text-zinc-400">
                Se o link expirou, peça ao administrador da clínica pra reenviar a
                confirmação na tela <b className="text-zinc-500">Configurações → Usuários</b>.
              </p>
              <Link
                href="/atendimento/login"
                className="mt-8 flex items-center gap-2 rounded-xl bg-zinc-100 px-5 py-2.5 text-sm font-semibold text-zinc-700 ring-1 ring-zinc-200 transition hover:bg-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300"
              >
                Ir para o login
                <ArrowRight size={16} />
              </Link>
            </>
          )}

          {status.kind !== 'loading' && status.kind !== 'error' ? null : null}
          <p className="mt-8 flex items-center gap-1.5 text-[11px] text-zinc-400">
            <CheckCircle2 size={11} className="text-emerald-500" />
            Odonto System — confirmação de e-mail da equipe
          </p>
        </div>
      </div>
    </div>
  );
}

export default function VerificarEmailPage() {
  // useSearchParams exige Suspense boundary no App Router
  return (
    <Suspense fallback={null}>
      <VerificarEmailInner />
    </Suspense>
  );
}
