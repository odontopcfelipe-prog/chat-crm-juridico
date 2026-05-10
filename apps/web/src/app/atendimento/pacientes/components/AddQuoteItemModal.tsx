'use client';

/**
 * AddQuoteItemModal — modal pra adicionar procedimentos ao orçamento.
 *
 * Visão clínica (sem valores monetários):
 *  - Search instantânea (autofocus) + procedimentos agrupados por especialidade
 *  - Click adiciona à cesta lateral (item ativo destacado)
 *  - Mini-odontograma no topo: click num dente toggla no item ATIVO
 *  - Cada item da cesta vira N procedimentos no submit (1 por dente)
 *  - Sem preços visíveis aqui — preços moram só na aba Orçamentos
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Plus, Minus, Search, Loader2, Layers, ShoppingCart, Save,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Procedure {
  id: string;
  name: string;
  base_price: string | number;
  code_tuss: string | null;
  duration_minutes?: number;
  specialty?: { id: string; name: string } | null;
  specialty_id?: string | null;
}

interface BasketItem {
  procedure_id: string;
  procedure_name: string;
  unit_price: string;
  quantity: number;
  /** Onda 3.35 — array de dentes (em vez de string única). Click no
   *  mini-odontograma adiciona/remove. Submit expande em N POSTs. */
  tooth_fdis: string[];
}

interface Props {
  quoteId: string;
  procedures: Procedure[];
  onClose: () => void;
  /** Recarrega items do orçamento depois que adicionar */
  onAdded: () => void | Promise<void>;
  /**
   * Onda 3.1 — dentes pre-selecionados via odontograma. Quando preenchido,
   * o primeiro procedimento adicionado herda esses dentes.
   */
  prefillTeeth?: string[];
}

// Mesma paleta da pagina de tabela de precos pra consistencia visual
const SPECIALTY_COLORS = [
  '#a855f7', '#3b82f6', '#22c55e', '#f97316',
  '#ec4899', '#14b8a6', '#eab308', '#06b6d4',
];

function colorForSpecialty(key: string): string {
  if (!key || key === '__none__') return '#94a3b8';
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return SPECIALTY_COLORS[Math.abs(hash) % SPECIALTY_COLORS.length];
}

