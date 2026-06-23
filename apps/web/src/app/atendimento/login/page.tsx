'use client';

/**
 * Onda 17.32.97 — Login com mesma identidade visual do /cadastrar
 * (split layout violet+emerald, tema claro a direita, branding dark
 * a esquerda). Substituiu o tema dark dourado anterior pra manter
 * consistencia de marca em toda a entrada do SaaS.
 */
import { useState, FormEvent, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Mail, Lock, AlertCircle, Eye, EyeOff,
  MessageSquare, CreditCard, FileSignature, CalendarDays,
  ShieldCheck, ArrowRight, Sparkles, Loader2, ArrowLeft,
} from 'lucide-react';
import api, { API_BASE_URL, clearSessionTraces } from '@/lib/api';

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
    const interval = setInterval(checkDb, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api.post('/auth/login', { email, password });
      // Onda 17.61 — limpa rastros locais de QUALQUER sessão anterior nesta máquina
      // (recados/tarefas/rascunhos/filtros) antes de entrar com a nova conta.
      clearSessionTraces();
      localStorage.setItem('token', res.data.access_token);
      if (rememberMe) {
        localStorage.setItem('remembered_email', email);
      } else {
        localStorage.removeItem('remembered_email');
      }
      // Onda 17.50 — Apos login, cai na home "Inicio" (baloes por papel),
      // que e a porta de entrada unica do sistema (antes ia direto pro
      // WhatsApp). O layout tambem redireciona login->dashboard quando ja
      // logado; manter os dois alinhados na mesma rota.
      router.push('/atendimento/dashboard');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      setError(e.response?.data?.message || 'Credenciais inválidas');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-50 via-white to-emerald-50/40 dark:from-violet-950/20 dark:via-background dark:to-emerald-950/10">
      {/* Glow de fundo */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-violet-500/10 blur-[120px] pointer-events-none -z-0" />

      <div className="relative z-10 min-h-screen flex flex-col lg:flex-row">
        {/* ─── Coluna esquerda — Branding violet ─── */}
        <aside className="hidden lg:flex lg:w-[42%] xl:w-[40%] flex-col justify-between p-12 xl:p-16 bg-gradient-to-br from-violet-600 via-violet-700 to-violet-900 text-white relative overflow-hidden">
          {/* Padrão decorativo */}
          <div
            className="absolute inset-0 opacity-[0.05] pointer-events-none"
            style={{
              backgroundImage:
                'radial-gradient(circle at 1px 1px, white 1px, transparent 0)',
              backgroundSize: '24px 24px',
            }}
          />
          <div className="absolute -top-32 -left-32 w-[400px] h-[400px] rounded-full bg-emerald-400/20 blur-[100px] pointer-events-none" />

          {/* Topo — link logo aponta pra home / (era /lp) */}
          <div className="relative z-10">
            <Link href="/" className="inline-flex items-center gap-2.5 mb-12 group">
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.6)] group-hover:scale-110 transition-transform" />
              <span className="text-base font-black uppercase tracking-tight group-hover:text-emerald-300 transition-colors">Odonto System</span>
            </Link>

            <div className="inline-flex items-center gap-2 bg-white/10 border border-white/20 rounded-full px-3 py-1 text-[11px] font-bold mb-5 backdrop-blur-sm">
              <Sparkles size={11} />
              Sistema completo · 24/7 online
            </div>

            <h1 className="text-4xl xl:text-5xl font-black leading-[1.1] mb-5 tracking-tight">
              Bem-vindo{' '}
              <span className="text-emerald-300">de volta.</span>
            </h1>

            <p className="text-base text-violet-100/80 leading-relaxed mb-8 max-w-md">
              Sua plataforma de gestão odontológica completa.
              Pacientes, agenda, WhatsApp, cobrança e contratos — num lugar só.
            </p>

            {/* Benefícios */}
            <div className="space-y-3.5">
              {[
                { Icon: MessageSquare, label: 'WhatsApp + IA pra atendimento' },
                { Icon: CreditCard,    label: 'Cobrança Asaas (PIX/boleto/cartão)' },
                { Icon: FileSignature, label: 'Contratos com ClickSign' },
                { Icon: CalendarDays,  label: 'Agenda + prontuário completo' },
              ].map(({ Icon, label }) => (
                <div key={label} className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-white/10 border border-white/15 flex items-center justify-center shrink-0">
                    <Icon size={14} className="text-emerald-300" />
                  </div>
                  <span className="text-sm font-medium text-violet-50">{label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Stats + trust embaixo */}
          <div className="relative z-10 mt-12">
            <div className="grid grid-cols-3 gap-4 mb-6 pb-6 border-b border-white/10">
              {[
                { num: '+10', label: 'Anos no mercado' },
                { num: '98%',  label: 'Satisfação' },
                { num: '24/7', label: 'Sistema online' },
              ].map((s) => (
                <div key={s.label}>
                  <div className="text-2xl font-black text-emerald-300 leading-none mb-1">
                    {s.num}
                  </div>
                  <div className="text-[11px] text-violet-200/70 font-medium leading-tight">
                    {s.label}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-3 text-[11px] font-semibold text-violet-100/70">
              <ShieldCheck size={14} className="text-emerald-300 shrink-0" />
              <span>Dados criptografados · LGPD-compliant · Sem fidelidade</span>
            </div>
          </div>
        </aside>

        {/* ─── Coluna direita — Form ─── */}
        <main className="flex-1 flex flex-col p-4 sm:p-8 lg:p-12">
          {/* Onda 17.32.99 — Botoes de navegacao no topo */}
          <div className="flex items-center justify-between mb-6 lg:mb-0">
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 text-xs font-bold text-muted-foreground hover:text-violet-700 transition-colors group"
            >
              <ArrowLeft size={14} className="group-hover:-translate-x-0.5 transition-transform" />
              Voltar pra home
            </Link>
            <Link
              href="/cadastrar"
              className="text-xs font-bold text-muted-foreground hover:text-violet-700 transition-colors"
            >
              Criar conta →
            </Link>
          </div>

          <div className="flex-1 flex items-center justify-center">
            <div className="w-full max-w-md">
              {/* Logo mobile */}
              <div className="lg:hidden text-center mb-6">
                <Link href="/" className="inline-flex items-center gap-2 mb-3">
                  <div className="w-2 h-2 rounded-full bg-violet-600" />
                  <span className="text-sm font-black uppercase tracking-tight text-foreground">Odonto System</span>
                </Link>
                <div className="inline-flex items-center gap-2 bg-violet-500/10 border border-violet-500/30 rounded-full px-3 py-1 text-[11px] font-bold text-violet-700">
                  <Sparkles size={11} />
                  Sistema completo · 24/7
                </div>
              </div>

            <div className="mb-7">
              <h2 className="text-2xl sm:text-[28px] font-extrabold text-foreground tracking-tight">
                Acessar plataforma
              </h2>
              <p className="text-sm text-muted-foreground mt-1.5">
                Entre com suas credenciais.
              </p>
            </div>

            <div className="bg-card border border-border/70 rounded-2xl shadow-[0_24px_60px_-12px_rgba(0,0,0,0.12)] overflow-hidden">
              {/* Session expired banner */}
              {sessionMsg && (
                <div className="px-6 py-3 bg-amber-500/10 border-b border-amber-500/20 flex items-center gap-3 text-sm text-amber-700 font-medium">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  {sessionMsg}
                </div>
              )}

              {/* Error banner — Onda 17.32.89: removido o "Bypass" que
                deixava qualquer um entrar sem senha. */}
              {error && (
                <div className="px-6 py-3 bg-red-500/10 border-b border-red-500/20 flex items-center gap-3 text-sm text-red-700 font-medium">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="p-6 sm:p-7 space-y-5">
                {/* Email */}
                <div>
                  <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5 flex items-center gap-1.5">
                    <Mail size={11} className="text-violet-500" />
                    E-mail
                  </label>
                  <input
                    autoComplete="email"
                    type="email"
                    placeholder="seu@email.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="w-full h-11 px-3.5 text-sm border border-border rounded-xl bg-background placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500/50 transition-colors"
                  />
                </div>

                {/* Password */}
                <div>
                  <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5 flex items-center gap-1.5">
                    <Lock size={11} className="text-violet-500" />
                    Senha
                  </label>
                  <div className="relative">
                    <input
                      autoComplete="current-password"
                      type={showPassword ? 'text' : 'password'}
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      className="w-full h-11 px-3.5 pr-10 text-sm border border-border rounded-xl bg-background placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500/50 transition-colors"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-violet-600 transition-colors"
                    >
                      {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </div>

                {/* Remember + Forgot */}
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={rememberMe}
                      onClick={() => setRememberMe((v) => !v)}
                      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 ${
                        rememberMe ? 'bg-violet-600' : 'bg-muted-foreground/20'
                      }`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200 ${
                          rememberMe ? 'translate-x-[18px]' : 'translate-x-[3px]'
                        }`}
                      />
                    </button>
                    <span className="font-medium">Lembrar acesso</span>
                  </label>
                  <Link
                    href="/esqueci-senha"
                    className="text-xs font-bold text-violet-700 hover:text-violet-900 hover:underline transition-colors"
                  >
                    Esqueci a senha
                  </Link>
                </div>

                {/* CTA */}
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full h-12 rounded-xl bg-violet-600 hover:bg-violet-700 active:bg-violet-800 text-white text-[15px] font-bold inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-[0_8px_24px_-4px_rgba(124,58,237,0.4)] hover:shadow-[0_12px_32px_-4px_rgba(124,58,237,0.5)] hover:-translate-y-0.5 disabled:transform-none disabled:shadow-none"
                >
                  {loading ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      Entrando...
                    </>
                  ) : (
                    <>
                      Acessar plataforma
                      <ArrowRight size={16} />
                    </>
                  )}
                </button>

                {/* DB status discreto */}
                <div className="flex items-center justify-center gap-2 pt-1">
                  <div className={`w-2 h-2 rounded-full transition-all duration-500 ${
                    dbStatus === 'online'   ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]' :
                    dbStatus === 'offline'  ? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.4)] animate-pulse' :
                                             'bg-amber-500 animate-pulse'
                  }`} />
                  <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    Banco de Dados:{' '}
                    <span className={dbStatus === 'online' ? 'text-emerald-600' : 'text-red-600'}>
                      {dbStatus === 'online' ? 'Online' : dbStatus === 'offline' ? 'Offline' : 'Verificando...'}
                    </span>
                  </span>
                </div>
              </form>
            </div>

            {/* Divisor + CTA secundario pra signup. Antes era so um link
              discreto no heading. Agora vira CTA forte pra capturar visitantes
              novos que caem aqui sem ter conta. */}
            <div className="mt-6 relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center">
                <span className="bg-background px-3 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  Ainda não tem conta?
                </span>
              </div>
            </div>

              <Link
                href="/cadastrar"
                className="mt-4 flex items-center justify-center gap-2 w-full h-12 rounded-xl border-2 border-violet-200 hover:border-violet-400 bg-violet-50/50 hover:bg-violet-50 dark:border-violet-800/50 dark:hover:border-violet-700 dark:bg-violet-950/20 dark:hover:bg-violet-950/30 text-violet-700 dark:text-violet-300 font-bold text-sm transition-all group"
              >
                <Sparkles size={14} className="group-hover:rotate-12 transition-transform" />
                Criar clínica grátis · 14 dias
                <ArrowRight size={14} className="group-hover:translate-x-1 transition-transform" />
              </Link>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
