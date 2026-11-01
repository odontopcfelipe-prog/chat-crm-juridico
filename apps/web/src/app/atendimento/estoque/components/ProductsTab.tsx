'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Camera, Check, Loader2, Package, Pencil, Plus, Search, Tags, Trash2, X,
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
  sale_price: string | null;
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

function fmtBRL(valor: number): string {
  return valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
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

/** Categoria criada pela própria clínica (Estoque → Categorias). */
interface ProductCategory {
  id: string;
  name: string;
  products: number;
}

const UNITS = ['UN', 'ML', 'MG', 'UI', 'CAIXA', 'KIT', 'G', 'L'];

export default function ProductsTab() {
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<ProductCategory[] | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [showLowStock, setShowLowStock] = useState(false);
  const [openModal, setOpenModal] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [openCategories, setOpenCategories] = useState(false);
  const [photoFor, setPhotoFor] = useState<Product | null>(null);

  const loadCategories = useCallback(async () => {
    try {
      const { data } = await api.get<ProductCategory[]>('/product-categories');
      setCategories(data || []);
    } catch (err: any) {
      setCategories((atual) => atual ?? []);
      showError(errMsg(err, 'Erro ao carregar categorias'));
    }
  }, []);

  useEffect(() => { loadCategories(); }, [loadCategories]);
  // A primeira leitura das categorias converte os códigos antigos dos produtos
  // em nome — a lista de produtos espera por ela pra não mostrar "RESINA".
  const categoriesReady = categories !== null;

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
    if (!categoriesReady) return;
    const debounce = setTimeout(load, 300);
    return () => clearTimeout(debounce);
  }, [load, categoriesReady]);

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
          {(categories ?? []).map((c) => (
            <option key={c.id} value={c.name}>{c.name}</option>
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
          onClick={() => setOpenCategories(true)}
          className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-border text-sm font-medium hover:bg-accent"
          title="Criar, renomear ou remover categorias"
        >
          <Tags size={16} /> Categorias
        </button>
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
                <th className="px-3 py-2 text-right">Compra</th>
                <th className="px-3 py-2 text-right">Venda</th>
                <th className="px-3 py-2 w-10"><span className="sr-only">Editar</span></th>
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
                          <button
                            type="button"
                            onClick={() => setEditing(p)}
                            className="font-medium text-left hover:text-primary hover:underline"
                            title="Editar produto"
                          >
                            {p.name}
                          </button>
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
                    <td className="px-3 py-2 text-right text-xs font-mono whitespace-nowrap">
                      {p.cost_price ? fmtBRL(Number(p.cost_price)) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-xs font-mono whitespace-nowrap">
                      {p.sale_price ? fmtBRL(Number(p.sale_price)) : '—'}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setEditing(p)}
                        className="p-1.5 rounded text-muted-foreground hover:bg-accent hover:text-primary"
                        title="Editar produto"
                        aria-label={`Editar ${p.name}`}
                      >
                        <Pencil size={15} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(openModal || editing) && (
        <ProductFormModal
          // key: trocar de produto remonta o formulário com os dados certos
          key={editing?.id ?? 'novo'}
          product={editing}
          categories={categories ?? []}
          onCategoriesChanged={loadCategories}
          onClose={() => { setOpenModal(false); setEditing(null); }}
          onSaved={() => {
            setOpenModal(false);
            setEditing(null);
            load();
            loadCategories();
          }}
        />
      )}

      {openCategories && (
        <CategoriesModal
          categories={categories ?? []}
          onClose={() => setOpenCategories(false)}
          onChanged={async () => {
            // Renomear/remover muda o nome nos produtos e pode tirar a do filtro
            setCategory('');
            await loadCategories();
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

/** Categorias da clínica: criar, renomear (renomeia nos produtos) e remover. */
function CategoriesModal({
  categories, onClose, onChanged,
}: { categories: ProductCategory[]; onClose: () => void; onChanged: () => Promise<void> }) {
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>, ok: string, fallback: string) => {
    setBusy(true);
    try {
      await action();
      showSuccess(ok);
      await onChanged();
      return true;
    } catch (err: any) {
      showError(errMsg(err, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    if (await run(() => api.post('/product-categories', { name }), 'Categoria criada', 'Erro ao criar categoria')) {
      setNewName('');
    }
  };

  const rename = async (c: ProductCategory) => {
    const name = editName.trim();
    if (!name || name === c.name) {
      setEditingId(null);
      return;
    }
    if (await run(() => api.patch(`/product-categories/${c.id}`, { name }), 'Categoria renomeada', 'Erro ao renomear')) {
      setEditingId(null);
    }
  };

  const remove = async (c: ProductCategory) => {
    const aviso = c.products > 0
      ? `Remover a categoria "${c.name}"? Os ${c.products} produto(s) dela continuam com esse nome, mas ela sai da lista.`
      : `Remover a categoria "${c.name}"?`;
    if (!confirm(aviso)) return;
    await run(() => api.delete(`/product-categories/${c.id}`), 'Categoria removida', 'Erro ao remover');
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl w-full max-w-md shadow-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Tags size={20} className="text-primary" /> Categorias de produto
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={create} className="p-4 flex gap-2 border-b border-border">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={60}
            autoFocus
            placeholder="Nova categoria (ex: Pulseira, Resina, Luva)"
            className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <button
            type="submit"
            disabled={busy || !newName.trim()}
            className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            <Plus size={16} /> Adicionar
          </button>
        </form>

        <div className="overflow-y-auto">
          {categories.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              Nenhuma categoria. Crie a primeira acima.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {categories.map((c) => (
                <li key={c.id} className="px-4 py-2 flex items-center gap-2">
                  {editingId === c.id ? (
                    <>
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); rename(c); }
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        maxLength={60}
                        autoFocus
                        className="flex-1 min-w-0 px-2 py-1 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                      />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => rename(c)}
                        className="p-1 text-primary hover:bg-accent rounded disabled:opacity-50"
                        title="Salvar"
                      >
                        <Check size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="p-1 text-muted-foreground hover:bg-accent rounded"
                        title="Cancelar"
                      >
                        <X size={16} />
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{c.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {c.products === 0 ? 'Nenhum produto' : `${c.products} produto(s)`}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => { setEditingId(c.id); setEditName(c.name); }}
                        className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded disabled:opacity-50"
                        title="Renomear"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => remove(c)}
                        className="p-1 text-muted-foreground hover:text-destructive hover:bg-accent rounded disabled:opacity-50"
                        title="Remover"
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
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

const NOVA_CATEGORIA = '__nova__';

/** Decimal da API ("12.500") → texto do campo ("12.5"); vazio quando não tem. */
function decimalParaCampo(valor: string | null | undefined): string {
  return valor === null || valor === undefined || valor === '' ? '' : String(Number(valor));
}

/** Cadastro (sem `product`) ou edição de um produto já cadastrado. */
function ProductFormModal({
  product, categories, onCategoriesChanged, onClose, onSaved,
}: {
  product: Product | null;
  categories: ProductCategory[];
  onCategoriesChanged: () => Promise<void>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editando = !!product;
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(product?.name ?? '');
  const [brand, setBrand] = useState(product?.brand ?? '');
  const [sku, setSku] = useState(product?.sku ?? '');
  const [category, setCategory] = useState(product?.category ?? '');
  // "+ Nova categoria…" troca o select por um campo, sem sair do cadastro
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [newCategory, setNewCategory] = useState('');
  const [savingCategory, setSavingCategory] = useState(false);
  const [unit, setUnit] = useState(product?.unit ?? 'UN');
  const [anvisa, setAnvisa] = useState(product?.anvisa_registration ?? '');
  const [isInjectable, setIsInjectable] = useState(product?.is_injectable ?? false);
  const [requiresLot, setRequiresLot] = useState(product?.requires_lot_tracking ?? false);
  const [minStock, setMinStock] = useState(decimalParaCampo(product?.min_stock));
  const [costPrice, setCostPrice] = useState(decimalParaCampo(product?.cost_price));
  const [salePrice, setSalePrice] = useState(decimalParaCampo(product?.sale_price));
  const lucro = (parseFloat(salePrice) || 0) - (parseFloat(costPrice) || 0);
  const [supplierId, setSupplierId] = useState(product?.supplier?.id ?? '');
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  // Edição: "Remover" tira a foto que já estava salva (só ao clicar em Salvar)
  const [removeSavedPhoto, setRemoveSavedPhoto] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const savedPhotoUrl = product?.photo_url
    ? `${API_BASE_URL}/products/${product.id}/photo?v=${encodeURIComponent(product.updated_at)}`
    : null;
  const { src: savedPhotoSrc } = useAuthedImage(savedPhotoUrl);
  const shownPhoto = photoPreview ?? (removeSavedPhoto ? null : savedPhotoSrc);

  useEffect(() => () => { if (photoPreview) URL.revokeObjectURL(photoPreview); }, [photoPreview]);

  useEffect(() => {
    api.get<{ data: { id: string; name: string }[] }>('/suppliers?active=true&limit=100')
      .then(({ data }) => setSuppliers(data?.data || []))
      .catch(() => setSuppliers([]));
  }, []);

  // Categoria removida da lista continua no produto: mostra ela pra não sumir do campo
  const categoriaForaDaLista = !!category && !categories.some((c) => c.name === category);
  // Mesmo caso com fornecedor arquivado
  const fornecedorForaDaLista = !!supplierId && !suppliers.some((s) => s.id === supplierId);

  const createCategory = async () => {
    const nome = newCategory.trim();
    if (!nome) return;
    setSavingCategory(true);
    try {
      const { data } = await api.post<{ id: string; name: string }>('/product-categories', { name: nome });
      await onCategoriesChanged();
      setCategory(data.name);
      setCreatingCategory(false);
      setNewCategory('');
    } catch (err: any) {
      showError(errMsg(err, 'Erro ao criar categoria'));
    } finally {
      setSavingCategory(false);
    }
  };

  const pickPhoto = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showError('Escolha um arquivo de imagem.');
      return;
    }
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
    setRemoveSavedPhoto(false);
  };

  const clearPhoto = () => {
    setPhotoFile(null);
    setPhotoPreview(null);
    if (product?.photo_url) setRemoveSavedPhoto(true);
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
      let productId: string | undefined;
      if (product) {
        // Edição: campo apagado vai como null (limpa no banco). Estoque atual
        // não entra — ele só muda por entrada/saída em Movimentações.
        await api.patch(`/products/${product.id}`, {
          name: name.trim(),
          brand: brand.trim() || null,
          sku: sku.trim() || null,
          category: category || null,
          unit,
          anvisa_registration: anvisa.trim() || null,
          is_injectable: isInjectable,
          requires_lot_tracking: requiresLot,
          min_stock: minStock !== '' ? parseFloat(minStock) : null,
          cost_price: costPrice !== '' ? parseFloat(costPrice) : null,
          sale_price: salePrice !== '' ? parseFloat(salePrice) : null,
          supplier_id: supplierId || null,
        });
        productId = product.id;
      } else {
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
          sale_price: salePrice ? parseFloat(salePrice) : undefined,
          supplier_id: supplierId || undefined,
        });
        productId = data?.id;
      }
      // Foto depois de salvar os dados: se falhar, o produto já está salvo —
      // avisa e dá pra colocar a foto pela miniatura na lista.
      try {
        if (photoFile && productId) {
          await uploadProductPhoto(productId, photoFile);
        } else if (removeSavedPhoto && product) {
          await api.delete(`/products/${product.id}/photo`);
        }
      } catch (err: any) {
        showError(`Produto salvo, mas a foto falhou: ${errMsg(err, 'tente de novo clicando na miniatura')}`);
      }
      showSuccess(editando ? 'Produto atualizado' : 'Produto cadastrado');
      onSaved();
    } catch (err: any) {
      showError(errMsg(err, editando ? 'Erro ao salvar' : 'Erro ao cadastrar'));
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
            {editando
              ? <><Pencil size={20} className="text-primary" /> Editar produto</>
              : <><Package size={20} className="text-primary" /> Novo produto</>}
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
              {shownPhoto ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={shownPhoto} alt="Foto do produto" className="w-full h-full object-cover" />
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
                {shownPhoto ? 'Trocar foto' : 'Adicionar foto'}
              </button>
              {shownPhoto && (
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
              {creatingCategory ? (
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter cria a categoria (não envia o cadastro do produto)
                      if (e.key === 'Enter') { e.preventDefault(); createCategory(); }
                      if (e.key === 'Escape') { e.preventDefault(); setCreatingCategory(false); }
                    }}
                    maxLength={60}
                    autoFocus
                    placeholder="Nova categoria"
                    className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <button
                    type="button"
                    disabled={savingCategory || !newCategory.trim()}
                    onClick={createCategory}
                    className="p-2 rounded-lg text-primary hover:bg-accent disabled:opacity-50"
                    title="Criar categoria"
                  >
                    {savingCategory ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setCreatingCategory(false)}
                    className="p-2 rounded-lg text-muted-foreground hover:bg-accent"
                    title="Cancelar"
                  >
                    <X size={16} />
                  </button>
                </div>
              ) : (
                <select
                  value={category}
                  onChange={(e) => {
                    if (e.target.value === NOVA_CATEGORIA) {
                      setNewCategory('');
                      setCreatingCategory(true);
                    } else {
                      setCategory(e.target.value);
                    }
                  }}
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  <option value="">—</option>
                  {categoriaForaDaLista && (
                    <option value={category}>{category} (fora da lista)</option>
                  )}
                  {categories.map((c) => (
                    <option key={c.id} value={c.name}>{c.name}</option>
                  ))}
                  <option value={NOVA_CATEGORIA}>+ Nova categoria…</option>
                </select>
              )}
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
            <label className="block text-xs font-medium mb-1">Fornecedor</label>
            <select
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="">—</option>
              {fornecedorForaDaLista && (
                <option value={supplierId}>{product?.supplier?.name ?? 'Fornecedor atual'}</option>
              )}
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
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
              <label className="block text-xs font-medium mb-1">Valor de compra (R$)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={costPrice}
                onChange={(e) => setCostPrice(e.target.value)}
                placeholder={`Quanto paga por ${unit}`}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Valor de venda (R$)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={salePrice}
                onChange={(e) => setSalePrice(e.target.value)}
                placeholder={`Quanto cobra por ${unit}`}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>
          {costPrice !== '' && salePrice !== '' && (
            <p className={`text-xs -mt-1 ${lucro < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
              {lucro < 0 ? 'Prejuízo' : 'Lucro'} por {unit}: <span className="font-mono font-medium">{fmtBRL(Math.abs(lucro))}</span>
            </p>
          )}

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
          </div>

          {product && (
            <p className="text-xs text-muted-foreground">
              Estoque atual: <span className="font-mono font-medium text-foreground">
                {Number(product.current_stock)} {product.unit}
              </span>. Para mudar a quantidade, lance uma entrada ou saída na aba Movimentacoes.
            </p>
          )}

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
              {saving
                ? <Loader2 size={16} className="animate-spin" />
                : editando ? <Check size={16} /> : <Plus size={16} />}
              {editando ? 'Salvar' : 'Cadastrar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
