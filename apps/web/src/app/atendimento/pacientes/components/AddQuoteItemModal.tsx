'use client';

/**
 * AddQuoteItemModal — modal pra adicionar procedimentos ao orçamento.
 *
 * Redesign Onda 6 (visual baseado em mockup ChatGPT):
 *  - Header limpo com label "Nome" lateral
 *  - Odontograma sempre visivel com toggle Adulto/Infantil + dentes dourados
 *  - Pills horizontais de filtro por especialidade (em vez de seções colapsáveis)
 *  - Lista plana com cards estilizados (ícone colorido + nome + TUSS/duração + valor + +)
 *  - Cesta lateral com chips amarelos dos dentes + controles -/+
 *  - Footer com info "N dentes · M procedimentos · ~Th de cadeira"
 *  - CTAs hierarquizados: Cancelar (ghost) + Adicionar ao orçamento (sólido)
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Plus, Minus, Search, Loader2, ShoppingCart, Save, Info, Check, Droplet, Copy,
} from 'lucide-react';
import { useTheme } from 'next-themes';
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
  id?: string;
  procedure_id: string;
  procedure_name: string;
  unit_price: string;
  quantity: number;
  tooth_fdis: string[];
  duration_minutes?: number;
}

interface ExistingQuoteItem {
  id: string;
  procedure_id: string;
  tooth_fdi: string | null;
  quantity: number;
  unit_price: string | number;
  procedure?: { id: string; name: string; duration_minutes?: number };
}

interface QuoteData {
  id: string;
  title: string | null;
  priority: string | null;
  /** Onda 14.2 — status pra bloquear edicao quando quote ja foi aceito/enviado */
  status: 'DRAFT' | 'SENT' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
  items: ExistingQuoteItem[];
}

interface Props {
  quoteId: string;
  procedures: Procedure[];
  onClose: () => void;
  onAdded: () => void | Promise<void>;
  prefillTeeth?: string[];
  initialTitle?: string | null;
  /** Onda 3.42 — Duplica este orcamento (cria novo DRAFT com items + " cópia N").
   * Quando definido, renderiza botao "Duplicar" vermelho no footer. */
  onDuplicate?: () => void | Promise<void>;
}

// Paleta de cores por especialidade (mesma da tabela de precos)
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

