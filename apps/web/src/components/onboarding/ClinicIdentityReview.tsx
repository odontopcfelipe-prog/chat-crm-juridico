'use client';

/**
 * Onda 17.32.152/154 — Revisão de identidade da clínica (passo 1
 * do Onboarding Wizard).
 *
 * Pega dados atuais do tenant e permite confirmar/ajustar. Seções:
 *   1. Identificação  (sempre aberta) — nome*, CNPJ/CPF, telefone, e-mail
 *   2. Endereço        (colapsável)   — CEP com auto-fill via ViaCEP
 *   3. Responsável Téc (colapsável)   — nome + CRO
 *   4. Horários        (colapsável)   — texto livre
 *
 * Min-height fixo evita layout shift entre loading skeleton e form
 * preenchido (era "aba pequena que pula" antes).
 */
import { useState, useEffect, useCallback } from 'react';
import {
  CheckCircle2, Loader2, AlertCircle, Save,
  Home, ShieldCheck, Clock,
} from 'lucide-react';
import api from '@/lib/api';

interface TenantSelf {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  cpf_cnpj: string | null;
  logo_url: string | null;
  theme_color: string | null;
  // Onda 17.32.154
  zip_code: string | null;
  address: string | null;
  address_number: string | null;
  address_complement: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  responsible_name: string | null;
  responsible_cro: string | null;
  business_hours: string | null;
}

interface Props {
  alreadyDone?: boolean;
  onSaved: () => Promise<void>;
}

const STATES = [
  'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
  'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO',
];

const inputCls =
  'w-full px-3 py-2 rounded-lg bg-white dark:bg-card border border-border text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 transition-all';
const labelCls =
  'block text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1';

const EMPTY: Omit<TenantSelf, 'id' | 'logo_url' | 'theme_color'> = {
  name: '', phone: '', email: '', cpf_cnpj: '',
  zip_code: '', address: '', address_number: '', address_complement: '',
  neighborhood: '', city: '', state: '',
  responsible_name: '', responsible_cro: '',
  business_hours: '',
};

