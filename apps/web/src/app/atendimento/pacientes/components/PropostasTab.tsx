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
  Plus, X, Clock, MessageSquare, Pencil, Send, ChevronDown,
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
  valid_until?: string | null;
  priority?: 'COMPLETO' | 'ESSENCIAL' | 'URGENTE' | null;
  _count?: { items: number };
  /** Onda 9 — soma duration_minutes × qty de cada item (vem do backend) */
  total_duration_minutes?: number;
}

interface QuoteItemDetail {
  id: string;
  total_price: string | number;
  notes: string | null;
  procedure: { name: string };
}

interface QuoteDetailLite {
  id: string;
  title: string | null;
  status: QuoteListItem['status'];
  total_value: string | number;
  valid_until: string | null;
  notes: string | null;
  items: QuoteItemDetail[];
}

/** Onda 10 — parseia linhas [CONTRAPROPOSTA YYYY-MM-DD HH:mm] do campo notes */
interface CounterProposalEntry {
  timestamp: string;
  body: string; // texto apos o timestamp (ex: "Essencial em PIX à vista = R$ 15.675,00 — paciente vai pensar")
}

function parseCounterProposals(notes: string | null): CounterProposalEntry[] {
  if (!notes) return [];
  const re = /^\[CONTRAPROPOSTA (\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s*(.+)$/;
  return notes
    .split('\n')
    .map((line) => {
      const m = line.match(re);
      return m ? { timestamp: m[1], body: m[2].trim() } : null;
    })
    .filter((e): e is CounterProposalEntry => e !== null)
    .reverse(); // mais recente primeiro
}

type Priority = 'COMPLETO' | 'ESSENCIAL' | 'URGENTE';

// Onda 9 — ordem na referencia: "do mais apertado pro mais completo"
const PRIORITY_ORDER: Priority[] = ['URGENTE', 'ESSENCIAL', 'COMPLETO'];

/** Onda 9 — formata minutos como "−Xh cadeira" ou "Xmin cadeira" */
function formatCadeira(totalMinutes: number | undefined): string | null {
  if (!totalMinutes || totalMinutes <= 0) return null;
  if (totalMinutes < 60) return `${totalMinutes}min cadeira`;
  const h = Math.round((totalMinutes / 60) * 10) / 10; // 1 casa
  // arredonda pra inteiro se for .0
  const display = h % 1 === 0 ? `${Math.floor(h)}h` : `${h.toString().replace('.', ',')}h`;
  return `${display} cadeira`;
}

/** Onda 9 — opcoes de pagamento renderizadas no painel inline */
interface PaymentOption {
  key: string;
  label: string;
  sublabel: string;
  discountPercent: number; // 0 = sem desconto
  installments: number;
  variant: 'avista' | 'parcelado';
}

function buildPaymentOptions(total: number): { avista: PaymentOption[]; parcelado: PaymentOption[] } {
  return {
    avista: [
      {
        key: 'pix',
        label: 'PIX ou dinheiro',
        sublabel: 'à vista',
        discountPercent: 5,
        installments: 1,
        variant: 'avista',
      },
      {
        key: 'boleto-avista',
        label: 'Boleto à vista',
        sublabel: 'vence em 3 dias úteis',
        discountPercent: 3,
        installments: 1,
        variant: 'avista',
      },
    ],
    parcelado: [
      { key: '3x', label: '3x', sublabel: '', discountPercent: 0, installments: 3, variant: 'parcelado' },
      { key: '6x', label: '6x', sublabel: '', discountPercent: 0, installments: 6, variant: 'parcelado' },
      { key: '10x', label: '10x', sublabel: '', discountPercent: 0, installments: 10, variant: 'parcelado' },
    ],
  };
}

/** Calcula valor final dado opcao + total base */
function applyPaymentOption(total: number, opt: PaymentOption): {
  finalValue: number;
  installmentValue: number;
  savedValue: number;
} {
  const savedValue = total * (opt.discountPercent / 100);
  const finalValue = total - savedValue;
  const installmentValue = finalValue / opt.installments;
  return { finalValue, installmentValue, savedValue };
}

function fmtBRL(n: number): string {
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const PRIORITY_CONFIG: Record<Priority, {
  label: string;
  description: string;
  icon: React.ReactNode;
  borderCls: string;
  bgCls: string;
  iconCls: string;
  selectedBorderCls: string;
  selectedBgCls: string;
}> = {
  URGENTE: {
    label: 'Urgente',
    description: 'só o que dói ou bloqueia o resto',
    icon: <Flame size={14} />,
    borderCls: 'border-red-500/30 hover:border-red-500/60',
    bgCls: 'bg-red-500/5',
    iconCls: 'text-red-700',
    selectedBorderCls: 'border-red-500 ring-2 ring-red-500/20',
    selectedBgCls: 'bg-red-500/10',
  },
  ESSENCIAL: {
    label: 'Essencial',
    description: 'só o que não pode esperar — sem estética opcional',
    icon: <AlertTriangle size={14} />,
    borderCls: 'border-amber-500/30 hover:border-amber-500/60',
    bgCls: 'bg-amber-500/5',
    iconCls: 'text-amber-700',
    selectedBorderCls: 'border-amber-500 ring-2 ring-amber-500/20',
    selectedBgCls: 'bg-amber-500/10',
  },
  COMPLETO: {
    label: 'Completo',
    description: 'plano ideal — todos os procedimentos sugeridos',
    icon: <Check size={14} />,
    borderCls: 'border-emerald-500/30 hover:border-emerald-500/60',
    bgCls: 'bg-emerald-500/5',
    iconCls: 'text-emerald-700',
    selectedBorderCls: 'border-emerald-500 ring-2 ring-emerald-500/20',
    selectedBgCls: 'bg-emerald-500/10',
  },
};

export default function PropostasTab({ patientId, onOpenQuoteDetail }: Props) {
  const [quotes, setQuotes] = useState<QuoteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  // Onda 8.1 — picker pra atribuir orcamento a slot vazio (Completo/Essencial/Urgente).
  const [pickerFor, setPickerFor] = useState<Priority | null>(null);
  const [assigning, setAssigning] = useState(false);
  // Onda 9 — seleção atual (qual versão tô oferecendo agora). Persiste por
  // paciente via sessionStorage pra sobreviver navegacao entre abas.
  const selectionKey = `propostas-selected-${patientId}`;
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try { return window.sessionStorage.getItem(selectionKey); } catch { return null; }
  });
  // Detalhe do quote selecionado (items + preços), carregado sob demanda.
  const [selectedDetail, setSelectedDetail] = useState<QuoteDetailLite | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  // Forma de pagamento ativa no painel (local, sem persistencia backend)
  const [activePaymentKey, setActivePaymentKey] = useState<string>('pix');
  // Expandir lista completa de items (padrao mostra top-4)
  const [itemsExpanded, setItemsExpanded] = useState(false);
  // Dialog "+ nova versao"
  const [newVersionOpen, setNewVersionOpen] = useState(false);
  const [creatingVersion, setCreatingVersion] = useState(false);

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

  // Persiste a seleção
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (selectedId) window.sessionStorage.setItem(selectionKey, selectedId);
      else window.sessionStorage.removeItem(selectionKey);
    } catch { /* ignora */ }
  }, [selectedId, selectionKey]);

  // Carrega detalhe quando muda a seleção (ou quote da lista atualiza)
  useEffect(() => {
    if (!selectedId) { setSelectedDetail(null); return; }
    let cancelled = false;
    setLoadingDetail(true);
    setItemsExpanded(false);
    api.get<QuoteDetailLite>(`/quotes/${selectedId}`)
      .then(({ data }) => { if (!cancelled) setSelectedDetail(data); })
      .catch((err) => {
        if (cancelled) return;
        const e = err as { response?: { data?: { message?: string } } };
        showError(e?.response?.data?.message || 'Erro ao carregar detalhe');
        // Quote pode ter sido deletado — limpa seleção
        setSelectedId(null);
      })
      .finally(() => { if (!cancelled) setLoadingDetail(false); });
    return () => { cancelled = true; };
  }, [selectedId]);

  // Onda 8.1 — atribui priority a um quote existente.
  const assignPriority = useCallback(async (quoteId: string, priority: Priority) => {
    setAssigning(true);
    try {
      await api.patch(`/quotes/${quoteId}`, { priority });
      showSuccess(`Orçamento marcado como ${PRIORITY_CONFIG[priority].label}`);
      setPickerFor(null);
      await load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao atribuir prioridade');
    } finally {
      setAssigning(false);
    }
  }, [load]);

  // Onda 9 — "+ nova versão": cria DRAFT vazio com priority escolhida,
  // navega pro detalhe na aba Orcamentos pra preencher items.
  const createNewVersion = useCallback(async (priority: Priority) => {
    setCreatingVersion(true);
    try {
      const { data } = await api.post<{ id: string }>(`/patients/${patientId}/quotes`, {});
      await api.patch(`/quotes/${data.id}`, { priority });
      showSuccess(`Nova versão ${PRIORITY_CONFIG[priority].label} criada — preencha os itens`);
      setNewVersionOpen(false);
      onOpenQuoteDetail?.(data.id);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao criar versão');
    } finally {
      setCreatingVersion(false);
    }
  }, [patientId, onOpenQuoteDetail]);

  // Onda 9 — envia oferta atual pro paciente via WhatsApp
  const [sending, setSending] = useState(false);
  const sendToPatient = useCallback(async () => {
    if (!selectedDetail) return;
    setSending(true);
    try {
      await api.post(`/quotes/${selectedDetail.id}/send-whatsapp`);
      showSuccess('Proposta enviada pro paciente');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao enviar');
    } finally {
      setSending(false);
    }
  }, [selectedDetail]);

  // Onda 10 — Salvar contraproposta (registra oferta como linha em notes)
  const [counterPropOpen, setCounterPropOpen] = useState(false);
  const [savingCounter, setSavingCounter] = useState(false);
  const saveCounterProposal = useCallback(
    async (payload: { payment_label: string; final_value: number; note?: string }) => {
      if (!selectedDetail) return;
      setSavingCounter(true);
      try {
        const { data } = await api.post<{ id: string; notes: string }>(
          `/quotes/${selectedDetail.id}/counter-proposal`,
          payload,
        );
        // Atualiza apenas o campo notes do detail local (evita refetch)
        setSelectedDetail((prev) => (prev ? { ...prev, notes: data.notes } : prev));
        setCounterPropOpen(false);
        showSuccess('Contraproposta salva no histórico');
      } catch (err: unknown) {
        const e = err as { response?: { data?: { message?: string } } };
        showError(e?.response?.data?.message || 'Erro ao salvar contraproposta');
      } finally {
        setSavingCounter(false);
      }
    },
    [selectedDetail],
  );

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
            do mais apertado pro mais completo · clique num card pra abrir a
            proposta com formas de pagamento
          </p>
        </div>
        <button
          type="button"
          onClick={() => setNewVersionOpen(true)}
          className="text-xs font-semibold text-primary hover:underline flex items-center gap-1"
        >
          <Plus size={14} />
          nova versão
        </button>
      </div>

      {/* Cards lado a lado por prioridade — ordem URGENTE → ESSENCIAL → COMPLETO */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {PRIORITY_ORDER.map((priority) => {
          const cfg = PRIORITY_CONFIG[priority];
          const items = grouped.get(priority) || [];
          const main = items[0]; // mais recente
          const olderCount = items.length - 1;
          const isSelected = !!main && selectedId === main.id;
          return (
            <PropostaCard
              key={priority}
              priority={priority}
              cfg={cfg}
              quote={main}
              olderCount={olderCount}
              completoTotal={completoTotal}
              selected={isSelected}
              onToggleSelect={() => {
                if (!main) return;
                setSelectedId(isSelected ? null : main.id);
              }}
              onPickEmpty={() => setPickerFor(priority)}
            />
          );
        })}
      </div>

      {/* Onda 9 — Painel inline da proposta selecionada (negociacao ao vivo) */}
      {selectedId && (
        <PropostaPainel
          loading={loadingDetail}
          detail={selectedDetail}
          priority={
            (quotes.find((q) => q.id === selectedId)?.priority as Priority | undefined) || null
          }
          activePaymentKey={activePaymentKey}
          onChangePayment={setActivePaymentKey}
          itemsExpanded={itemsExpanded}
          onToggleItems={() => setItemsExpanded((v) => !v)}
          onClose={() => setSelectedId(null)}
          onAjustar={() => selectedDetail && onOpenQuoteDetail?.(selectedDetail.id)}
          onSend={sendToPatient}
          sending={sending}
          onSaveCounter={() => setCounterPropOpen(true)}
        />
      )}

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

      {/* Onda 9 — Dialog "+ nova versão" */}
      {newVersionOpen && (
        <NewVersionDialog
          existingPriorities={
            new Set(
              Array.from(grouped.keys()).filter((k): k is Priority => k !== 'NONE'),
            )
          }
          loading={creatingVersion}
          onCancel={() => setNewVersionOpen(false)}
          onCreate={createNewVersion}
        />
      )}

      {/* Onda 10 — Dialog "Salvar contraproposta" */}
      {counterPropOpen && selectedDetail && (() => {
        const total = Number(selectedDetail.total_value);
        const opts = buildPaymentOptions(total);
        const allOptions = [...opts.avista, ...opts.parcelado];
        const activeOption = allOptions.find((o) => o.key === activePaymentKey) || opts.avista[0];
        const calc = applyPaymentOption(total, activeOption);
        const priority = (quotes.find((q) => q.id === selectedId)?.priority as Priority | undefined) || null;
        const priorityLabel = priority ? PRIORITY_CONFIG[priority].label : 'Proposta';
        const paymentLabel =
          activeOption.variant === 'avista'
            ? `${activeOption.label} à vista`
            : `${activeOption.installments}x no cartão`;
        const finalValue =
          activeOption.variant === 'avista' ? calc.finalValue : total;
        return (
          <CounterProposalDialog
            priorityLabel={priorityLabel}
            paymentLabel={paymentLabel}
            finalValue={finalValue}
            loading={savingCounter}
            onCancel={() => setCounterPropOpen(false)}
            onSave={(note) =>
              saveCounterProposal({
                payment_label: paymentLabel,
                final_value: finalValue,
                note,
              })
            }
          />
        );
      })()}

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
  selected,
  onToggleSelect,
  onPickEmpty,
}: {
  priority: Priority;
  cfg: typeof PRIORITY_CONFIG[Priority];
  quote: QuoteListItem | undefined;
  olderCount: number;
  completoTotal: number | null;
  /** Onda 9 — card destacado quando e a versao "selecionada" pra negociar */
  selected: boolean;
  /** Onda 9 — click no card preenchido alterna seleção (abre/fecha painel inline) */
  onToggleSelect: () => void;
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
  const cadeira = formatCadeira(quote.total_duration_minutes);
  // Diferenca vs Completo (so faz sentido pra Essencial/Urgente)
  const diffVsCompleto =
    completoTotal !== null && priority !== 'COMPLETO'
      ? total - completoTotal
      : null;

  return (
    <button
      type="button"
      onClick={onToggleSelect}
      data-selected={selected ? '1' : '0'}
      className={`p-4 rounded-xl border-2 text-left transition-all hover:shadow-md group relative ${
        selected
          ? `${cfg.selectedBorderCls} ${cfg.selectedBgCls}`
          : `${cfg.borderCls} ${cfg.bgCls}`
      }`}
    >
      {/* Badge "atual" — quote enviada esta em negociacao */}
      {isSent && !selected && (
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

      {/* Titulo custom + contagem + horas cadeira */}
      <div className="mb-2">
        {quote.title && (
          <p className="text-xs font-semibold text-foreground truncate mb-1" title={quote.title}>
            {quote.title}
          </p>
        )}
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground flex-wrap">
          <span className="flex items-center gap-1">
            <Layers size={10} />
            {quote._count?.items ?? 0} {quote._count?.items === 1 ? 'item' : 'itens'}
          </span>
          {cadeira && (
            <span className="flex items-center gap-1">
              <Clock size={10} />
              {cadeira}
            </span>
          )}
        </div>
      </div>

      {/* Total */}
      <p className="text-xl font-bold text-foreground">
        R$ {fmtBRL(total)}
      </p>

      {/* Diferenca vs Completo */}
      {diffVsCompleto !== null && diffVsCompleto < 0 && (
        <p className="text-[11px] text-emerald-700 mt-1">
          −R$ {fmtBRL(Math.abs(diffVsCompleto))} vs completo
        </p>
      )}

      {/* Older count — "+N anteriores" */}
      {olderCount > 0 && (
        <p className="text-[10px] text-muted-foreground mt-2 italic">
          + {olderCount} versão {olderCount === 1 ? 'anterior' : 'anteriores'} desta categoria
        </p>
      )}

      {/* Footer: estado de seleção */}
      <div className={`mt-3 pt-3 border-t border-border/40 flex items-center justify-between text-[11px] ${
        selected ? `font-semibold ${cfg.iconCls}` : 'text-muted-foreground group-hover:text-foreground'
      }`}>
        {selected ? (
          <span className="flex items-center gap-1">
            <Check size={12} />
            selecionado
          </span>
        ) : (
          <>
            <span>ver proposta</span>
            <ChevronDown size={12} />
          </>
        )}
      </div>
    </button>
  );
}

// ─── Painel inline: proposta selecionada com pagamento + acoes ──────
// Onda 9 — renderiza abaixo dos cards quando alguma versao esta selecionada.
// Reune items (top-4 + expand), opcoes de pagamento, resumo da oferta e acoes
// de negociacao (ajustar / contraproposta / enviar pro paciente).

function PropostaPainel({
  loading,
  detail,
  priority,
  activePaymentKey,
  onChangePayment,
  itemsExpanded,
  onToggleItems,
  onClose,
  onAjustar,
  onSend,
  sending,
  onSaveCounter,
}: {
  loading: boolean;
  detail: QuoteDetailLite | null;
  priority: Priority | null;
  activePaymentKey: string;
  onChangePayment: (key: string) => void;
  itemsExpanded: boolean;
  onToggleItems: () => void;
  onClose: () => void;
  onAjustar: () => void;
  onSend: () => void;
  sending: boolean;
  /** Onda 10 — abre dialog pra registrar a oferta atual como contraproposta */
  onSaveCounter: () => void;
}) {
  if (loading) {
    return (
      <div className="bg-card border border-border rounded-xl p-6 flex items-center justify-center text-muted-foreground">
        <Loader2 size={16} className="animate-spin mr-2" />
        Carregando proposta...
      </div>
    );
  }
  if (!detail) return null;

  const cfg = priority ? PRIORITY_CONFIG[priority] : null;
  const total = Number(detail.total_value);
  const options = buildPaymentOptions(total);
  const allOptions = [...options.avista, ...options.parcelado];
  const activeOption = allOptions.find((o) => o.key === activePaymentKey) || options.avista[0];
  const activeCalc = applyPaymentOption(total, activeOption);

  // Top 4 itens (na ordem que o backend retorna — order_index asc)
  const topItems = detail.items.slice(0, 4);
  const remainingItems = detail.items.slice(4);
  const hasMore = remainingItems.length > 0;

  // Validade em dias (se valid_until existir)
  const daysValid = detail.valid_until
    ? Math.max(0, Math.round((new Date(detail.valid_until).getTime() - Date.now()) / 86400000))
    : null;

  return (
    <div className={`bg-card border-2 rounded-xl p-4 ${cfg?.selectedBorderCls || 'border-border'}`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-3 pb-3 border-b border-border">
        <div className="min-w-0 flex-1">
          <h3 className={`text-sm font-bold flex items-center gap-2 ${cfg?.iconCls || ''}`}>
            {cfg?.icon}
            Proposta — {cfg?.label || detail.title || 'sem prioridade'}
          </h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {detail.items.length} {detail.items.length === 1 ? 'item' : 'itens'}
            {' · '}base R$ {fmtBRL(total)}
            {daysValid !== null && ` · validade ${daysValid} dia${daysValid === 1 ? '' : 's'}`}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground p-1 -mr-1 -mt-1 shrink-0"
          aria-label="Fechar painel"
        >
          <X size={16} />
        </button>
      </div>

      {/* Items list */}
      <div className="mb-4">
        <p className="text-[11px] font-semibold text-foreground mb-2 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          O que está incluído
        </p>
        <ul className="space-y-1">
          {(itemsExpanded ? detail.items : topItems).map((it) => (
            <li
              key={it.id}
              className="flex items-baseline justify-between text-xs py-1 border-b border-border/30 last:border-0"
            >
              <span className="text-foreground truncate pr-2">
                {it.procedure.name}
                {it.notes && (
                  <span className="text-muted-foreground"> · {it.notes}</span>
                )}
              </span>
              <span className="text-muted-foreground tabular-nums shrink-0">
                R$ {fmtBRL(Number(it.total_price))}
              </span>
            </li>
          ))}
        </ul>
        {hasMore && (
          <button
            type="button"
            onClick={onToggleItems}
            className="text-[11px] text-primary hover:underline mt-1.5"
          >
            {itemsExpanded
              ? '− mostrar menos'
              : `+ ${remainingItems.length} outros itens · clique pra expandir`}
          </button>
        )}
      </div>

      {/* Pagamento à vista */}
      <div className="mb-4">
        <p className="text-[11px] font-semibold text-foreground mb-2 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          À vista — com desconto
        </p>
        <div className="grid grid-cols-2 gap-2">
          {options.avista.map((opt) => {
            const isActive = activePaymentKey === opt.key;
            const calc = applyPaymentOption(total, opt);
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => onChangePayment(opt.key)}
                className={`p-3 rounded-lg border text-left transition-colors relative ${
                  isActive
                    ? 'border-emerald-500 bg-emerald-500/10'
                    : 'border-border hover:bg-accent/40'
                }`}
              >
                <span className="absolute top-1.5 right-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-600 text-white">
                  −{opt.discountPercent}%
                </span>
                <p className="text-xs font-semibold flex items-center gap-1.5 mb-1">
                  {opt.key === 'pix' ? <Send size={11} /> : <DollarSign size={11} />}
                  {opt.label}
                </p>
                <p className="text-base font-bold tabular-nums">
                  R$ {fmtBRL(calc.finalValue)}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {opt.key === 'pix'
                    ? `economia de R$ ${fmtBRL(calc.savedValue)}`
                    : opt.sublabel}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Parcelado */}
      <div className="mb-3">
        <p className="text-[11px] font-semibold text-foreground mb-2 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          Parcelado no cartão — sem juros
        </p>
        <div className="grid grid-cols-3 gap-2">
          {options.parcelado.map((opt) => {
            const isActive = activePaymentKey === opt.key;
            const calc = applyPaymentOption(total, opt);
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => onChangePayment(opt.key)}
                className={`p-2.5 rounded-lg border text-center transition-colors ${
                  isActive
                    ? 'border-emerald-500 bg-emerald-500/10'
                    : 'border-border hover:bg-accent/40'
                }`}
              >
                <p className="text-[11px] font-semibold mb-0.5">{opt.label}</p>
                <p className="text-sm font-bold tabular-nums">
                  R$ {fmtBRL(calc.installmentValue)}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Aviso de juros 12x — calculado (1,5% a.m.) */}
      <PaymentInterestNote total={total} />

      {/* Resumo "voce esta oferecendo" */}
      <div className="mt-4 pt-3 border-t border-border">
        <p className="text-xs text-muted-foreground">
          você está oferecendo:{' '}
          <strong className="text-foreground">
            {cfg?.label || 'Proposta'} em{' '}
            {activeOption.variant === 'avista'
              ? `${activeOption.label} à vista`
              : `${activeOption.installments}x no cartão`}
            {' = R$ '}
            {fmtBRL(
              activeOption.variant === 'avista'
                ? activeCalc.finalValue
                : total,
            )}
          </strong>
        </p>
      </div>

      {/* Ações */}
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={onAjustar}
          className="text-xs px-3 py-2 rounded-lg border border-border hover:bg-accent flex items-center gap-1.5"
        >
          <Pencil size={12} />
          Ajustar
        </button>
        <button
          type="button"
          onClick={onSaveCounter}
          className="text-xs px-3 py-2 rounded-lg border border-border hover:bg-accent flex items-center gap-1.5"
        >
          <MessageSquare size={12} />
          Salvar contraproposta
        </button>
        <button
          type="button"
          onClick={onSend}
          disabled={sending}
          className="text-xs px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-wait flex items-center gap-1.5 ml-auto"
        >
          {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
          Enviar pro paciente
        </button>
      </div>

      {/* Onda 10 — Histórico de contrapropostas (parseado de notes) */}
      <CounterProposalsHistory notes={detail.notes} />
    </div>
  );
}

/** Onda 10 — renderiza historico de contrapropostas parseado de Quote.notes */
function CounterProposalsHistory({ notes }: { notes: string | null }) {
  const entries = useMemo(() => parseCounterProposals(notes), [notes]);
  if (entries.length === 0) return null;
  return (
    <div className="mt-4 pt-3 border-t border-border">
      <p className="text-[11px] font-semibold text-foreground mb-2 flex items-center gap-1.5">
        <MessageSquare size={11} className="text-muted-foreground" />
        Histórico de contrapropostas ({entries.length})
      </p>
      <ul className="space-y-1">
        {entries.map((e, idx) => (
          <li
            key={`${e.timestamp}-${idx}`}
            className="text-[11px] text-muted-foreground px-2 py-1.5 rounded bg-muted/30 border border-border/40"
          >
            <span className="font-mono text-[10px] text-foreground/70 mr-2">
              {e.timestamp}
            </span>
            <span className="text-foreground">{e.body}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Calcula 12x com juros 1,5% a.m. e renderiza alerta amber */
function PaymentInterestNote({ total }: { total: number }) {
  const monthlyRate = 0.015;
  const n = 12;
  // Tabela Price: PMT = PV × i / (1 − (1+i)^(−n))
  const pmt = total * monthlyRate / (1 - Math.pow(1 + monthlyRate, -n));
  const totalWithInterest = pmt * n;
  const extra = totalWithInterest - total;
  return (
    <p className="text-[11px] text-amber-800 bg-amber-500/10 border border-amber-500/30 rounded-md px-2.5 py-1.5">
      ⚠ 12x com juros 1,5%/mês: R$ {fmtBRL(pmt)}/mês · total R$ {fmtBRL(totalWithInterest)} · paga R$ {fmtBRL(extra)} a mais
    </p>
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
                Em outro slot — mover pra {cfg.label}
              </p>
              <p className="text-[11px] text-amber-700 bg-amber-500/10 border border-amber-500/30 rounded-md px-2 py-1.5 mb-2">
                ⚠ Cada orçamento tem só uma prioridade. Mover daqui vai{' '}
                <strong>esvaziar o slot atual</strong>.
              </p>
              <ul className="space-y-1.5">
                {inOtherSlot.map((q) => (
                  <QuotePickerRow
                    key={q.id}
                    quote={q}
                    loading={loading}
                    currentPriority={q.priority as Priority}
                    targetPriority={targetPriority}
                    onSelect={() => {
                      const fromLabel = PRIORITY_CONFIG[q.priority as Priority].label;
                      const toLabel = cfg.label;
                      const ok = window.confirm(
                        `Mover "${q.title || 'orçamento'}" de ${fromLabel} pra ${toLabel}?\n\nO slot ${fromLabel} vai ficar vazio.`,
                      );
                      if (ok) onSelect(q.id);
                    }}
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
  targetPriority,
  onSelect,
}: {
  quote: QuoteListItem;
  loading: boolean;
  currentPriority?: Priority;
  targetPriority?: Priority;
  onSelect: () => void;
}) {
  const total = Number(quote.total_value);
  const isMove = !!currentPriority && !!targetPriority;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        disabled={loading}
        className={`w-full text-left px-3 py-2 rounded-lg border disabled:opacity-50 disabled:cursor-wait flex items-center gap-3 transition-colors ${
          isMove
            ? 'border-amber-500/40 hover:bg-amber-500/10 hover:border-amber-500/70'
            : 'border-border hover:bg-accent/40 hover:border-primary/40'
        }`}
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
                <span className={`font-semibold ${PRIORITY_CONFIG[currentPriority].iconCls}`}>
                  {PRIORITY_CONFIG[currentPriority].label}
                </span>
                {targetPriority && (
                  <>
                    {' → '}
                    <span className={`font-semibold ${PRIORITY_CONFIG[targetPriority].iconCls}`}>
                      {PRIORITY_CONFIG[targetPriority].label}
                    </span>
                  </>
                )}
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

// ─── Dialog "+ nova versão" ──────────────────────────────────
// Onda 9 — cria novo Quote DRAFT com priority escolhida e navega
// pra Orcamentos detalhe pra preencher items.

function NewVersionDialog({
  existingPriorities,
  loading,
  onCancel,
  onCreate,
}: {
  existingPriorities: Set<Priority>;
  loading: boolean;
  onCancel: () => void;
  onCreate: (priority: Priority) => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-xl max-w-md w-full overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-4 border-b border-border">
          <div>
            <h3 className="text-sm font-bold">Nova versão do plano</h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              escolha a prioridade — você será levado pro detalhe pra
              preencher os procedimentos
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

        <div className="p-3 space-y-2">
          {PRIORITY_ORDER.map((p) => {
            const cfg = PRIORITY_CONFIG[p];
            const exists = existingPriorities.has(p);
            return (
              <button
                key={p}
                type="button"
                disabled={loading}
                onClick={() => onCreate(p)}
                className={`w-full text-left p-3 rounded-lg border-2 transition-colors disabled:opacity-50 disabled:cursor-wait ${cfg.borderCls} ${cfg.bgCls} hover:shadow-sm`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={cfg.iconCls}>{cfg.icon}</span>
                    <div className="min-w-0">
                      <p className={`text-sm font-bold ${cfg.iconCls}`}>
                        {cfg.label}
                      </p>
                      <p className="text-[11px] text-muted-foreground truncate">
                        {cfg.description}
                      </p>
                    </div>
                  </div>
                  {exists && (
                    <span className="text-[10px] font-semibold text-amber-700 bg-amber-500/10 px-1.5 py-0.5 rounded-full shrink-0">
                      já existe
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

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

// ─── Dialog "Salvar contraproposta" ──────────────────────────
// Onda 10 — registra a oferta atual (priority + forma de pagamento + valor
// final) como linha em Quote.notes. Operador pode anexar nota livre.

function CounterProposalDialog({
  priorityLabel,
  paymentLabel,
  finalValue,
  loading,
  onCancel,
  onSave,
}: {
  priorityLabel: string;
  paymentLabel: string;
  finalValue: number;
  loading: boolean;
  onCancel: () => void;
  onSave: (note?: string) => void;
}) {
  const [note, setNote] = useState('');
  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-xl max-w-md w-full overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-4 border-b border-border">
          <div>
            <h3 className="text-sm font-bold flex items-center gap-2">
              <MessageSquare size={14} className="text-primary" />
              Salvar contraproposta
            </h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              registra a oferta atual no histórico do orçamento — útil pra
              acompanhar negociações em andamento
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

        <div className="p-4 space-y-3">
          {/* Resumo da oferta */}
          <div className="bg-muted/30 border border-border/60 rounded-md p-3">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
              oferta a registrar
            </p>
            <p className="text-sm font-bold text-foreground">
              {priorityLabel} em {paymentLabel}
            </p>
            <p className="text-lg font-bold text-emerald-700 tabular-nums">
              R$ {fmtBRL(finalValue)}
            </p>
          </div>

          {/* Nota livre */}
          <div>
            <label className="text-[11px] font-semibold text-foreground block mb-1">
              Nota (opcional)
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Ex: paciente vai pensar até sexta · pediu mais um desconto"
              disabled={loading}
              rows={3}
              className="w-full text-xs px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none disabled:opacity-50"
            />
            <p className="text-[10px] text-muted-foreground mt-1 italic">
              fica salvo junto com a oferta no histórico do orçamento
            </p>
          </div>
        </div>

        <div className="p-3 border-t border-border flex items-center justify-end gap-2 bg-muted/20">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-accent disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => onSave(note.trim() || undefined)}
            disabled={loading}
            className="text-xs px-4 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 disabled:cursor-wait flex items-center gap-1.5"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}
