'use client';

/**
 * PropostasTab — Onda 8.
 *
 * Comparacao lado-a-lado dos orcamentos do paciente agrupados por priority
 * (COMPLETO / ESSENCIAL / URGENTE). Inspirado no "Modo negociação" de
 * referencia. Operador apresenta as 3 alternativas pro paciente comparar:
 *  - Completo: plano ideal, todos os procedimentos sugeridos
 *  - Essencial: plano mais enxuto, so o que nao pode esperar
 *  - Urgente: foco no problema imediato
 *
 * Click no card abre o orcamento na aba Orcamentos em modo detalhe (reusa
 * fluxo existente — sem botoes de aprovacao aqui, ficam onde sempre foram).
 *
 * Sem schema novo, sem endpoint novo — usa GET /patients/:id/quotes que ja
 * existe. Filtra DRAFT/SENT (aceitos/rejeitados ja foram decididos).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Loader2, DollarSign, ChevronRight, Layers, AlertTriangle, Check, Flame,
  Plus, X,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Props {
  patientId: string;
  /**
   * Abre o orcamento no detalhe da aba Orcamentos. Parent (PacienteFichaInner)
   * cuida da navegacao (router + setTab).
   */
  onOpenQuoteDetail?: (quoteId: string) => void;
}

interface QuoteListItem {
  id: string;
  status: 'DRAFT' | 'SENT' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
  title: string | null;
  total_value: string | number;
  created_at: string;
  priority?: 'COMPLETO' | 'ESSENCIAL' | 'URGENTE' | null;
  _count?: { items: number };
}

type Priority = 'COMPLETO' | 'ESSENCIAL' | 'URGENTE';

const PRIORITY_ORDER: Priority[] = ['COMPLETO', 'ESSENCIAL', 'URGENTE'];

const PRIORITY_CONFIG: Record<Priority, {
  label: string;
  description: string;
  icon: React.ReactNode;
  borderCls: string;
  bgCls: string;
  iconCls: string;
}> = {
  COMPLETO: {
    label: 'Completo',
    description: 'plano ideal — todos os procedimentos sugeridos',
    icon: <Check size={14} />,
    borderCls: 'border-emerald-500/30 hover:border-emerald-500/60',
    bgCls: 'bg-emerald-500/5',
    iconCls: 'text-emerald-700',
  },
  ESSENCIAL: {
    label: 'Essencial',
    description: 'plano enxuto — só o que não pode esperar',
    icon: <AlertTriangle size={14} />,
    borderCls: 'border-amber-500/30 hover:border-amber-500/60',
    bgCls: 'bg-amber-500/5',
    iconCls: 'text-amber-700',
  },
  URGENTE: {
    label: 'Urgente',
    description: 'foco no problema imediato',
    icon: <Flame size={14} />,
    borderCls: 'border-red-500/30 hover:border-red-500/60',
    bgCls: 'bg-red-500/5',
    iconCls: 'text-red-700',
  },
};

