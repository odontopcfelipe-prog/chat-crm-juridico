'use client';

/**
 * Onda 17.32.85 — Signup publico de nova clinica (SaaS).
 *
 * Pagina aberta — usuario novo entra aqui, cadastra a clinica + admin
 * e ja inicia trial de 14 dias. Apos cadastro, faz login automatico
 * e redireciona pro /atendimento/dashboard.
 *
 * SEO: pode ser linkada de landing page externa pra captacao.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Loader2, Building2, User, Mail, Lock, IdCard, Phone, CheckCircle2,
  Sparkles, ArrowRight,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

export default function SignupPage() {
  const router = useRouter();
  // Dados clinica
  const [clinicName, setClinicName] = useState('');
  const [cpfCnpj, setCpfCnpj] = useState('');
  const [phone, setPhone] = useState('');
  // Admin
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [plan, setPlan] = useState('STARTER');
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accepted) {
      showError('Aceite os termos pra continuar');
      return;
    }
    if (adminPassword.length < 6) {
      showError('Senha precisa ter ao menos 6 caracteres');
      return;
    }
    setSubmitting(true);
    try {
      // 1. Cria tenant + admin via signup publico
      await api.post('/signup', {
        clinic_name: clinicName,
        cpf_cnpj: cpfCnpj || undefined,
        phone: phone || undefined,
        admin_name: adminName,
        admin_email: adminEmail,
        admin_password: adminPassword,
        plan,
      });
      // 2. Faz login automatico pra entrar no sistema ja autenticado
      const loginResp = await api.post<{ access_token: string }>('/auth/login', {
        email: adminEmail.toLowerCase().trim(),
        password: adminPassword,
      });
      if (loginResp.data?.access_token) {
        localStorage.setItem('token', loginResp.data.access_token);
      }
      showSuccess(`Bem-vindo(a) ao ${clinicName}! Trial de 14 dias iniciado.`);
      router.push('/atendimento/dashboard');
    } catch (err: any) {
      const msg = err?.response?.data?.message || 'Erro no cadastro';
      showError(typeof msg === 'string' ? msg : (Array.isArray(msg) ? msg.join(', ') : 'Erro'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-violet-500/5 via-background to-emerald-500/5">
      <div className="w-full max-w-2xl">
        {/* Hero */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center gap-2 bg-violet-500/10 border border-violet-500/30 rounded-full px-3 py-1 text-[11px] font-bold text-violet-700 mb-3">
            <Sparkles size={11} />
            14 dias grátis · sem cartão
          </div>
          <h1 className="text-3xl font-extrabold text-foreground">Crie sua clínica em 1 minuto</h1>
          <p className="text-sm text-muted-foreground mt-1">
            WhatsApp, prontuário, financeiro e cobrança Asaas tudo no mesmo lugar.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-card border border-border rounded-2xl shadow-xl overflow-hidden"
        >
          {/* Sessao 1: Clinica */}
          <div className="p-6 border-b border-border">
            <h2 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
              <Building2 size={14} className="text-violet-600" />
              Dados da clínica
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormField
                Icon={Building2}
                label="Nome da clínica *"
                value={clinicName}
                onChange={setClinicName}
                placeholder="Clínica Odontológica Sorriso"
                required
              />
              <FormField
                Icon={IdCard}
                label="CPF/CNPJ"
                value={cpfCnpj}
                onChange={setCpfCnpj}
                placeholder="11.222.333/0001-44"
              />
              <FormField
                Icon={Phone}
                label="Telefone (WhatsApp)"
                value={phone}
                onChange={setPhone}
                placeholder="5582999999999"
              />
              <div>
                <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1 block">
                  Plano inicial
                </label>
                <select
                  value={plan}
                  onChange={(e) => setPlan(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-violet-500/30"
                >
                  <option value="STARTER">Starter (até 300 pacientes)</option>
                  <option value="PRO">Pro (até 3000 pacientes)</option>
                  <option value="ENTERPRISE">Enterprise (ilimitado)</option>
                </select>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Você pode mudar depois. Trial não cobra.
                </p>
              </div>
            </div>
          </div>

          {/* Sessao 2: Admin */}
          <div className="p-6 border-b border-border">
            <h2 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
              <User size={14} className="text-violet-600" />
              Seus dados de administrador
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormField
                Icon={User}
                label="Seu nome *"
                value={adminName}
                onChange={setAdminName}
                placeholder="Dr(a). Fulano de Tal"
                required
              />
              <FormField
                Icon={Mail}
                label="Email *"
                type="email"
                value={adminEmail}
                onChange={setAdminEmail}
                placeholder="admin@clinica.com.br"
                required
              />
              <FormField
                Icon={Lock}
                label="Senha *"
                type="password"
                value={adminPassword}
                onChange={setAdminPassword}
                placeholder="Mínimo 6 caracteres"
                required
              />
            </div>
            <label className="flex items-start gap-2 mt-3 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
                className="mt-0.5 shrink-0"
              />
              Aceito os <Link href="/termos" className="text-violet-700 hover:underline">termos de uso</Link> e a{' '}
              <Link href="/privacidade" className="text-violet-700 hover:underline">política de privacidade</Link>
            </label>
          </div>

          {/* Footer / CTA */}
          <div className="p-6 bg-muted/30">
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-center">
              <p className="text-xs text-muted-foreground inline-flex items-start gap-1.5">
                <CheckCircle2 size={11} className="shrink-0 mt-0.5 text-emerald-600" />
                <span>
                  14 dias grátis sem cartão. Após o trial, você escolhe plano e
                  forma de pagamento.
                </span>
              </p>
              <button
                type="submit"
                disabled={submitting || !accepted}
                className="text-sm font-bold px-5 py-3 rounded-lg bg-violet-600 hover:bg-violet-700 text-white inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {submitting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Criando sua clínica...
                  </>
                ) : (
                  <>
                    Começar grátis
                    <ArrowRight size={14} />
                  </>
                )}
              </button>
            </div>
            <p className="text-[11px] text-center text-muted-foreground mt-4">
              Já tem conta?{' '}
              <Link href="/atendimento/login" className="text-violet-700 font-semibold hover:underline">
                Faça login
              </Link>
            </p>
          </div>
        </form>
      </div>
    </div>
  );
}

function FormField({
  Icon, label, value, onChange, placeholder, type = 'text', required,
}: {
  Icon: any;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1 flex items-center gap-1">
        <Icon size={10} />
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        placeholder={placeholder}
        className="w-full px-3 py-2.5 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-violet-500/30"
      />
    </div>
  );
}