export default function AddQuoteItemModal({ quoteId, procedures, onClose, onAdded, prefillTeeth }: Props) {
  const [search, setSearch] = useState('');
  const [basket, setBasket] = useState<BasketItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  // Onda 3.35 — Item ATIVO da cesta. Mini-odontograma reflete os dentes desse
  // item; click num dente do mini adiciona/remove do item ativo.
  const [activeBasketIdx, setActiveBasketIdx] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const hasPrefilledTeeth = !!(prefillTeeth && prefillTeeth.length > 0);
  const activeItem = activeBasketIdx !== null ? basket[activeBasketIdx] : null;
  const prefilledConsumedRef = useRef(false);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  // Agrupa por especialidade + filtra por search
  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? procedures.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            (p.code_tuss || '').toLowerCase().includes(q),
        )
      : procedures;

    const groups: Record<string, { name: string; key: string; items: Procedure[] }> = {};
    for (const p of filtered) {
      const key = p.specialty?.id || p.specialty_id || '__none__';
      const name = p.specialty?.name || 'Sem especialidade';
      if (!groups[key]) groups[key] = { name, key, items: [] };
      groups[key].items.push(p);
    }
    return Object.values(groups).sort((a, b) =>
      a.name.localeCompare(b.name, 'pt-BR'),
    );
  }, [procedures, search]);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const addToBasket = (p: Procedure) => {
    // Primeiro add com prefillTeeth: usa os dentes pre-selecionados.
    // Demais adds começam com array vazio (operador clica no mini-odontograma).
    const initialTeeth = !prefilledConsumedRef.current && hasPrefilledTeeth && prefillTeeth
      ? [...prefillTeeth]
      : [];
    if (initialTeeth.length > 0) prefilledConsumedRef.current = true;
    const newItem: BasketItem = {
      procedure_id: p.id,
      procedure_name: p.name,
      unit_price: String(p.base_price),
      quantity: 1,
      tooth_fdis: initialTeeth,
    };
    setBasket((prev) => {
      const next = [...prev, newItem];
      setActiveBasketIdx(next.length - 1);
      return next;
    });
  };

  const updateBasketItem = (idx: number, patch: Partial<BasketItem>) => {
    setBasket((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };

  const removeFromBasket = (idx: number) => {
    setBasket((prev) => prev.filter((_, i) => i !== idx));
    setActiveBasketIdx((prev) => {
      if (prev === idx) return null;
      if (prev !== null && prev > idx) return prev - 1;
      return prev;
    });
  };

  // Click no dente do mini-odontograma → toggla no item ativo
  const toggleToothInActive = (fdi: string) => {
    if (activeBasketIdx === null) {
      showError('Selecione um procedimento da cesta primeiro');
      return;
    }
    const item = basket[activeBasketIdx];
    if (!item) return;
    const hasIt = item.tooth_fdis.includes(fdi);
    const newFdis = hasIt
      ? item.tooth_fdis.filter((f) => f !== fdi)
      : [...item.tooth_fdis, fdi].sort();
    updateBasketItem(activeBasketIdx, { tooth_fdis: newFdis });
  };

  // Mapa fdi → nome do OUTRO procedimento que ja usa esse dente
  // (pra renderizar com cor amber no mini-odontograma)
  const otherUsedFdis = useMemo(() => {
    const m = new Map<string, string>();
    basket.forEach((it, i) => {
      if (i === activeBasketIdx) return;
      it.tooth_fdis.forEach((fdi) => {
        if (!m.has(fdi)) m.set(fdi, it.procedure_name);
      });
    });
    return m;
  }, [basket, activeBasketIdx]);

  // Total de items REAIS apos expansao tooth_fdis
  const totalItemsToCreate = basket.reduce(
    (acc, it) => acc + Math.max(it.tooth_fdis.length, 1),
    0,
  );

  const submit = async (keepOpen: boolean) => {
    if (basket.length === 0) {
      showError('Adicione ao menos um procedimento');
      return;
    }
    setSaving(true);
    try {
      // Expande tooth_fdis em N POSTs (1 por dente). Sem dentes = 1 POST.
      // Onda 3.21 — qty sempre 1 quando ha dentes (cada dente = 1 procedimento).
      for (const it of basket) {
        const teeth = it.tooth_fdis.length > 0 ? it.tooth_fdis : [null];
        const qtyPerPost = it.tooth_fdis.length > 0 ? 1 : it.quantity;
        for (const tooth of teeth) {
          await api.post(`/quotes/${quoteId}/items`, {
            procedure_id: it.procedure_id,
            quantity: qtyPerPost,
            unit_price: it.unit_price === '' ? undefined : Number(it.unit_price),
            tooth_fdi: tooth || undefined,
          });
        }
      }
      showSuccess(`${totalItemsToCreate} procedimento(s) adicionado(s)`);
      await onAdded();
      if (keepOpen) {
        setBasket([]);
        setActiveBasketIdx(null);
        prefilledConsumedRef.current = false;
        setSearch('');
        setTimeout(() => inputRef.current?.focus(), 50);
      } else {
        onClose();
      }
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao adicionar');
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
        className="bg-card border border-border rounded-xl w-full max-w-5xl shadow-2xl max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Plus size={18} className="text-primary" />
            <h2 className="text-base font-semibold">Adicionar procedimentos ao orçamento</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        {/* Mini-odontograma — click toggla dente do item ativo */}
        <MiniOdontograma
          activeFdis={activeItem?.tooth_fdis || []}
          activeProcedureName={activeItem?.procedure_name}
          otherUsedFdis={otherUsedFdis}
          onToggle={toggleToothInActive}
          hasActive={activeBasketIdx !== null}
        />

        {/* Body — 2 colunas: lista (esq) + cesta (dir) */}
        <div className="flex-1 grid grid-cols-1 md:grid-cols-[1fr_360px] gap-0 overflow-hidden">
          {/* COLUNA ESQ — busca + lista agrupada */}
          <div className="flex flex-col overflow-hidden">
            <div className="p-3 border-b border-border bg-background/30">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  ref={inputRef}
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar procedimento por nome ou código TUSS..."
                  className="w-full pl-9 pr-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <p className="text-[10px] text-muted-foreground mt-1.5">
                Click pra adicionar à cesta. Click de novo no mesmo pra incrementar quantidade.
              </p>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {procedures.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  Nenhum procedimento cadastrado.{' '}
                  <a href="/atendimento/settings/procedures" className="text-primary underline">
                    Cadastrar tabela de preços
                  </a>
                </div>
              ) : grouped.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  Nenhum procedimento corresponde a &quot;{search}&quot;
                </div>
              ) : (
                grouped.map((g) => {
                  const color = colorForSpecialty(g.key);
                  const collapsed = collapsedGroups.has(g.key);
                  return (
                    <div
                      key={g.key}
                      className="border-l-4 rounded-r-lg overflow-hidden bg-background border border-border"
                      style={{ borderLeftColor: color }}
                    >
                      <button
                        type="button"
                        onClick={() => toggleGroup(g.key)}
                        className="w-full px-3 py-2 flex items-center gap-2 hover:bg-muted/50 text-left"
                        style={{ background: color + '12' }}
                      >
                        <Layers size={12} style={{ color }} />
                        <span className="text-xs font-bold" style={{ color }}>
                          {g.name}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {g.items.length}
                        </span>
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {collapsed ? '+' : '−'}
                        </span>
                      </button>
                      {!collapsed && (
                        <div className="divide-y divide-border">
                          {g.items.map((p) => {
                            // Onda 3.35 — count efetivo apos expansao de dentes
                            const inBasketEffectiveCount = basket
                              .filter((b) => b.procedure_id === p.id)
                              .reduce((acc, b) => acc + Math.max(b.tooth_fdis.length, 1), 0);
                            return (
                              <button
                                key={p.id}
                                type="button"
                                onClick={() => addToBasket(p)}
                                className="w-full px-3 py-2 flex items-center gap-2 hover:bg-accent/50 text-left transition-colors"
                              >
                                <Plus
                                  size={14}
                                  className={inBasketEffectiveCount > 0 ? 'text-primary' : 'text-muted-foreground'}
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm font-medium truncate">{p.name}</div>
                                  <div className="text-[10px] text-muted-foreground flex items-center gap-2">
                                    {p.code_tuss && <span>TUSS {p.code_tuss}</span>}
                                    {p.duration_minutes && <span>{p.duration_minutes} min</span>}
                                  </div>
                                </div>
                                {/* Onda 3.35 — preco removido (visao clinica
                                    pura no modal). Indicador "Nx" mantido. */}
                                {inBasketEffectiveCount > 0 && (
                                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-primary text-primary-foreground">
                                    {inBasketEffectiveCount}×
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* COLUNA DIR — cesta de selecao */}
          <div className="border-l border-border bg-background/30 flex flex-col overflow-hidden">
            <div className="p-3 border-b border-border flex items-center gap-2">
              <ShoppingCart size={14} className="text-primary" />
              <span className="text-sm font-semibold">Cesta</span>
              <span className="text-xs text-muted-foreground">
                ({basket.length} {basket.length === 1 ? 'item' : 'itens'})
              </span>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {basket.length === 0 ? (
                <div className="p-6 text-center text-xs text-muted-foreground">
                  <ShoppingCart size={24} className="mx-auto mb-2 opacity-30" />
                  Click nos procedimentos da esquerda pra adicionar à cesta.
                </div>
              ) : (
                basket.map((it, idx) => {
                  const isActive = activeBasketIdx === idx;
                  const hasTeeth = it.tooth_fdis.length > 0;
                  const effectiveQty = hasTeeth ? it.tooth_fdis.length : it.quantity;
                  return (
                    <div
                      key={idx}
                      onClick={() => setActiveBasketIdx(idx)}
                      className={`bg-card border rounded-lg p-2 space-y-1.5 cursor-pointer transition-colors ${
                        isActive
                          ? 'border-primary shadow-sm bg-primary/5'
                          : 'border-border hover:border-primary/30'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0 flex items-center gap-1.5">
                          {isActive && (
                            <span className="text-[10px] font-bold uppercase text-primary">
                              ← Editando
                            </span>
                          )}
                          <p className="text-xs font-medium truncate" title={it.procedure_name}>
                            {it.procedure_name}
                          </p>
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-primary/15 text-primary shrink-0">
                            {effectiveQty}×
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); removeFromBasket(idx); }}
                          className="text-muted-foreground hover:text-destructive shrink-0"
                        >
                          <X size={12} />
                        </button>
                      </div>

                      {/* Qtd + Dentes na mesma linha. Qtd auto-derivada quando
                          ha dentes (1 por dente); manual quando sem dentes
                          (procedimentos genericos como "Avaliacao inicial"). */}
                      <div className="flex items-center gap-2 flex-wrap">
                        {hasTeeth ? (
                          <div className="flex items-center gap-1 shrink-0">
                            <span className="text-[10px] text-muted-foreground">Qtd:</span>
                            <span className="text-xs font-bold text-primary px-1.5 py-0.5 rounded bg-primary/10">
                              {it.tooth_fdis.length}
                            </span>
                            <span className="text-[10px] text-muted-foreground italic">
                              (1 por dente)
                            </span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 shrink-0">
                            <span className="text-[10px] text-muted-foreground">Qtd:</span>
                            <div className="flex items-center border border-border rounded">
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); updateBasketItem(idx, { quantity: Math.max(1, it.quantity - 1) }); }}
                                className="px-1 hover:bg-accent"
                              >
                                <Minus size={10} />
                              </button>
                              <input
                                type="number"
                                min={1}
                                value={it.quantity}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => updateBasketItem(idx, { quantity: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                                className="w-10 px-1 py-1 text-xs text-center bg-transparent focus:outline-none"
                              />
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); updateBasketItem(idx, { quantity: it.quantity + 1 }); }}
                                className="px-1 hover:bg-accent"
                              >
                                <Plus size={10} />
                              </button>
                            </div>
                          </div>
                        )}

                        <div className="h-5 w-px bg-border" />

                        <div className="flex items-center gap-1 flex-wrap flex-1 min-w-0">
                          <span className="text-[10px] text-muted-foreground shrink-0">Dentes:</span>
                          {it.tooth_fdis.length === 0 ? (
                            <span className="text-[10px] text-muted-foreground italic">
                              clique no odontograma acima
                            </span>
                          ) : (
                            it.tooth_fdis.map((fdi) => (
                              <button
                                key={fdi}
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  updateBasketItem(idx, {
                                    tooth_fdis: it.tooth_fdis.filter((f) => f !== fdi),
                                  });
                                }}
                                className="inline-flex items-center gap-0.5 pl-1.5 pr-1 py-0.5 rounded font-mono text-[10px] bg-primary text-primary-foreground hover:bg-primary/80 group"
                                title={`Remover dente ${fdi}`}
                              >
                                {fdi}
                                <X size={10} className="opacity-60 group-hover:opacity-100" />
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Onda 3.35 — Rodape simplificado: total de items reais (apos
                expansao tooth_fdis). SEM subtotal monetario — modal eh visao
                clinica pura. */}
            {basket.length > 0 && (
              <div className="p-3 border-t border-border bg-background/50 text-xs text-muted-foreground">
                <strong className="text-foreground">{totalItemsToCreate}</strong> procedimento(s) ser&atilde;o adicionado(s)
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-border p-3 flex justify-end gap-2 bg-background/30">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-3 py-2 rounded-lg border border-border text-sm hover:bg-accent disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => submit(true)}
            disabled={saving || basket.length === 0}
            className="px-3 py-2 rounded-lg border border-primary/30 text-primary text-sm hover:bg-primary/10 disabled:opacity-50 inline-flex items-center gap-1"
            title="Adiciona e mantém o modal aberto pra continuar adicionando"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Adicionar e continuar
          </button>
          <button
            type="button"
            onClick={() => submit(false)}
            disabled={saving || basket.length === 0}
            className="px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Adicionar {basket.length > 0 && `(${totalItemsToCreate})`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Mini-odontograma ────────────────────────────────────────

const FDI_PERM_SUP_DIR = ['18', '17', '16', '15', '14', '13', '12', '11'];
const FDI_PERM_SUP_ESQ = ['21', '22', '23', '24', '25', '26', '27', '28'];
const FDI_PERM_INF_ESQ = ['31', '32', '33', '34', '35', '36', '37', '38'];
const FDI_PERM_INF_DIR = ['48', '47', '46', '45', '44', '43', '42', '41'];

function MiniOdontograma({
  activeFdis,
  activeProcedureName,
  otherUsedFdis,
  onToggle,
  hasActive,
}: {
  activeFdis: string[];
  activeProcedureName?: string;
  /** fdi → nome do outro procedimento que ja usa esse dente */
  otherUsedFdis: Map<string, string>;
  onToggle: (fdi: string) => void;
  hasActive: boolean;
}) {
  const activeSet = new Set(activeFdis);
  const totalOtherUsed = otherUsedFdis.size;
  return (
    <div className="px-4 py-3 border-b border-border bg-background/50">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <p className="text-xs font-medium text-foreground">
          {hasActive ? (
            <>
              Selecione os dentes para{' '}
              <span className="text-primary font-semibold">
                {activeProcedureName}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground italic">
              Adicione um procedimento &agrave; cesta para vincular dentes
            </span>
          )}
        </p>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          {hasActive && (
            <span>
              {activeFdis.length === 0
                ? 'Nenhum dente selecionado'
                : `${activeFdis.length} ${activeFdis.length === 1 ? 'dente' : 'dentes'} selecionado${activeFdis.length === 1 ? '' : 's'}`}
            </span>
          )}
          {totalOtherUsed > 0 && (
            <span className="inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />
              {totalOtherUsed} em outros procedimentos
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-col items-center gap-1.5">
        <div className="flex justify-center gap-6">
          <MiniRow fdiList={FDI_PERM_SUP_DIR} activeSet={activeSet} otherUsedFdis={otherUsedFdis} onToggle={onToggle} hasActive={hasActive} />
          <div className="w-px bg-border" />
          <MiniRow fdiList={FDI_PERM_SUP_ESQ} activeSet={activeSet} otherUsedFdis={otherUsedFdis} onToggle={onToggle} hasActive={hasActive} />
        </div>
        <div className="h-px bg-border w-full max-w-[560px]" />
        <div className="flex justify-center gap-6">
          <MiniRow fdiList={FDI_PERM_INF_DIR} activeSet={activeSet} otherUsedFdis={otherUsedFdis} onToggle={onToggle} hasActive={hasActive} />
          <div className="w-px bg-border" />
          <MiniRow fdiList={FDI_PERM_INF_ESQ} activeSet={activeSet} otherUsedFdis={otherUsedFdis} onToggle={onToggle} hasActive={hasActive} />
        </div>
      </div>
    </div>
  );
}

function MiniRow({
  fdiList, activeSet, otherUsedFdis, onToggle, hasActive,
}: {
  fdiList: string[];
  activeSet: Set<string>;
  otherUsedFdis: Map<string, string>;
  onToggle: (fdi: string) => void;
  hasActive: boolean;
}) {
  return (
    <div className="flex gap-1">
      {fdiList.map((fdi) => {
        const isActive = activeSet.has(fdi);
        const otherProcName = otherUsedFdis.get(fdi);
        const isOtherUsed = !!otherProcName && !isActive;
        return (
          <button
            key={fdi}
            type="button"
            onClick={() => onToggle(fdi)}
            disabled={!hasActive}
            className={`relative w-10 h-10 rounded-md text-xs font-bold border-2 flex items-center justify-center transition-all ${
              isActive
                ? 'bg-primary text-primary-foreground border-primary scale-105'
                : isOtherUsed
                ? 'bg-amber-100 dark:bg-amber-950/40 border-amber-400 text-amber-800 dark:text-amber-200 hover:border-primary hover:bg-primary hover:text-primary-foreground'
                : hasActive
                ? 'bg-background border-border text-muted-foreground hover:border-primary hover:text-primary'
                : 'bg-muted/30 border-border/50 text-muted-foreground/50 cursor-not-allowed'
            }`}
            title={
              isActive
                ? `Click pra remover dente ${fdi}`
                : isOtherUsed
                ? `Dente ${fdi} ja em uso por: ${otherProcName} (click pra adicionar tambem ao ativo)`
                : hasActive
                ? `Click pra adicionar dente ${fdi}`
                : 'Selecione um procedimento da cesta primeiro'
            }
          >
            {fdi}
            {isOtherUsed && (
              <span
                className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-amber-500 border border-background"
                aria-hidden="true"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
