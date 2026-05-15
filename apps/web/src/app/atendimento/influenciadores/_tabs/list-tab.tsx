'use client';

/**
 * Aba "Lista" — cadastro CRUD de influenciadores.
 * (Movida de page.tsx quando a página virou container com tabs.)
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus, Search, Loader2, Pencil, Trash2,
  Instagram, Music2, Youtube, Globe, Phone, Mail, AtSign,
  Tag, Users as UsersIcon, Pause, CheckCircle2, XCircle, Megaphone,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import ModalBase from '@/components/ModalBase';
import { inputCls, Field, formatBRL } from './ui-shared';

type Platform = 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE' | 'OUTRO';
type CommissionType = 'PERCENTUAL' | 'FIXO' | 'PERMUTA';
type Status = 'ATIVO' | 'PAUSADO' | 'INATIVO';

export interface Influencer {
  id: string;
  name: string;
  handle: string | null;
  phone: string | null;
  email: string | null;
  platform: Platform | null;
  followers: number | null;
  niche: string | null;
  commission_type: CommissionType | null;
  commission_value: string | null;
  coupon_code: string | null;
  status: Status;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const STATUS_CFG: Record<Status, { label: string; cls: string; icon: React.ElementType }> = {
  ATIVO:    { label: 'Ativo',    cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20', icon: CheckCircle2 },
  PAUSADO:  { label: 'Pausado',  cls: 'bg-amber-500/10 text-amber-600 border-amber-500/20',       icon: Pause },
  INATIVO:  { label: 'Inativo',  cls: 'bg-muted text-muted-foreground border-border',             icon: XCircle },
};

const PLATFORM_ICON: Record<Platform, React.ElementType> = {
  INSTAGRAM: Instagram,
  TIKTOK: Music2,
  YOUTUBE: Youtube,
  OUTRO: Globe,
};

const COMMISSION_LABEL: Record<CommissionType, string> = {
  PERCENTUAL: '% sobre venda',
  FIXO: 'R$ por lead/venda',
  PERMUTA: 'Permuta',
};

const formatFollowers = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.0', '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace('.0', '')}k`;
  return String(n);
};

interface FormState {
  name: string;
  handle: string;
  phone: string;
  email: string;
  platform: Platform | '';
  followers: string;
  niche: string;
  commission_type: CommissionType | '';
  commission_value: string;
  coupon_code: string;
  status: Status;
  notes: string;
}

const EMPTY_FORM: FormState = {
  name: '', handle: '', phone: '', email: '',
  platform: '', followers: '', niche: '',
  commission_type: '', commission_value: '', coupon_code: '',
  status: 'ATIVO', notes: '',
};

export function ListTab() {
  const [items, setItems] = useState<Influencer[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<Status | ''>('');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Influencer | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (statusFilter) params.status = statusFilter;
      if (debouncedQuery) params.q = debouncedQuery;
      const { data } = await api.get<Influencer[]>('/influencers', { params });
      setItems(Array.isArray(data) ? data : []);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar influenciadores');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, debouncedQuery]);

  useEffect(() => { fetchList(); }, [fetchList]);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setModalOpen(true);
  };

  const openEdit = (inf: Influencer) => {
    setEditing(inf);
    setForm({
      name: inf.name,
      handle: inf.handle || '',
      phone: inf.phone || '',
      email: inf.email || '',
      platform: (inf.platform || '') as Platform | '',
      followers: inf.followers != null ? String(inf.followers) : '',
      niche: inf.niche || '',
      commission_type: (inf.commission_type || '') as CommissionType | '',
      commission_value: inf.commission_value != null ? String(inf.commission_value) : '',
      coupon_code: inf.coupon_code || '',
      status: inf.status,
      notes: inf.notes || '',
    });
    setModalOpen(true);
  };

  const closeModal = () => {
    if (saving) return;
    setModalOpen(false);
    setEditing(null);
  };

  const handleSave = async () => {
    if (!form.name.trim()) { showError('Nome é obrigatório'); return; }
    setSaving(true);
    try {
      const payload: any = {
        name: form.name.trim(),
        handle: form.handle.trim() || null,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        platform: form.platform || null,
        followers: form.followers.trim() ? Number(form.followers) : null,
        niche: form.niche.trim() || null,
        commission_type: form.commission_type || null,
        commission_value: form.commission_value.trim() ? Number(form.commission_value) : null,
        coupon_code: form.coupon_code.trim() || null,
        status: form.status,
        notes: form.notes.trim() || null,
      };
      if (editing) {
        await api.patch(`/influencers/${editing.id}`, payload);
        showSuccess('Influenciador atualizado');
      } else {
        await api.post('/influencers', payload);
        showSuccess('Influenciador cadastrado');
      }
      setModalOpen(false);
      setEditing(null);
      fetchList();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (inf: Influencer) => {
    if (!confirm(`Remover "${inf.name}"? Esta ação não pode ser desfeita.`)) return;
    try {
      await api.delete(`/influencers/${inf.id}`);
      showSuccess('Influenciador removido');
      fetchList();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao remover');
    }
  };

  const counts = useMemo(() => {
    const acc: Record<Status, number> = { ATIVO: 0, PAUSADO: 0, INATIVO: 0 };
    items.forEach(i => { acc[i.status] = (acc[i.status] || 0) + 1; });
    return acc;
  }, [items]);

  return (
    <div>
      {/* ─── Toolbar: contagem + CTA ─── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <p className="text-xs text-muted-foreground">
          {counts.ATIVO} ativo{counts.ATIVO === 1 ? '' : 's'} · {counts.PAUSADO} pausado{counts.PAUSADO === 1 ? '' : 's'} · {counts.INATIVO} inativo{counts.INATIVO === 1 ? '' : 's'}
        </p>
        <button
          onClick={openCreate}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90 text-sm font-medium shadow-sm"
        >
          <Plus size={16} strokeWidth={2.5} /> Novo influenciador
        </button>
      </div>

      {/* ─── Filtros ─── */}
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Buscar por nome, @handle ou cupom..."
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value as Status | '')}
          className="px-3 py-2 rounded-lg bg-card border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
        >
          <option value="">Todos os status</option>
          <option value="ATIVO">Ativos ({counts.ATIVO})</option>
          <option value="PAUSADO">Pausados ({counts.PAUSADO})</option>
          <option value="INATIVO">Inativos ({counts.INATIVO})</option>
        </select>
      </div>

      {/* ─── Lista de cards ─── */}
      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-16 bg-card border border-dashed border-border rounded-xl">
          <Megaphone size={36} className="mx-auto mb-3 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground mb-1">
            {debouncedQuery || statusFilter
              ? 'Nenhum influenciador encontrado com esses filtros.'
              : 'Nenhum influenciador cadastrado ainda.'}
          </p>
          {!debouncedQuery && !statusFilter && (
            <button
              onClick={openCreate}
              className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:opacity-90 text-xs font-medium"
            >
              <Plus size={14} /> Cadastrar primeiro
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {items.map(inf => {
            const StatusIcon = STATUS_CFG[inf.status].icon;
            const PlatformIcon = inf.platform ? PLATFORM_ICON[inf.platform] : null;
            return (
              <div
                key={inf.id}
                className="bg-card border border-border rounded-xl p-4 hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-foreground truncate">{inf.name}</h3>
                    {inf.handle && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                        {PlatformIcon ? <PlatformIcon size={12} /> : <AtSign size={12} />}
                        @{inf.handle}
                        {inf.followers != null && (
                          <span className="ml-1 inline-flex items-center gap-0.5">
                            · <UsersIcon size={10} /> {formatFollowers(inf.followers)}
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                  <span className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-semibold ${STATUS_CFG[inf.status].cls}`}>
                    <StatusIcon size={10} /> {STATUS_CFG[inf.status].label}
                  </span>
                </div>

                <div className="space-y-1 text-xs text-muted-foreground mb-3">
                  {inf.phone && (
                    <p className="flex items-center gap-1.5"><Phone size={11} /> {inf.phone}</p>
                  )}
                  {inf.email && (
                    <p className="flex items-center gap-1.5"><Mail size={11} /> {inf.email}</p>
                  )}
                  {inf.niche && <p>Nicho: <span className="text-foreground">{inf.niche}</span></p>}
                  {inf.commission_type && (
                    <p>
                      Comissão: <span className="text-foreground">{COMMISSION_LABEL[inf.commission_type]}</span>
                      {inf.commission_value != null && inf.commission_type !== 'PERMUTA' && (
                        <span className="ml-1 text-foreground font-medium">
                          {inf.commission_type === 'PERCENTUAL'
                            ? `${Number(inf.commission_value)}%`
                            : formatBRL(inf.commission_value)}
                        </span>
                      )}
                    </p>
                  )}
                  {inf.coupon_code && (
                    <p className="flex items-center gap-1.5">
                      <Tag size={11} /> Cupom: <code className="bg-muted px-1.5 py-0.5 rounded text-foreground font-mono">{inf.coupon_code}</code>
                    </p>
                  )}
                </div>

                <div className="flex gap-2 pt-2 border-t border-border">
                  <button
                    onClick={() => openEdit(inf)}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-accent-foreground hover:bg-accent/80 text-xs font-medium"
                  >
                    <Pencil size={12} /> Editar
                  </button>
                  <button
                    onClick={() => handleDelete(inf)}
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-destructive hover:bg-destructive/10 text-xs font-medium"
                    title="Remover"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ─── Modal Cadastro/Edição ─── */}
      <ModalBase
        open={modalOpen}
        onClose={closeModal}
        title={editing ? 'Editar influenciador' : 'Novo influenciador'}
        subtitle={editing ? editing.name : 'Cadastro de parceria de marketing'}
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <button
              onClick={closeModal}
              disabled={saving}
              className="px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !form.name.trim()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90 text-sm font-medium disabled:opacity-50"
            >
              {saving && <Loader2 size={14} className="animate-spin" />}
              {editing ? 'Salvar alterações' : 'Cadastrar'}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <fieldset className="space-y-3">
            <legend className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Contato</legend>
            <Field label="Nome *">
              <input
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder="Nome completo do influenciador"
                className={inputCls}
              />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="@ (handle principal)">
                <input
                  value={form.handle}
                  onChange={e => setForm({ ...form, handle: e.target.value })}
                  placeholder="ex: anaodonto"
                  className={inputCls}
                />
              </Field>
              <Field label="Telefone">
                <input
                  value={form.phone}
                  onChange={e => setForm({ ...form, phone: e.target.value })}
                  placeholder="(82) 98888-7777"
                  className={inputCls}
                />
              </Field>
            </div>
            <Field label="E-mail">
              <input
                type="email"
                value={form.email}
                onChange={e => setForm({ ...form, email: e.target.value })}
                placeholder="contato@influencer.com"
                className={inputCls}
              />
            </Field>
          </fieldset>

          <fieldset className="space-y-3 pt-3 border-t border-border">
            <legend className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Plataforma & Audiência</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Plataforma principal">
                <select
                  value={form.platform}
                  onChange={e => setForm({ ...form, platform: e.target.value as Platform | '' })}
                  className={inputCls}
                >
                  <option value="">— Selecione —</option>
                  <option value="INSTAGRAM">Instagram</option>
                  <option value="TIKTOK">TikTok</option>
                  <option value="YOUTUBE">YouTube</option>
                  <option value="OUTRO">Outro</option>
                </select>
              </Field>
              <Field label="Nº de seguidores">
                <input
                  type="number"
                  min={0}
                  value={form.followers}
                  onChange={e => setForm({ ...form, followers: e.target.value })}
                  placeholder="ex: 25000"
                  className={inputCls}
                />
              </Field>
            </div>
            <Field label="Nicho / categoria">
              <input
                value={form.niche}
                onChange={e => setForm({ ...form, niche: e.target.value })}
                placeholder="ex: odonto, lifestyle, fitness, beleza"
                className={inputCls}
              />
            </Field>
          </fieldset>

          <fieldset className="space-y-3 pt-3 border-t border-border">
            <legend className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Comissão</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Modelo">
                <select
                  value={form.commission_type}
                  onChange={e => setForm({ ...form, commission_type: e.target.value as CommissionType | '' })}
                  className={inputCls}
                >
                  <option value="">— Selecione —</option>
                  <option value="PERCENTUAL">% sobre venda</option>
                  <option value="FIXO">R$ fixo por lead/venda</option>
                  <option value="PERMUTA">Permuta (sem dinheiro)</option>
                </select>
              </Field>
              <Field label={form.commission_type === 'PERCENTUAL' ? 'Valor (%)' : 'Valor (R$)'}>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.commission_value}
                  onChange={e => setForm({ ...form, commission_value: e.target.value })}
                  disabled={form.commission_type === 'PERMUTA' || !form.commission_type}
                  placeholder={form.commission_type === 'PERCENTUAL' ? '10' : '150.00'}
                  className={`${inputCls} disabled:opacity-50 disabled:cursor-not-allowed`}
                />
              </Field>
            </div>
            <Field
              label="Cupom de desconto associado (opcional)"
              hint="Útil para rastrear conversões. Único por clínica."
            >
              <input
                value={form.coupon_code}
                onChange={e => setForm({ ...form, coupon_code: e.target.value.toUpperCase() })}
                placeholder="ex: ANA10"
                className={`${inputCls} font-mono uppercase`}
              />
            </Field>
          </fieldset>

          <fieldset className="space-y-3 pt-3 border-t border-border">
            <legend className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Operacional</legend>
            <Field label="Status">
              <div className="flex gap-2">
                {(['ATIVO', 'PAUSADO', 'INATIVO'] as Status[]).map(s => {
                  const Icon = STATUS_CFG[s].icon;
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setForm({ ...form, status: s })}
                      className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                        form.status === s
                          ? STATUS_CFG[s].cls
                          : 'bg-card text-muted-foreground border-border hover:bg-accent/50'
                      }`}
                    >
                      <Icon size={12} /> {STATUS_CFG[s].label}
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="Observações">
              <textarea
                value={form.notes}
                onChange={e => setForm({ ...form, notes: e.target.value })}
                rows={3}
                placeholder="Anotações sobre a parceria, combinações, contatos do agente, etc."
                className={`${inputCls} resize-y`}
              />
            </Field>
          </fieldset>
        </div>
      </ModalBase>
    </div>
  );
}
