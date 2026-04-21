'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, Loader2, Package, Plus, Search, X,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Product {
  id: string;
  name: string;
  brand: string | null;
  sku: string | null;
  category: string | null;
  unit: string;
  current_stock: string;
  min_stock: string | null;
  cost_price: string | null;
  is_injectable: boolean;
  requires_lot_tracking: boolean;
  anvisa_registration: string | null;
  active: boolean;
  supplier?: { id: string; name: string } | null;
}

const CATEGORIES = [
  '', 'ANESTESICO', 'RESINA', 'BRACKETS', 'EQUIPAMENTO', 'DESCARTAVEL',
  'TOXINA_BOTULINICA', 'ACIDO_HIALURONICO', 'BIOESTIMULADOR',
  'FIO_PDO', 'FIO_PLLA', 'ENZIMA', 'PEELING_QUIMICO',
  'SKINBOOSTER', 'ANESTESICO_TOPICO', 'COSMETICO', 'OUTRO',
];

const UNITS = ['UN', 'ML', 'MG', 'UI', 'CAIXA', 'KIT', 'G', 'L'];

export default function ProductsTab() {
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [showLowStock, setShowLowStock] = useState(false);
  const [openModal, setOpenModal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ active: 'true', limit: '200' });
      if (search) params.set('search', search);
      if (category) params.set('category', category);
      if (showLowStock) params.set('lowStock', 'true');
      const { data } = await api.get<{ data: Product[] }>(`/products?${params}`);
      setProducts(data?.data || []);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar produtos');
    } finally {
      setLoading(false);
    }
  }, [search, category, showLowStock]);

  useEffect(() => {
    const debounce = setTimeout(load, 300);
    return () => clearTimeout(debounce);
  }, [load]);

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome, marca, SKU ou registro ANVISA..."
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        >
          <option value="">Todas as categorias</option>
          {CATEGORIES.filter(Boolean).map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm cursor-pointer hover:bg-accent">
          <input
            type="checkbox"
            checked={showLowStock}
            onChange={(e) => setShowLowStock(e.target.checked)}
            className="accent-primary"
          />
          <span>Baixo estoque</span>
        </label>
        <button
          onClick={() => setOpenModal(true)}
          className="inline-flex items-center gap-1 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
        >
          <Plus size={16} /> Novo produto
        </button>
      </div>

      {/* List */}
      {loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : products.length === 0 ? (
        <div className="p-12 text-center text-sm text-muted-foreground">
          <Package size={28} className="mx-auto mb-2 opacity-50" />
          Nenhum produto encontrado.
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2">Produto</th>
                <th className="px-3 py-2">Categoria</th>
                <th className="px-3 py-2 text-right">Estoque</th>
                <th className="px-3 py-2">Lote ANVISA</th>
                <th className="px-3 py-2">Fornecedor</th>
                <th className="px-3 py-2 text-right">Custo</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => {
                const stock = Number(p.current_stock);
                const min = p.min_stock ? Number(p.min_stock) : null;
                const isLow = min !== null && stock <= min;
                return (
                  <tr key={p.id} className="border-b border-border hover:bg-accent/30">
                    <td className="px-3 py-2">
                      <div className="font-medium">{p.name}</div>
                      {p.brand && <div className="text-xs text-muted-foreground">{p.brand}</div>}
                      {p.sku && <div className="text-[10px] text-muted-foreground font-mono">SKU: {p.sku}</div>}
                    </td>
                    <td className="px-3 py-2">
                      {p.category ? (
                        <span className="text-xs px-2 py-0.5 rounded bg-primary/10 text-primary">
                          {p.category}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className={`font-mono ${isLow ? 'text-destructive font-bold' : ''}`}>
                        {stock} {p.unit}
                      </span>
                      {isLow && (
                        <div className="text-[10px] text-destructive flex items-center justify-end gap-1 mt-0.5">
                          <AlertTriangle size={10} /> min: {min}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {p.requires_lot_tracking && (
                        <span className="text-xs px-2 py-0.5 rounded bg-amber-500/10 text-amber-600 border border-amber-500/20">
                          Rastreado
                        </span>
                      )}
                      {p.anvisa_registration && (
                        <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
                          {p.anvisa_registration}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {p.supplier?.name || '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-xs font-mono">
                      {p.cost_price ? `R$ ${Number(p.cost_price).toFixed(2)}` : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {openModal && (
        <NewProductModal
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

function NewProductModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [sku, setSku] = useState('');
  const [category, setCategory] = useState('');
  const [unit, setUnit] = useState('UN');
  const [anvisa, setAnvisa] = useState('');
  const [isInjectable, setIsInjectable] = useState(false);
  const [requiresLot, setRequiresLot] = useState(false);
  const [minStock, setMinStock] = useState('');
  const [costPrice, setCostPrice] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      showError('Nome e obrigatorio');
      return;
    }
    setSaving(true);
    try {
      await api.post('/products', {
        name: name.trim(),
        brand: brand.trim() || undefined,
        sku: sku.trim() || undefined,
        category: category || undefined,
        unit,
        anvisa_registration: anvisa.trim() || undefined,
        is_injectable: isInjectable,
        requires_lot_tracking: requiresLot,
        min_stock: minStock ? parseFloat(minStock) : undefined,
        cost_price: costPrice ? parseFloat(costPrice) : undefined,
      });
      showSuccess('Produto cadastrado');
      onCreated();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao cadastrar');
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
        className="bg-card border border-border rounded-xl w-full max-w-xl shadow-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Package size={20} className="text-primary" /> Novo produto
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="p-4 space-y-3 overflow-y-auto">
          <div>
            <label className="block text-xs font-medium mb-1">Nome *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Marca</label>
              <input
                type="text"
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">SKU</label>
              <input
                type="text"
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Categoria</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c || '—'}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Unidade</label>
              <select
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Registro ANVISA</label>
            <input
              type="text"
              value={anvisa}
              onChange={(e) => setAnvisa(e.target.value)}
              placeholder="ex: 80149310234"
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="flex flex-col gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isInjectable}
                onChange={(e) => setIsInjectable(e.target.checked)}
                className="accent-amber-500"
              />
              Produto injetavel (toxina, AH, bioestimulador)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={requiresLot}
                onChange={(e) => setRequiresLot(e.target.checked)}
                className="accent-amber-500"
              />
              Exige rastreabilidade de lote (ANVISA)
            </label>
            {requiresLot && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Toda movimentacao desse produto exigira batch_number obrigatorio.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Estoque minimo</label>
              <input
                type="number"
                step="0.001"
                value={minStock}
                onChange={(e) => setMinStock(e.target.value)}
                placeholder="Alerta de reposicao"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Preco de custo (R$)</label>
              <input
                type="number"
                step="0.01"
                value={costPrice}
                onChange={(e) => setCostPrice(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
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
              Cadastrar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
