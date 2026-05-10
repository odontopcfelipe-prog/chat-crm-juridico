'use client';

/**
 * AddQuoteItemModal — modal pra adicionar procedimento ao orçamento.
 *
 * UX otimizada pra ser usada MUITO:
 *  - Search instantânea no topo (autofocus)
 *  - Procedimentos agrupados por especialidade (collapse) com cor lateral
 *  - Click adiciona à "cesta de seleção" (lado direito)
 *  - Cada item da cesta: dente FDI editável + qtd + preço unitário pré-preenchido
 *  - Adicionar tudo de uma vez OU cancelar
 *  - "Salvar e adicionar mais" mantém modal aberto pra add em sequência
 *
 * Resolve dor: form inline antes era cramped/abaixo do scroll, com <select>
 * nativo difícil de usar com 30+ procedimentos.
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
  base_price: number;
  unit_price: string;
  quantity: number;
  tooth_fdi: string;
}

interface Props {
  quoteId: string;
  procedures: Procedure[];
  onClose: () => void;
  /** Recarrega items do orçamento depois que adicionar */
  onAdded: () => void | Promise<void>;
  /**
   * Onda 3.1 — dentes pre-selecionados via odontograma. Quando preenchido,
   * mostra header indicando "Aplicar a X dentes" + toggle multiplicar/unificar.
   * Ao adicionar procedimento da lista, cria N items (multiplicar) ou 1
   * item agregado (unificar).
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

const formatBRL = (v: number | string) =>
  Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function AddQuoteItemModal({ quoteId, procedures, onClose, onAdded, prefillTeeth }: Props) {
  const [search, setSearch] = useState('');
  const [basket, setBasket] = useState<BasketItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  // Onda 3.1 — quando vem do odontograma com N dentes, escolhe modo:
  //   multiplicar: cria N items (cada dente cobrado 1x)
  //   unificar:    cria 1 item (cobra 1x, lista dentes nas notas)
  // Default: multiplicar (caso mais comum em odonto — tratar varios dentes)
  const [teethMode, setTeethMode] = useState<'multiply' | 'unify'>('multiply');
  const inputRef = useRef<HTMLInputElement>(null);

  const hasPrefilledTeeth = prefillTeeth && prefillTeeth.length > 0;

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
    // Onda 3.1 — se vem do odontograma com dentes pre-selecionados, aplica
    // o modo escolhido (multiplicar/unificar) e adiciona items correspondentes.
    if (hasPrefilledTeeth && prefillTeeth) {
      if (teethMode === 'multiply') {
        // 1 item por dente — facilita renegociar/remover individualmente
        const newItems: BasketItem[] = prefillTeeth.map((tooth) => ({
          procedure_id: p.id,
          procedure_name: p.name,
          base_price: Number(p.base_price),
          unit_price: String(p.base_price),
          quantity: 1,
          tooth_fdi: tooth,
        }));
        setBasket([...basket, ...newItems]);
      } else {
        // Modo unificar: 1 item agregado, dentes listados no campo tooth_fdi
        // (separados por vírgula). Permite "Limpeza geral" que cobre tudo.
        setBasket([
          ...basket,
          {
            procedure_id: p.id,
            procedure_name: p.name,
            base_price: Number(p.base_price),
            unit_price: String(p.base_price),
            quantity: 1,
            tooth_fdi: prefillTeeth.join(', '),
          },
        ]);
      }
      return;
    }

    // Comportamento default (sem dentes pre-selecionados):
    // Se ja esta na cesta, incrementa qty
    const existing = basket.find((b) => b.procedure_id === p.id);
    if (existing) {
      setBasket(basket.map((b) =>
        b.procedure_id === p.id ? { ...b, quantity: b.quantity + 1 } : b,
      ));
    } else {
      setBasket([
        ...basket,
        {
          procedure_id: p.id,
          procedure_name: p.name,
          base_price: Number(p.base_price),
          unit_price: String(p.base_price),
          quantity: 1,
          tooth_fdi: '',
        },
      ]);
    }
  };

  const updateBasketItem = (idx: number, patch: Partial<BasketItem>) => {
    setBasket(basket.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };

  const removeFromBasket = (idx: number) => {
    setBasket(basket.filter((_, i) => i !== idx));
  };

  const basketSubtotal = basket.reduce(
    (acc, b) => acc + Number(b.unit_price || 0) * b.quantity,
    0,
  );

  const submit = async (keepOpen: boolean) => {
    if (basket.length === 0) {
      showError('Adicione ao menos um procedimento');
      return;
    }
    setSaving(true);
    try {
      // Submete em sequencia (poderia paralelizar, mas mantem ordem)
      for (const it of basket) {
        await api.post(`/quotes/${quoteId}/items`, {
          procedure_id: it.procedure_id,
          quantity: it.quantity,
          unit_price: it.unit_price === '' ? undefined : Number(it.unit_price),
          tooth_fdi: it.tooth_fdi || undefined,
        });
      }
      showSuccess(`${basket.length} procedimento(s) adicionado(s)`);
      await onAdded();
      if (keepOpen) {
        setBasket([]);
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

        {/* Onda 3.1 — banner quando vem do odontograma com dentes pre-selecionados */}
        {hasPrefilledTeeth && prefillTeeth && (
          <div className="px-4 py-2.5 bg-primary/5 border-b border-primary/20 flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-semibold text-primary">
                {prefillTeeth.length} {prefillTeeth.length === 1 ? 'dente' : 'dentes'} selecionado{prefillTeeth.length === 1 ? '' : 's'}:
              </span>
              <div className="flex flex-wrap gap-1">
                {prefillTeeth.map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center px-1.5 py-0.5 rounded font-mono text-xs bg-primary text-primary-foreground"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
            <div className="ml-auto flex items-center gap-1 bg-background border border-border rounded-lg p-0.5">
              <button
                type="button"
                onClick={() => setTeethMode('multiply')}
                className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
                  teethMode === 'multiply'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                title={`Cria 1 item por dente (cobra ${prefillTeeth.length}x)`}
              >
                Multiplicar valor
              </button>
              <button
                type="button"
                onClick={() => setTeethMode('unify')}
                className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
                  teethMode === 'unify'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                title="Cria 1 item unico cobrindo todos os dentes (cobra 1x)"
              >
                Unificar
              </button>
            </div>
          </div>
        )}

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
                  Nenhum procedimento corresponde a "{search}"
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
                            const inBasket = basket.find((b) => b.procedure_id === p.id);
                            return (
                              <button
                                key={p.id}
                                type="button"
                                onClick={() => addToBasket(p)}
                                className="w-full px-3 py-2 flex items-center gap-2 hover:bg-accent/50 text-left transition-colors"
                              >
                                <Plus
                                  size={14}
                                  className={inBasket ? 'text-primary' : 'text-muted-foreground'}
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm font-medium truncate">{p.name}</div>
                                  <div className="text-[10px] text-muted-foreground flex items-center gap-2">
                                    {p.code_tuss && <span>TUSS {p.code_tuss}</span>}
                                    {p.duration_minutes && <span>{p.duration_minutes} min</span>}
                                  </div>
                                </div>
                                <div className="text-sm font-semibold text-foreground">
                                  {formatBRL(p.base_price)}
                                </div>
                                {inBasket && (
                                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-primary text-primary-foreground">
                                    {inBasket.quantity}×
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
                basket.map((it, idx) => (
                  <div key={idx} className="bg-card border border-border rounded-lg p-2 space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-medium truncate flex-1" title={it.procedure_name}>
                        {it.procedure_name}
                      </p>
                      <button
                        type="button"
                        onClick={() => removeFromBasket(idx)}
                        className="text-muted-foreground hover:text-destructive shrink-0"
                      >
                        <X size={12} />
                      </button>
                    </div>
                    <div className="grid grid-cols-3 gap-1">
                      <div>
                        <label className="text-[9px] text-muted-foreground block">Qtd</label>
                        <div className="flex items-center border border-border rounded">
                          <button
                            type="button"
                            onClick={() => updateBasketItem(idx, { quantity: Math.max(1, it.quantity - 1) })}
                            className="px-1 hover:bg-accent"
                          >
                            <Minus size={10} />
                          </button>
                          <input
                            type="number"
                            min={1}
                            value={it.quantity}
                            onChange={(e) => updateBasketItem(idx, { quantity: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                            className="w-full px-1 py-1 text-xs text-center bg-transparent focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => updateBasketItem(idx, { quantity: it.quantity + 1 })}
                            className="px-1 hover:bg-accent"
                          >
                            <Plus size={10} />
                          </button>
                        </div>
                      </div>
                      <div>
                        <label className="text-[9px] text-muted-foreground block">Dente</label>
                        <input
                          type="text"
                          value={it.tooth_fdi}
                          onChange={(e) => updateBasketItem(idx, { tooth_fdi: e.target.value })}
                          placeholder="—"
                          className="w-full px-1.5 py-1 text-xs rounded border border-border bg-background"
                        />
                      </div>
                      <div>
                        <label className="text-[9px] text-muted-foreground block">Unit. R$</label>
                        <input
                          type="number"
                          step="0.01"
                          min={0}
                          value={it.unit_price}
                          onChange={(e) => updateBasketItem(idx, { unit_price: e.target.value })}
                          className="w-full px-1.5 py-1 text-xs rounded border border-border bg-background"
                        />
                      </div>
                    </div>
                    <div className="text-right text-xs font-semibold text-primary">
                      = {formatBRL(Number(it.unit_price || 0) * it.quantity)}
                    </div>
                  </div>
                ))
              )}
            </div>

            {basket.length > 0 && (
              <div className="p-3 border-t border-border bg-background/50">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-muted-foreground">Subtotal da cesta</span>
                  <span className="text-base font-bold text-primary">
                    {formatBRL(basketSubtotal)}
                  </span>
                </div>
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
            Adicionar {basket.length > 0 && `(${basket.length})`}
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
  /** Onda 3.29 — fdi → nome do outro procedimento que ja usa esse dente */
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
