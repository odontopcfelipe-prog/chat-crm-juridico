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
} from 'lucide-react';
import api from '@/lib/api';
import { showError } from '@/lib/toast';

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
            />
          );
        })}
      </div>

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
}: {
  priority: Priority;
  cfg: typeof PRIORITY_CONFIG[Priority];
  quote: QuoteListItem | undefined;
  olderCount: number;
  completoTotal: number | null;
  onOpen: () => void;
}) {
  // Quote nao existe → empty state pro slot daquela prioridade
  if (!quote) {
    return (
      <div className={`p-4 rounded-xl border-2 border-dashed ${cfg.borderCls} bg-card opacity-50`}>
        <div className="flex items-center gap-2 mb-2">
          <span className={cfg.iconCls}>{cfg.icon}</span>
          <h3 className={`text-sm font-bold ${cfg.iconCls}`}>{cfg.label}</h3>
        </div>
        <p className="text-[11px] text-muted-foreground mb-3">
          {cfg.description}
        </p>
        <p className="text-xs text-muted-foreground italic">
          Sem proposta {cfg.label.toLowerCase()} criada ainda.
        </p>
      </div>
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