export default function AddQuoteItemModal({ quoteId, procedures, onClose, onAdded, prefillTeeth, initialTitle, onDuplicate }: Props) {
  // Onda 6 — paleta dos cards se adapta ao tema (dark precisa de tint mais
  // forte pra cor ser visivel; light precisa ser mais sutil pra nao saturar).
  // Onda 15: dark = noturno (preto+dourado) ou cyber (roxo+ciano).
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'noturno' || resolvedTheme === 'cyber';
  const tintIdle  = isDark ? '24' : '0d';  // ~14% dark / ~5% light
  const tintHover = isDark ? '3d' : '1f';  // ~24% dark / ~12% light
  const borderTone = isDark ? '66' : '40'; // ~40% dark / ~25% light

  const [search, setSearch] = useState('');
  const [basket, setBasket] = useState<BasketItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [activeBasketIdx, setActiveBasketIdx] = useState<number | null>(null);
  const [titleDraft, setTitleDraft] = useState<string>(initialTitle || '');
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [loadingExisting, setLoadingExisting] = useState(true);
  const [originalTitle, setOriginalTitle] = useState<string>(initialTitle || '');
  // Onda 14.2 — Status do quote pra bloquear edicao quando nao for DRAFT
  const [quoteStatus, setQuoteStatus] = useState<QuoteData['status']>('DRAFT');
  // Onda 6.2 — Snapshot dos tooth_fdis originais por item.id pra detectar
  // mudanca nos dentes de items existentes (operador toggla no odontograma).
  // Sem isso, mudancas em items ja salvos nao habilitam o botao "Adicionar".
  const [originalToothByItemId, setOriginalToothByItemId] = useState<Map<string, string[]>>(new Map());
  // Onda 6 — filtro por pill de especialidade ("__all__" mostra todas)
  const [specialtyFilter, setSpecialtyFilter] = useState<string>('__all__');
  // Onda 6 — toggle Adulto/Infantil (visual; dentes deciduos podem vir depois)
  const [dentitionMode, setDentitionMode] = useState<'adult' | 'child'>('adult');
  // Onda 6.4 — Prioridade clinica (Avaliacao). Dentista classifica o orcamento
  // como COMPLETO (tratamento completo, default) | ESSENCIAL (importante) |
  // URGENTE (precisa hoje). Recepcao usa pra priorizar o fechamento.
  type Priority = 'COMPLETO' | 'ESSENCIAL' | 'URGENTE';
  const [priority, setPriority] = useState<Priority>('COMPLETO');
  const [originalPriority, setOriginalPriority] = useState<Priority>('COMPLETO');
  const inputRef = useRef<HTMLInputElement>(null);

  const hasPrefilledTeeth = !!(prefillTeeth && prefillTeeth.length > 0);
  const activeItem = activeBasketIdx !== null ? basket[activeBasketIdx] : null;
  const prefilledConsumedRef = useRef(false);
  const titleChanged = titleDraft.trim() !== originalTitle.trim();
  const priorityChanged = priority !== originalPriority;

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  // Carrega items existentes do quote ao montar
  useEffect(() => {
    if (!quoteId) {
      setLoadingExisting(false);
      return;
    }
    let cancelled = false;
    setLoadingExisting(true);
    (async () => {
      try {
        const { data } = await api.get<QuoteData>(`/quotes/${quoteId}`);
        if (cancelled) return;
        // Onda 14.2 — guarda status pra UI mostrar warning + desabilitar submit
        setQuoteStatus(data.status);
        const t = data.title || '';
        setTitleDraft(t);
        setOriginalTitle(t);
        const pri = (data.priority === 'ESSENCIAL' || data.priority === 'URGENTE')
          ? data.priority
          : 'COMPLETO';
        setPriority(pri);
        setOriginalPriority(pri);
        const items: BasketItem[] = data.items.map((it) => ({
          id: it.id,
          procedure_id: it.procedure_id,
          procedure_name: it.procedure?.name || 'procedimento',
          unit_price: String(it.unit_price ?? ''),
          quantity: it.quantity,
          tooth_fdis: it.tooth_fdi ? [it.tooth_fdi] : [],
          duration_minutes: it.procedure?.duration_minutes,
        }));
        setBasket(items);
        // Snapshot dos dentes originais pra detectar mudancas depois
        const snap = new Map<string, string[]>();
        items.forEach((it) => {
          if (it.id) snap.set(it.id, [...it.tooth_fdis]);
        });
        setOriginalToothByItemId(snap);
      } catch {
        // Silencia: se nao conseguir carregar, abre vazio
      } finally {
        if (!cancelled) setLoadingExisting(false);
      }
    })();
    return () => { cancelled = true; };
  }, [quoteId]);

  // Contagem por especialidade (pra exibir nos pills)
  const specialtyCounts = useMemo(() => {
    const counts: Record<string, { name: string; count: number }> = {};
    for (const p of procedures) {
      const key = p.specialty?.id || p.specialty_id || '__none__';
      const name = p.specialty?.name || 'Sem especialidade';
      if (!counts[key]) counts[key] = { name, count: 0 };
      counts[key].count++;
    }
    return counts;
  }, [procedures]);

  // Lista plana filtrada por search + especialidade
  const filteredProcedures = useMemo(() => {
    const q = search.trim().toLowerCase();
    return procedures.filter((p) => {
      if (specialtyFilter !== '__all__') {
        const key = p.specialty?.id || p.specialty_id || '__none__';
        if (key !== specialtyFilter) return false;
      }
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.code_tuss || '').toLowerCase().includes(q)
      );
    });
  }, [procedures, search, specialtyFilter]);

  const addToBasket = (p: Procedure) => {
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
      duration_minutes: p.duration_minutes,
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
    setBasket((prev) => {
      const target = prev[idx];
      if (target?.id) {
        setRemovedIds((rs) => {
          const next = new Set(rs);
          next.add(target.id!);
          return next;
        });
      }
      return prev.filter((_, i) => i !== idx);
    });
    setActiveBasketIdx((prev) => {
      if (prev === idx) return null;
      if (prev !== null && prev > idx) return prev - 1;
      return prev;
    });
  };

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

  // Resumo no footer: total dentes únicos + procedimentos efetivos + tempo
  const summaryStats = useMemo(() => {
    const allTeeth = new Set<string>();
    let procCount = 0;
    let totalMinutes = 0;
    basket.forEach((it) => {
      it.tooth_fdis.forEach((t) => allTeeth.add(t));
      const effectiveQty = Math.max(it.tooth_fdis.length, 1);
      procCount += effectiveQty;
      if (it.duration_minutes) totalMinutes += it.duration_minutes * effectiveQty;
    });
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    const timeLabel = totalMinutes <= 0
      ? null
      : h > 0
        ? (m > 0 ? `~${h}h${String(m).padStart(2, '0')}min` : `~${h}h`)
        : `~${m}min`;
    return { dentes: allTeeth.size, procedimentos: procCount, tempo: timeLabel };
  }, [basket]);

  const totalItemsToCreate = basket.reduce((acc, it) => {
    if (it.id) return acc;
    return acc + Math.max(it.tooth_fdis.length, 1);
  }, 0);
  const newItemsCount = basket.filter((it) => !it.id).length;

  // Onda 6.2 — detecta items existentes com dentes alterados (toggla via odontograma)
  const isItemToothChanged = (it: BasketItem): boolean => {
    if (!it.id) return false;
    const original = originalToothByItemId.get(it.id) || [];
    if (original.length !== it.tooth_fdis.length) return true;
    const a = [...it.tooth_fdis].sort();
    const b = [...original].sort();
    return a.some((v, i) => v !== b[i]);
  };
  const itemsWithChangedTeeth = basket.filter(isItemToothChanged);
  const hasChanges =
    newItemsCount > 0
    || removedIds.size > 0
    || titleChanged
    || priorityChanged
    || itemsWithChangedTeeth.length > 0;

  const submit = async (keepOpen: boolean) => {
    // Onda 14.2 — bloqueia se quote nao for DRAFT (backend tambem valida)
    if (quoteStatus !== 'DRAFT') {
      showError(
        `Este orçamento está ${quoteStatus} e não pode mais ser editado. ` +
        `Crie uma nova versão na aba Propostas → "+ nova versão".`,
      );
      return;
    }
    if (!hasChanges) {
      showError('Nada pra salvar — adicione, remova procedimentos ou edite o nome');
      return;
    }
    setSaving(true);
    try {
      if (titleChanged || priorityChanged) {
        await api.patch(`/quotes/${quoteId}`, {
          ...(titleChanged ? { title: titleDraft.trim() || null } : {}),
          ...(priorityChanged ? { priority } : {}),
        });
      }
      for (const id of removedIds) {
        try {
          await api.delete(`/quote-items/${id}`);
        } catch {
          // ignora — provavelmente ja foi deletado
        }
      }
      // Onda 6.2 — items existentes com dentes alterados: DELETE original + POST com novos
      let updatedCount = 0;
      for (const it of itemsWithChangedTeeth) {
        if (!it.id) continue;
        try { await api.delete(`/quote-items/${it.id}`); } catch {}
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
        updatedCount++;
      }
      let createdCount = 0;
      for (const it of basket) {
        if (it.id) continue;
        const teeth = it.tooth_fdis.length > 0 ? it.tooth_fdis : [null];
        const qtyPerPost = it.tooth_fdis.length > 0 ? 1 : it.quantity;
        for (const tooth of teeth) {
          await api.post(`/quotes/${quoteId}/items`, {
            procedure_id: it.procedure_id,
            quantity: qtyPerPost,
            unit_price: it.unit_price === '' ? undefined : Number(it.unit_price),
            tooth_fdi: tooth || undefined,
          });
          createdCount++;
        }
      }
      const summary = [
        createdCount > 0 ? `+${createdCount} novo(s)` : null,
        updatedCount > 0 ? `${updatedCount} atualizado(s)` : null,
        removedIds.size > 0 ? `-${removedIds.size} removido(s)` : null,
        titleChanged && titleDraft.trim() ? `nome: "${titleDraft.trim()}"` : null,
        priorityChanged ? `prioridade: ${priority}` : null,
      ].filter(Boolean).join(' · ');
      showSuccess(summary || 'Orçamento atualizado');
      await onAdded();
      if (keepOpen) {
        setBasket((prev) => prev.filter((it) => it.id));
        setRemovedIds(new Set());
        setActiveBasketIdx(null);
        prefilledConsumedRef.current = false;
        setSearch('');
        setOriginalTitle(titleDraft);
        setOriginalPriority(priority);
        setTimeout(() => inputRef.current?.focus(), 50);
      } else {
        onClose();
      }
    } catch (err: any) {
      // Onda 14.2 — log no console pra debug + mensagem detalhada pro user
      const msg = err?.response?.data?.message;
      const status = err?.response?.status;
      console.error('[AddQuoteItemModal] Erro ao salvar:', { status, msg, err });
      showError(
        msg
          ? `Erro ao adicionar (${status || 'rede'}): ${msg}`
          : `Erro ao adicionar — verifique o status do orçamento`,
      );
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
        className="bg-card border border-border rounded-2xl w-full max-w-5xl shadow-2xl max-h-[92vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ─── HEADER ────────────────────────────────────────── */}
        <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Plus size={18} className="text-primary" />
            <h2 className="text-base font-semibold">Adicionar procedimentos ao orçamento</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-accent rounded-full"
            aria-label="Fechar"
          >
            <X size={18} />
          </button>
        </div>

        {/* Onda 14.2 — Banner quando quote ja foi aceito/enviado/rejeitado.
            Impede edicao e explica o que fazer. */}
        {quoteStatus !== 'DRAFT' && !loadingExisting && (
          <div className={`px-5 py-3 border-b border-border ${
            quoteStatus === 'ACCEPTED' ? 'bg-emerald-500/10' :
            quoteStatus === 'REJECTED' ? 'bg-red-500/10' :
            'bg-amber-500/10'
          }`}>
            <p className="text-sm font-semibold text-foreground flex items-center gap-2">
              {quoteStatus === 'ACCEPTED' && '✓ Orçamento ACEITO'}
              {quoteStatus === 'SENT' && '📤 Orçamento ENVIADO'}
              {quoteStatus === 'REJECTED' && '✕ Orçamento REJEITADO'}
              {quoteStatus === 'EXPIRED' && '⏰ Orçamento EXPIRADO'}
              <span className="text-xs font-normal text-muted-foreground ml-2">
                — não pode mais ser editado
              </span>
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {quoteStatus === 'ACCEPTED'
                ? 'Pra mudar procedimentos, crie uma nova versão do plano na aba Propostas.'
                : quoteStatus === 'SENT'
                ? 'O orçamento já foi enviado ao paciente. Pra editar, primeiro retorne pra DRAFT na aba Orçamentos.'
                : 'Crie uma nova versão ou duplique este orçamento.'}
            </p>
          </div>
        )}

        {/* ─── NOME DO ORÇAMENTO ────────────────────────────── */}
        <div className="px-5 py-3 flex items-center gap-3">
          <label className="text-sm font-medium text-foreground shrink-0">Nome</label>
          <input
            type="text"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            placeholder="Ex: Reabilitação superior, Canal + coroa 36 (opcional)"
            maxLength={100}
            className="flex-1 px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-muted-foreground/60"
          />
        </div>

        {/* ─── PRIORIDADE CLÍNICA (Onda 6.4) ────────────────── */}
        <div className="px-5 pb-3 flex items-center gap-3 flex-wrap">
          <label className="text-sm font-medium text-foreground shrink-0">Prioridade</label>
          <div className="inline-flex rounded-lg border border-border bg-background p-0.5 text-xs font-semibold">
            <button
              type="button"
              onClick={() => setPriority('COMPLETO')}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                priority === 'COMPLETO'
                  ? 'bg-emerald-500 text-white'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              }`}
              title="Tratamento completo — sem urgência"
            >
              ✓ Completo
            </button>
            <button
              type="button"
              onClick={() => setPriority('ESSENCIAL')}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                priority === 'ESSENCIAL'
                  ? 'bg-amber-500 text-white'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              }`}
              title="Procedimentos importantes — fazer em breve"
            >
              ⚠ Essencial
            </button>
            <button
              type="button"
              onClick={() => setPriority('URGENTE')}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                priority === 'URGENTE'
                  ? 'bg-red-600 text-white'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              }`}
              title="Urgência — paciente precisa o quanto antes"
            >
              🔥 Urgente
            </button>
          </div>
        </div>

        {/* ─── ODONTOGRAMA ──────────────────────────────────── */}
        <Odontograma
          activeFdis={activeItem?.tooth_fdis || []}
          activeProcedureName={activeItem?.procedure_name}
          otherUsedFdis={otherUsedFdis}
          onToggle={toggleToothInActive}
          hasActive={activeBasketIdx !== null}
          dentitionMode={dentitionMode}
          onDentitionChange={setDentitionMode}
        />

        {/* ─── BODY (lista esquerda + cesta direita) ────────── */}
        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[1fr_340px] gap-0 overflow-hidden border-t border-border">
          {/* COLUNA ESQ — busca + pills + lista plana */}
          <div className="flex flex-col overflow-hidden min-h-0">
            {/* Busca */}
            <div className="px-5 pt-4">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  ref={inputRef}
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar por nome ou código TUSS..."
                  className="w-full pl-9 pr-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-muted-foreground/60"
                />
              </div>
            </div>

            {/* Pills de filtro por especialidade */}
            <div className="px-5 pt-3 flex flex-wrap gap-2">
              <FilterPill
                label="Todos"
                count={procedures.length}
                active={specialtyFilter === '__all__'}
                onClick={() => setSpecialtyFilter('__all__')}
              />
              {Object.entries(specialtyCounts)
                .sort(([, a], [, b]) => a.name.localeCompare(b.name, 'pt-BR'))
                .map(([key, { name, count }]) => (
                  <FilterPill
                    key={key}
                    label={name}
                    count={count}
                    active={specialtyFilter === key}
                    color={colorForSpecialty(key)}
                    onClick={() => setSpecialtyFilter(key)}
                  />
                ))}
            </div>

            {/* Lista plana de procedimentos */}
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3 space-y-2">
              {procedures.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  Nenhum procedimento cadastrado.{' '}
                  <a href="/atendimento/settings/procedures" className="text-primary underline">
                    Cadastrar tabela de preços
                  </a>
                </div>
              ) : filteredProcedures.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  Nenhum procedimento corresponde aos filtros.
                </div>
              ) : (
                filteredProcedures.map((p) => {
                  const inBasketCount = basket
                    .filter((b) => b.procedure_id === p.id)
                    .reduce((acc, b) => acc + Math.max(b.tooth_fdis.length, 1), 0);
                  const key = p.specialty?.id || p.specialty_id || '__none__';
                  const color = colorForSpecialty(key);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => addToBasket(p)}
                      className="w-full px-3 py-2.5 flex items-center gap-3 border rounded-xl transition-colors text-left group"
                      style={{
                        backgroundColor: color + tintIdle,
                        borderColor: color + borderTone,
                        borderLeftWidth: 4,
                        borderLeftColor: color,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = color + tintHover;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = color + tintIdle;
                      }}
                    >
                      {/* Bolha de cor da especialidade */}
                      <div
                        className="w-9 h-9 rounded-lg shrink-0 flex items-center justify-center"
                        style={{ backgroundColor: color + '33' }}
                      >
                        <Droplet size={14} style={{ color }} />
                      </div>
                      {/* Nome + meta — visao clinica SEM valores monetarios.
                          Dentistas nao tem acesso a valores; precos moram so
                          na aba Orcamentos (visao comercial/recepcao). */}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-foreground truncate">
                          {p.name}
                        </div>
                        <div className="text-[11px] text-muted-foreground flex items-center gap-2 mt-0.5">
                          {p.duration_minutes && (
                            <span className="inline-flex items-center gap-0.5">
                              ⏱ {p.duration_minutes} min
                            </span>
                          )}
                          {p.code_tuss && <span>TUSS {p.code_tuss}</span>}
                        </div>
                      </div>
                      {/* Botão + */}
                      <div className="relative">
                        <span className="w-7 h-7 rounded-lg bg-background border border-border group-hover:bg-primary group-hover:border-primary group-hover:text-primary-foreground flex items-center justify-center transition-colors">
                          <Plus size={14} />
                        </span>
                        {inBasketCount > 0 && (
                          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-bold flex items-center justify-center">
                            {inBasketCount}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* COLUNA DIR — cesta */}
          <div className="border-l border-border bg-muted/20 flex flex-col overflow-hidden min-h-0">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ShoppingCart size={14} className="text-primary" />
                <span className="text-sm font-semibold">Cesta</span>
              </div>
              <span className="text-xs text-muted-foreground">
                {basket.length} {basket.length === 1 ? 'item' : 'itens'}
              </span>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
              {loadingExisting ? (
                <div className="p-6 text-center text-xs text-muted-foreground">
                  <Loader2 size={20} className="mx-auto mb-2 animate-spin" />
                  Carregando procedimentos...
                </div>
              ) : basket.length === 0 ? (
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
                      key={it.id || `new-${idx}`}
                      onClick={() => setActiveBasketIdx(idx)}
                      className={`bg-card border rounded-xl p-3 space-y-2 cursor-pointer transition-colors ${
                        isActive
                          ? 'border-primary shadow-sm ring-1 ring-primary/30'
                          : 'border-border hover:border-primary/30'
                      }`}
                    >
                      {/* Linha 1: nome + X (sem valor — visao clinica) */}
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs font-semibold text-foreground line-clamp-2 flex-1">
                          {it.procedure_name}
                        </p>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); removeFromBasket(idx); }}
                          className="text-muted-foreground hover:text-destructive p-0.5 rounded shrink-0"
                          title="Remover"
                        >
                          <X size={12} />
                        </button>
                      </div>

                      {/* Linha 2: chips dos dentes + controles qtd */}
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        {/* Chips amarelos dos dentes */}
                        <div className="flex items-center gap-1 flex-wrap min-w-0">
                          {hasTeeth ? (
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
                                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-mono text-[10px] font-bold bg-amber-200 text-amber-900 hover:bg-amber-300 group"
                                title={`Remover dente ${fdi}`}
                              >
                                {fdi}
                                <X size={9} className="opacity-50 group-hover:opacity-100" />
                              </button>
                            ))
                          ) : (
                            <span className="text-[10px] text-muted-foreground italic">
                              clique no odontograma acima
                            </span>
                          )}
                        </div>

                        {/* Controles - 1 + */}
                        {hasTeeth ? (
                          <span className="text-[10px] text-muted-foreground italic shrink-0">
                            {effectiveQty}× (1/dente)
                          </span>
                        ) : (
                          <div
                            className="flex items-center border border-border rounded-lg bg-background shrink-0"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              onClick={() => updateBasketItem(idx, { quantity: Math.max(1, it.quantity - 1) })}
                              className="px-1.5 py-1 hover:bg-accent rounded-l-lg"
                            >
                              <Minus size={10} />
                            </button>
                            <span className="px-2 py-1 text-xs font-bold min-w-[1.5rem] text-center">
                              {it.quantity}
                            </span>
                            <button
                              type="button"
                              onClick={() => updateBasketItem(idx, { quantity: it.quantity + 1 })}
                              className="px-1.5 py-1 hover:bg-accent rounded-r-lg"
                            >
                              <Plus size={10} />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* ─── FOOTER ────────────────────────────────────────── */}
        <div className="border-t border-border px-5 py-3 flex items-center justify-between gap-3 flex-wrap bg-background/50">
          <div className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Info size={12} />
            <span>
              <strong className="text-foreground">{summaryStats.dentes}</strong> dente{summaryStats.dentes === 1 ? '' : 's'}
              {' · '}
              <strong className="text-foreground">{summaryStats.procedimentos}</strong> procedimento{summaryStats.procedimentos === 1 ? '' : 's'}
              {summaryStats.tempo && (
                <>
                  {' · '}
                  <strong className="text-foreground">{summaryStats.tempo}</strong> de cadeira
                </>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 rounded-lg text-sm hover:bg-accent disabled:opacity-50 text-muted-foreground"
            >
              Cancelar
            </button>
            {onDuplicate && (
              <button
                type="button"
                onClick={() => onDuplicate()}
                disabled={saving}
                className="px-3 py-2 rounded-lg text-sm font-semibold inline-flex items-center gap-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
                title="Duplicar este orçamento (cria novo rascunho com os mesmos procedimentos + ' cópia N')"
              >
                <Copy size={14} /> Duplicar
              </button>
            )}
            <button
              type="button"
              onClick={() => submit(true)}
              disabled={saving || !hasChanges || quoteStatus !== 'DRAFT'}
              className="px-3 py-2 rounded-lg border border-border text-sm hover:bg-accent disabled:opacity-50 inline-flex items-center gap-1.5"
              title={
                quoteStatus !== 'DRAFT'
                  ? `Orçamento ${quoteStatus} — não pode ser editado`
                  : 'Salva e mantém o modal aberto pra continuar editando'
              }
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Salvar e continuar
            </button>
            <button
              type="button"
              onClick={() => submit(false)}
              disabled={saving || !hasChanges || quoteStatus !== 'DRAFT'}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5 shadow-sm"
              title={
                quoteStatus !== 'DRAFT'
                  ? `Orçamento ${quoteStatus} — não pode ser editado`
                  : undefined
              }
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              Adicionar ao orçamento
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Filter pill ──────────────────────────────────────────────────────

function FilterPill({
  label, count, active, onClick, color,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
        active
          ? 'bg-foreground text-background border-foreground'
          : 'bg-background border-border text-foreground hover:border-primary/40 hover:bg-accent/40'
      }`}
      style={
        active && color
          ? { backgroundColor: color, borderColor: color, color: '#fff' }
          : undefined
      }
    >
      {label}
      <span className={`text-[10px] ${active ? 'opacity-80' : 'text-muted-foreground'}`}>
        {count}
      </span>
    </button>
  );
}

