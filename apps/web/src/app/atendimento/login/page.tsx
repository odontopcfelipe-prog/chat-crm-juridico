'use client';

import { useState, FormEvent, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Mail, Lock, AlertCircle, Eye, EyeOff,
  MessageSquare, CreditCard, FileSignature, CalendarDays,
  ShieldCheck, ArrowRight, Sparkles,
} from 'lucide-react';
// CheckCircle2 removido — coluna esquerda agora usa icones por categoria
// (MessageSquare/CreditCard/FileSignature/CalendarDays) em vez de check generico.
import { motion } from 'framer-motion';
import api, { API_BASE_URL } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [dbStatus, setDbStatus] = useState<'online' | 'offline' | 'checking'>('checking');
  const [sessionMsg, setSessionMsg] = useState<string | null>(null);

  useEffect(() => {
    const savedEmail = localStorage.getItem('remembered_email');
    if (savedEmail) {
      setEmail(savedEmail);
      setRememberMe(true);
    }
    // Verifica se foi redirecionado por logout automático
    const reason = localStorage.getItem('auth_logout_reason');
    if (reason) {
      localStorage.removeItem('auth_logout_reason');
      setSessionMsg(
        reason === 'expired'
          ? 'Sua sessão expirou. Faça login novamente.'
          : 'Acesso não autorizado. Faça login novamente.'
      );
    }
  }, []);

  useEffect(() => {
    let consecutiveFailures = 0;

    const checkDb = async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(`${API_BASE_URL}/health/db`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.status === 'ok') {
          setDbStatus('online');
          consecutiveFailures = 0;
        } else {
          throw new Error(data.message || 'DB not ok');
        }
      } catch {
        clearTimeout(timeoutId);
        consecutiveFailures++;
        // Marca offline após 2 falhas consecutivas (evita false positive por 1 timeout)
        if (consecutiveFailures >= 2) {
          setDbStatus('offline');
        }
      }
    };

    checkDb();
    // Verifica a cada 30 segundos — sem reset de contador
    // (antes era 10s, gerava ruido e carga inutil sem o usuario nem estar logado)
    const interval = setInterval(checkDb, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api.post('/auth/login', { email, password });
      localStorage.setItem('token', res.data.access_token);
      if (rememberMe) {
        localStorage.setItem('remembered_email', email);
      } else {
        localStorage.removeItem('remembered_email');
      }
      router.push('/atendimento');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      setError(e.response?.data?.message || 'Credenciais inválidas');
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#0A0A0A]">
      {/* Background effects */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(168,144,72,0.07)_0%,transparent_70%)]" />
      <div className="absolute -left-40 -top-40 h-[500px] w-[500px] rounded-full bg-[#A89048]/5 blur-[120px] animate-pulse" />
      <div className="absolute -bottom-40 -right-40 h-[500px] w-[500px] rounded-full bg-[#A89048]/5 blur-[120px] animate-pulse" />

      <div className="relative flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-[1100px]">
          <div className="grid gap-8 lg:grid-cols-2 lg:gap-20">

            {/* ── Left — Branding (Onda 17.32.96: reformulado SaaS) ──── */}
            <div className="hidden flex-col justify-between lg:flex">
              <div>
                <div className="mb-12 inline-flex items-center gap-2.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-[#A89048] shadow-[0_0_12px_rgba(168,144,72,0.7)]" />
                  <h2 className="text-2xl font-black uppercase tracking-tight text-[#A89048]">
                    Odonto System
                  </h2>
                </div>

                <div className="inline-flex items-center gap-2 bg-[#A89048]/10 border border-[#A89048]/25 rounded-full px-3 py-1 text-[11px] font-bold text-[#A89048] mb-6 backdrop-blur-sm">
                  <Sparkles size={11} />
                  14 dias grátis · sem cartão
                </div>

                <h1 className="mb-6 text-5xl font-black leading-[1.05] text-white uppercase tracking-tight">
                  Sistema completo <br />
                  <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#e3c788] via-[#d4b568] to-[#c8aa62]">
                    pra sua clínica
                  </span>
                </h1>

                <p className="mb-10 text-base text-slate-400 font-medium leading-relaxed max-w-md">
                  Pacientes, agenda, WhatsApp, cobrança Asaas, contratos
                  ClickSign e relatórios — tudo num lugar.
                </p>

                <div className="space-y-4">
                  {[
                    { Icon: MessageSquare,  label: 'WhatsApp + IA pra atendimento' },
                    { Icon: CreditCard,     label: 'Cobrança Asaas (PIX/boleto/cartão)' },
                    { Icon: FileSignature,  label: 'Contratos com ClickSign' },
                    { Icon: CalendarDays,   label: 'Agenda + prontuário completo' },
                  ].map(({ Icon, label }) => (
                    <div key={label} className="flex items-center gap-3 group">
                      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#A89048]/10 border border-[#A89048]/25 transition-all group-hover:bg-[#A89048]/20 group-hover:border-[#A89048]/40 shrink-0">
                        <Icon className="h-4 w-4 text-[#A89048]" strokeWidth={2.2} />
                      </div>
                      <span className="text-sm font-semibold text-slate-200 tracking-tight">{label}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Stats + trust signal embaixo */}
              <div className="mt-12">
                <div className="grid grid-cols-3 gap-4 pb-5 mb-5 border-b border-white/[0.06]">
                  {[
                    { num: '+10',   label: 'Anos no mercado' },
                    { num: '98%',   label: 'Satisfação' },
                    { num: '24/7',  label: 'Online' },
                  ].map((s) => (
                    <div key={s.label}>
                      <div className="text-2xl font-black text-transparent bg-clip-text bg-gradient-to-r from-[#e3c788] to-[#c8aa62] leading-none mb-1.5">
                        {s.num}
                      </div>
                      <div className="text-[11px] text-slate-500 font-semibold leading-tight tracking-wide">
                        {s.label}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex items-center gap-3 text-[11px] font-semibold text-slate-500">
                  <ShieldCheck size={14} className="text-[#A89048] shrink-0" />
                  <span>Dados criptografados · LGPD-compliant · Sem fidelidade</span>
                </div>
              </div>
            </div>

            {/* ── Right — Login Form ───────────────────────────────── */}
            <div className="flex items-center justify-center">
              <div className="w-full max-w-md border border-white/[0.08] bg-[#111111] shadow-[0_20px_60px_rgba(0,0,0,0.6)] rounded-[2rem] overflow-hidden">
                <div className="p-8 md:p-12">

                  {/* Mobile logo (Onda 17.32.96: com bolinha dourada) */}
                  <div className="mb-8 flex flex-col items-center justify-center lg:hidden">
                    <div className="inline-flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-[#A89048] shadow-[0_0_10px_rgba(168,144,72,0.7)]" />
                      <h2 className="text-xl font-black uppercase tracking-tight text-[#A89048]">
                        Odonto System
                      </h2>
                    </div>
                  </div>

                  {/* Heading */}
                  <div className="mb-9 text-center lg:text-left">
                    <h2 className="text-3xl font-black text-white uppercase tracking-tight">
                      Bem-vindo de volta
                    </h2>
                    <div className="w-12 h-1 bg-[#A89048] mt-3 mb-4 rounded-full mx-auto lg:mx-0 shadow-[0_0_10px_rgba(168,144,72,0.5)]" />
                    <p className="text-slate-400 font-medium text-sm">Acesse seu painel com segurança</p>
                  </div>

                  {/* Session expired banner */}
                  {sessionMsg && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="mb-6"
                    >
                      <div className="flex items-center gap-3 rounded-xl bg-amber-500/10 border border-amber-500/20 p-4 text-sm text-amber-400 font-medium">
                        <AlertCircle className="h-5 w-5 flex-shrink-0" />
                        {sessionMsg}
                      </div>
                    </motion.div>
                  )}

                  {/* Error banner — Onda 17.32.89:
                    Removido o "Modo de Demonstração (Bypass)" que dava
                    pra QUALQUER UM entrar sem senha apos errar a senha.
                    Era furo de seguranca grave em SaaS comercial. */}
                  {error && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="mb-6"
                    >
                      <div className="flex items-center gap-3 rounded-xl bg-red-500/10 border border-red-500/20 p-4 text-sm text-red-400 font-medium">
                        <AlertCircle className="h-5 w-5 flex-shrink-0" />
                        {error}
                      </div>
                    </motion.div>
                  )}

                  <form onSubmit={handleSubmit} className="space-y-6">
                    {/* Email */}
                    <div className="space-y-2">
                      <label className="text-[11px] font-black uppercase tracking-widest text-[#A89048] ml-1">
                        E-mail
                      </label>
                      <div className="relative">
                        <Mail className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500 pointer-events-none" />
                        <input
                          autoComplete="email"
                          type="email"
                          placeholder="seu@email.com"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          required
                          className="w-full h-14 pl-11 pr-4 rounded-xl border border-white/10 bg-white/5 text-white placeholder:text-slate-600 outline-none focus:border-[#A89048] focus:ring-2 focus:ring-[#A89048]/20 transition-all text-sm"
                        />
                      </div>
                    </div>

                    {/* Password */}
                    <div className="space-y-2">
                      <label className="text-[11px] font-black uppercase tracking-widest text-[#A89048] ml-1">
                        Senha
                      </label>
                      <div className="relative">
                        <Lock className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500 pointer-events-none" />
                        <input
                          autoComplete="current-password"
                          type={showPassword ? 'text' : 'password'}
                          placeholder="••••••••"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          required
                          className="w-full h-14 pl-11 pr-12 rounded-xl border border-white/10 bg-white/5 text-white placeholder:text-slate-600 outline-none focus:border-[#A89048] focus:ring-2 focus:ring-[#A89048]/20 transition-all text-sm"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 hover:text-[#A89048] transition-colors"
                        >
                          {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                        </button>
                      </div>
                    </div>

                    {/* Remember me + Recover password */}
                    <div className="flex items-center justify-between text-xs font-bold">
                      <label className="flex items-center gap-3 text-slate-400 cursor-pointer group select-none">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={rememberMe}
                          onClick={() => setRememberMe(v => !v)}
                          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none ${
                            rememberMe ? 'bg-[#A89048]' : 'bg-white/10'
                          }`}
                        >
                          <span
                            className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200 ${
                              rememberMe ? 'translate-x-[18px]' : 'translate-x-[3px]'
                            }`}
                          />
                        </button>
                        <span className="group-hover:text-slate-200 transition-colors">Lembrar acesso</span>
                      </label>
                      <button
                        type="button"
                        onClick={() => setError('Funcionalidade em breve')}
                        className="text-[#A89048] hover:text-[#e3c788] uppercase tracking-widest transition-colors"
                      >
                        Recuperar Senha
                      </button>
                    </div>

                    {/* Submit */}
                    <button
                      type="submit"
                      disabled={loading}
                      className="w-full h-14 rounded-xl bg-gradient-to-r from-[#e3c788] via-[#d4b568] to-[#c8aa62] text-[#0A0A0A] font-black uppercase tracking-widest text-sm shadow-[0_10px_30px_rgba(168,144,72,0.2)] hover:shadow-[0_15px_40px_rgba(168,144,72,0.3)] hover:scale-[1.02] transition-all active:scale-95 disabled:opacity-70 disabled:cursor-not-allowed disabled:hover:scale-100"
                    >
                      {loading ? (
                        <span className="flex items-center justify-center gap-2">
                          <svg className="animate-spin h-5 w-5 text-[#0A0A0A]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                          </svg>
                          Entrando...
                        </span>
                      ) : (
                        'Acessar Plataforma'
                      )}
                    </button>
                  </form>

                  {/* Onda 17.32.96 — Divisor "ou" + CTA secundario pra signup.
                    Antes era so texto solto no heading. Agora vira CTA forte
                    pra capturar novos clientes no proprio login. */}
                  <div className="my-6 relative">
                    <div className="absolute inset-0 flex items-center">
                      <div className="w-full border-t border-white/[0.06]" />
                    </div>
                    <div className="relative flex justify-center">
                      <span className="bg-[#111111] px-3 text-[10px] font-bold uppercase tracking-widest text-slate-600">
                        Ainda não tem conta?
                      </span>
                    </div>
                  </div>

                  <a
                    href="/cadastrar"
                    className="flex items-center justify-center gap-2 w-full h-12 rounded-xl border border-[#A89048]/30 bg-[#A89048]/5 hover:bg-[#A89048]/10 hover:border-[#A89048]/50 text-[#A89048] font-bold text-sm transition-all group"
                  >
                    <Sparkles size={14} className="group-hover:rotate-12 transition-transform" />
                    Criar clínica grátis — 14 dias
                    <ArrowRight size={14} className="group-hover:translate-x-1 transition-transform" />
                  </a>

                  {/* DB status */}
                  <div className="flex items-center justify-center gap-2 pt-6 mt-6 border-t border-white/5">
                    <div className={`w-2.5 h-2.5 rounded-full transition-all duration-500 ${
                      dbStatus === 'online'   ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]' :
                      dbStatus === 'offline'  ? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.4)] animate-pulse' :
                                               'bg-amber-500 animate-pulse'
                    }`} />
                    <span className="text-[11px] font-bold uppercase tracking-widest text-slate-600">
                      Banco de Dados:{' '}
                      <span className={dbStatus === 'online' ? 'text-emerald-500/80' : 'text-red-500/80'}>
                        {dbStatus === 'online' ? 'Online' : dbStatus === 'offline' ? 'Offline' : 'Verificando...'}
                      </span>
                    </span>
                  </div>

                </div>
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
