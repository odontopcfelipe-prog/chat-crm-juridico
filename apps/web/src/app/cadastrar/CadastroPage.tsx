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
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Loader2, Building2, User, Mail, Lock, IdCard, Phone, CheckCircle2,
  Sparkles, ArrowRight, Zap, MessageSquare, CreditCard, FileSignature,
  CalendarDays, ShieldCheck, ArrowLeft, Stethoscope, FlaskConical, MapPin,
  PackageCheck, Wallet,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

// Onda 17.32.94 — Info dos planos pra renderizar badge/CTA quando
// o usuario chega via /cadastrar?plan=... (link da landing).
const PLAN_INFO: Record<string, { name: string; price: number; tagline: string }> = {
  STARTER:    { name: 'Starter',    price: 60,  tagline: 'Clínica pequena começando' },
  PRO:        { name: 'Pro',        price: 90,  tagline: 'Clínica em crescimento' },
  ENTERPRISE: { name: 'Enterprise', price: 150, tagline: 'Redes e franquias' },
};

// Caminho escolhido no topo do cadastro. "Laboratório de prótese" ainda não cria
// conta: vira lista de espera (POST /lab-waitlist) até o laboratório abrir.
export type Caminho = 'CLINICA' | 'LABORATORIO';

/** O page.tsx (servidor) lê ?tipo= e passa o caminho inicial, sem piscar o outro. */
export default function SignupPage({ caminhoInicial = 'CLINICA' }: { caminhoInicial?: Caminho }) {
  const router = useRouter();
  const [caminho, setCaminho] = useState<Caminho>(caminhoInicial);
  // Dados clinica
  const [clinicName, setClinicName] = useState('');
  const [cpfCnpj, setCpfCnpj] = useState('');
  const [phone, setPhone] = useState('');
  // Admin
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [plan, setPlan] = useState('STARTER');
  // Onda 17.32.94 — Quando true, esconde o select e mostra banner do
  // plano (usuario veio direto dos cards de planos da /lp).
  const [planFromUrl, setPlanFromUrl] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Onda 17.32.93 — Pre-seleciona o plano via query param ?plan=...
  // Acessado a partir dos cards de plano da landing /lp.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('plan');
    if (!raw) return;
    const normalized = raw.toUpperCase();
    if (normalized === 'STARTER' || normalized === 'PRO' || normalized === 'ENTERPRISE') {
      setPlan(normalized);
      setPlanFromUrl(true);
    }
  }, []);

  const planInfo = PLAN_INFO[plan] ?? PLAN_INFO.STARTER;
  const laboratorio = caminho === 'LABORATORIO';

  // Troca o caminho e deixa o link compartilhável (/cadastrar?tipo=laboratorio).
  const escolherCaminho = (c: Caminho) => {
    setCaminho(c);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (c === 'LABORATORIO') url.searchParams.set('tipo', 'laboratorio');
    else url.searchParams.delete('tipo');
    window.history.replaceState(null, '', url.toString());
  };

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
      // 1. Cria tenant + admin via signup publico. Captura trial_ends_at
      // pra mostrar a data exata no toast de boas-vindas.
      const signupResp = await api.post<{ id: string; trial_ends_at: string | null; name: string }>('/signup', {
        clinic_name: clinicName,
        cpf_cnpj: cpfCnpj || undefined,
        phone: phone || undefined,
        admin_name: adminName,
        admin_email: adminEmail,
        admin_password: adminPassword,
        plan,
      });
      const trialEnds = signupResp.data?.trial_ends_at
        ? new Date(signupResp.data.trial_ends_at)
        : null;
      // 2. Faz login automatico pra entrar no sistema ja autenticado
      const loginResp = await api.post<{ access_token: string }>('/auth/login', {
        email: adminEmail.toLowerCase().trim(),
        password: adminPassword,
      });
      if (loginResp.data?.access_token) {
        localStorage.setItem('token', loginResp.data.access_token);
      }
      const trialMsg = trialEnds
        ? `Trial liberado até ${trialEnds.toLocaleDateString('pt-BR')}.`
        : 'Trial de 14 dias iniciado.';
      showSuccess(`Bem-vindo(a) ao ${clinicName}! ${trialMsg}`);
      router.push('/atendimento/dashboard');
    } catch (err: any) {
      const msg = err?.response?.data?.message || 'Erro no cadastro';
      showError(typeof msg === 'string' ? msg : (Array.isArray(msg) ? msg.join(', ') : 'Erro'));
    } finally {
      setSubmitting(false);
    }
  };

  // Onda 17.32.95 — Layout reformulado pra ficar com cara de SaaS
  // profissional: split de 2 colunas, branding + trust signals na
  // esquerda, form no card limpo a direita.
  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-50 via-white to-emerald-50/40 dark:from-violet-950/20 dark:via-background dark:to-emerald-950/10">
      {/* Glow de fundo */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-violet-500/10 blur-[120px] pointer-events-none -z-0" />

      <div className="relative z-10 min-h-screen flex flex-col lg:flex-row">
        {/* ─── Coluna esquerda — Branding + benefícios ─── */}
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
          <div
            className="absolute -top-32 -left-32 w-[400px] h-[400px] rounded-full bg-emerald-400/20 blur-[100px] pointer-events-none"
          />

          {/* Logo + tagline topo (link pra home — agora /) */}
          <div className="relative z-10">
            <Link href="/" className="inline-flex items-center gap-2.5 mb-12 group">
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.6)] group-hover:scale-110 transition-transform" />
              <span className="text-base font-black uppercase tracking-tight group-hover:text-emerald-300 transition-colors">Odonto System</span>
            </Link>

            <div className="inline-flex items-center gap-2 bg-white/10 border border-white/20 rounded-full px-3 py-1 text-[11px] font-bold mb-5 backdrop-blur-sm">
              <Sparkles size={11} />
              {laboratorio ? 'Em breve · lista de espera aberta' : '14 dias grátis · sem cartão'}
            </div>

            {laboratorio ? (
              <>
                <h1 className="text-4xl xl:text-5xl font-black leading-[1.1] mb-5 tracking-tight">
                  Seu laboratório online,{' '}
                  <span className="text-emerald-300">em breve.</span>
                </h1>

                <p className="text-base text-violet-100/80 leading-relaxed mb-8 max-w-md">
                  Dentistas clientes, trabalhos, WhatsApp e cobrança —
                  o mesmo sistema das clínicas, feito para o laboratório de prótese.
                </p>
              </>
            ) : (
              <>
                <h1 className="text-4xl xl:text-5xl font-black leading-[1.1] mb-5 tracking-tight">
                  Sua clínica online em{' '}
                  <span className="text-emerald-300">1 minuto.</span>
                </h1>

                <p className="text-base text-violet-100/80 leading-relaxed mb-8 max-w-md">
                  Pacientes, agenda, WhatsApp, cobrança Asaas, contratos digitais —
                  tudo num lugar, na mão da sua equipe.
                </p>
              </>
            )}

            {/* Benefícios */}
            <div className="space-y-3.5">
              {(laboratorio ? [
                { Icon: MessageSquare, label: 'WhatsApp com os dentistas clientes' },
                { Icon: PackageCheck,  label: 'Trabalhos, provas e entregas' },
                { Icon: CreditCard,    label: 'Cobrança Asaas (PIX/boleto/cartão)' },
                { Icon: Wallet,        label: 'Caixa, financeiro e boletos' },
              ] : [
                { Icon: MessageSquare, label: 'WhatsApp + IA pra atendimento' },
                { Icon: CreditCard,    label: 'Cobrança Asaas (PIX/boleto/cartão)' },
                { Icon: FileSignature, label: 'Contratos com ClickSign' },
                { Icon: CalendarDays,  label: 'Agenda + prontuário completo' },
              ]).map(({ Icon, label }) => (
                <div key={label} className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-white/10 border border-white/15 flex items-center justify-center shrink-0">
                    <Icon size={14} className="text-emerald-300" />
                  </div>
                  <span className="text-sm font-medium text-violet-50">{label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Trust signals embaixo */}
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
          {/* Onda 17.32.99 — Botao "Voltar pra home" no topo, visivel
            em desktop e mobile. Antes so o logo era clicavel e nao era
            obvio. Agora qualquer um sabe como sair. */}
          <div className="flex items-center justify-between mb-6 lg:mb-0">
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 text-xs font-bold text-muted-foreground hover:text-violet-700 transition-colors group"
            >
              <ArrowLeft size={14} className="group-hover:-translate-x-0.5 transition-transform" />
              Voltar pra home
            </Link>
            <Link
              href="/atendimento/login"
              className="text-xs font-bold text-muted-foreground hover:text-violet-700 transition-colors"
            >
              Já tenho conta →
            </Link>
          </div>

          <div className="flex-1 flex items-center justify-center">
            <div className="w-full max-w-xl">
              {/* Header do form (mobile mostra logo aqui) */}
              <div className="lg:hidden text-center mb-6">
                <Link href="/" className="inline-flex items-center gap-2 mb-3">
                  <div className="w-2 h-2 rounded-full bg-violet-600" />
                  <span className="text-sm font-black uppercase tracking-tight text-foreground">Odonto System</span>
                </Link>
                <div className="inline-flex items-center gap-2 bg-violet-500/10 border border-violet-500/30 rounded-full px-3 py-1 text-[11px] font-bold text-violet-700">
                  <Sparkles size={11} />
                  {laboratorio ? 'Em breve · lista de espera aberta' : '14 dias grátis · sem cartão'}
                </div>
              </div>

            <EscolhaDoCaminho caminho={caminho} onEscolher={escolherCaminho} />

            <div className="mb-7">
              {laboratorio ? (
                <>
                  <h2 className="text-2xl sm:text-[28px] font-extrabold text-foreground tracking-tight">
                    Laboratório de prótese
                  </h2>
                  <p className="text-sm text-muted-foreground mt-1.5">
                    Estamos preparando o sistema para laboratórios. Deixe seu contato e você é dos primeiros a entrar.
                  </p>
                </>
              ) : (
                <>
                  <h2 className="text-2xl sm:text-[28px] font-extrabold text-foreground tracking-tight">
                    Crie sua conta
                  </h2>
                  <p className="text-sm text-muted-foreground mt-1.5">
                    Leva menos de 1 minuto. Comece a usar agora mesmo.
                  </p>
                </>
              )}
            </div>

            {/* Os dois ficam montados: trocar de caminho e voltar não apaga o que foi digitado. */}
            <div hidden={!laboratorio}>
              <ListaEsperaLaboratorio />
            </div>
            <div hidden={laboratorio}>
            <form
              onSubmit={handleSubmit}
              className="bg-card border border-border/70 rounded-2xl shadow-[0_24px_60px_-12px_rgba(0,0,0,0.12)] overflow-hidden"
            >
              {/* Plano selecionado (banner top do card) */}
              {planFromUrl && (
                <div className="px-6 py-3.5 bg-gradient-to-r from-violet-500/10 via-violet-500/8 to-emerald-500/8 border-b border-violet-500/20 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-8 h-8 rounded-lg bg-violet-600 text-white flex items-center justify-center shrink-0">
                      <Zap size={15} />
                    </div>
                    <div className="min-w-0">
                      <div className="text-[11px] uppercase tracking-wider font-bold text-violet-700">Plano escolhido</div>
                      <div className="text-sm font-bold text-foreground truncate">
                        {planInfo.name}
                        <span className="text-violet-700 ml-1.5">R$ {planInfo.price}</span>
                        <span className="text-xs font-medium text-muted-foreground">/mês</span>
                        <span className="text-xs font-normal text-muted-foreground ml-2 hidden sm:inline">
                          · {planInfo.tagline}
                        </span>
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPlanFromUrl(false)}
                    className="text-[11px] font-bold text-violet-700 hover:text-violet-900 hover:underline shrink-0"
                  >
                    Trocar
                  </button>
                </div>
              )}

              {/* Seção 1: Clínica */}
              <div className="p-6 sm:p-7 border-b border-border/60">
                <div className="flex items-center gap-2 mb-4">
                  <span className="w-6 h-6 rounded-full bg-violet-600 text-white text-[11px] font-bold flex items-center justify-center">1</span>
                  <h3 className="text-sm font-bold text-foreground">Sua clínica</h3>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <div className="sm:col-span-2">
                    <FormField
                      Icon={Building2}
                      label="Nome da clínica *"
                      value={clinicName}
                      onChange={setClinicName}
                      placeholder="Clínica Odontológica Sorriso"
                      required
                    />
                  </div>
                  <FormField
                    Icon={IdCard}
                    label="CPF/CNPJ"
                    value={cpfCnpj}
                    onChange={setCpfCnpj}
                    placeholder="11.222.333/0001-44"
                  />
                  <FormField
                    Icon={Phone}
                    label="WhatsApp"
                    value={phone}
                    onChange={setPhone}
                    placeholder="5582999999999"
                  />
                  {!planFromUrl && (
                    <div className="sm:col-span-2">
                      <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5 flex items-center gap-1">
                        <Zap size={10} />
                        Plano inicial
                      </label>
                      <select
                        value={plan}
                        onChange={(e) => setPlan(e.target.value)}
                        className="w-full px-3.5 py-3 text-sm border border-border rounded-xl bg-background focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500/50 transition-colors"
                      >
                        <option value="STARTER">Starter — R$ 60/mês (até 300 pacientes)</option>
                        <option value="PRO">Pro — R$ 90/mês (até 3000 pacientes)</option>
                        <option value="ENTERPRISE">Enterprise — R$ 150/mês (ilimitado)</option>
                      </select>
                      <p className="text-[11px] text-muted-foreground mt-1.5">
                        Trial não cobra. Você pode mudar de plano depois.
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* Seção 2: Admin */}
              <div className="p-6 sm:p-7 border-b border-border/60">
                <div className="flex items-center gap-2 mb-4">
                  <span className="w-6 h-6 rounded-full bg-violet-600 text-white text-[11px] font-bold flex items-center justify-center">2</span>
                  <h3 className="text-sm font-bold text-foreground">Seu acesso</h3>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
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
                    label="E-mail *"
                    type="email"
                    value={adminEmail}
                    onChange={setAdminEmail}
                    placeholder="seu@email.com"
                    required
                  />
                  <div className="sm:col-span-2">
                    <FormField
                      Icon={Lock}
                      label="Senha * (mínimo 6 caracteres)"
                      type="password"
                      value={adminPassword}
                      onChange={setAdminPassword}
                      placeholder="••••••••"
                      required
                    />
                  </div>
                </div>
                <label className="flex items-start gap-2.5 mt-4 text-xs text-muted-foreground cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={accepted}
                    onChange={(e) => setAccepted(e.target.checked)}
                    className="mt-0.5 shrink-0 w-4 h-4 accent-violet-600 cursor-pointer"
                  />
                  <span>
                    Aceito os{' '}
                    <Link href="/termos" className="text-violet-700 font-semibold hover:underline">
                      termos de uso
                    </Link>{' '}
                    e a{' '}
                    <Link href="/privacidade" className="text-violet-700 font-semibold hover:underline">
                      política de privacidade
                    </Link>
                    .
                  </span>
                </label>
              </div>

              {/* CTA */}
              <div className="p-6 sm:p-7 bg-gradient-to-br from-violet-50 to-emerald-50/50 dark:from-violet-950/30 dark:to-emerald-950/20">
                <button
                  type="submit"
                  disabled={submitting || !accepted}
                  className="w-full h-12 sm:h-13 rounded-xl bg-violet-600 hover:bg-violet-700 active:bg-violet-800 text-white text-[15px] font-bold inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-[0_8px_24px_-4px_rgba(124,58,237,0.4)] hover:shadow-[0_12px_32px_-4px_rgba(124,58,237,0.5)] hover:-translate-y-0.5 disabled:transform-none disabled:shadow-none"
                >
                  {submitting ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      Criando sua clínica...
                    </>
                  ) : (
                    <>
                      Começar 14 dias grátis no {planInfo.name}
                      <ArrowRight size={16} />
                    </>
                  )}
                </button>
                <p className="text-[11px] text-center text-muted-foreground mt-3 flex items-center justify-center gap-1.5">
                  <CheckCircle2 size={11} className="text-emerald-600" />
                  Sem cartão · sem fidelidade · cancele quando quiser
                </p>
              </div>
            </form>
            </div>

              {/* Login link */}
              <p className="text-center text-xs text-muted-foreground mt-6">
                Já tem conta?{' '}
                <Link href="/atendimento/login" className="text-violet-700 font-bold hover:underline">
                  Entrar
                </Link>
              </p>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

const CAMINHOS: { valor: Caminho; Icon: any; titulo: string; sub: string; selo?: string }[] = [
  { valor: 'CLINICA', Icon: Stethoscope, titulo: 'Clínica odontológica', sub: 'Pacientes, agenda e tratamentos' },
  { valor: 'LABORATORIO', Icon: FlaskConical, titulo: 'Laboratório de prótese', sub: 'Dentistas clientes e trabalhos', selo: 'Em breve' },
];

function EscolhaDoCaminho({ caminho, onEscolher }: { caminho: Caminho; onEscolher: (c: Caminho) => void }) {
  return (
    <div className="mb-6">
      <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">
        O que você vai cadastrar?
      </p>
      <div role="radiogroup" aria-label="O que você vai cadastrar?" className="grid grid-cols-2 gap-2.5">
        {CAMINHOS.map(({ valor, Icon, titulo, sub, selo }) => {
          const ativo = caminho === valor;
          return (
            <button
              key={valor}
              type="button"
              role="radio"
              aria-checked={ativo}
              onClick={() => onEscolher(valor)}
              className={`text-left rounded-xl border px-3.5 py-3 transition-colors ${
                ativo
                  ? 'border-violet-500 bg-violet-500/10 ring-2 ring-violet-500/25'
                  : 'border-border bg-card hover:border-violet-300'
              }`}
            >
              <div className="flex items-center gap-2">
                <div
                  className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                    ativo ? 'bg-violet-600 text-white' : 'bg-violet-500/10 text-violet-600'
                  }`}
                >
                  <Icon size={14} />
                </div>
                <span className="text-sm font-bold text-foreground leading-tight">{titulo}</span>
              </div>
              <p className="text-[11px] text-muted-foreground mt-1.5 leading-snug">
                {sub}
                {selo && (
                  <span className="ml-1.5 inline-block align-middle text-[9px] font-bold uppercase tracking-wide text-emerald-700 bg-emerald-500/10 border border-emerald-500/30 rounded-full px-1.5 py-px">
                    {selo}
                  </span>
                )}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Caminho "Laboratório de prótese": ainda não cria conta, só entra na lista de espera. */
function ListaEsperaLaboratorio() {
  const [labName, setLabName] = useState('');
  const [contactName, setContactName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [city, setCity] = useState('');
  // Campo escondido: gente não vê nem preenche; robô preenche e é ignorado no servidor.
  const [website, setWebsite] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [pronto, setPronto] = useState(false);

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (phone.replace(/\D/g, '').length < 10) {
      showError('Informe o WhatsApp com DDD');
      return;
    }
    setEnviando(true);
    try {
      await api.post('/lab-waitlist', {
        lab_name: labName,
        contact_name: contactName,
        phone,
        email: email.trim() || undefined,
        city: city.trim() || undefined,
        website: website || undefined,
      });
      setPronto(true);
    } catch (err: any) {
      const msg = err?.response?.status === 429
        ? 'Muitas tentativas. Espere um minuto e tente de novo.'
        : err?.response?.data?.message || 'Não foi possível enviar agora. Tente de novo.';
      showError(typeof msg === 'string' ? msg : (Array.isArray(msg) ? msg.join(', ') : 'Erro'));
    } finally {
      setEnviando(false);
    }
  };

  if (pronto) {
    return (
      <div className="bg-card border border-border/70 rounded-2xl shadow-[0_24px_60px_-12px_rgba(0,0,0,0.12)] p-7 sm:p-8 text-center">
        <div className="w-12 h-12 rounded-full bg-emerald-500/15 text-emerald-600 flex items-center justify-center mx-auto mb-4">
          <CheckCircle2 size={24} />
        </div>
        <h3 className="text-lg font-extrabold text-foreground">Você está na lista!</h3>
        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
          Recebemos o contato do <b className="text-foreground">{labName.trim()}</b>. Quando o sistema para
          laboratórios abrir, chamamos você no WhatsApp informado.
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 mt-6 text-sm font-bold text-violet-700 hover:underline"
        >
          <ArrowLeft size={14} />
          Voltar pra home
        </Link>
      </div>
    );
  }

  return (
    <form
      onSubmit={enviar}
      className="bg-card border border-border/70 rounded-2xl shadow-[0_24px_60px_-12px_rgba(0,0,0,0.12)] overflow-hidden"
    >
      <div className="p-6 sm:p-7 border-b border-border/60">
        <div className="flex items-center gap-2 mb-4">
          <span className="w-6 h-6 rounded-full bg-violet-600 text-white text-[11px] font-bold flex items-center justify-center">1</span>
          <h3 className="text-sm font-bold text-foreground">Seu laboratório</h3>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <div className="sm:col-span-2">
            <FormField
              Icon={FlaskConical}
              label="Nome do laboratório *"
              value={labName}
              onChange={setLabName}
              placeholder="Laboratório de Prótese Sorriso"
              required
            />
          </div>
          <FormField
            Icon={User}
            label="Seu nome *"
            value={contactName}
            onChange={setContactName}
            placeholder="Fulano de Tal"
            required
          />
          <FormField
            Icon={Phone}
            label="WhatsApp *"
            value={phone}
            onChange={setPhone}
            placeholder="(82) 99999-9999"
            required
          />
          <FormField
            Icon={Mail}
            label="E-mail"
            type="email"
            value={email}
            onChange={setEmail}
            placeholder="seu@email.com"
          />
          <FormField
            Icon={MapPin}
            label="Cidade"
            value={city}
            onChange={setCity}
            placeholder="Maceió - AL"
          />
        </div>
        <div aria-hidden="true" className="absolute -left-[9999px] w-px h-px overflow-hidden">
          <label>
            Site
            <input
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </label>
        </div>
      </div>

      <div className="p-6 sm:p-7 bg-gradient-to-br from-violet-50 to-emerald-50/50 dark:from-violet-950/30 dark:to-emerald-950/20">
        <button
          type="submit"
          disabled={enviando}
          className="w-full h-12 sm:h-13 rounded-xl bg-violet-600 hover:bg-violet-700 active:bg-violet-800 text-white text-[15px] font-bold inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-[0_8px_24px_-4px_rgba(124,58,237,0.4)] hover:shadow-[0_12px_32px_-4px_rgba(124,58,237,0.5)] hover:-translate-y-0.5 disabled:transform-none disabled:shadow-none"
        >
          {enviando ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              Enviando...
            </>
          ) : (
            <>
              Entrar na lista de espera
              <ArrowRight size={16} />
            </>
          )}
        </button>
        <p className="text-[11px] text-center text-muted-foreground mt-3 flex items-center justify-center gap-1.5">
          <CheckCircle2 size={11} className="text-emerald-600" />
          Sem compromisso · usamos seu contato só para avisar da abertura
        </p>
      </div>
    </form>
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
      <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5 flex items-center gap-1.5">
        <Icon size={11} className="text-violet-500" />
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        placeholder={placeholder}
        className="w-full h-11 px-3.5 text-sm border border-border rounded-xl bg-background placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500/50 transition-colors"
      />
    </div>
  );
}
