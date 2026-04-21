'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowDownUp, Loader2, Plus, X, ArrowDown, ArrowUp, RotateCcw, Trash2,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Product {
  id: string;
  name: string;
  brand: string | null;
  unit: string;
  current_stock: string;
  requires_lot_tracking: boolean;
  has_expiration: boolean;
}

interface Movement {
  id: string;
  type: string;
  quantity: string;
  unit_cost: string | null;
  total_cost: string | null;
  batch_number: string | null;
  expiration_date: string | null;
  notes: string | null;
  performed_at: string;
  product?: { id: string; name: string; brand: string | null; unit: string } | null;
  supplier?: { id: string; name: string } | null;
}

const TYPES = ['ENTRADA', 'SAIDA', 'AJUSTE', 'DESCARTE_VENCIMENTO', 'PERDA'];

const TYPE_CFG: Record<string, { label: string; cls: string; icon: any }> = {
  ENTRADA:             { label: 'Entrada',         cls: 'bg-green-500/10 text-green-700 border-green-500/20',   icon: ArrowDown },
  SAIDA:               { label: 'Saida',           cls: 'bg-blue-500/10 text-blue-700 border-blue-500/20',      icon: ArrowUp },
  AJUSTE:              { label: 'Ajuste',          cls: 'bg-amber-500/10 text-amber-700 border-amber-500/20',   icon: RotateCcw },
  DESCARTE_VENCIMENTO: { label: 'Vencimento',      cls: 'bg-red-500/10 text-red-700 border-red-500/20',         icon: Trash2 },
  PERDA:               { label: 'Perda',           cls: 'bg-red-500/10 text-red-700 border-red-500/20',         icon: Trash2 },
};

export default function MovementsTab() {
  const [loading, setLoading] = useState(true);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [typeFilter, setTypeFilter] = useState('');
  const [openModal, setOpenModal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (typeFilter) params.set('type', typeFilter);
      const { data } = await api.get<{ data: Movement[] }>(`/stock-movements?${params}`);
      setMovements(data?.data || []);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar movimentacoes');
    } finally {
      setLoading(false);
    }
  }, [typeFilter]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        >
          <option value="">Todos os tipos</option>
          {TYPES.map((t) => <option key={t} value={t}>{TYPE_CFG[t]?.label || t}</option>)}
        </select>
        <div className="flex-1" />
        <button
          onClick={() => setOpenModal(true)}
          className="inline-flex items-center gap-1 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
        >
          <Plus size={16} /> Nova movimentacao
        </button>
      </div>

      {loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : movements.length === 0 ? (
        <div className="p-12 text-center text-sm text-muted-foreground">
          <ArrowDownUp size={28} className="mx-auto mb-2 opacity-50" />
          Nenhuma movimentacao registrada.
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2">Data</th>
                <th className="px-3 py-2">Tipo</th>
                <th className="px-3 py-2">Produto</th>
                <th className="px-3 py-2 text-right">Qtd</th>
                <th className="px-3 py-2">Lote</th>
                <th className="px-3 py-2">Validade</th>
                <th className="px-3 py-2">Origem</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((m) => {
                const cfg = TYPE_CFG[m.type] || TYPE_CFG.AJUSTE;
                const TypeIcon = cfg.icon;
                return (
                  <tr key={m.id} className="border-b border-border hover:bg-accent/30">
                    <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(m.performed_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border ${cfg.cls}`}>
                        <TypeIcon size={11} /> {cfg.label}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{m.product?.name || '—'}</div>
                      {m.product?.brand && <div className="text-xs text-muted-foreground">{m.product.brand}</div>}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {m.quantity} {m.product?.unit}
                    </td>
                    <td className="px-3 py-2 text-xs font-mono">{m.batch_number || '—'}</td>
                    <td className="px-3 py-2 text-xs">
                      {m.expiration_date
                        ? new Date(m.expiration_date).toLocaleDateString('pt-BR')
                        : '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {m.supplier?.name || (m.notes ? <span className="italic">{m.notes.slice(0, 40)}{m.notes.length > 40 ? '...' : ''}</span> : '—')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {openModal && (
        <NewMovementModal
          onClose={() => setOpenModal(false)}
          onCreated={() => {
            setOpenModal(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function NewMovementModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [saving, setSaving] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);

  const [productId, setProductId] = useState('');
  const [type, setType] = useState('ENTRADA');
  const [quantity, setQuantity] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [batchNumber, setBatchNumber] = useState('');
  const [expirationDate, setExpirationDate] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get<{ data: Product[] }>('/products?limit=200&active=true');
        setProducts(data?.data || []);
      } catch {
        // ignora
      }
    })();
  }, []);

  const selectedProduct = products.find((p) => p.id === productId);
  const requiresLot = selectedProduct?.requires_lot_tracking ?? false;
  const requiresExpiration = (selectedProduct?.has_expiration ?? false) && type === 'ENTRADA';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!productId) {
      showError('Selecione um produto');
      return;
    }
    if (!quantity || parseFloat(quantity) <= 0) {
      showError('Quantidade deve ser positiva');
      return;
    }
    if (requiresLot && !batchNumber.trim()) {
      showError(`Produto exige rastreabilidade ANVISA. Informe o lote.`);
      return;
    }
    if (requiresExpiration && !expirationDate) {
      showError('Produto exige validade na entrada');
      return;
    }

    setSaving(true);
    try {
      await api.post('/stock-movements', {
        product_id: productId,
        type,
        quantity: parseFloat(quantity),
        unit_cost: unitCost ? parseFloat(unitCost) : undefined,
        batch_number: batchNumber.trim() || undefined,
        expiration_date: expirationDate || undefined,
        notes: notes.trim() || undefined,
      });
      showSuccess('Movimentacao registrada');
      onCreated();
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
        className="bg-card border border-border rounded-xl w-full max-w-lg shadow-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <ArrowDownUp size={20} className="text-primary" /> Nova movimentacao
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="p-4 space-y-3 overflow-y-auto">
          <div>
            <label className="block text-xs font-medium mb-1">Produto *</label>
            <select
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              required
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="">— escolha —</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.brand ? ` — ${p.brand}` : ''} (estoque: {p.current_stock} {p.unit})
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Tipo *</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                {TYPES.map((t) => <option key={t} value={t}>{TYPE_CFG[t]?.label || t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Quantidade *</label>
              <input
                type="number"
                step="0.001"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                required
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          {(requiresLot || type === 'ENTRADA') && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">
                  Lote {requiresLot && <span className="text-destructive">*ANVISA</span>}
                </label>
                <input
                  type="text"
                  value={batchNumber}
                  onChange={(e) => setBatchNumber(e.target.value)}
                  className={`w-full px-3 py-2 rounded-lg bg-background border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 ${
                    requiresLot && !batchNumber ? 'border-destructive/50' : 'border-border'
                  }`}
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">
                  Validade {requiresExpiration && <span className="text-destructive">*</span>}
                </label>
                <input
                  type="date"
                  value={expirationDate}
                  onChange={(e) => setExpirationDate(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            </div>
          )}

          {type === 'ENTRADA' && (
            <div>
              <label className="block text-xs font-medium mb-1">Custo unitario (R$)</label>
              <input
                type="number"
                step="0.01"
                value={unitCost}
                onChange={(e) => setUnitCost(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium mb-1">Observacoes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
              placeholder="Motivo do ajuste, notas da entrega, etc."
            />
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-accent"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
              Registrar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
