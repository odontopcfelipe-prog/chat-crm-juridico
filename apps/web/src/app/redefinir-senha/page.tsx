'use client';

/**
 * Onda 17.32.179 — Página pública de redefinição de senha.
 *
 * Recebe ?token= do link enviado por e-mail (POST /auth/forgot-password)
 * e chama POST /auth/reset-password com a senha nova. Token vale 1h.
 * Visual no padrão claro do primeiro acesso (fundo roxo + card branco).
 */
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { AlertCircle, ArrowRight, CheckCircle2, KeyRound, Loader2 } from 'lucide-react';
import api from '@/lib/api';

function RedefinirSenhaInner() {
  const params = useSearchParams();
  const token = params.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit = password.trim().length >= 6 && password === confirm && !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      await api.post('/auth/reset-password', { token, password: password.trim() });
      setDone(true);
    } catch (e: any) {
      const raw = e?.response?.data?.message;
      setError(typeof raw === 'string' && raw ? raw : 'Não foi possível redefinir a senha. Tente abrir o link de novo.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center overflow-y-auto bg-gradient-to-b from-violet-600 via-violet-800 to-indigo-950 p-4 font-sans antialiased">
      <div className="relative w-full max-w-md">
        <div className="pointer-events-none absolute -inset-10 rounded-[40px] bg-emerald-500/20 blur-3xl" />
        <div className="relative flex flex-col items-center overflow-hidden rounded-3xl bg-white px-6 py-12 text-center shadow-2xl">
          {done ? (
            <>
              <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-100 ring-1 ring-emerald-200">
                <CheckCircle2 className="h-7 w-7 text-emerald-600" />
              </div>
              <h1 className="text-2xl font-bold leading-tight text-zinc-900">Senha redefinida!</h1>
              <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-zinc-500">
                Sua nova senha já está valendo. Entre no sistema com ela.
              </p>
              <Link
                href="/atendimento/login"
                className="mt-8 flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg transition hover:bg-emerald-500 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              >
                Ir para o login
                <ArrowRight size={16} />
              </Link>
            </>
          ) : !token ? (
            <>
              <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-100 ring-1 ring-rose-200">
                <AlertCircle className="h-7 w-7 text-rose-600" />
              </div>
              <h1 className="text-2xl font-bold leading-tight text-zinc-900">Link incompleto</h1>
              <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-zinc-500">
                Este endereço não tem o código de redefinição. Abra o link exatamente
                como veio no e-mail, ou peça um novo.
              </p>
              <Link
                href="/esqueci-senha"
                className="mt-8 flex items-center gap-2 rounded-xl bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg transition hover:bg-violet-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
              >
                Pedir novo link
                <ArrowRight size={16} />
              </Link>
            </>
          ) : (
            <>
              <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-100 ring-1 ring-violet-200">
                <KeyRound className="h-7 w-7 text-violet-600" />
              </div>
              <h1 className="text-2xl font-bold leading-tight text-zinc-900">Crie sua nova senha</h1>
              <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-zinc-500">
                Mínimo de 6 caracteres. Depois é só entrar com ela no login.
              </p>
              <div className="mt-6 w-full max-w-sm space-y-3 text-left">
                <div>
                  <label className="mb-1 block text-[12px] font-medium text-zinc-600">Nova senha</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    autoFocus
                    className="w-full rounded-lg bg-white px-3 py-2.5 text-sm text-zinc-900 ring-1 ring-zinc-200 placeholder:text-zinc-400 transition focus:outline-none focus:ring-2 focus:ring-violet-400/60"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[12px] font-medium text-zinc-600">Confirmar nova senha</label>
                  <input
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                    placeholder="••••••••"
                    className="w-full rounded-lg bg-white px-3 py-2.5 text-sm text-zinc-900 ring-1 ring-zinc-200 placeholder:text-zinc-400 transition focus:outline-none focus:ring-2 focus:ring-violet-400/60"
                  />
                  {mismatch && (
                    <p className="mt-1 text-[11px] text-rose-600">As senhas não coincidem.</p>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={submit}
                disabled={!canSubmit}
                className="mt-6 flex items-center gap-2 rounded-xl bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg transition hover:bg-violet-500 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
              >
                {saving ? <Loader2 size={16} className="animate-spin" /> : null}
                {saving ? 'Salvando…' : 'Salvar nova senha'}
                {!saving && <ArrowRight size={16} />}
              </button>
              {error && (
                <p className="mt-4 flex max-w-sm items-start gap-1.5 text-left text-xs text-rose-600">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" />
                  <span>{error} Se o link expirou, <Link href="/esqueci-senha" className="font-semibold underline">peça um novo aqui</Link>.</span>
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function RedefinirSenhaPage() {
  // useSearchParams exige Suspense boundary no App Router
  return (
    <Suspense fallback={null}>
      <RedefinirSenhaInner />
    </Suspense>
  );
}
