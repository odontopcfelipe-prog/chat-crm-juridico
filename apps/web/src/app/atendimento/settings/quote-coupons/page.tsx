'use client';

/**
 * Settings → Cupons de Desconto (Fase 24 — Onda 2).
 *
 * Admin cria cupons promocionais com código, tipo de desconto (% ou R$),
 * validade e limite de usos. Operador digita o código no orçamento e
 * desconto é aplicado automaticamente.
 */
import { useEffect, useState, FormEvent } from 'react';
import {
  Tag, Loader2, Plus, Pencil, Trash2, X, Save, Calendar,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Coupon {
  id: string;
  code: string;
  description: string | null;
  discount_type: 'PERCENT' | 'FIXED';
  discount_amount: string | number;
  valid_from: string | null;
  valid_until: string | null;
  max_uses: number | null;
  used_count: number;
  min_order_value: string | number | null;
  is_active: boolean;
  notes: string | null;
}

const formatBRL = (v: number | string) =>
  Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function QuoteCouponsSettingsPage() {
  const [list, setList] = useState<Coupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Coupon | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get<Coupon[]>('/quote-coupons');
      setList(data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleDelete = async (c: Coupon) => {
    if (!confirm(`Remover cupom "${c.code}"?`)) return;
    try {
      await api.delete(`/quote-coupons/${c.id}`);
      showSuccess('Cupom removido');
      load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao remover');
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Tag size={24} className="text-primary" /> Cupons de Desconto
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Códigos promocionais (FRIEND15, BLACKFRIDAY) que dão desconto automático
            no orçamento. Use pra promoções, indicações e parcerias.
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-medium"
        >
          <Plus size={16} /> Novo cupom
        </button>
      </div>

      {loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : list.length === 0 ? (
        <div className="p-12 text-center bg-card border border-border rounded-xl">
          <Tag size={28} className="mx-auto mb-2 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground mb-3">Nenhum cupom cadastrado.</p>
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
          >
            <Plus size={14} /> Criar primeiro cupom
          </button>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Código</th>
                <th className="text-left px-4 py-2 font-medium">Desconto</th>
                <th className="text-left px-4 py-2 font-medium">Validade</th>
                <th className="text-right px-4 py-2 font-medium">Usos</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-right px-4 py-2 font-medium">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.map((c) => {
                const expired = c.valid_until && new Date(c.valid_until) < new Date();
                const limitReached = c.max_uses !== null && c.used_count >= c.max_uses;
                return (
                  <tr key={c.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <div className="font-mono font-bold">{c.code}</div>
                      {c.description && (
                        <div className="text-xs text-muted-foreground">{c.description}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-semibold">
                      {c.discount_type === 'PERCENT'
                        ? `${Number(c.discount_amount)}%`
                        : formatBRL(c.discount_amount)}
                      {c.min_order_value && (
                        <div className="text-xs text-muted-foreground font-normal">
                          mín. {formatBRL(c.min_order_value)}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {c.valid_from && (
                        <div>De {new Date(c.valid_from).toLocaleDateString('pt-BR')}</div>
                      )}
                      {c.valid_until ? (
                        <div className={expired ? 'text-red-600' : ''}>
                          Até {new Date(c.valid_until).toLocaleDateString('pt-BR')}
                          {expired && ' (vencido)'}
                        </div>
                      ) : (
                        <div className="text-muted-foreground">Sem prazo</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-xs">
                      <div className={limitReached ? 'text-red-600' : ''}>
                        {c.used_count}{c.max_uses !== null ? ` / ${c.max_uses}` : ''}
                      </div>
                      {limitReached && <div className="text-red-600">esgotado</div>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                        c.is_active && !expired && !limitReached
                          ? 'bg-emerald-500/10 text-emerald-600'
                          : 'bg-muted text-muted-foreground'
                      }`}>
                        {c.is_active && !expired && !limitReached ? 'Ativo' : 'Inativo'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setEditing(c)}
                        className="text-muted-foreground hover:text-foreground p-1 mr-1"
                        title="Editar"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => handleDelete(c)}
                        className="text-muted-foreground hover:text-destructive p-1"
                        title="Remover"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(creating || editing) && (
        <CouponModal
          coupon={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function CouponModal({
  coupon, onClose, onSaved,
}: { coupon: Coupon | null; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!coupon;
  const [code, setCode] = useState(coupon?.code || '');
  const [description, setDescription] = useState(coupon?.description || '');
  const [discountType, setDiscountType] = useState<'PERCENT' | 'FIXED'>(coupon?.discount_type || 'PERCENT');
  const [discountAmount, setDiscountAmount] = useState(coupon ? String(coupon.discount_amount) : '');
  const [validFrom, setValidFrom] = useState(coupon?.valid_from?.slice(0, 10) || '');
  const [validUntil, setValidUntil] = useState(coupon?.valid_until?.slice(0, 10) || '');
  const [maxUses, setMaxUses] = useState(coupon?.max_uses?.toString() || '');
  const [minOrder, setMinOrder] = useState(coupon?.min_order_value ? String(coupon.min_order_value) : '');
  const [isActive, setIsActive] = useState(coupon?.is_active !== false);
  const [notes, setNotes] = useState(coupon?.notes || '');
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return showError('Código obrigatório');
    if (!discountAmount || Number(discountAmount) <= 0) return showError('Desconto inválido');
    setSaving(true);
    try {
      const payload = {
        code: code.trim().toUpperCase(),
        description: description.trim() || null,
        discount_type: discountType,
        discount_amount: Number(discountAmount),
        valid_from: validFrom || null,
        valid_until: validUntil || null,
        max_uses: maxUses ? Number(maxUses) : null,
        min_order_value: minOrder ? Number(minOrder) : null,
        is_active: isActive,
        notes: notes.trim() || null,
      };
      if (isEdit) {
        await api.patch(`/quote-coupons/${coupon!.id}`, payload);
        showSuccess('Cupom atualizado');
      } else {
        await api.post('/quote-coupons', payload);
        showSuccess('Cupom criado');
      }
      onSaved();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Tag size={18} className="text-primary" />
            <h2 className="text-base font-semibold">{isEdit ? 'Editar cupom' : 'Novo cupom'}</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Código *</label>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                required
                placeholder="FRIEND15"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Tipo de desconto</label>
              <select
                value={discountType}
                onChange={(e) => setDiscountType(e.target.value as any)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm"
              >
                <option value="PERCENT">Percentual (%)</option>
                <option value="FIXED">Valor fixo (R$)</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">
              Valor do desconto * {discountType === 'PERCENT' ? '(%)' : '(R$)'}
            </label>
            <input
              type="number"
              step="0.01"
              min={0}
              value={discountAmount}
              onChange={(e) => setDiscountAmount(e.target.value)}
              required
              placeholder={discountType === 'PERCENT' ? '15' : '250.00'}
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Descrição</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Ex: Indicação de amigos · 15% off"
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Válido a partir</label>
              <input
                type="date"
                value={validFrom}
                onChange={(e) => setValidFrom(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Válido até</label>
              <input
                type="date"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Limite de usos</label>
              <input
                type="number"
                min={1}
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
                placeholder="Ilimitado"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Valor mín. orçamento (R$)</label>
              <input
                type="number"
                step="0.01"
                min={0}
                value={minOrder}
                onChange={(e) => setMinOrder(e.target.value)}
                placeholder="Sem mínimo"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="w-4 h-4 rounded border-border"
            />
            Cupom ativo (operadores podem aplicar)
          </label>

          <div className="flex justify-end gap-2 pt-2 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 rounded-lg border border-border text-sm hover:bg-accent"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {isEdit ? 'Salvar' : 'Criar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
