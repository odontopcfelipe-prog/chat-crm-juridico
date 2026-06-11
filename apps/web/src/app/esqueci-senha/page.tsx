'use client';

/**
 * Onda 17.32.179 — Página pública "Esqueci minha senha".
 *
 * Pede o e-mail e chama POST /auth/forgot-password (sempre responde ok
 * — anti-enumeração). O link do e-mail leva pra /redefinir-senha?token=.
 * Visual no padrão claro do primeiro acesso (fundo roxo + card branco).
 */
import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, KeyRound, Loader2, MailCheck } from 'lucide-react';
import api from '@/lib/api';

export default function EsqueciSenhaPage() {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async () => {
    const value = email.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      await api.post('/auth/forgot-password', { email: value });
    } catch {
      // resposta é sempre genérica — mesmo em erro mostramos o mesmo estado
    } finally {
      setSending(false);
      setDone(true);
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
                <MailCheck className="h-7 w-7 text-emerald-600" />
              </div>
              <h1 className="text-2xl font-bold leading-tight text-zinc-900">Verifique seu e-mail</h1>
              <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-zinc-500">
                Se <b className="text-zinc-700">{email.trim()}</b> estiver cadastrado, você vai
                receber um link pra criar uma nova senha. O link vale por <b>1 hora</b> —
                olhe também o spam/lixo eletrônico.
              </p>
              <Link
                href="/atendimento/login"
                className="mt-8 flex items-center gap-2 rounded-xl bg-zinc-100 px-5 py-2.5 text-sm font-semibold text-zinc-700 ring-1 ring-zinc-200 transition hover:bg-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300"
              >
                <ArrowLeft size={16} />
                Voltar ao login
              </Link>
            </>
          ) : (
            <>
              <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-100 ring-1 ring-violet-200">
                <KeyRound className="h-7 w-7 text-violet-600" />
              </div>
              <h1 className="text-2xl font-bold leading-tight text-zinc-900">Esqueceu sua senha?</h1>
              <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-zinc-500">
                Digite o e-mail do seu acesso e enviaremos um link pra você criar uma senha nova.
              </p>
              <div className="mt-6 w-full max-w-sm text-left">
                <label className="mb-1 block text-[12px] font-medium text-zinc-600">E-mail</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                  placeholder="voce@suaclinica.com.br"
                  autoFocus
                  className="w-full rounded-lg bg-white px-3 py-2.5 text-sm text-zinc-900 ring-1 ring-zinc-200 placeholder:text-zinc-400 transition focus:outline-none focus:ring-2 focus:ring-violet-400/60"
                />
              </div>
              <button
                type="button"
                onClick={submit}
                disabled={!email.trim() || sending}
                className="mt-6 flex items-center gap-2 rounded-xl bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg transition hover:bg-violet-500 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
              >
                {sending ? <Loader2 size={16} className="animate-spin" /> : null}
                {sending ? 'Enviando…' : 'Enviar link de redefinição'}
                {!sending && <ArrowRight size={16} />}
              </button>
              <Link
                href="/atendimento/login"
                className="mt-4 text-xs font-medium text-zinc-400 transition hover:text-zinc-600"
              >
                Lembrei a senha — voltar ao login
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
