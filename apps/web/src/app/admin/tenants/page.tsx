'use client';

/**
 * Onda 17.32.77 — Lista de Tenants do SaaS (SUPER_ADMIN only).
 *
 * Cards com nome, status, plano, contadores (users/patients/leads/charges).
 * Botao "+ Novo tenant" abre modal pra criar tenant + admin inicial.
 * Acoes por tenant: editar, suspender, reativar.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Loader2, Search, Plus, Building2, Users, HeartPulse, Briefcase, Receipt,
  Pause, Play, Pencil, X, Save, AlertCircle, CheckCircle2, Calendar, Mail, Phone, IdCard,
} from 'lucide-react';
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
  status: string; // ACTIVE | TRIAL | SUSPENDED | DELETED
  plan: string;   // STARTER | PRO | ENTERPRISE | CUSTOM
  trial_ends_at: string | null;
  suspended_at: string | null;
  suspended_reason: string | null;
  created_at: string;
  _count?: {
    users: number;
    patients: number;
    leads: number;
    payment_gateway_charges: number;
  };
}

const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  ACTIVE: { label: 'Ativo', cls: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30' },
  TRIAL: { label: 'Em avaliação', cls: 'bg-amber-500/15 text-amber-700 border-amber-500/30' },
  SUSPENDED: { label: 'Suspenso', cls: 'bg-red-500/15 text-red-700 border-red-500/30' },
  DELETED: { label: 'Excluído', cls: 'bg-muted text-muted-foreground border-border' },
};

const PLAN_CONFIG: Record<string, { label: string; cls: string }> = {
  STARTER: { label: 'Starter', cls: 'bg-slate-500/15 text-slate-700' },
  PRO: { label: 'Pro', cls: 'bg-blue-500/15 text-blue-700' },
  ENTERPRISE: { label: 'Enterprise', cls: 'bg-violet-500/15 text-violet-700' },
  CUSTOM: { label: 'Custom', cls: 'bg-orange-500/15 text-orange-700' },
};

const STATUS_FILTERS = ['', 'ACTIVE', 'TRIAL', 'SUSPENDED', 'DELETED'];

export default function AdminTenantsPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [newOpen, setNewOpen] = useState(false);
  const [editing, setEditing] = useState<Tenant | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (search.trim()) params.set('q', search.trim());
      const { data } = await api.get<Tenant[]>(`/tenants?${params.toString()}`);
      setTenants(data || []);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Falha ao carregar tenants');
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter]);

  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 250);
    return () => clearTimeout(t);
  }, [load]);

  const handleSuspend = async (t: Tenant) => {
    const reason = prompt(`Suspender "${t.name}"?\n\nMotivo (opcional, sera mostrado pro tenant ao tentar login):`);
    if (reason === null) return; // cancelou
    try {
      await api.post(`/tenants/${t.id}/suspend`, { reason: reason || undefined });
      showSuccess('Tenant suspenso');
      void load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao suspender');
    }
  };

  const handleActivate = async (t: Tenant) => {
    if (!confirm(`Reativar "${t.name}"?`)) return;
    try {
      await api.post(`/tenants/${t.id}/activate`);
      showSuccess('Tenant reativado');
      void load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao reativar');
    }
  };

  // Totais agregados pro topo
  const totals = useMemo(() => {
    const t = { active: 0, trial: 0, suspended: 0, totalUsers: 0, totalPatients: 0 };
    for (const x of tenants) {
      if (x.status === 'ACTIVE') t.active++;
      else if (x.status === 'TRIAL') t.trial++;
      else if (x.status === 'SUSPENDED') t.suspended++;
      t.totalUsers += x._count?.users || 0;
      t.totalPatients += x._count?.patients || 0;
    }
    return t;
  }, [tenants]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-foreground flex items-center gap-2">
            <Building2 size={24} />
            Tenants do SaaS
          </h1>
          <p className="text-sm text-muted-foreground">Gerencie clínicas que usam o sistema</p>
        </div>
        <button
          type="button"
          onClick={() => setNewOpen(true)}
          className="text-sm font-bold px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-700 text-white inline-flex items-center gap-2"
        >
          <Plus size={14} />
          Novo tenant
        </button>
      </div>

      {/* Mini KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <KpiCard label="Ativos" value={totals.active} icon={<CheckCircle2 size={14} />} tone="emerald" />
        <KpiCard label="Em avaliação" value={totals.trial} icon={<AlertCircle size={14} />} tone="amber" />
        <KpiCard label="Suspensos" value={totals.suspended} icon={<Pause size={14} />} tone="red" />
        <KpiCard label="Total usuários" value={totals.totalUsers} icon={<Users size={14} />} tone="neutral" />
      </div>

      {/* Filtros */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome, slug, email ou CPF/CNPJ..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-lg bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-violet-500/30"
          />
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          {STATUS_FILTERS.map((s) => {
            const active = statusFilter === s;
            const label = s ? STATUS_CONFIG[s]?.label : 'Todos';
            return (
              <button
                key={s || 'all'}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`text-xs font-semibold px-3 py-1.5 rounded-md border transition-colors ${
                  active
                    ? 'bg-foreground text-background border-foreground'
                    : 'border-border bg-card text-foreground hover:bg-accent/40'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Lista */}
      {loading ? (
        <div className="py-16 flex items-center justify-center text-muted-foreground">
          <Loader2 size={18} className="animate-spin mr-2" />
          Carregando tenants...
        </div>
      ) : tenants.length === 0 ? (
        <div className="py-16 text-center bg-card border border-dashed border-border rounded-xl">
          <Building2 size={32} className="mx-auto mb-2 text-muted-foreground/50" />
          <p className="text-sm font-bold mb-1">Nenhum tenant encontrado</p>
          <p className="text-xs text-muted-foreground">
            {search || statusFilter ? 'Ajuste os filtros ou' : ''} clique em "Novo tenant" pra cadastrar.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {tenants.map((t) => {
            const stCfg = STATUS_CONFIG[t.status] || STATUS_CONFIG.ACTIVE;
            const planCfg = PLAN_CONFIG[t.plan] || PLAN_CONFIG.STARTER;
            return (
              <div
                key={t.id}
                className="bg-card border border-border rounded-xl p-4 hover:shadow-sm transition-shadow"
              >
                <div className="grid grid-cols-[auto_1fr_auto] gap-4 items-center">
                  {/* Avatar / logo */}
                  <div className="w-12 h-12 rounded-lg bg-violet-500/10 text-violet-700 flex items-center justify-center shrink-0">
                    {t.logo_url ? (
                      <img src={t.logo_url} alt={t.name} className="w-full h-full rounded-lg object-cover" />
                    ) : (
                      <Building2 size={20} />
                    )}
                  </div>
                  {/* Info */}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-0.5">
                      <h3 className="text-sm font-bold text-foreground truncate">{t.name}</h3>
                      <span className={`text-[10px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded border ${stCfg.cls}`}>
                        {stCfg.label}
                      </span>
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${planCfg.cls}`}>
                        {planCfg.label}
                      </span>
                      {t.slug && (
                        <span className="text-[10px] font-mono text-muted-foreground">/{t.slug}</span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {t.email && <><Mail size={9} className="inline" /> {t.email} · </>}
                      {t.phone && <><Phone size={9} className="inline" /> {t.phone} · </>}
                      <Calendar size={9} className="inline" />{' '}
                      Desde {new Date(t.created_at).toLocaleDateString('pt-BR')}
                    </p>
                    {/* Contadores */}
                    {t._count && (
                      <div className="flex items-center gap-3 mt-1.5 text-[11px] flex-wrap">
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <Users size={10} />
                          <strong className="text-foreground">{t._count.users}</strong> usuário(s)
                        </span>
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <HeartPulse size={10} />
                          <strong className="text-foreground">{t._count.patients}</strong> paciente(s)
                        </span>
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <Briefcase size={10} />
                          <strong className="text-foreground">{t._count.leads}</strong> lead(s)
                        </span>
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <Receipt size={10} />
                          <strong className="text-foreground">{t._count.payment_gateway_charges}</strong> cobrança(s)
                        </span>
                      </div>
                    )}
                    {t.status === 'SUSPENDED' && t.suspended_reason && (
                      <p className="text-[11px] text-red-700 mt-1">
                        Motivo: {t.suspended_reason}
                      </p>
                    )}
                    {t.status === 'TRIAL' && t.trial_ends_at && (
                      <p className="text-[11px] text-amber-700 mt-1">
                        Trial até {new Date(t.trial_ends_at).toLocaleDateString('pt-BR')}
                      </p>
                    )}
                  </div>
                  {/* Acoes */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => setEditing(t)}
                      className="p-2 rounded-md border border-border bg-card hover:bg-accent/40 text-muted-foreground hover:text-foreground transition-colors"
                      title="Editar"
                    >
                      <Pencil size={12} />
                    </button>
                    {t.status === 'SUSPENDED' ? (
                      <button
                        type="button"
                        onClick={() => handleActivate(t)}
                        className="p-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 transition-colors"
                        title="Reativar"
                      >
                        <Play size={12} />
                      </button>
                    ) : t.status !== 'DELETED' && (
                      <button
                        type="button"
                        onClick={() => handleSuspend(t)}
                        className="p-2 rounded-md border border-red-500/30 bg-red-500/10 text-red-700 hover:bg-red-500/20 transition-colors"
                        title="Suspender"
                      >
                        <Pause size={12} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modal de criar */}
      {newOpen && (
        <TenantFormDialog
          mode="create"
          onClose={() => setNewOpen(false)}
          onSaved={() => { setNewOpen(false); void load(); }}
        />
      )}

      {/* Modal de editar */}
      {editing && (
        <TenantFormDialog
          mode="edit"
          tenant={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

function KpiCard({ label, value, icon, tone }: { label: string; value: number; icon: React.ReactNode; tone: 'emerald'|'amber'|'red'|'neutral' }) {
  const cfg = {
    emerald: 'bg-emerald-500/5 border-emerald-500/20 text-emerald-700',
    amber: 'bg-amber-500/5 border-amber-500/20 text-amber-700',
    red: 'bg-red-500/5 border-red-500/20 text-red-700',
    neutral: 'bg-card border-border text-foreground',
  }[tone];
  return (
    <div className={`border-2 rounded-xl p-3 ${cfg}`}>
      <div className="flex items-center gap-1.5 mb-1">
        {icon}
        <p className="text-[10px] uppercase tracking-wider font-bold">{label}</p>
      </div>
      <p className="text-xl font-extrabold tabular-nums">{value}</p>
    </div>
  );
}

/** Modal pra criar tenant + admin inicial OU editar tenant existente. */
function TenantFormDialog({
  mode,
  tenant,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  tenant?: Tenant;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(tenant?.name || '');
  const [slug, setSlug] = useState(tenant?.slug || '');
  const [email, setEmail] = useState(tenant?.email || '');
  const [phone, setPhone] = useState(tenant?.phone || '');
  const [cpfCnpj, setCpfCnpj] = useState(tenant?.cpf_cnpj || '');
  const [plan, setPlan] = useState(tenant?.plan || 'STARTER');
  const [logoUrl, setLogoUrl] = useState(tenant?.logo_url || '');
  const [themeColor, setThemeColor] = useState(tenant?.theme_color || '');
  // Admin inicial (so no modo create)
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminPhone, setAdminPhone] = useState('');

  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { showError('Nome eh obrigatorio'); return; }
    if (mode === 'create') {
      if (!adminName.trim() || !adminEmail.trim() || !adminPassword) {
        showError('Dados do admin inicial sao obrigatorios');
        return;
      }
    }
    setSaving(true);
    try {
      const payload: any = {
        name: name.trim(),
        slug: slug.trim() || undefined,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        cpf_cnpj: cpfCnpj.trim() || undefined,
        plan,
        logo_url: logoUrl.trim() || undefined,
        theme_color: themeColor.trim() || undefined,
      };
      if (mode === 'create') {
        payload.admin = {
          name: adminName.trim(),
          email: adminEmail.trim().toLowerCase(),
          password: adminPassword,
          phone: adminPhone.trim() || undefined,
        };
        await api.post('/tenants', payload);
        showSuccess('Tenant criado!');
      } else {
        await api.patch(`/tenants/${tenant!.id}`, payload);
        showSuccess('Tenant atualizado');
      }
      onSaved();
    } catch (err: any) {
      const msg = err?.response?.data?.message || 'Erro ao salvar';
      showError(typeof msg === 'string' ? msg : (Array.isArray(msg) ? msg.join(', ') : 'Erro'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[95vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border bg-violet-500/5 shrink-0">
          <h2 className="text-base font-bold inline-flex items-center gap-2">
            <Building2 size={16} className="text-violet-700" />
            {mode === 'create' ? 'Novo tenant' : `Editar: ${tenant?.name}`}
          </h2>
          <button type="button" onClick={onClose} className="p-1.5 rounded-md hover:bg-accent/40">
            <X size={16} />
          </button>
        </div>

        {/* Body — scroll */}
        <div className="flex-1 overflow-auto p-5 space-y-4">
          <section>
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">Dados da clínica</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormField label="Nome *" required value={name} onChange={setName} placeholder="Clínica Passos Odontologia" />
              <FormField label="Slug (opcional)" value={slug} onChange={setSlug} placeholder="clinica-passos" />
              <FormField label="Email" type="email" value={email} onChange={setEmail} placeholder="contato@clinica.com.br" />
              <FormField label="Telefone" value={phone} onChange={setPhone} placeholder="5582999999999" />
              <FormField label="CPF/CNPJ" value={cpfCnpj} onChange={setCpfCnpj} placeholder="11.222.333/0001-44" />
              <div>
                <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1 block">Plano</label>
                <select
                  value={plan}
                  onChange={(e) => setPlan(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background"
                >
                  <option value="STARTER">Starter</option>
                  <option value="PRO">Pro</option>
                  <option value="ENTERPRISE">Enterprise</option>
                  <option value="CUSTOM">Custom</option>
                </select>
              </div>
            </div>
          </section>

          <section>
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">Branding (opcional)</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormField label="URL do logo" value={logoUrl} onChange={setLogoUrl} placeholder="https://..." />
              <div>
                <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1 block">Cor primária</label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={themeColor || '#7c3aed'}
                    onChange={(e) => setThemeColor(e.target.value)}
                    className="w-12 h-9 border border-border rounded cursor-pointer"
                  />
                  <input
                    type="text"
                    value={themeColor}
                    onChange={(e) => setThemeColor(e.target.value)}
                    placeholder="#7c3aed"
                    className="flex-1 px-3 py-2 text-sm border border-border rounded-md bg-background font-mono"
                  />
                </div>
              </div>
            </div>
          </section>

          {mode === 'create' && (
            <section>
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">Administrador inicial</p>
              <div className="bg-muted/30 border border-border rounded-md p-3 space-y-3">
                <p className="text-[11px] text-muted-foreground inline-flex items-start gap-1.5">
                  <IdCard size={11} className="shrink-0 mt-0.5" />
                  Este usuário poderá criar outros usuários dentro do tenant e gerenciar tudo.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <FormField label="Nome *" required value={adminName} onChange={setAdminName} placeholder="Dr(a). Responsável" />
                  <FormField label="Email *" required type="email" value={adminEmail} onChange={setAdminEmail} placeholder="admin@clinica.com.br" />
                  <FormField label="Senha *" required type="password" value={adminPassword} onChange={setAdminPassword} placeholder="••••••••" />
                  <FormField label="Telefone" value={adminPhone} onChange={setAdminPhone} placeholder="5582999999999" />
                </div>
              </div>
            </section>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-5 py-3 border-t border-border bg-muted/30 shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="flex-1 text-sm font-semibold px-3 py-2 rounded-md border border-border bg-card hover:bg-accent/40 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="flex-1 text-sm font-bold px-3 py-2 rounded-md bg-violet-600 hover:bg-violet-700 text-white inline-flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {mode === 'create' ? 'Criar tenant' : 'Salvar'}
          </button>
        </div>
      </form>
    </div>
  );
}

function FormField({
  label, value, onChange, placeholder, type = 'text', required,
}: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; required?: boolean }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1 block">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-violet-500/30"
      />
    </div>
  );
}