// ─── Odontograma ──────────────────────────────────────────────────────

const FDI_PERM_SUP_DIR = ['18', '17', '16', '15', '14', '13', '12', '11'];
const FDI_PERM_SUP_ESQ = ['21', '22', '23', '24', '25', '26', '27', '28'];
const FDI_PERM_INF_ESQ = ['31', '32', '33', '34', '35', '36', '37', '38'];
const FDI_PERM_INF_DIR = ['48', '47', '46', '45', '44', '43', '42', '41'];

// Dentes deciduos (infantil) — quadrantes 5/6/7/8
const FDI_DEC_SUP_DIR = ['55', '54', '53', '52', '51'];
const FDI_DEC_SUP_ESQ = ['61', '62', '63', '64', '65'];
const FDI_DEC_INF_ESQ = ['71', '72', '73', '74', '75'];
const FDI_DEC_INF_DIR = ['85', '84', '83', '82', '81'];

function Odontograma({
  activeFdis,
  activeProcedureName,
  otherUsedFdis,
  onToggle,
  hasActive,
  dentitionMode,
  onDentitionChange,
}: {
  activeFdis: string[];
  activeProcedureName?: string;
  otherUsedFdis: Map<string, string>;
  onToggle: (fdi: string) => void;
  hasActive: boolean;
  dentitionMode: 'adult' | 'child';
  onDentitionChange: (m: 'adult' | 'child') => void;
}) {
  const activeSet = new Set(activeFdis);
  const isAdult = dentitionMode === 'adult';
  const supDir = isAdult ? FDI_PERM_SUP_DIR : FDI_DEC_SUP_DIR;
  const supEsq = isAdult ? FDI_PERM_SUP_ESQ : FDI_DEC_SUP_ESQ;
  const infDir = isAdult ? FDI_PERM_INF_DIR : FDI_DEC_INF_DIR;
  const infEsq = isAdult ? FDI_PERM_INF_ESQ : FDI_DEC_INF_ESQ;

  return (
    <div className="px-5 py-3">
      <div className="bg-stone-50 dark:bg-stone-900/40 border border-stone-200 dark:border-stone-800 rounded-xl px-4 py-3">
        {/* Cabecalho com label + toggle Adulto/Infantil */}
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Droplet size={14} className="text-stone-500" />
            <span>
              {hasActive ? (
                <>
                  Selecione os dentes para{' '}
                  <strong className="text-primary">{activeProcedureName}</strong>
                </>
              ) : (
                'Selecione os dentes envolvidos no tratamento'
              )}
            </span>
          </div>
          <div className="inline-flex rounded-full border border-stone-200 dark:border-stone-700 bg-background p-0.5 text-xs font-medium">
            <button
              type="button"
              onClick={() => onDentitionChange('adult')}
              className={`px-3 py-1 rounded-full transition-colors ${
                isAdult ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Adulto
            </button>
            <button
              type="button"
              onClick={() => onDentitionChange('child')}
              className={`px-3 py-1 rounded-full transition-colors ${
                !isAdult ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Infantil
            </button>
          </div>
        </div>

        {/* Grid de dentes — Onda 16.1: visual 3D em formato de dente real
            (SVG inline com gradient + highlight + glow). Superiores rotacionam
            180deg pra ficarem com coroa pra baixo (anatomia natural — olhando
            de frente pra boca aberta). Separador central tipo LUMEN. */}
        <div className="flex flex-col items-center gap-2">
          <div className="flex justify-center gap-4">
            <ToothRow fdiList={supDir} activeSet={activeSet} otherUsedFdis={otherUsedFdis} onToggle={onToggle} hasActive={hasActive} isUpper={true} />
            <div className="w-px bg-stone-300 dark:bg-stone-700 self-stretch" />
            <ToothRow fdiList={supEsq} activeSet={activeSet} otherUsedFdis={otherUsedFdis} onToggle={onToggle} hasActive={hasActive} isUpper={true} />
          </div>
          <div className="flex items-center w-full max-w-[560px] text-[10px] font-bold text-muted-foreground tracking-wider">
            <div className="flex-1 h-px bg-border" />
            <span className="px-3 uppercase">↑ superior · inferior ↓</span>
            <div className="flex-1 h-px bg-border" />
          </div>
          <div className="flex justify-center gap-4">
            <ToothRow fdiList={infDir} activeSet={activeSet} otherUsedFdis={otherUsedFdis} onToggle={onToggle} hasActive={hasActive} isUpper={false} />
            <div className="w-px bg-stone-300 dark:bg-stone-700 self-stretch" />
            <ToothRow fdiList={infEsq} activeSet={activeSet} otherUsedFdis={otherUsedFdis} onToggle={onToggle} hasActive={hasActive} isUpper={false} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ToothRow({
  fdiList, activeSet, otherUsedFdis, onToggle, hasActive, isUpper,
}: {
  fdiList: string[];
  activeSet: Set<string>;
  otherUsedFdis: Map<string, string>;
  onToggle: (fdi: string) => void;
  hasActive: boolean;
  isUpper: boolean;
}) {
  return (
    <div className="flex gap-1.5 items-end">
      {fdiList.map((fdi) => {
        const isActive = activeSet.has(fdi);
        const otherProcName = otherUsedFdis.get(fdi);
        const isOtherUsed = !!otherProcName && !isActive;
        const title = isActive
          ? `Click pra remover dente ${fdi}`
          : isOtherUsed
          ? `Dente ${fdi} ja em uso por: ${otherProcName}`
          : hasActive
          ? `Click pra adicionar dente ${fdi}`
          : 'Selecione um procedimento da cesta primeiro';
        return (
          <Tooth3D
            key={fdi}
            fdi={fdi}
            isActive={isActive}
            isOtherUsed={isOtherUsed}
            disabled={!hasActive}
            isUpper={isUpper}
            onClick={() => onToggle(fdi)}
            title={title}
          />
        );
      })}
    </div>
  );
}

// ─── Dente 3D (SVG inline) ────────────────────────────────────────────
// Onda 16.1 — substituicao dos botoes quadrados por visual de dente real.
// Cores via gradient + highlight elipse pra dar profundidade. Glow no
// estado ativo pra reforcar selecao visual.
function Tooth3D({
  fdi, isActive, isOtherUsed, disabled, isUpper, onClick, title,
}: {
  fdi: string;
  isActive: boolean;
  isOtherUsed: boolean;
  disabled: boolean;
  isUpper: boolean;
  onClick: () => void;
  title: string;
}) {
  // Paleta por estado
  const colors = isActive
    ? { fill: '#fbbf24', highlight: '#fde68a', stroke: '#d97706', glow: 'rgba(251, 191, 36, 0.65)', textColor: 'text-amber-700' }
    : isOtherUsed
    ? { fill: '#fed7aa', highlight: '#ffedd5', stroke: '#fb923c', glow: 'transparent', textColor: 'text-amber-700' }
    : disabled
    ? { fill: '#e7e5e4', highlight: '#f5f5f4', stroke: '#d6d3d1', glow: 'transparent', textColor: 'text-muted-foreground/60' }
    : { fill: '#f5f5f4', highlight: '#ffffff', stroke: '#a8a29e', glow: 'transparent', textColor: 'text-stone-600' };

  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
      className={`group relative flex flex-col items-center gap-0.5 transition-all ${
        disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer hover:scale-110'
      } ${isActive ? 'scale-110' : ''}`}
    >
      <div
        className="relative w-7 h-9"
        style={{
          filter: isActive
            ? `drop-shadow(0 0 6px ${colors.glow}) drop-shadow(0 2px 3px rgba(0,0,0,0.15))`
            : 'drop-shadow(0 1px 2px rgba(0,0,0,0.10))',
        }}
      >
        <svg
          viewBox="0 0 32 36"
          className={`w-full h-full ${isUpper ? 'rotate-180' : ''}`}
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <linearGradient id={`tooth-${fdi}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors.highlight} />
              <stop offset="55%" stopColor={colors.fill} />
              <stop offset="100%" stopColor={colors.fill} />
            </linearGradient>
          </defs>
          {/* Path do dente: coroa arredondada larga + 2 raizes que se separam */}
          <path
            d="M16 2 C 9 2, 5 6, 5 13 C 5 17, 6 21, 7 25 C 7.5 29, 9 33, 11 33 C 12.5 33, 13 30, 13.5 27 C 14 25, 14.5 24, 16 24 C 17.5 24, 18 25, 18.5 27 C 19 30, 19.5 33, 21 33 C 23 33, 24.5 29, 25 25 C 26 21, 27 17, 27 13 C 27 6, 23 2, 16 2 Z"
            fill={`url(#tooth-${fdi})`}
            stroke={colors.stroke}
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          {/* Highlight elipse pra dar 3D */}
          <ellipse cx="11" cy="9" rx="2.5" ry="4" fill="white" opacity="0.45" />
        </svg>
      </div>
      <span className={`text-[9px] font-bold leading-none ${colors.textColor}`}>
        {fdi}
      </span>
      {isOtherUsed && !isActive && (
        <span
          className="absolute top-0 right-0 w-1.5 h-1.5 rounded-full bg-amber-500 ring-1 ring-background"
          aria-hidden="true"
        />
      )}
    </button>
  );
}
