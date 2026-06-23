'use client';

/**
 * Onda 17.32.81 — Detalhe do tenant + edicao de integracoes (SUPER_ADMIN).
 *
 * 3 abas:
 *  - Geral: contadores, status, dados, branding
 *  - Integracoes: Asaas, Evolution (WhatsApp), ClickSign per-tenant
 *  - Uso: barras de plano + reset de senha do admin
 *
 * Settings sao salvas como TenantSetting (sobrescreve GlobalSetting
 * apenas pra esse tenant). Helper getTenantSetting() no backend ja
 * faz fallback automatico, entao migracao eh transparente.
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Loader2, ArrowLeft, Building2, Save, AlertCircle, CheckCircle2, Trash2,
  Pause, Play, Pencil, Settings as SettingsIcon, Users, HeartPulse, Briefcase,
  Receipt, MessageSquare, Eye, EyeOff, ExternalLink, Banknote, FileSignature,
} from 'lucide-react';
import Link from 'next/link';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Tenant {
  id: string;
  name: string;
  slug: string | null;
  email: string | null;
  phone: string | null;
  cpf_cnpj: string | null;
  logo_url: string | null;
  theme_color: string | null;
  custom_domain: string | null;
  status: string;
  plan: string;
  trial_ends_at: string | null;
  suspended_at: string | null;
  suspended_reason: string | null;
  created_at: string;
  _count?: { users: number; patients: number; leads: number; payment_gateway_charges: number };
}

interface TenantSetting {
  key: string;
  value: string;
  is_sensitive: boolean;
  updated_at: string;
}

type Tab = 'geral' | 'integracoes' | 'uso';

export default function TenantDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('geral');

  const load = useCallback(async () => {
    if (!params?.id) return;
    setLoading(true);
    try {
      const { data } = await api.get<Tenant>(`/tenants/${params.id}`);
      setTenant(data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Tenant nao encontrado');
      router.push('/admin/tenants');
    } finally {
      setLoading(false);
    }
  }, [params?.id, router]);

  useEffect(() => { void load(); }, [load]);

  if (loading || !tenant) {
    return (
      <div className="p-12 flex items-center justify-center text-muted-foreground">
        <Loader2 size={18} className="animate-spin mr-2" />
        Carregando tenant...
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <Link href="/admin/tenants" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-3">
          <ArrowLeft size={12} />
          Voltar pra lista
        </Link>
        <div className="flex items-start gap-4 flex-wrap">
          <div className="w-14 h-14 rounded-xl bg-violet-500/10 text-violet-700 flex items-center justify-center shrink-0 overflow-hidden">
            {tenant.logo_url ? (
              <img src={tenant.logo_url} alt={tenant.name} className="w-full h-full object-cover" />
            ) : (
              <Building2 size={28} />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-extrabold text-foreground">{tenant.name}</h1>
            <p className="text-sm text-muted-foreground">
              {tenant.slug && <>/{tenant.slug} · </>}
              {tenant.plan} · Status: <strong>{tenant.status}</strong>
              {tenant.email && <> · {tenant.email}</>}
            </p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border mb-6 overflow-x-auto">
        {[
          { key: 'geral' as const, label: 'Geral', Icon: Building2 },
          { key: 'integracoes' as const, label: 'Integrações', Icon: SettingsIcon },
          { key: 'uso' as const, label: 'Uso & limites', Icon: Banknote },
        ].map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap ${
              tab === t.key
                ? 'border-violet-600 text-violet-700'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <t.Icon size={14} />
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'geral' && <GeralTab tenant={tenant} onReload={load} />}
      {tab === 'integracoes' && <IntegracoesTab tenantId={tenant.id} />}
      {tab === 'uso' && <UsoTab tenant={tenant} onUpdated={load} />}
    </div>
  );
}

function GeralTab({ tenant, onReload }: { tenant: Tenant; onReload: () => void }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <CounterCard label="Usuários" value={tenant._count?.users || 0} Icon={Users} />
        <CounterCard label="Pacientes" value={tenant._count?.patients || 0} Icon={HeartPulse} />
        <CounterCard label="Leads" value={tenant._count?.leads || 0} Icon={Briefcase} />
        <CounterCard label="Cobranças" value={tenant._count?.payment_gateway_charges || 0} Icon={Receipt} />
      </div>
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <h3 className="text-sm font-bold text-foreground">Dados cadastrais</h3>
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <Field label="Nome" value={tenant.name} />
          <Field label="Slug" value={tenant.slug || '—'} />
          <Field label="Email" value={tenant.email || '—'} />
          <Field label="Telefone" value={tenant.phone || '—'} />
          <Field label="CPF/CNPJ" value={tenant.cpf_cnpj || '—'} />
          <Field label="Domínio custom" value={tenant.custom_domain || '—'} />
          <Field label="Plano" value={tenant.plan} />
          <Field label="Status" value={tenant.status} />
          <Field label="Criado em" value={new Date(tenant.created_at).toLocaleString('pt-BR')} />
          {tenant.trial_ends_at && <Field label="Trial até" value={new Date(tenant.trial_ends_at).toLocaleDateString('pt-BR')} />}
          {tenant.suspended_at && <Field label="Suspenso em" value={new Date(tenant.suspended_at).toLocaleString('pt-BR')} />}
          {tenant.suspended_reason && <Field label="Motivo da suspensão" value={tenant.suspended_reason} />}
        </dl>
      </div>
      {tenant.status === 'SUSPENDED' && (
        <button
          type="button"
          onClick={async () => {
            if (!confirm(`Reativar ${tenant.name}?`)) return;
            await api.post(`/tenants/${tenant.id}/activate`);
            showSuccess('Reativado');
            onReload();
          }}
          className="text-sm font-bold px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white inline-flex items-center gap-2"
        >
          <Play size={14} />
          Reativar tenant
        </button>
      )}
    </div>
  );
}

interface IntegrationField {
  key: string;
  label: string;
  placeholder: string;
  sensitive?: boolean;
  helper?: string;
}

interface IntegrationGroup {
  Icon: any;
  title: string;
  description: string;
  fields: IntegrationField[];
}

// Onda 17.32.81 — Definicao das integracoes editaveis por tenant.
const INTEGRATION_GROUPS: IntegrationGroup[] = [
  {
    Icon: Banknote,
    title: 'Asaas (cobranças)',
    description: 'Cada tenant precisa da sua conta Asaas pra cobrar pacientes. Token: app.asaas.com → Configurações → API.',
    fields: [
      { key: 'ASAAS_API_KEY', label: 'API Key', placeholder: '$aact_prod_...', sensitive: true },
      { key: 'ASAAS_BASE_URL', label: 'Base URL', placeholder: 'https://www.asaas.com (prod) ou https://sandbox.asaas.com', helper: 'Padrão: produção' },
    ],
  },
  {
    Icon: MessageSquare,
    title: 'Evolution / WhatsApp',
    description: 'Instância Evolution API dedicada ao tenant. Cada tenant tem sua própria conexão WhatsApp.',
    fields: [
      { key: 'EVOLUTION_INSTANCE_NAME', label: 'Nome da instância', placeholder: 'clinica-passos' },
      { key: 'EVOLUTION_API_KEY', label: 'API Key', placeholder: 'B6D7...', sensitive: true },
      { key: 'EVOLUTION_BASE_URL', label: 'Base URL da Evolution', placeholder: 'https://evolution.exemplo.com.br', helper: 'Onde está hospedada a instância' },
    ],
  },
  {
    Icon: FileSignature,
    title: 'ClickSign (contratos)',
    description: 'Token e webhook do ClickSign pra assinatura digital de contratos com o paciente.',
    fields: [
      { key: 'CLICKSIGN_API_TOKEN', label: 'API Token', placeholder: 'eyJhb...', sensitive: true },
      { key: 'CLICKSIGN_BASE_URL', label: 'Base URL', placeholder: 'https://app.clicksign.com (prod) ou https://sandbox.clicksign.com', helper: 'Padrão: produção' },
      { key: 'CLICKSIGN_WEBHOOK_TOKEN', label: 'Webhook Token', placeholder: 'token de validação', sensitive: true },
    ],
  },
];

function IntegracoesTab({ tenantId }: { tenantId: string }) {
  const [settings, setSettings] = useState<TenantSetting[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<TenantSetting[]>(`/tenants/${tenantId}/settings`);
      setSettings(data || []);
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  const settingsByKey = settings.reduce<Record<string, TenantSetting>>((acc, s) => {
    acc[s.key] = s;
    return acc;
  }, {});

  if (loading) {
    return (
      <div className="py-12 flex items-center justify-center text-muted-foreground">
        <Loader2 size={18} className="animate-spin mr-2" />
        Carregando settings...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 flex items-start gap-3">
        <AlertCircle size={16} className="text-amber-700 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-bold text-amber-700 mb-1">Importante</p>
          <p className="text-xs text-amber-700">
            Estas chaves <strong>sobrescrevem</strong> as chaves globais do sistema apenas pra esse tenant.
            Se não configurar, o tenant usa as chaves globais (compartilhadas).
            Para revenda real, <strong>cada tenant deve ter sua própria conta Asaas e instância Evolution</strong>.
          </p>
        </div>
      </div>

      {INTEGRATION_GROUPS.map((group) => (
        <IntegrationGroupCard
          key={group.title}
          group={group}
          tenantId={tenantId}
          settingsByKey={settingsByKey}
          onReload={load}
        />
      ))}
    </div>
  );
}

function IntegrationGroupCard({
  group, tenantId, settingsByKey, onReload,
}: {
  group: IntegrationGroup;
  tenantId: string;
  settingsByKey: Record<string, TenantSetting>;
  onReload: () => void;
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-9 h-9 rounded-lg bg-violet-500/15 text-violet-700 flex items-center justify-center">
          <group.Icon size={16} />
        </div>
        <div>
          <h3 className="text-sm font-bold text-foreground">{group.title}</h3>
          <p className="text-[11px] text-muted-foreground">{group.description}</p>
        </div>
      </div>
      <div className="space-y-3">
        {group.fields.map((field) => (
          <SettingField
            key={field.key}
            tenantId={tenantId}
            field={field}
            currentSetting={settingsByKey[field.key]}
            onReload={onReload}
          />
        ))}
      </div>
    </div>
  );
}

function SettingField({
  tenantId, field, currentSetting, onReload,
}: {
  tenantId: string;
  field: IntegrationField;
  currentSetting?: TenantSetting;
  onReload: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [showValue, setShowValue] = useState(false);
  const [saving, setSaving] = useState(false);

  const isConfigured = !!currentSetting;

  const handleSave = async () => {
    if (!value.trim()) { showError('Valor obrigatorio'); return; }
    setSaving(true);
    try {
      await api.post(`/tenants/${tenantId}/settings`, {
        key: field.key,
        value: value.trim(),
      });
      showSuccess(`${field.label} salva`);
      setEditing(false);
      setValue('');
      setShowValue(false);
      onReload();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Remover override de ${field.label}? O tenant vai voltar a usar a configuração global.`)) return;
    try {
      await api.post(`/tenants/${tenantId}/settings/${encodeURIComponent(field.key)}/delete`);
      showSuccess(`${field.label} removida (volta a usar global)`);
      onReload();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao remover');
    }
  };

  return (
    <div className="border border-border rounded-md p-3 bg-background/40">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div>
          <label className="text-[11px] font-bold text-foreground">{field.label}</label>
          {field.helper && (
            <p className="text-[10px] text-muted-foreground">{field.helper}</p>
          )}
        </div>
        {isConfigured && !editing && (
          <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-700 inline-flex items-center gap-1">
            <CheckCircle2 size={9} />
            Configurada
          </span>
        )}
      </div>

      {editing ? (
        <div className="flex items-center gap-1.5">
          <input
            type={field.sensitive && !showValue ? 'password' : 'text'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={field.placeholder}
            autoFocus
            className="flex-1 px-3 py-1.5 text-xs border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-violet-500/30 font-mono"
          />
          {field.sensitive && (
            <button
              type="button"
              onClick={() => setShowValue(!showValue)}
              className="p-2 rounded-md hover:bg-accent/40 text-muted-foreground"
              title={showValue ? 'Ocultar' : 'Mostrar'}
            >
              {showValue ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !value.trim()}
            className="text-xs font-bold px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white inline-flex items-center gap-1 disabled:opacity-50"
          >
            {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
            Salvar
          </button>
          <button
            type="button"
            onClick={() => { setEditing(false); setValue(''); }}
            disabled={saving}
            className="text-xs font-semibold px-3 py-1.5 rounded-md border border-border bg-card hover:bg-accent/40"
          >
            Cancelar
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <code className="flex-1 px-3 py-1.5 text-xs border border-border rounded-md bg-muted/30 text-foreground font-mono truncate">
            {isConfigured ? currentSetting.value : <span className="text-muted-foreground">(usa config global)</span>}
          </code>
          <button
            type="button"
            onClick={() => { setEditing(true); setValue(''); }}
            className="p-2 rounded-md border border-border bg-card hover:bg-accent/40 text-muted-foreground"
            title={isConfigured ? 'Editar' : 'Configurar pra esse tenant'}
          >
            <Pencil size={12} />
          </button>
          {isConfigured && (
            <button
              type="button"
              onClick={handleDelete}
              className="p-2 rounded-md border border-red-500/30 bg-red-500/10 text-red-700 hover:bg-red-500/20"
              title="Remover override"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function UsoTab({ tenant, onUpdated }: { tenant: Tenant; onUpdated: () => void }) {
  const [usage, setUsage] = useState<any>(null);
  const [savingPlan, setSavingPlan] = useState(false);

  useEffect(() => {
    // /tenants/me/usage retorna o uso do tenant DO USER LOGADO. Pra ver
    // outro tenant precisaria expor um endpoint cross-tenant. Por enquanto
    // mostramos o uso pelo _count que ja veio em findOne.
    setUsage(null); // placeholder — usa _count
  }, [tenant.id]);

  // Onda 17.61 — SUPER_ADMIN troca o plano do tenant (PATCH /tenants/:id) — sobe o
  // limite de usuários/pacientes na hora, sem deploy. PRO=20, ENTERPRISE/CUSTOM=ilimitado.
  const changePlan = async (plan: string) => {
    if (plan === tenant.plan) return;
    setSavingPlan(true);
    try {
      await api.patch(`/tenants/${tenant.id}`, { plan });
      showSuccess(`Plano alterado para ${plan}.`);
      onUpdated();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao alterar o plano');
    } finally {
      setSavingPlan(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
          <h3 className="text-sm font-bold text-foreground">Plano: {tenant.plan}</h3>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold text-muted-foreground">Trocar plano:</span>
            <select
              value={tenant.plan}
              onChange={(e) => changePlan(e.target.value)}
              disabled={savingPlan}
              className="px-2 py-1 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40 disabled:opacity-50"
            >
              <option value="STARTER">STARTER (5 users)</option>
              <option value="PRO">PRO (20 users)</option>
              <option value="ENTERPRISE">ENTERPRISE (ilimitado)</option>
              <option value="CUSTOM">CUSTOM (ilimitado)</option>
            </select>
            {savingPlan && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Limites por plano definidos em <code>apps/api/src/tenants/plan-limits.ts</code>.
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          STARTER: 5 users · 300 patients · 1 inbox · 100 charges/mês<br />
          PRO: 20 · 3000 · 3 · 1000<br />
          ENTERPRISE/CUSTOM: ilimitado
        </p>
      </div>
      <div className="bg-card border border-border rounded-xl p-4">
        <h3 className="text-sm font-bold text-foreground mb-3">Uso atual</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <CounterCard label="Usuários" value={tenant._count?.users || 0} Icon={Users} />
          <CounterCard label="Pacientes" value={tenant._count?.patients || 0} Icon={HeartPulse} />
          <CounterCard label="Leads" value={tenant._count?.leads || 0} Icon={Briefcase} />
          <CounterCard label="Cobranças" value={tenant._count?.payment_gateway_charges || 0} Icon={Receipt} />
        </div>
      </div>
    </div>
  );
}

function CounterCard({ label, value, Icon }: { label: string; value: number; Icon: any }) {
  return (
    <div className="bg-card border border-border rounded-xl p-3">
      <div className="flex items-center gap-1.5 mb-1 text-muted-foreground">
        <Icon size={11} />
        <p className="text-[10px] uppercase tracking-wider font-bold">{label}</p>
      </div>
      <p className="text-xl font-extrabold tabular-nums text-foreground">{value}</p>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{label}</dt>
      <dd className="font-semibold text-foreground mt-0.5 break-all">{value}</dd>
    </div>
  );
}
