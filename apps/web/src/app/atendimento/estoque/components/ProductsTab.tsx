'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Camera, Loader2, Package, Plus, Search, Trash2, X,
} from 'lucide-react';
import api, { API_BASE_URL } from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useAuthedImage } from '@/lib/use-authed-image';

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
  photo_url: string | null;
  updated_at: string;
  supplier?: { id: string; name: string } | null;
}

/**
 * Reduz a foto antes de enviar (lado maior até 1024 px, JPEG): foto de celular
 * passa fácil dos 2 MB que a API aceita, e a lista carrega mais rápido.
 */
async function prepareProductPhoto(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('Escolha um arquivo de imagem.');
  const objUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Não foi possível ler essa imagem.'));
      el.src = objUrl;
    });
    const scale = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Não foi possível preparar a imagem.');
    // Fundo branco: PNG transparente viraria fundo preto no JPEG
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Não foi possível preparar a imagem.'))),
        'image/jpeg',
        0.85,
      ),
    );
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}

async function uploadProductPhoto(productId: string, file: File) {
  const blob = await prepareProductPhoto(file);
  const fd = new FormData();
  fd.append('file', blob, 'foto.jpg');
  await api.post(`/products/${productId}/photo`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
}

function errMsg(err: any, fallback: string): string {
  const msg = err?.response?.data?.message ?? err?.message;
  return (Array.isArray(msg) ? msg.join(', ') : msg) || fallback;
}

/** Miniatura da foto (fetch autenticado); sem foto mostra o ícone de pacote. */
function ProductThumb({ product, size = 40 }: { product: Product; size?: number }) {
  // ?v=updated_at: trocou a foto → updated_at muda → a miniatura baixa a nova
  const url = product.photo_url
    ? `${API_BASE_URL}/products/${product.id}/photo?v=${encodeURIComponent(product.updated_at)}`
    : null;
  const { src } = useAuthedImage(url);
  return (
    <div
      className="rounded-lg overflow-hidden shrink-0 flex items-center justify-center bg-muted text-muted-foreground"
      style={{ width: size, height: size }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={product.name} className="w-full h-full object-cover" />
      ) : (
        <Package size={Math.round(size * 0.45)} className="opacity-60" />
      )}
    </div>
  );
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
  const [photoFor, setPhotoFor] = useState<Product | null>(null);

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
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => setPhotoFor(p)}
                          title={p.photo_url ? 'Ver ou trocar a foto' : 'Colocar foto'}
                          className="rounded-lg hover:ring-2 hover:ring-primary/40"
                        >
                          <ProductThumb product={p} />
                        </button>
                        <div className="min-w-0">
                          <div className="font-medium">{p.name}</div>
                          {p.brand && <div className="text-xs text-muted-foreground">{p.brand}</div>}
                          {p.sku && <div className="text-[10px] text-muted-foreground font-mono">SKU: {p.sku}</div>}
                        </div>
                      </div>
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

      {photoFor && (
        <ProductPhotoModal
          product={photoFor}
          onClose={() => setPhotoFor(null)}
          onChanged={() => {
            setPhotoFor(null);
            load();
          }}
        />
      )}
    </div>
  );
}

/** Foto de um produto já cadastrado: ver grande, colocar/trocar ou remover. */
function ProductPhotoModal({
  product, onClose, onChanged,
}: { product: Product; onClose: () => void; onChanged: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      await uploadProductPhoto(product.id, file);
      showSuccess('Foto salva');
      onChanged();
    } catch (err: any) {
      showError(errMsg(err, 'Erro ao salvar a foto'));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleRemove = async () => {
    if (!confirm(`Remover a foto de "${product.name}"?`)) return;
    setBusy(true);
    try {
      await api.delete(`/products/${product.id}/photo`);
      showSuccess('Foto removida');
      onChanged();
    } catch (err: any) {
      showError(errMsg(err, 'Erro ao remover a foto'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl w-full max-w-sm shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-base font-semibold flex items-center gap-2 min-w-0">
            <Camera size={18} className="text-primary shrink-0" />
            <span className="truncate">{product.name}</span>
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        <div className="p-4 flex flex-col items-center gap-4">
          <ProductThumb product={product} size={240} />

          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />

          <div className="flex gap-2 w-full">
            <button
              type="button"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Camera size={16} />}
              {product.photo_url ? 'Trocar foto' : 'Escolher foto'}
            </button>
            {product.photo_url && (
              <button
                type="button"
                disabled={busy}
                onClick={handleRemove}
                className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-border text-sm hover:bg-accent hover:text-destructive disabled:opacity-50"
                title="Remover foto"
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
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
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => { if (photoPreview) URL.revokeObjectURL(photoPreview); }, [photoPreview]);

  const pickPhoto = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showError('Escolha um arquivo de imagem.');
      return;
    }
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  };

  const clearPhoto = () => {
    setPhotoFile(null);
    setPhotoPreview(null);
    if (photoInputRef.current) photoInputRef.current.value = '';
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      showError('Nome e obrigatorio');
      return;
    }
    setSaving(true);
    try {
      const { data } = await api.post<{ id: string }>('/products', {
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
      // Foto depois de criar: se falhar, o produto já existe — avisa e dá pra
      // colocar a foto pela miniatura na lista.
      if (photoFile && data?.id) {
        try {
          await uploadProductPhoto(data.id, photoFile);
        } catch (err: any) {
          showError(`Produto cadastrado, mas a foto falhou: ${errMsg(err, 'tente de novo clicando na miniatura')}`);
        }
      }
      showSuccess('Produto cadastrado');
      onCreated();
    } catch (err: any) {
      showError(errMsg(err, 'Erro ao cadastrar'));
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
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => photoInputRef.current?.click()}
              title="Foto do produto"
              className="w-20 h-20 rounded-lg overflow-hidden shrink-0 flex items-center justify-center bg-muted text-muted-foreground border border-dashed border-border hover:ring-2 hover:ring-primary/40"
            >
              {photoPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photoPreview} alt="Foto do produto" className="w-full h-full object-cover" />
              ) : (
                <Camera size={24} className="opacity-60" />
              )}
            </button>
            <div className="flex flex-col items-start gap-1">
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                className="text-sm font-medium text-primary hover:underline"
              >
                {photoPreview ? 'Trocar foto' : 'Adicionar foto'}
              </button>
              {photoPreview && (
                <button
                  type="button"
                  onClick={clearPhoto}
                  className="text-xs text-muted-foreground hover:text-destructive"
                >
                  Remover
                </button>
              )}
              <span className="text-[11px] text-muted-foreground">Opcional — JPEG, PNG ou WebP</span>
            </div>
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => pickPhoto(e.target.files?.[0])}
            />
          </div>

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
