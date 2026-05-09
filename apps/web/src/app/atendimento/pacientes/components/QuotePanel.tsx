'use client';

/**
 * QuotePanel — painel inline de orcamento embutido no Odontograma.
 *
 * Substitui o modal full-screen pra fluxo "anotar dente -> orcar" sem perder
 * o contexto visual do odontograma. Tres formas de adicionar:
 *  1. Click em "+ procedimentos" (sem dente) — proc avulso (limpeza, etc)
 *  2. Ctrl+click em N dentes no odontograma -> banner aparece com modo
 *     "multiplicar" (1 item/dente) ou "unificar" (1 item agregado)
 *  3. (Fase 2) anotar estado clinico no dente -> sugestao automatica
 *
 * Edicao inline de qtd/preco. Detalhe avancado (face, dentista, payment_method
 * por item) fica no /quotes/:id existente — link "Detalhes" no rodape.
 */

import { useState, useMemo, useEffect, useCallback } from 'react';
import {
  Loader2, Plus, Search, Trash2, ShoppingCart, X,
  Pencil, Layers, DollarSign, Lightbulb, Check,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { colorForSpecialty } from '@/lib/specialty-colors';

interface Procedure {
  id: string;
  name: string;
  base_price: string | number;
  code_tuss: string | null;
  duration_minutes?: number;
  specialty?: { id: string; name: string } | null;
  specialty_id?: string | null;
}

interface QuoteItem {
  id: string;
  procedure_id: string;
  tooth_fdi: string | null;
  quantity: number;
  unit_price: string | number;
  total_price: string | number;
  notes?: string | null;
  procedure?: {
    id: string;
    name: string;
    code_tuss?: string | null;
    specialty_id?: string | null;
    specialty?: { id: string; name: string } | null;
  };
}

interface Quote {
  id: string;
  status: string;
  subtotal: string | number;
  discount_percent: string | number;
  discount_value: string | number;
  total_value: string | number;
  items: QuoteItem[];
}

interface Props {
  patientId: string;
  /** Quote draft ativo. null = ainda carregando. */
  quote: Quote | null;
  procedures: Procedure[];
  /** Dentes pre-selecionados via Ctrl+click no odontograma. */
  selectedTeeth: string[];
  /** Limpa multi-selecao no parent. */
  onClearSelection: () => void;
  /** Refetch o quote depois de mutacao. */
  onQuoteChange: () => void | Promise<void>;
  loading?: boolean;
  /**
   * Onda 3.2 — Ultima anotacao clinica nova (nao edicao). Quando muda,
   * o painel busca sugestoes automaticas configuradas e mostra card.
   * `ts` garante que a mesma dupla (fdi, state) anotada de novo dispare effect.
   */
  lastAnnotation?: { tooth_fdi: string; state: string; ts: number } | null;
  /** Callback pra consumir/descartar a anotacao apos o usuario decidir. */
  onAnnotationConsumed?: () => void;
  /**
   * Onda 3.9 — Modo compacto: usado quando o painel esta DENTRO de um card
   * expansivel (cada orcamento na lista tem um QuotePanel inline). Esconde
   * o header proprio (o card pai ja tem nome/status/categoria) e o link
   * "Ir para orcamentos" (operador ja esta editando o quote).
   */
  compact?: boolean;
}

// Onda 3.2 — sugestao buscada de /state-suggestions
interface Suggestion {
  id: string;
  state: string;
  priority: number;
  procedure: {
    id: string;
    name: string;
    base_price: string | number;
    code_tuss: string | null;
    duration_minutes?: number;
  };
}

// Helper pra tipar respostas de erro do axios sem usar `any`
type ApiError = { response?: { data?: { message?: string } } };
const errMsg = (err: unknown, fallback: string) =>
  (err as ApiError)?.response?.data?.message || fallback;

export default function QuotePanel({
  patientId,
  quote,
  procedures,
  selectedTeeth,
  onClearSelection,
  onQuoteChange,
  loading,
  lastAnnotation,
  onAnnotationConsumed,
  compact,
}: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  // Quando ha multi-selecao: 1 item por dente (multiplicar) ou agregado (unificar)
  const [teethMode, setTeethMode] = useState<'multiply' | 'unify'>('multiply');

  // Onda 3.5 — Plano de tratamento eh ESTRITAMENTE CLINICO. Sem valores
  // pra ninguem (nem admin/financeiro). Valores aparecem so na aba Orcamentos.
  // Beneficio: dentista, secretaria, paciente vendo a tela juntos nao tem
  // distração com precos durante o planejamento clinico.

  // Onda 3.2 — Sugestao automatica baseada no estado anotado.
  // Quando lastAnnotation muda, busca /state-suggestions?state=X. Primeira
  // (priority asc) vira o card pulsante. Aceitar = cria QuoteItem; descartar
  // = chama onAnnotationConsumed.
  const [suggestion, setSuggestion] = useState<{
    tooth_fdi: string;
    state: string;
    candidate: Suggestion;
  } | null>(null);

  const items = quote?.items ?? [];
  const hasSelectedTeeth = selectedTeeth.length > 0;

  // Auto-abre o picker quando usuario seleciona dentes via Ctrl+click — 1 click a menos
  useEffect(() => {
    if (hasSelectedTeeth && !pickerOpen) setPickerOpen(true);
  }, [hasSelectedTeeth, pickerOpen]);

  // Onda 3.2 — Reage a lastAnnotation: busca sugestoes ativas para o estado.
  // Se houver, mostra a primeira (menor priority) como card.
  useEffect(() => {
    if (!lastAnnotation) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get<Suggestion[]>('/state-suggestions', {
          params: { state: lastAnnotation.state },
        });
        if (cancelled) return;
        if (data && data.length > 0) {
          setSuggestion({
            tooth_fdi: lastAnnotation.tooth_fdi,
            state: lastAnnotation.state,
            candidate: data[0],
          });
        } else {
          // Sem sugestao configurada — consome anotacao silenciosamente
          onAnnotationConsumed?.();
        }
      } catch {
        // Falha silenciosa: nao bloqueia fluxo, so deixa de sugerir
        onAnnotationConsumed?.();
      }
    })();
    return () => { cancelled = true; };
  }, [lastAnnotation, onAnnotationConsumed]);

  const dismissSuggestion = useCallback(() => {
    setSuggestion(null);
    onAnnotationConsumed?.();
  }, [onAnnotationConsumed]);

  const acceptSuggestion = async () => {
    if (!quote || !suggestion) return;
    setBusy(true);
    try {
      await api.post(`/quotes/${quote.id}/items`, {
        procedure_id: suggestion.candidate.procedure.id,
        quantity: 1,
        unit_price: Number(suggestion.candidate.procedure.base_price),
        tooth_fdi: suggestion.tooth_fdi,
      });
      showSuccess('Sugestao adicionada ao orcamento');
      setSuggestion(null);
      onAnnotationConsumed?.();
      await onQuoteChange();
    } catch (err) {
      showError(errMsg(err, 'Erro ao aceitar sugestao'));
    } finally {
      setBusy(false);
    }
  };

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? procedures.filter((p) =>
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

  const addProcedure = async (p: Procedure) => {
    if (!quote) return;
    setBusy(true);
    // Onda 3.6 — Modo "dente unico em cadeia": quando ha 1 dente selecionado,
    // mantemos a selecao apos adicionar pra permitir empilhar varios procedimentos
    // no mesmo dente (canal + coroa + restauracao eh comum). Multi-selecao
    // (2+ dentes) limpa apos add — comportamento intencional.
    const keepSelection = hasSelectedTeeth && selectedTeeth.length === 1;
    try {
      if (hasSelectedTeeth) {
        if (teethMode === 'multiply') {
          for (const tooth of selectedTeeth) {
            await api.post(`/quotes/${quote.id}/items`, {
              procedure_id: p.id,
              quantity: 1,
              unit_price: Number(p.base_price),
              tooth_fdi: tooth,
            });
          }
          showSuccess(
            keepSelection
              ? `Adicionado ao dente ${selectedTeeth[0]} — continue ou clique Concluir`
              : `${selectedTeeth.length} item(ns) adicionado(s)`,
          );
        } else {
          await api.post(`/quotes/${quote.id}/items`, {
            procedure_id: p.id,
            quantity: 1,
            unit_price: Number(p.base_price),
            notes: `Dentes: ${selectedTeeth.join(', ')}`,
          });
          showSuccess('Item unificado adicionado');
        }
        if (!keepSelection) onClearSelection();
      } else {
        await api.post(`/quotes/${quote.id}/items`, {
          procedure_id: p.id,
          quantity: 1,
          unit_price: Number(p.base_price),
        });
        showSuccess('Item adicionado');
      }
      await onQuoteChange();
      setSearch('');
    } catch (err) {
      showError(errMsg(err, 'Erro ao adicionar'));
    } finally {
      setBusy(false);
    }
  };

  const updateItem = async (id: string, patch: Partial<QuoteItem>) => {
    try {
      await api.patch(`/quote-items/${id}`, patch);
      await onQuoteChange();
    } catch (err) {
      showError(errMsg(err, 'Erro ao atualizar item'));
    }
  };

  const removeItem = async (id: string) => {
    if (!confirm('Remover este procedimento do orcamento?')) return;
    try {
      await api.delete(`/quote-items/${id}`);
      showSuccess('Removido');
      await onQuoteChange();
    } catch (err) {
      showError(errMsg(err, 'Erro ao remover'));
    }
  };

  if (loading || !quote) {
    return (
      <div className="bg-card border border-border rounded-xl p-8 flex items-center justify-center text-muted-foreground">
        <Loader2 size={16} className="animate-spin mr-2" />
        Carregando orcamento...
      </div>
    );
  }

  return (
    <div className={compact ? '' : 'bg-card border border-border rounded-xl overflow-hidden'}>
      {/* Header — escondido no modo compact (card pai ja tem nome/status) */}
      {!compact && (
        <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <DollarSign size={16} className="text-primary" />
            <h3 className="font-semibold text-foreground">
              Plano de tratamento
              {items.length > 0 && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {items.length} {items.length === 1 ? 'item' : 'itens'} ·{' '}
                  {quote.status === 'DRAFT' ? 'rascunho' : quote.status.toLowerCase()}
                </span>
              )}
            </h3>
          </div>
          {items.length > 0 && !pickerOpen && (
            <button
              onClick={() => setPickerOpen(true)}
              className="text-xs inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Plus size={12} /> procedimentos
            </button>
          )}
        </div>
      )}
      {/* Compact mode: botao "+ procedimentos" so no canto superior direito
          (sem header completo). Aparece quando ha items + picker fechado. */}
      {compact && items.length > 0 && !pickerOpen && (
        <div className="px-4 pt-3 flex justify-end">
          <button
            onClick={() => setPickerOpen(true)}
            className="text-xs inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus size={12} /> procedimentos
          </button>
        </div>
      )}

      {/* Banner de multi-selecao via Ctrl+click — diferencia 1 dente (modo
          "empilhar varios procedimentos no mesmo dente") de 2+ dentes (modo
          multiplicar/unificar). */}
      {hasSelectedTeeth && (
        <div className="px-4 py-2.5 bg-primary/5 border-b border-primary/20 flex items-center gap-3 flex-wrap">
          {selectedTeeth.length === 1 ? (
            // Modo "dente unico em cadeia" — empilhar canal+coroa+restauracao etc.
            <>
              <span className="text-sm font-semibold text-primary inline-flex items-center gap-1.5">
                🦷 Adicionando ao dente
                <span className="inline-flex items-center px-2 py-0.5 rounded font-mono text-xs bg-primary text-primary-foreground">
                  {selectedTeeth[0]}
                </span>
              </span>
              <span className="text-xs text-muted-foreground">
                — escolha quantos procedimentos quiser (canal, coroa, restauracao...)
              </span>
              <button
                onClick={onClearSelection}
                className="ml-auto text-xs inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90"
                title="Encerrar e desmarcar o dente"
              >
                <Check size={12} /> Concluir
              </button>
            </>
          ) : (
            // Modo multi-selecao — multiplicar/unificar entre varios dentes
            <>
              <span className="text-sm font-semibold text-primary inline-flex items-center gap-1.5">
                🦷 {selectedTeeth.length} dentes:
              </span>
              <div className="flex flex-wrap gap-1">
                {selectedTeeth.slice(0, 12).map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center px-1.5 py-0.5 rounded font-mono text-xs bg-primary text-primary-foreground"
                  >
                    {t}
                  </span>
                ))}
                {selectedTeeth.length > 12 && (
                  <span className="text-xs text-muted-foreground">+{selectedTeeth.length - 12}</span>
                )}
              </div>
              <div className="ml-auto flex items-center gap-2">
                <div className="flex items-center bg-background border border-border rounded-lg p-0.5">
                  <button
                    onClick={() => setTeethMode('multiply')}
                    className={`px-2 py-0.5 text-[11px] rounded font-medium transition-colors ${
                      teethMode === 'multiply'
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    title={`1 item por dente (cobra ${selectedTeeth.length}x)`}
                  >
                    Multiplicar
                  </button>
                  <button
                    onClick={() => setTeethMode('unify')}
                    className={`px-2 py-0.5 text-[11px] rounded font-medium transition-colors ${
                      teethMode === 'unify'
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    title="1 item unico cobrindo todos"
                  >
                    Unificar
                  </button>
                </div>
                <button
                  onClick={onClearSelection}
                  className="text-xs px-1.5 py-1 rounded text-muted-foreground hover:bg-muted"
                  title="Limpar selecao"
                >
                  <X size={12} />
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Onda 3.2 — Card de sugestao automatica baseada no estado anotado */}
      {suggestion && (
        <div className="px-4 py-3 bg-amber-500/5 border-b border-amber-500/30 flex items-center gap-3 flex-wrap animate-in fade-in slide-in-from-top-2 duration-300">
          <div className="flex items-center gap-2 text-sm flex-1 min-w-0">
            <Lightbulb size={16} className="text-amber-600 shrink-0 animate-pulse" />
            <span className="font-medium">
              Dente{' '}
              <span className="font-mono font-bold text-amber-700">
                {suggestion.tooth_fdi}
              </span>{' '}
              ({suggestion.state.toLowerCase()}) sugere:
            </span>
            <span className="font-semibold truncate">
              {suggestion.candidate.procedure.name}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={dismissSuggestion}
              disabled={busy}
              className="text-xs inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-border hover:bg-accent text-muted-foreground"
              title="Descartar sugestao"
            >
              <X size={12} /> Descartar
            </button>
            <button
              onClick={acceptSuggestion}
              disabled={busy}
              className="text-xs inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 font-semibold"
            >
              {busy ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Check size={12} />
              )}{' '}
              Aceitar
            </button>
          </div>
        </div>
      )}

      {/* Conteudo principal */}
      {items.length === 0 && !pickerOpen ? (
        <div className="p-10 text-center">
          <ShoppingCart size={28} className="mx-auto text-muted-foreground/50 mb-3" />
          <p className="text-sm font-medium text-foreground mb-1">
            Comece adicionando procedimentos
          </p>
          <p className="text-xs text-muted-foreground mb-5 max-w-md mx-auto">
            Clique em um dente para anotar · Ctrl+clique em varios para orcar em lote · Ou use o botao abaixo
          </p>
          <button
            onClick={() => setPickerOpen(true)}
            className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold shadow-sm transition"
          >
            <DollarSign size={16} /> Iniciar orçamento
          </button>
        </div>
      ) : (
        <>
          {items.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-background/50 text-xs text-muted-foreground">
                    <th className="text-left px-4 py-2 font-medium w-16">Dente</th>
                    <th className="text-left px-3 py-2 font-medium">Procedimento</th>
                    <th className="text-center px-2 py-2 font-medium w-20">Qtd</th>
                    <th className="w-12" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      onUpdate={(patch) => updateItem(item.id, patch)}
                      onRemove={() => removeItem(item.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {pickerOpen && (
            <div className="border-t border-border bg-background/30">
              <div className="p-3 border-b border-border flex items-center gap-2">
                <Search size={14} className="text-muted-foreground" />
                <input
                  autoFocus
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar procedimento por nome ou TUSS..."
                  className="flex-1 px-2 py-1.5 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <button
                  onClick={() => { setPickerOpen(false); setSearch(''); }}
                  className="p-1 hover:bg-accent rounded text-muted-foreground"
                  title="Fechar"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="max-h-72 overflow-y-auto p-3 space-y-1.5">
                {procedures.length === 0 ? (
                  <div className="p-4 text-center text-xs text-muted-foreground">
                    Nenhum procedimento cadastrado.{' '}
                    <a
                      href="/atendimento/settings/procedures"
                      className="text-primary underline"
                    >
                      Cadastrar tabela de precos
                    </a>
                  </div>
                ) : grouped.length === 0 ? (
                  <div className="p-4 text-center text-xs text-muted-foreground">
                    Nenhum procedimento corresponde a &quot;{search}&quot;
                  </div>
                ) : (
                  grouped.map((g) => {
                    const c = colorForSpecialty(g.key);
                    return (
                      <div
                        key={g.key}
                        className="rounded-lg border border-border bg-background overflow-hidden"
                      >
                        <div
                          className="px-3 py-1.5 flex items-center gap-2 border-l-4"
                          style={{ borderLeftColor: c.bar, background: c.tint }}
                        >
                          <Layers size={10} style={{ color: c.bar }} />
                          <span className="text-[11px] font-bold" style={{ color: c.bar }}>
                            {g.name}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {g.items.length}
                          </span>
                        </div>
                        <div className="divide-y divide-border">
                          {g.items.map((p) => (
                            <button
                              key={p.id}
                              onClick={() => addProcedure(p)}
                              disabled={busy}
                              className="w-full px-3 py-2 flex items-center gap-2 hover:bg-accent/50 text-left disabled:opacity-50 transition-colors"
                            >
                              <Plus size={12} className="text-muted-foreground shrink-0" />
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium truncate">{p.name}</div>
                                <div className="text-[10px] text-muted-foreground">
                                  {p.code_tuss && `TUSS ${p.code_tuss}`}
                                  {p.duration_minutes ? ` · ${p.duration_minutes} min` : ''}
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* Rodape com link "Ir para orcamentos" — escondido no modo compact
              (operador ja esta vendo o orcamento no Odontograma; o link
              equivalente vem do header do card pai se necessario). */}
          {items.length > 0 && !compact && (
            <div className="border-t border-border p-4 flex items-center justify-between flex-wrap gap-3 bg-background/30">
              <div className="text-xs text-muted-foreground italic">
                Plano clinico — valores, descontos e condicoes ficam no tab Orçamentos
              </div>
              <a
                href={`/atendimento/pacientes/${patientId}?tab=quotes&quote=${quote.id}`}
                className="text-xs inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border hover:bg-accent text-foreground"
                title="Ir para o tab Orçamentos pra ver valores, aplicar descontos e enviar ao paciente"
              >
                <Pencil size={11} /> Ir para orçamentos
              </a>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Linha da tabela (edicao inline tooth/qtd) ────────────────
// Estrategia: o draft local so existe DURANTE a edicao. Quando o usuario
// clica pra editar, copia o valor atual do item pro draft. Em re-render
// (ex: refetch do quote), nao precisa sync via useEffect — se nao estiver
// editando, mostra item.quantity direto. Elimina o anti-pattern do
// react-hooks/set-state-in-effect.
//
// Onda 3.5 — preco/total removidos da tabela. Plano clinico estritamente
// nao-comercial. Valores ficam no tab Orcamentos.
//
// FDI valido: 11-48 (permanente) ou 51-85 (deciduo). Mesma regra do backend.
const FDI_REGEX = /^([1-4][1-8]|[5-8][1-5])$/;

function ItemRow({
  item, onUpdate, onRemove,
}: {
  item: QuoteItem;
  onUpdate: (patch: Partial<QuoteItem>) => void | Promise<void>;
  onRemove: () => void;
}) {
  const [toothDraft, setToothDraft] = useState<string | null>(null);
  const [qtyDraft, setQtyDraft] = useState<number | null>(null);
  const editingTooth = toothDraft !== null;
  const editingQty = qtyDraft !== null;

  const startEditTooth = () => setToothDraft(item.tooth_fdi || '');
  const cancelEditTooth = () => setToothDraft(null);
  const commitTooth = () => {
    if (toothDraft !== null) {
      const trimmed = toothDraft.trim();
      // Vazio = remove o vinculo. Valido = atualiza. Invalido = ignora.
      if (trimmed === '' && item.tooth_fdi !== null) {
        onUpdate({ tooth_fdi: null });
      } else if (FDI_REGEX.test(trimmed) && trimmed !== item.tooth_fdi) {
        onUpdate({ tooth_fdi: trimmed });
      }
    }
    setToothDraft(null);
  };

  const startEditQty = () => setQtyDraft(item.quantity);
  const cancelEditQty = () => setQtyDraft(null);
  const commitQty = () => {
    if (qtyDraft !== null && qtyDraft >= 1 && qtyDraft !== item.quantity) {
      onUpdate({ quantity: qtyDraft });
    }
    setQtyDraft(null);
  };

  // Item sem dente vinculado fica destacado pra dentista lembrar de preencher
  const toothEmpty = !item.tooth_fdi;

  // Onda 3.5 — Cor da especialidade do procedimento, pra pintar o badge
  // do dente e o nome do procedimento. Mantem consistencia visual entre
  // o Plano de Tratamento e as bolinhas no odontograma.
  const specialtyKey =
    item.procedure?.specialty?.id || item.procedure?.specialty_id || '__none__';
  const specColor = colorForSpecialty(specialtyKey);

  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-background/50">
      <td className="px-4 py-2.5">
        {editingTooth ? (
          <input
            autoFocus
            type="text"
            inputMode="numeric"
            maxLength={2}
            value={toothDraft ?? ''}
            onChange={(e) => setToothDraft(e.target.value.replace(/\D/g, '').slice(0, 2))}
            onBlur={commitTooth}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTooth();
              if (e.key === 'Escape') cancelEditTooth();
            }}
            placeholder="—"
            className="w-12 px-1 py-1 text-center rounded border border-primary bg-background text-xs font-mono font-semibold focus:outline-none"
          />
        ) : item.tooth_fdi ? (
          <button
            onClick={startEditTooth}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md font-mono font-bold text-xs border-2 transition hover:scale-105"
            style={{
              backgroundColor: specColor.tint,
              borderColor: specColor.bar,
              color: specColor.bar,
            }}
            title={`Clique para editar dente · ${item.procedure?.specialty?.name || 'sem especialidade'}`}
          >
            {item.tooth_fdi}
          </button>
        ) : (
          <button
            onClick={startEditTooth}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md border-2 border-dashed border-amber-500 text-amber-700 font-mono font-bold text-xs hover:bg-amber-500/10 transition animate-pulse"
            title="Clique para vincular um dente FDI (ex: 12, 36)"
          >
            ?
          </button>
        )}
      </td>
      <td className="px-3 py-2.5">
        <div className="text-sm font-medium" style={{ color: specColor.bar }}>
          {item.procedure?.name || '—'}
        </div>
        {item.notes && (
          <div className="text-[10px] text-muted-foreground truncate max-w-md">
            {item.notes}
          </div>
        )}
        {toothEmpty && (
          <div className="text-[10px] text-amber-700 mt-0.5">
            Vincule um dente para que apareca no odontograma
          </div>
        )}
      </td>
      <td className="px-2 py-2.5 text-center">
        {editingQty ? (
          <input
            autoFocus
            type="number"
            min={1}
            value={qtyDraft ?? item.quantity}
            onChange={(e) => setQtyDraft(Math.max(1, parseInt(e.target.value, 10) || 1))}
            onBlur={commitQty}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitQty();
              if (e.key === 'Escape') cancelEditQty();
            }}
            className="w-14 px-2 py-1 text-center rounded border border-primary bg-background text-sm focus:outline-none"
          />
        ) : (
          <button
            onClick={startEditQty}
            className="text-sm hover:bg-accent rounded px-2 py-0.5"
            title="Clique para editar"
          >
            {item.quantity}
          </button>
        )}
      </td>
      <td className="px-2 py-2.5">
        <button
          onClick={onRemove}
          className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          title="Remover"
        >
          <Trash2 size={12} />
        </button>
      </td>
    </tr>
  );
}