export default function PropostasTab({ patientId, onOpenQuoteDetail }: Props) {
  const [quotes, setQuotes] = useState<QuoteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  // Onda 8.1 — picker pra atribuir orcamento a slot vazio (Completo/Essencial/Urgente).
  // Quando != null, abre modal listando quotes elegiveis.
  const [pickerFor, setPickerFor] = useState<Priority | null>(null);
  const [assigning, setAssigning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<QuoteListItem[]>(`/patients/${patientId}/quotes`);
      setQuotes(data);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao carregar propostas');
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => { load(); }, [load]);

  // Onda 8.1 — atribui priority a um quote existente (slot vazio recebe quote).
  // Reusa PATCH /quotes/:id (ja aceita { priority }) — sem endpoint novo.
  const assignPriority = useCallback(async (quoteId: string, priority: Priority) => {
    setAssigning(true);
    try {
      await api.patch(`/quotes/${quoteId}`, { priority });
      showSuccess(`Orcamento marcado como ${PRIORITY_CONFIG[priority].label}`);
      setPickerFor(null);
      await load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao atribuir prioridade');
    } finally {
      setAssigning(false);
    }
  }, [load]);

  // Filtra so DRAFT/SENT (aceitos/rejeitados ja foram decididos, nao
  // sao "propostas em negociacao"). Agrupa por priority.
  const grouped = useMemo(() => {
    const eligible = quotes.filter((q) => q.status === 'DRAFT' || q.status === 'SENT');
    const m = new Map<Priority | 'NONE', QuoteListItem[]>();
    for (const q of eligible) {
      const key = (q.priority || 'NONE') as Priority | 'NONE';
      const arr = m.get(key) || [];
      arr.push(q);
      m.set(key, arr);
    }
    // Ordena cada grupo por created_at desc (mais recente primeiro)
    m.forEach((arr) => arr.sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    ));
    return m;
  }, [quotes]);

  // Total da proposta COMPLETO (mais alta) — referencia pra calcular
  // diferenca nas outras.
  const completoTotal = useMemo(() => {
    const cs = grouped.get('COMPLETO');
    if (!cs || cs.length === 0) return null;
    return Number(cs[0].total_value);
  }, [grouped]);

  if (loading) {
    return (
      <div className="py-12 flex items-center justify-center text-muted-foreground">
        <Loader2 size={18} className="animate-spin mr-2" /> Carregando propostas...
      </div>
    );
  }

  const eligibleCount = Array.from(grouped.values()).reduce((acc, arr) => acc + arr.length, 0);

  if (eligibleCount === 0) {
    return (
      <div className="bg-card border border-border border-dashed rounded-xl p-10 text-center">
        <Layers size={32} className="mx-auto text-muted-foreground/60 mb-3" />
        <p className="text-sm font-medium text-foreground mb-1">
          Nenhuma proposta pra comparar
        </p>
        <p className="text-xs text-muted-foreground max-w-md mx-auto">
          Crie orçamentos com prioridades diferentes (Completo, Essencial,
          Urgente) na aba <strong>Avaliação</strong>, e eles aparecerão aqui
          lado a lado pro paciente escolher.
        </p>
      </div>
    );
  }

  const noneItems = grouped.get('NONE') || [];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Layers size={16} className="text-primary" />
            Versões do plano
          </h2>
          <p className="text-xs text-muted-foreground">
            crie alternativas pro paciente comparar lado a lado · click no
            card abre detalhes pra negociar
          </p>
        </div>
      </div>

      {/* Cards lado a lado por prioridade */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {PRIORITY_ORDER.map((priority) => {
          const cfg = PRIORITY_CONFIG[priority];
          const items = grouped.get(priority) || [];
          const main = items[0]; // mais recente
          const olderCount = items.length - 1;
          return (
            <PropostaCard
              key={priority}
              priority={priority}
              cfg={cfg}
              quote={main}
              olderCount={olderCount}
              completoTotal={completoTotal}
              onOpen={() => main && onOpenQuoteDetail && onOpenQuoteDetail(main.id)}
              onPickEmpty={() => setPickerFor(priority)}
            />
          );
        })}
      </div>

      {/* Onda 8.1 — Picker modal: lista quotes elegiveis pra atribuir ao slot */}
      {pickerFor && (
        <QuotePicker
          targetPriority={pickerFor}
          quotes={quotes.filter((q) => q.status === 'DRAFT' || q.status === 'SENT')}
          loading={assigning}
          onCancel={() => setPickerFor(null)}
          onSelect={(quoteId) => assignPriority(quoteId, pickerFor)}
        />
      )}

      {/* Orcamentos sem priority — lista flat embaixo */}
      {noneItems.length > 0 && (
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
              Sem prioridade definida ({noneItems.length})
            </p>
          </div>
          <p className="text-[11px] text-muted-foreground italic mb-3">
            Defina prioridade (Completo / Essencial / Urgente) na aba Avaliação
            pra esses orçamentos aparecerem agrupados acima.
          </p>
          <ul className="space-y-1.5">
            {noneItems.map((q) => (
              <li
                key={q.id}
                onClick={() => onOpenQuoteDetail && onOpenQuoteDetail(q.id)}
                className="px-3 py-2 rounded-lg border border-border hover:bg-accent/40 cursor-pointer flex items-center gap-3"
              >
                <DollarSign size={14} className="text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {q.title || 'Orçamento sem nome'}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {q._count?.items ?? 0} item(ns) ·{' '}
                    {new Date(q.created_at).toLocaleDateString('pt-BR')}
                  </p>
                </div>
                <p className="text-sm font-bold text-foreground">
                  R$ {Number(q.total_value).toLocaleString('pt-BR', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </p>
                <ChevronRight size={14} className="text-muted-foreground" />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Card individual da proposta ────────────────────────────────

function PropostaCard({
  priority,
  cfg,
  quote,
  olderCount,
  completoTotal,
  onOpen,
  onPickEmpty,
}: {
  priority: Priority;
  cfg: typeof PRIORITY_CONFIG[Priority];
  quote: QuoteListItem | undefined;
  olderCount: number;
  completoTotal: number | null;
  onOpen: () => void;
  /** Onda 8.1 — click no card vazio abre picker pra atribuir orcamento ao slot */
  onPickEmpty: () => void;
}) {
  // Quote nao existe → empty state clicavel: click abre picker pra escolher
  // qual orcamento (sem priority ou em outro slot) vai pra esse slot.
  if (!quote) {
    return (
      <button
        type="button"
        onClick={onPickEmpty}
        className={`p-4 rounded-xl border-2 border-dashed ${cfg.borderCls} bg-card text-left w-full transition-all hover:opacity-100 hover:shadow-sm hover:bg-accent/30 opacity-70 group`}
      >
        <div className="flex items-center gap-2 mb-2">
          <span className={cfg.iconCls}>{cfg.icon}</span>
          <h3 className={`text-sm font-bold ${cfg.iconCls}`}>{cfg.label}</h3>
        </div>
        <p className="text-[11px] text-muted-foreground mb-3">
          {cfg.description}
        </p>
        <p className="text-xs text-muted-foreground italic mb-3">
          Sem proposta {cfg.label.toLowerCase()} criada ainda.
        </p>
        <div className={`flex items-center gap-1.5 text-[11px] font-semibold ${cfg.iconCls} group-hover:underline`}>
          <Plus size={12} />
          <span>Escolher orçamento</span>
        </div>
      </button>
    );
  }

  const total = Number(quote.total_value);
  const isSent = quote.status === 'SENT';
  // Diferenca vs Completo (so faz sentido pra Essencial/Urgente)
  const diffVsCompleto =
    completoTotal !== null && priority !== 'COMPLETO'
      ? total - completoTotal
      : null;

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`p-4 rounded-xl border-2 ${cfg.borderCls} ${cfg.bgCls} text-left transition-all hover:shadow-md group relative`}
    >
      {/* Badge "atual" — quote enviada esta em negociacao */}
      {isSent && (
        <span className="absolute -top-2 -right-2 text-[10px] font-bold px-2 py-0.5 rounded-full bg-orange-500 text-white shadow-sm">
          atual
        </span>
      )}

      {/* Header com priority */}
      <div className="flex items-center gap-2 mb-2">
        <span className={cfg.iconCls}>{cfg.icon}</span>
        <h3 className={`text-sm font-bold ${cfg.iconCls}`}>{cfg.label}</h3>
      </div>
      <p className="text-[11px] text-muted-foreground mb-3 leading-tight">
        {cfg.description}
      </p>

      {/* Titulo do orcamento + contagem */}
      <div className="mb-2">
        {quote.title && (
          <p className="text-xs font-semibold text-foreground truncate mb-1" title={quote.title}>
            {quote.title}
          </p>
        )}
        <p className="text-[11px] text-muted-foreground">
          {quote._count?.items ?? 0} {quote._count?.items === 1 ? 'item' : 'itens'}
          {' · '}
          Criado em {new Date(quote.created_at).toLocaleDateString('pt-BR')}
        </p>
      </div>

      {/* Total */}
      <p className="text-xl font-bold text-foreground">
        R$ {total.toLocaleString('pt-BR', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}
      </p>

      {/* Diferenca vs Completo */}
      {diffVsCompleto !== null && diffVsCompleto < 0 && (
        <p className="text-[11px] text-emerald-700 mt-1">
          −R$ {Math.abs(diffVsCompleto).toLocaleString('pt-BR', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })} vs completo
        </p>
      )}

      {/* Older count — "+N anteriores" */}
      {olderCount > 0 && (
        <p className="text-[10px] text-muted-foreground mt-2 italic">
          + {olderCount} versão {olderCount === 1 ? 'anterior' : 'anteriores'} desta categoria
        </p>
      )}

      {/* Footer click */}
      <div className="mt-3 pt-3 border-t border-border/40 flex items-center justify-between text-[11px] text-muted-foreground group-hover:text-foreground">
        <span>ver detalhes</span>
        <ChevronRight size={12} />
      </div>
    </button>
  );
}

// ─── Picker modal: atribui orcamento existente a slot vazio ──────
// Onda 8.1 — abre quando user clica num card vazio (Completo/Essencial/Urgente).
// Lista todos os quotes elegiveis (DRAFT/SENT) e destaca os "sem prioridade"
// no topo. Click em um → patch /quotes/:id { priority } no parent.

function QuotePicker({
  targetPriority,
  quotes,
  loading,
  onCancel,
  onSelect,
}: {
  targetPriority: Priority;
  quotes: QuoteListItem[];
  loading: boolean;
  onCancel: () => void;
  onSelect: (quoteId: string) => void;
}) {
  const cfg = PRIORITY_CONFIG[targetPriority];

  // Separa: 1) sem prioridade (alvo natural) 2) em outro slot (permite trocar)
  // 3) ja neste slot (filtra fora — nao faz sentido reatribuir pra mesmo lugar)
  const withoutPriority = quotes.filter((q) => !q.priority);
  const inOtherSlot = quotes.filter(
    (q) => q.priority && q.priority !== targetPriority,
  );

  const empty = withoutPriority.length === 0 && inOtherSlot.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-xl max-w-md w-full max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-4 border-b border-border">
          <div>
            <h3 className="text-sm font-bold flex items-center gap-2">
              <span className={cfg.iconCls}>{cfg.icon}</span>
              Escolher orçamento — {cfg.label}
            </h3>
            <p className="text-[11px] text-muted-foreground mt-1">
              Selecione qual orçamento vai ser exibido no slot{' '}
              <span className={`font-semibold ${cfg.iconCls}`}>{cfg.label}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-muted-foreground hover:text-foreground p-1 -mr-1 -mt-1"
            aria-label="Fechar"
          >
            <X size={16} />
          </button>
        </div>

        {/* Lista */}
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {empty && (
            <div className="py-8 text-center">
              <Layers size={28} className="mx-auto text-muted-foreground/60 mb-2" />
              <p className="text-xs text-muted-foreground">
                Nenhum orçamento disponível pra atribuir.
              </p>
              <p className="text-[11px] text-muted-foreground italic mt-1">
                Crie um orçamento na aba <strong>Avaliação</strong> primeiro.
              </p>
            </div>
          )}

          {withoutPriority.length > 0 && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1.5 px-1">
                Sem prioridade ({withoutPriority.length})
              </p>
              <ul className="space-y-1.5">
                {withoutPriority.map((q) => (
                  <QuotePickerRow
                    key={q.id}
                    quote={q}
                    loading={loading}
                    onSelect={() => onSelect(q.id)}
                  />
                ))}
              </ul>
            </div>
          )}

          {inOtherSlot.length > 0 && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1.5 px-1">
                Em outro slot — trocar pra {cfg.label}
              </p>
              <ul className="space-y-1.5">
                {inOtherSlot.map((q) => (
                  <QuotePickerRow
                    key={q.id}
                    quote={q}
                    loading={loading}
                    currentPriority={q.priority as Priority}
                    onSelect={() => onSelect(q.id)}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-border flex items-center justify-end gap-2 bg-muted/20">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-accent disabled:opacity-50"
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

function QuotePickerRow({
  quote,
  loading,
  currentPriority,
  onSelect,
}: {
  quote: QuoteListItem;
  loading: boolean;
  currentPriority?: Priority;
  onSelect: () => void;
}) {
  const total = Number(quote.total_value);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        disabled={loading}
        className="w-full text-left px-3 py-2 rounded-lg border border-border hover:bg-accent/40 hover:border-primary/40 disabled:opacity-50 disabled:cursor-wait flex items-center gap-3 transition-colors"
      >
        <DollarSign size={14} className="text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">
            {quote.title || 'Orçamento sem nome'}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {quote._count?.items ?? 0} item(ns) ·{' '}
            {new Date(quote.created_at).toLocaleDateString('pt-BR')}
            {currentPriority && (
              <>
                {' · '}
                <span className={PRIORITY_CONFIG[currentPriority].iconCls}>
                  atualmente em {PRIORITY_CONFIG[currentPriority].label}
                </span>
              </>
            )}
          </p>
        </div>
        <p className="text-sm font-bold text-foreground shrink-0">
          R$ {total.toLocaleString('pt-BR', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
        </p>
        {loading ? (
          <Loader2 size={14} className="animate-spin text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight size={14} className="text-muted-foreground shrink-0" />
        )}
      </button>
    </li>
  );
}