export default function ClinicIdentityReview({ alreadyDone = false, onSaved }: Props) {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [cepLoading, setCepLoading] = useState(false);

  const [initial, setInitial] = useState<TenantSelf | null>(null);
  const [form, setForm] = useState({ ...EMPTY });

  // Seções colapsáveis
  const [openAddress, setOpenAddress] = useState(false);
  const [openResponsible, setOpenResponsible] = useState(false);
  const [openHours, setOpenHours] = useState(false);

  const set = (k: keyof typeof EMPTY, v: any) =>
    setForm((f) => ({ ...f, [k]: v }));

  const fetchTenant = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<TenantSelf>('/tenants/me');
      setInitial(res.data);
      setForm({
        name:               res.data.name || '',
        phone:              res.data.phone || '',
        email:              res.data.email || '',
        cpf_cnpj:           res.data.cpf_cnpj || '',
        zip_code:           res.data.zip_code || '',
        address:            res.data.address || '',
        address_number:     res.data.address_number || '',
        address_complement: res.data.address_complement || '',
        neighborhood:       res.data.neighborhood || '',
        city:               res.data.city || '',
        state:              res.data.state || '',
        responsible_name:   res.data.responsible_name || '',
        responsible_cro:    res.data.responsible_cro || '',
        business_hours:     res.data.business_hours || '',
      });
    } catch (e: any) {
      const raw = e?.response?.data?.message || '';
      setError(typeof raw === 'string' ? raw : 'Não foi possível carregar os dados da clínica.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTenant(); }, [fetchTenant]);

  // CEP auto-fill (ViaCEP)
  const handleCepBlur = useCallback(async () => {
    const cep = (form.zip_code || '').replace(/\D/g, '');
    if (cep.length !== 8) return;
    setCepLoading(true);
    try {
      const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
      const data = await res.json();
      if (data?.erro) return;
      setForm((f) => ({
        ...f,
        address: data.logradouro || f.address,
        neighborhood: data.bairro || f.neighborhood,
        city: data.localidade || f.city,
        state: data.uf || f.state,
      }));
    } catch { /* ignora */ }
    finally { setCepLoading(false); }
  }, [form.zip_code]);

  // ─── Quais campos essenciais faltam ──────────────────────────────
  const essentials = ['name', 'cpf_cnpj', 'phone', 'email'] as const;
  const missingCount = essentials.filter((k) => !(form as any)[k]?.trim()).length;

  const handleSave = async () => {
    setError(null);
    if (!form.name.trim()) { setError('Nome da clínica é obrigatório.'); return; }
    setSubmitting(true);
    try {
      const payload: any = {};
      const diffs: Array<keyof typeof EMPTY> = [
        'name', 'phone', 'email', 'cpf_cnpj',
        'zip_code', 'address', 'address_number', 'address_complement',
        'neighborhood', 'city', 'state',
        'responsible_name', 'responsible_cro', 'business_hours',
      ];
      for (const k of diffs) {
        const newVal = (form[k] ?? '').trim();
        const oldVal = (initial as any)?.[k] ?? '';
        if (newVal !== oldVal) {
          payload[k] = newVal || null;
        }
      }
      if (Object.keys(payload).length === 0) {
        setSuccess(true);
        await onSaved();
        setTimeout(() => setSuccess(false), 4000);
        return;
      }
      await api.patch('/tenants/me', payload);
      setInitial((cur) => cur ? { ...cur, ...payload } as TenantSelf : cur);
      setSuccess(true);
      await onSaved();
      setTimeout(() => setSuccess(false), 4000);
    } catch (e: any) {
      const raw = e?.response?.data?.message || '';
      if (typeof raw === 'string' && raw.startsWith('Cannot')) {
        setError('Servidor ainda não reconhece — deploy em andamento?');
      } else if (Array.isArray(raw)) {
        setError(raw.join(', '));
      } else {
        setError(raw || 'Falha ao salvar.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Onda 17.32.154 — min-height fixo evita layout shift
  const containerCls =
    'bg-emerald-500/5 border border-emerald-500/20 rounded-2xl p-5 min-h-[400px] max-h-[55vh] overflow-y-auto';

  if (loading) {
    return (
      <div className={containerCls}>
        <SkeletonForm />
      </div>
    );
  }

  return (
    <div className={containerCls}>
      {success && (
        <div className="mb-4 bg-emerald-500/15 border border-emerald-500/40 rounded-xl p-3 flex items-center gap-3 animate-in slide-in-from-top-2 duration-300">
          <div className="w-8 h-8 rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0">
            <CheckCircle2 size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-emerald-700 dark:text-emerald-400">
              ✓ Dados da clínica confirmados!
            </p>
            <p className="text-xs text-emerald-700/80 dark:text-emerald-400/80">
              Sua clínica está pronta — partiu próximo passo.
            </p>
          </div>
        </div>
      )}

      {!success && (
        <div className="mb-4 flex items-center gap-2 text-xs">
          {missingCount === 0 ? (
            <>
              <CheckCircle2 size={14} className="text-emerald-500" />
              <span className="text-emerald-700 dark:text-emerald-400 font-bold">
                Todos os dados essenciais já estão preenchidos.
              </span>
              <span className="text-muted-foreground">Pode confirmar.</span>
            </>
          ) : (
            <>
              <AlertCircle size={14} className="text-amber-500" />
              <span className="text-amber-700 dark:text-amber-400 font-bold">
                Faltam {missingCount} de {essentials.length} essenciais
              </span>
              <span className="text-muted-foreground">— complete pra finalizar.</span>
            </>
          )}
        </div>
      )}

      {/* ─── Identificação ─────────────────────────────────────── */}
      <SectionTitle icon="🏢">Identificação</SectionTitle>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="md:col-span-2">
          <label className={labelCls}>
            Nome da clínica / consultório *
            {!form.name?.trim() && <span className="ml-2 text-amber-500 normal-case">Obrigatório</span>}
          </label>
          <input type="text" value={form.name || ''} onChange={(e) => set('name', e.target.value)}
                 placeholder="Ex: Instituto Odonto Passos" className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>
            CPF ou CNPJ
            {!form.cpf_cnpj?.trim() && <span className="ml-2 text-amber-500 normal-case">Faltando</span>}
          </label>
          <input type="text" value={form.cpf_cnpj || ''} onChange={(e) => set('cpf_cnpj', e.target.value)}
                 placeholder="00.000.000/0001-00" className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>
            Telefone principal
            {!form.phone?.trim() && <span className="ml-2 text-amber-500 normal-case">Faltando</span>}
          </label>
          <input type="tel" value={form.phone || ''} onChange={(e) => set('phone', e.target.value)}
                 placeholder="(11) 99999-8888" className={inputCls} />
        </div>
        <div className="md:col-span-2">
          <label className={labelCls}>
            E-mail de contato
            {!form.email?.trim() && <span className="ml-2 text-amber-500 normal-case">Faltando</span>}
          </label>
          <input type="email" value={form.email || ''} onChange={(e) => set('email', e.target.value)}
                 placeholder="contato@suaclinica.com.br" className={inputCls} />
        </div>
      </div>

      {/* ─── Endereço (colapsável) ─────────────────────────────── */}
      <Toggle icon={<Home size={14} />} label="Endereço" open={openAddress}
              onToggle={() => setOpenAddress((v) => !v)} />
      {openAddress && (
        <div className="grid grid-cols-1 md:grid-cols-6 gap-3 mb-4">
          <div className="md:col-span-2">
            <label className={labelCls}>CEP</label>
            <div className="relative">
              <input type="text" value={form.zip_code || ''}
                     onChange={(e) => set('zip_code', e.target.value)}
                     onBlur={handleCepBlur} placeholder="00000-000" className={inputCls} />
              {cepLoading && <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 animate-spin text-emerald-500" size={14} />}
            </div>
          </div>
          <div className="md:col-span-4">
            <label className={labelCls}>Rua / Logradouro</label>
            <input type="text" value={form.address || ''} onChange={(e) => set('address', e.target.value)} className={inputCls} />
          </div>
          <div className="md:col-span-2">
            <label className={labelCls}>Número</label>
            <input type="text" value={form.address_number || ''} onChange={(e) => set('address_number', e.target.value)} className={inputCls} />
          </div>
          <div className="md:col-span-4">
            <label className={labelCls}>Complemento</label>
            <input type="text" value={form.address_complement || ''} onChange={(e) => set('address_complement', e.target.value)}
                   placeholder="Sala, andar, bloco…" className={inputCls} />
          </div>
          <div className="md:col-span-3">
            <label className={labelCls}>Bairro</label>
            <input type="text" value={form.neighborhood || ''} onChange={(e) => set('neighborhood', e.target.value)} className={inputCls} />
          </div>
          <div className="md:col-span-2">
            <label className={labelCls}>Cidade</label>
            <input type="text" value={form.city || ''} onChange={(e) => set('city', e.target.value)} className={inputCls} />
          </div>
          <div className="md:col-span-1">
            <label className={labelCls}>UF</label>
            <select value={form.state || ''} onChange={(e) => set('state', e.target.value)} className={`${inputCls} cursor-pointer`}>
              <option value="">—</option>
              {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* ─── Responsável Técnico (colapsável) ──────────────────── */}
      <Toggle icon={<ShieldCheck size={14} />} label="Responsável técnico (dentista responsável)"
              open={openResponsible} onToggle={() => setOpenResponsible((v) => !v)} />
      {openResponsible && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
          <div>
            <label className={labelCls}>Nome completo</label>
            <input type="text" value={form.responsible_name || ''}
                   onChange={(e) => set('responsible_name', e.target.value)}
                   placeholder="Dr(a). Nome do dentista" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>CRO (Registro do CRO)</label>
            <input type="text" value={form.responsible_cro || ''}
                   onChange={(e) => set('responsible_cro', e.target.value)}
                   placeholder="ex: 12345-SP" className={inputCls} />
          </div>
        </div>
      )}

      {/* ─── Horário de Funcionamento (colapsável) ─────────────── */}
      <Toggle icon={<Clock size={14} />} label="Horário de funcionamento"
              open={openHours} onToggle={() => setOpenHours((v) => !v)} />
      {openHours && (
        <div className="mb-4">
          <label className={labelCls}>Texto livre — descreva como sua clínica atende</label>
          <textarea value={form.business_hours || ''} onChange={(e) => set('business_hours', e.target.value)}
                    rows={3}
                    placeholder="Ex: Seg a Sex 08:00–18:00, Sáb 08:00–12:00"
                    className={inputCls} />
        </div>
      )}

      <p className="mt-3 text-[11px] text-muted-foreground">
        💡 Esses dados aparecem em <b>recibos, contratos, notas fiscais</b> e no rodapé do sistema. Vale conferir.
      </p>

      <button type="button" disabled={submitting || !form.name?.trim()} onClick={handleSave}
              className="mt-4 w-full inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm shadow-[0_6px_18px_-4px_rgba(16,185,129,0.5)] transition-all disabled:opacity-50 disabled:cursor-not-allowed">
        {submitting ? <Loader2 className="animate-spin" size={16} /> : missingCount === 0 ? <CheckCircle2 size={16} /> : <Save size={16} />}
        {submitting ? 'Salvando…' : missingCount === 0 ? 'Confirmar dados' : 'Salvar e continuar'}
      </button>

      {error && (
        <p className="mt-3 text-xs text-rose-600 dark:text-rose-400 flex items-start gap-1.5">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 mb-2 text-xs font-bold text-emerald-700 dark:text-emerald-400">
      <span>{icon}</span>
      <span className="uppercase tracking-wider">{children}</span>
    </div>
  );
}

function Toggle({
  icon, label, open, onToggle,
}: {
  icon: React.ReactNode; label: string; open: boolean; onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="mt-4 mb-2 w-full flex items-center justify-between p-2 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/15 transition-colors text-left"
    >
      <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
        {icon}
        {label}
      </span>
      <span className="text-emerald-700 dark:text-emerald-400">{open ? '▲' : '▼'}</span>
    </button>
  );
}

/** Skeleton que ocupa o mesmo espaço do form preenchido — evita
    o "pop" de layout shift quando o GET termina. */
function SkeletonForm() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="h-3 w-48 bg-emerald-500/20 rounded mb-4" />
      <div className="h-4 w-36 bg-emerald-500/20 rounded mt-2" />
      <div className="h-10 bg-emerald-500/10 rounded-lg" />
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="h-3 w-24 bg-emerald-500/20 rounded mb-2" />
          <div className="h-10 bg-emerald-500/10 rounded-lg" />
        </div>
        <div>
          <div className="h-3 w-24 bg-emerald-500/20 rounded mb-2" />
          <div className="h-10 bg-emerald-500/10 rounded-lg" />
        </div>
      </div>
      <div className="h-3 w-24 bg-emerald-500/20 rounded mb-2 mt-2" />
      <div className="h-10 bg-emerald-500/10 rounded-lg" />
      <div className="h-10 bg-emerald-500/10 rounded-lg mt-6 w-full" />
    </div>
  );
}
