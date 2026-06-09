'use client';

/**
 * Onda 17.32.152 — Revisão de identidade da clínica (passo 1 do
 * Onboarding Wizard).
 *
 * Pega dados atuais do tenant (que vieram do signup) e permite
 * confirmar/ajustar. Os 4 campos essenciais (Nome, CNPJ/CPF,
 * Telefone, E-mail) aparecem em pré-recibos, contratos, NFs e
 * cabeçalhos de sistema — por isso são obrigatórios pra etapa
 * ficar "Pronto" pelo auto-detect do backend.
 *
 * Endpoint usado: PATCH /tenants/me (mesmo da página /settings/identidade).
 */
import { useState, useEffect, useCallback } from 'react';
import {
  CheckCircle2, Loader2, Building2, AlertCircle, Save,
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
}

interface Props {
  alreadyDone?: boolean;
  onSaved: () => Promise<void>;
}

const inputCls =
  'w-full px-3 py-2 rounded-lg bg-white dark:bg-card border border-border text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 transition-all';
const labelCls =
  'block text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1';

export default function ClinicIdentityReview({ alreadyDone = false, onSaved }: Props) {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Snapshot inicial (pra detectar mudanças)
  const [initial, setInitial] = useState<TenantSelf | null>(null);
  const [name, setName] = useState('');
  const [cpfCnpj, setCpfCnpj] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');

  const fetchTenant = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get<TenantSelf>('/tenants/me');
      setInitial(res.data);
      setName(res.data.name || '');
      setCpfCnpj(res.data.cpf_cnpj || '');
      setPhone(res.data.phone || '');
      setEmail(res.data.email || '');
    } catch (e: any) {
      const raw = e?.response?.data?.message || '';
      setError(typeof raw === 'string' ? raw : 'Não foi possível carregar os dados da clínica.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTenant(); }, [fetchTenant]);

  // ─── Quais campos faltam ─────────────────────────────────────────
  const fieldStatus = (val: string, initialVal?: string | null) => {
    const trimmed = val.trim();
    const hadBefore = !!initialVal?.trim();
    if (!trimmed) return 'missing';      // vazio
    if (!hadBefore) return 'new';        // user acabou de preencher
    if (trimmed !== initialVal) return 'edited';
    return 'unchanged';
  };

  const missingCount = [name, cpfCnpj, phone, email].filter((v) => !v.trim()).length;

  // ─── Save ────────────────────────────────────────────────────────
  const handleSave = async () => {
    setError(null);
    if (!name.trim()) {
      setError('Nome da clínica é obrigatório.');
      return;
    }
    setSubmitting(true);
    try {
      const payload: any = {};
      if (name.trim() !== (initial?.name || ''))        payload.name = name.trim();
      if (cpfCnpj.trim() !== (initial?.cpf_cnpj || '')) payload.cpf_cnpj = cpfCnpj.trim() || null;
      if (phone.trim() !== (initial?.phone || ''))      payload.phone = phone.trim() || null;
      if (email.trim() !== (initial?.email || ''))      payload.email = email.trim() || null;

      if (Object.keys(payload).length === 0) {
        // Nada mudou — só confirma
        setSuccess(true);
        await onSaved();
        setTimeout(() => setSuccess(false), 4000);
        return;
      }

      await api.patch('/tenants/me', payload);
      // Atualiza o snapshot
      setInitial({ ...(initial as TenantSelf), name: name.trim(), cpf_cnpj: cpfCnpj.trim(), phone: phone.trim(), email: email.trim() });
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

  // ─── Render ──────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-2xl p-8 flex items-center justify-center gap-3">
        <Loader2 className="animate-spin text-emerald-500" size={20} />
        <span className="text-sm text-muted-foreground">Carregando dados da clínica…</span>
      </div>
    );
  }

  return (
    <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-2xl p-5 max-h-[55vh] overflow-y-auto">
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

      {/* Resumo do estado atual */}
      {!success && (
        <div className="mb-4 flex items-center gap-2 text-xs">
          {missingCount === 0 ? (
            <>
              <CheckCircle2 size={14} className="text-emerald-500" />
              <span className="text-emerald-700 dark:text-emerald-400 font-bold">
                Todos os dados essenciais já estão preenchidos.
              </span>
              <span className="text-muted-foreground">Confira e clique em "Confirmar".</span>
            </>
          ) : (
            <>
              <AlertCircle size={14} className="text-amber-500" />
              <span className="text-amber-700 dark:text-amber-400 font-bold">
                Faltam {missingCount} de 4 informações
              </span>
              <span className="text-muted-foreground">— complete pra finalizar o cadastro da clínica.</span>
            </>
          )}
        </div>
      )}

      {/* Campos */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="md:col-span-2">
          <label className={labelCls}>
            Nome da clínica / consultório *
            {fieldStatus(name, initial?.name) === 'missing' && (
              <span className="ml-2 text-amber-500 normal-case">Obrigatório</span>
            )}
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex: Instituto Odonto Passos"
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>
            CPF ou CNPJ
            {fieldStatus(cpfCnpj, initial?.cpf_cnpj) === 'missing' && (
              <span className="ml-2 text-amber-500 normal-case">Faltando</span>
            )}
          </label>
          <input
            type="text"
            value={cpfCnpj}
            onChange={(e) => setCpfCnpj(e.target.value)}
            placeholder="00.000.000/0001-00"
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>
            Telefone principal
            {fieldStatus(phone, initial?.phone) === 'missing' && (
              <span className="ml-2 text-amber-500 normal-case">Faltando</span>
            )}
          </label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(11) 99999-8888"
            className={inputCls}
          />
        </div>
        <div className="md:col-span-2">
          <label className={labelCls}>
            E-mail de contato
            {fieldStatus(email, initial?.email) === 'missing' && (
              <span className="ml-2 text-amber-500 normal-case">Faltando</span>
            )}
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="contato@suaclinica.com.br"
            className={inputCls}
          />
        </div>
      </div>

      <p className="mt-3 text-[11px] text-muted-foreground">
        💡 Esses dados aparecem em <b>recibos, contratos, notas fiscais</b> e cabeçalhos do sistema. Vale a pena conferir.
      </p>

      <button
        type="button"
        disabled={submitting || !name.trim()}
        onClick={handleSave}
        className="mt-4 w-full inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm shadow-[0_6px_18px_-4px_rgba(16,185,129,0.5)] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
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
