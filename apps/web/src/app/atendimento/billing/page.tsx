'use client';

/**
 * Onda 17.32.86 — Pagina de billing do tenant (mensalidade SaaS).
 *
 * Mostra plano atual + proximo vencimento + acoes:
 *  - Mudar plano (upgrade/downgrade)
 *  - Mudar forma de pagamento
 *  - Ver historico
 *
 * Quando trial expirando ou suspenso, mostra CTA destacado.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Loader2, CreditCard, Building2, AlertCircle, CheckCircle2, Calendar,
  TrendingUp, Receipt, Shield, ArrowRight, Sparkles, DollarSign,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Plan {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  price_monthly: string | number;
  max_users: number | null;
  max_patients: number | null;
  max_inboxes: number | null;
  max_charges_month: number | null;
  features_json: string | null;
  display_order: number;
}

interface Subscription {
  id: string;
  status: string;
  asaas_subscription_id: string | null;
  next_charge_date: string | null;
  last_paid_at: string | null;
  billing_type: string;
  plan: Plan;
}

interface BillingData {
  tenant: {
    name: string;
    status: string;
    trial_ends_at: string | null;
    cpf_cnpj: string | null;
    email: string | null;
    phone: string | null;
  };
  subscription: Subscription | null;
}

export default function BillingPage() {
  const [billing, setBilling] = useState<BillingData | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkingOut, setCheckingOut] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [bResp, pResp] = await Promise.all([
        api.get<BillingData>('/billing/me'),
        api.get<Plan[]>('/billing/plans'),
      ]);
      setBilling(bResp.data);
      setPlans(pResp.data || []);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Falha ao carregar billing');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCheckout = async (planSlug: string, billingType: 'PIX' | 'BOLETO' | 'CREDIT_CARD') => {
    setCheckingOut(planSlug);
    try {
      const { data } = await api.post('/billing/checkout', { plan_slug: planSlug, billing_type: billingType });
      showSuccess(data?.message || 'Assinatura criada!');
      await load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro no checkout');
    } finally {
      setCheckingOut(null);
    }
  };

  if (loading) {
    return (
      <div className="p-12 flex items-center justify-center text-muted-foreground">
        <Loader2 size={18} className="animate-spin mr-2" />
        Carregando billing...
      </div>
    );
  }

  if (!billing) return null;

  const currentPlan = billing.subscription?.plan;
  const isTrial = billing.tenant.status === 'TRIAL';
  const isSuspended = billing.tenant.status === 'SUSPENDED';
  const trialEnds = billing.tenant.trial_ends_at ? new Date(billing.tenant.trial_ends_at) : null;
  const trialDaysLeft = trialEnds ? Math.max(0, Math.ceil((trialEnds.getTime() - Date.now()) / (1000 * 60 * 60 * 24))) : 0;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-extrabold text-foreground flex items-center gap-2">
          <CreditCard size={22} />
          Assinatura
        </h1>
        <p className="text-sm text-muted-foreground">Gerencie seu plano e forma de pagamento</p>
      </div>

      {/* Banner de status */}
      {isSuspended && (
        <div className="mb-6 bg-red-500/10 border-2 border-red-500/40 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle size={20} className="text-red-700 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-bold text-red-700 mb-1">Conta suspensa</p>
            <p className="text-xs text-red-700">
              Sua conta foi suspensa por inadimplência. Escolha um plano abaixo pra regularizar.
            </p>
          </div>
        </div>
      )}
      {isTrial && (
        <div className="mb-6 bg-amber-500/10 border-2 border-amber-500/40 rounded-xl p-4 flex items-start gap-3">
          <Sparkles size={20} className="text-amber-700 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-bold text-amber-700 mb-1">
              Período de avaliação · {trialDaysLeft} dia{trialDaysLeft !== 1 ? 's' : ''} restante{trialDaysLeft !== 1 ? 's' : ''}
            </p>
            <p className="text-xs text-amber-700">
              Sua avaliação termina em {trialEnds?.toLocaleDateString('pt-BR')}. Escolha um plano agora pra não perder acesso.
            </p>
          </div>
        </div>
      )}

      {/* Plano atual */}
      {currentPlan && billing.subscription && (
        <div className="mb-6 bg-card border border-border rounded-xl p-5">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
            <div>
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Plano atual</p>
              <h2 className="text-xl font-extrabold text-foreground inline-flex items-center gap-2">
                {currentPlan.name}
                <span className={`text-[10px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded border ${
                  billing.subscription.status === 'ACTIVE' ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30' :
                  billing.subscription.status === 'PAST_DUE' ? 'bg-red-500/15 text-red-700 border-red-500/30' :
                  'bg-amber-500/15 text-amber-700 border-amber-500/30'
                }`}>
                  {billing.subscription.status === 'ACTIVE' ? 'Ativa' :
                   billing.subscription.status === 'PAST_DUE' ? 'Em atraso' :
                   billing.subscription.status === 'PENDING_PAYMENT' ? 'Aguardando pagamento' :
                   billing.subscription.status}
                </span>
              </h2>
            </div>
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Mensalidade</p>
              <p className="text-2xl font-extrabold tabular-nums">R$ {Number(currentPlan.price_monthly).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-3 border-t border-border">
            <InfoItem
              Icon={Calendar}
              label="Próximo vencimento"
              value={billing.subscription.next_charge_date
                ? new Date(billing.subscription.next_charge_date).toLocaleDateString('pt-BR')
                : '—'}
            />
            <InfoItem
              Icon={CheckCircle2}
              label="Último pagamento"
              value={billing.subscription.last_paid_at
                ? new Date(billing.subscription.last_paid_at).toLocaleDateString('pt-BR')
                : 'Aguardando'}
            />
            <InfoItem
              Icon={CreditCard}
              label="Forma de pagamento"
              value={
                billing.subscription.billing_type === 'PIX' ? 'PIX' :
                billing.subscription.billing_type === 'CREDIT_CARD' ? 'Cartão de crédito' :
                'Boleto'
              }
            />
          </div>
        </div>
      )}

      {/* Comparador de planos */}
      <div className="mb-6">
        <h2 className="text-sm font-bold text-foreground mb-3">
          {currentPlan ? 'Mudar de plano' : 'Escolha um plano'}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {plans.map((p) => {
            const features: string[] = p.features_json ? JSON.parse(p.features_json) : [];
            const isCurrent = currentPlan?.slug === p.slug;
            return (
              <div
                key={p.id}
                className={`bg-card border-2 rounded-xl p-5 ${
                  isCurrent ? 'border-violet-500 ring-4 ring-violet-500/20' : 'border-border'
                }`}
              >
                {isCurrent && (
                  <p className="text-[10px] uppercase tracking-wider font-bold text-violet-700 mb-2">
                    Seu plano
                  </p>
                )}
                <h3 className="text-lg font-extrabold text-foreground">{p.name}</h3>
                {p.description && (
                  <p className="text-xs text-muted-foreground mb-3">{p.description}</p>
                )}
                <p className="text-3xl font-extrabold tabular-nums mb-3">
                  R$ {Number(p.price_monthly).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                  <span className="text-sm text-muted-foreground font-normal">/mês</span>
                </p>
                <ul className="space-y-1.5 mb-4 text-xs">
                  {features.map((f, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <CheckCircle2 size={11} className="text-emerald-600 shrink-0 mt-0.5" />
                      <span className="text-foreground">{f}</span>
                    </li>
                  ))}
                </ul>
                {!isCurrent && (
                  <div className="space-y-1.5">
                    <CheckoutButton
                      onClick={() => handleCheckout(p.slug, 'PIX')}
                      loading={checkingOut === p.slug}
                      label="Pagar com PIX"
                      Icon={DollarSign}
                      primary
                    />
                    <CheckoutButton
                      onClick={() => handleCheckout(p.slug, 'CREDIT_CARD')}
                      loading={false}
                      label="Cartão de crédito"
                      Icon={CreditCard}
                    />
                    <CheckoutButton
                      onClick={() => handleCheckout(p.slug, 'BOLETO')}
                      loading={false}
                      label="Boleto"
                      Icon={Receipt}
                    />
                  </div>
                )}
                {isCurrent && (
                  <p className="text-[11px] text-center text-emerald-700 font-semibold py-2">
                    ✓ Plano em uso
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="bg-muted/30 border border-border rounded-xl p-4">
        <p className="text-xs text-muted-foreground inline-flex items-start gap-1.5">
          <Shield size={11} className="shrink-0 mt-0.5 text-emerald-600" />
          <span>
            Pagamentos seguros via Asaas. Você pode cancelar a qualquer momento.
            Dúvidas? <a href="mailto:suporte@odontosystem.com.br" className="text-violet-700 hover:underline">suporte@odontosystem.com.br</a>
          </span>
        </p>
      </div>
    </div>
  );
}

function InfoItem({ Icon, label, value }: { Icon: any; label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground flex items-center gap-1">
        <Icon size={10} />
        {label}
      </p>
      <p className="text-sm font-bold text-foreground mt-0.5">{value}</p>
    </div>
  );
}

function CheckoutButton({ onClick, loading, label, Icon, primary }: {
  onClick: () => void;
  loading: boolean;
  label: string;
  Icon: any;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className={`w-full text-xs font-bold px-3 py-2 rounded-md inline-flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50 ${
        primary
          ? 'bg-violet-600 hover:bg-violet-700 text-white'
          : 'border border-border bg-card hover:bg-accent/40 text-foreground'
      }`}
    >
      {loading ? <Loader2 size={11} className="animate-spin" /> : <Icon size={11} />}
      {label}
    </button>
  );
}
