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
  Building2, ShieldCheck, XCircle, Search, Trash2,
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
  /** Onda 11 — contagem de contrapropostas registradas em notes */
  counter_proposals_count?: number;
  /** Onda 11.1 — aprovacao parcial: contadores e valores monetarios */
  approved_count?: number;
  pending_count?: number;
  approved_value?: number;
  pending_value?: number;
}

interface QuoteItemDetail {
  id: string;
  total_price: string | number;
  notes: string | null;
  /** Onda 11.1 — item aprovado em-place (status do item, nao do quote) */
  approved_at?: string | null;
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

/** Onda 12 — payload + resposta do credit-check */
interface CreditCheckRequest {
  cpf: string;
  nome: string;
  data_nascimento: string;
  renda_mensal: number;
  telefone: string;
  profissao: string;
  parcela_alvo: number;
  parcelas: number;
  valor_total: number;
}

interface CreditCheckResult {
  status: 'approved' | 'pending' | 'denied';
  decision_id: string;
  ratio: number;
  message: string;
  motivo?: string;
  suggestion?: string;
  conditions?: {
    max_parcelas: number;
    parcela_aprovada: number;
    total_aprovado: number;
    juros_mes: number;
    entrada_pct: number;
  };
  /** Onda 12.1 — fonte da decisao: internal (mock), asaas_history (cliente
   *  recorrente da clinica) ou serasa (quando integrar). */
  source?: 'internal' | 'asaas_history' | 'serasa';
  /** Onda 12.1 — sumario do historico Asaas quando o paciente e cliente recorrente */
  asaas_summary?: {
    is_recurring: boolean;
    on_time_rate?: number;
    charges_count?: number;
  };
  checked_at: string;
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

/** Onda 9 — opcoes de pagamento renderizadas no painel inline.
 *  Onda 11.2 — adicionado interestRate (% a.m.) pra suportar boleto parcelado.
 *  Onda 11.3 — adicionado downPaymentPercent (entrada que abate as parcelas).
 *  Onda 11.4 — adicionado variant 'cartao' (1x-12x sem juros). */
interface PaymentOption {
  key: string;
  label: string;
  sublabel: string;
  discountPercent: number; // 0 = sem desconto
  installments: number;
  variant: 'avista' | 'cartao' | 'parcelado';
  /** Onda 11.2 — % de juros ao mes (default 0 = sem juros, Tabela Price quando > 0) */
  interestRate?: number;
  /** Onda 11.3 — % de entrada (default 0). Reduz valor financiado antes de
   *  aplicar Price → parcelas menores. Entrada paga a vista no fechamento. */
  downPaymentPercent?: number;
}

function buildPaymentOptions(): {
  avista: PaymentOption[];
  cartao: PaymentOption[];
  parcelado: PaymentOption[];
} {
  // Onda 11.4 — gera 12 opcoes de cartao (1x ate 12x).
  // Onda 11.7 — 1x..6x sem juros / 7x..12x com juros padrao PagBank 3,59% a.m.
  const PAGBANK_INTEREST_RATE = 3.59; // % ao mes (taxa padrao PagBank para 7x-12x)
  const cartao: PaymentOption[] = Array.from({ length: 12 }, (_, idx) => {
    const n = idx + 1;
    return {
      key: `cartao-${n}x`,
      label: `${n}x`,
      sublabel: '',
      discountPercent: 0,
      installments: n,
      variant: 'cartao',
      interestRate: n <= 6 ? 0 : PAGBANK_INTEREST_RATE,
    };
  });

  return {
    avista: [
      {
        key: 'pix',
        label: 'PIX ou dinheiro',
        sublabel: 'à vista',
        discountPercent: 10,
        installments: 1,
        variant: 'avista',
      },
    ],
    // Onda 11.4 — Cartao de credito 1x ate 12x sem juros
    cartao,
    // Onda 11.2 — Boleto parcelado com juros 1,5%/mes
    // Onda 11.3 — entrada de 20% em todas as opcoes parceladas
    parcelado: [
      { key: '12x', label: '12x', sublabel: '', discountPercent: 0, installments: 12, variant: 'parcelado', interestRate: 1.5, downPaymentPercent: 20 },
      { key: '18x', label: '18x', sublabel: '', discountPercent: 0, installments: 18, variant: 'parcelado', interestRate: 1.5, downPaymentPercent: 20 },
      { key: '24x', label: '24x', sublabel: '', discountPercent: 0, installments: 24, variant: 'parcelado', interestRate: 1.5, downPaymentPercent: 20 },
    ],
  };
}

/** Calcula valor final dado opcao + total base.
 *  Onda 11.2 — usa Tabela Price quando interestRate > 0: PMT = PV × i / (1 − (1+i)^(−n))
 *  Onda 11.3 — quando downPaymentPercent > 0:
 *    1. Entrada (downPayment) = total × downPaymentPercent / 100 (paga a vista)
 *    2. Valor financiado = total − entrada
 *    3. Aplica Price sobre o valor financiado
 *    4. Total final = entrada + (parcelas × n)
 */
function applyPaymentOption(total: number, opt: PaymentOption): {
  /** total final pago (descontos aplicados ou juros somados) */
  finalValue: number;
  /** valor de cada parcela mensal (ou finalValue/installments se 1x) */
  installmentValue: number;
  /** desconto aplicado (so a vista) */
  savedValue: number;
  /** juros pagos a mais (so parcelado com juros) */
  extraInterest: number;
  /** Onda 11.3 — valor da entrada (so parcelado com entrada) */
  downPaymentValue: number;
  /** Onda 11.3 — valor que sera financiado (total - entrada) */
  financedAmount: number;
} {
  if (opt.interestRate && opt.interestRate > 0) {
    const downPaymentValue = (opt.downPaymentPercent ?? 0) > 0
      ? total * ((opt.downPaymentPercent ?? 0) / 100)
      : 0;
    const financedAmount = total - downPaymentValue;
    const i = opt.interestRate / 100;
    const n = opt.installments;
    const pmt = financedAmount * i / (1 - Math.pow(1 + i, -n));
    const totalInstallments = pmt * n;
    const finalValue = downPaymentValue + totalInstallments;
    return {
      finalValue,
      installmentValue: pmt,
      savedValue: 0,
      extraInterest: finalValue - total,
      downPaymentValue,
      financedAmount,
    };
  }
  const savedValue = total * (opt.discountPercent / 100);
  const finalValue = total - savedValue;
  return {
    finalValue,
    installmentValue: finalValue / opt.installments,
    savedValue,
    extraInterest: 0,
    downPaymentValue: 0,
    financedAmount: finalValue,
  };
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
  const paymentKeyStorage = `propostas-payment-${patientId}`;
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try { return window.sessionStorage.getItem(selectionKey); } catch { return null; }
  });
  // Detalhe do quote selecionado (items + preços), carregado sob demanda.
  const [selectedDetail, setSelectedDetail] = useState<QuoteDetailLite | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  // Onda 11 — forma de pagamento persistida por paciente (sobrevive reload/aba)
  const [activePaymentKey, setActivePaymentKey] = useState<string>(() => {
    if (typeof window === 'undefined') return 'pix';
    try { return window.sessionStorage.getItem(paymentKeyStorage) || 'pix'; } catch { return 'pix'; }
  });
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

  // Onda 11 — persiste forma de pagamento
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { window.sessionStorage.setItem(paymentKeyStorage, activePaymentKey); }
    catch { /* ignora */ }
  }, [activePaymentKey, paymentKeyStorage]);

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

  // Onda 12.5 — Remove o quote do slot (limpa priority, NAO exclui o quote).
  // Orcamento continua existente na aba Orcamentos e volta pra "Sem prioridade
  // definida" aqui — pode ser re-atribuido pelo picker depois.
  const removeFromSlot = useCallback(async (quoteId: string, label: string) => {
    const ok = window.confirm(
      `Remover do slot "${label}"?\n\nO orçamento NÃO será excluído — ele volta pra "Sem prioridade definida" e pode ser atribuído de novo a qualquer momento.`,
    );
    if (!ok) return;
    try {
      await api.patch(`/quotes/${quoteId}`, { priority: null });
      // Se o card removido estava selecionado, limpa selecao
      setSelectedId((prev) => (prev === quoteId ? null : prev));
      showSuccess(`Removido do slot ${label}`);
      await load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao remover do slot');
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

  // Onda 12 — Consulta de credito do Financiamento Banco PASSOS
  const [creditCheckOpen, setCreditCheckOpen] = useState(false);

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
        // Onda 11 — refresh da lista pra badge "N propostas" atualizar no card
        load();
      } catch (err: unknown) {
        const e = err as { response?: { data?: { message?: string } } };
        showError(e?.response?.data?.message || 'Erro ao salvar contraproposta');
      } finally {
        setSavingCounter(false);
      }
    },
    [selectedDetail, load],
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
  // diferenca nas outras. Onda 11.1 — usa approved_value quando ha aprovacao
  // parcial (compara o que vai ser pago, nao o bruto).
  const completoTotal = useMemo(() => {
    const cs = grouped.get('COMPLETO');
    if (!cs || cs.length === 0) return null;
    const c = cs[0];
    const ac = c.approved_count ?? 0;
    return ac > 0
      ? Number(c.approved_value ?? 0)
      : Number(c.total_value);
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
              onRemoveFromSlot={() => {
                if (!main) return;
                removeFromSlot(main.id, cfg.label);
              }}
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
          onOpenCreditCheck={() => setCreditCheckOpen(true)}
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
        // Onda 11.1 — usa approved_value quando ha aprovacao parcial (proposta
        // de pagamento e sobre o que paciente ja topou).
        const totalBruto = Number(selectedDetail.total_value);
        const approvedValue = selectedDetail.items
          .filter((it) => !!it.approved_at)
          .reduce((acc, it) => acc + Number(it.total_price), 0);
        const hasApproved = selectedDetail.items.some((it) => !!it.approved_at);
        const total = hasApproved ? approvedValue : totalBruto;
        const opts = buildPaymentOptions();
        const allOptions = [...opts.avista, ...opts.cartao, ...opts.parcelado];
        const activeOption = allOptions.find((o) => o.key === activePaymentKey) || opts.avista[0];
        const calc = applyPaymentOption(total, activeOption);
        const priority = (quotes.find((q) => q.id === selectedId)?.priority as Priority | undefined) || null;
        const priorityLabel = priority ? PRIORITY_CONFIG[priority].label : 'Proposta';
        const paymentLabel =
          activeOption.variant === 'avista'
            ? `${activeOption.label} à vista`
            : activeOption.variant === 'cartao'
            ? `${activeOption.installments}x no cartão (${(activeOption.interestRate ?? 0) === 0 ? 'sem juros' : `juros PagBank ${activeOption.interestRate}%/mês`})`
            : `${activeOption.installments}x no Financiamento Banco PASSOS (entrada ${activeOption.downPaymentPercent ?? 0}% + ${activeOption.interestRate}%/mês)`;
        // Onda 11.2 — finalValue agora reflete o que foi ofertado:
        // a vista = descontado / parcelado = total com juros
        const finalValue = calc.finalValue;
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

      {/* Onda 12 — Dialog "Financiamento Banco PASSOS" (consulta de credito) */}
      {creditCheckOpen && selectedDetail && (() => {
        const totalForCheck = (() => {
          const approved = selectedDetail.items
            .filter((it) => !!it.approved_at)
            .reduce((acc, it) => acc + Number(it.total_price), 0);
          const has = selectedDetail.items.some((it) => !!it.approved_at);
          return has ? approved : Number(selectedDetail.total_value);
        })();
        return (
          <CreditCheckDialog
            quoteId={selectedDetail.id}
            valorTotal={totalForCheck}
            onCancel={() => setCreditCheckOpen(false)}
            onAppliedSuccess={(parcelaKey) => {
              setActivePaymentKey(parcelaKey);
              load(); // refresh lista pra refletir quote ACCEPTED
              showSuccess('Boletos gerados e proposta aplicada');
            }}
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
  onRemoveFromSlot,
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
  /** Onda 12.5 — Remove o orcamento deste slot (limpa priority, NAO exclui).
   *  Slot vira vazio e o orcamento volta pra "Sem prioridade definida". */
  onRemoveFromSlot: () => void;
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

  const totalBruto = Number(quote.total_value);
  // Onda 11.1 — se ha aprovacao parcial, exibe approved_value como base
  // (o que paciente ja topou e vai pagar). Pendentes ficam de fora da proposta.
  // Senao usa total_value.
  const approvedCount = quote.approved_count ?? 0;
  const approvedValue = Number(quote.approved_value ?? 0);
  const pendingValue = Number(quote.pending_value ?? totalBruto);
  const hasPartialApproval = approvedCount > 0;
  const total = hasPartialApproval ? approvedValue : totalBruto;
  const isSent = quote.status === 'SENT';
  const cadeira = formatCadeira(quote.total_duration_minutes);
  // Diferenca vs Completo (so faz sentido pra Essencial/Urgente).
  // Usa approved value de ambos os lados pra comparacao justa do que vai
  // ser efetivamente pago.
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

      {/* Onda 11 — Badge "N propostas" quando ha contrapropostas registradas */}
      {(quote.counter_proposals_count ?? 0) > 0 && (
        <span
          className="absolute -top-2 -left-2 text-[10px] font-bold px-2 py-0.5 rounded-full bg-primary text-primary-foreground shadow-sm flex items-center gap-1"
          title="contrapropostas registradas"
        >
          <MessageSquare size={9} />
          {quote.counter_proposals_count}
        </span>
      )}

      {/* Onda 12.5 — Lixeirinha pra remover do slot (sem excluir o orçamento) */}
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          onRemoveFromSlot();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            onRemoveFromSlot();
          }
        }}
        className="absolute top-2 right-2 p-1 rounded-md text-muted-foreground hover:text-red-700 hover:bg-red-500/10 transition-colors cursor-pointer"
        aria-label={`Remover do slot ${cfg.label}`}
        title="Remover do slot (orçamento continua salvo)"
      >
        <Trash2 size={12} />
      </span>

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
            {hasPartialApproval ? (
              <>
                <span className="text-emerald-700 font-semibold">
                  {approvedCount} aprovado{approvedCount === 1 ? '' : 's'}
                </span>
                {' · '}
                {quote.pending_count ?? 0} em aberto
              </>
            ) : (
              <>
                {quote._count?.items ?? 0} {quote._count?.items === 1 ? 'item' : 'itens'}
              </>
            )}
          </span>
          {cadeira && (
            <span className="flex items-center gap-1">
              <Clock size={10} />
              {cadeira}
            </span>
          )}
        </div>
      </div>

      {/* Total — quando ha aprovacao parcial, exibe approved_value como destaque
          (o que paciente ja topou e vai pagar). Pendente vira info secundaria. */}
      <p className="text-xl font-bold text-foreground">
        R$ {fmtBRL(total)}
      </p>
      {hasPartialApproval ? (
        <p className="text-[11px] text-muted-foreground mt-0.5">
          <span className="text-emerald-700">já aprovado</span> · + R$ {fmtBRL(pendingValue)} em aberto
        </p>
      ) : null}

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
  onOpenCreditCheck,
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
  /** Onda 12 — abre dialog de credit-check do Financiamento Banco PASSOS */
  onOpenCreditCheck: () => void;
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
  const totalBruto = Number(detail.total_value);
  // Onda 11.1 — items aprovados in-place (approved_at != null) sao o que o
  // paciente ja topou e vai pagar. Proposta de pagamento e sobre esses items.
  // Pendentes ficam de fora (paciente ainda nao topou).
  const approvedItems = detail.items.filter((it) => !!it.approved_at);
  const pendingItems = detail.items.filter((it) => !it.approved_at);
  const approvedValue = approvedItems.reduce((acc, it) => acc + Number(it.total_price), 0);
  const pendingValue = pendingItems.reduce((acc, it) => acc + Number(it.total_price), 0);
  const hasPartialApproval = approvedItems.length > 0;
  // Base usada pra calcular formas de pagamento — usa o ja aprovado.
  const total = hasPartialApproval ? approvedValue : totalBruto;

  const options = buildPaymentOptions();
  const allOptions = [...options.avista, ...options.cartao, ...options.parcelado];
  const activeOption = allOptions.find((o) => o.key === activePaymentKey) || options.avista[0];
  const activeCalc = applyPaymentOption(total, activeOption);

  // Onda 11.1 — Ordena itens: aprovados primeiro (incluidos nesta proposta de
  // pagamento), pendentes depois (em aberto, nao incluidos).
  const itemsSorted = hasPartialApproval
    ? [...approvedItems, ...pendingItems]
    : detail.items;
  const topItems = itemsSorted.slice(0, 4);
  const remainingItems = itemsSorted.slice(4);
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
            {hasPartialApproval ? (
              <>
                <span className="text-emerald-700 font-semibold">
                  {approvedItems.length} aprovado{approvedItems.length === 1 ? '' : 's'}
                </span>
                {' · '}
                {pendingItems.length} em aberto
                {' · '}base R$ {fmtBRL(total)}
                {' '}<span className="text-muted-foreground">(do que foi aprovado)</span>
              </>
            ) : (
              <>
                {detail.items.length} {detail.items.length === 1 ? 'item' : 'itens'}
                {' · '}base R$ {fmtBRL(total)}
              </>
            )}
            {daysValid !== null && ` · validade ${daysValid} dia${daysValid === 1 ? '' : 's'}`}
          </p>
          {/* Banner: items ainda em aberto (nao incluidos nesta proposta) */}
          {hasPartialApproval && pendingItems.length > 0 && (
            <p className="text-[10px] text-amber-800 bg-amber-500/10 border border-amber-500/30 rounded-md px-2 py-1 mt-1.5 inline-flex items-center gap-1.5">
              <AlertTriangle size={10} />
              <strong>R$ {fmtBRL(pendingValue)}</strong> em {pendingItems.length} item{pendingItems.length === 1 ? '' : 's'} ainda em aberto · fora desta proposta
            </p>
          )}
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

      {/* Items list — Onda 11.1: items aprovados ficam com check verde + opacity */}
      <div className="mb-4">
        <p className="text-[11px] font-semibold text-foreground mb-2 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          O que está incluído
        </p>
        <ul className="space-y-1">
          {(itemsExpanded ? itemsSorted : topItems).map((it) => {
            const isApproved = !!it.approved_at;
            // Onda 11.1 — quando ha aprovacao parcial, items pendentes ficam
            // sinalizados como "em aberto" (badge amber) mas totalmente legiveis.
            // Aprovados recebem check verde. Sem aprovacao parcial, tudo normal.
            const isOutOfProposal = hasPartialApproval && !isApproved;
            return (
              <li
                key={it.id}
                className="flex items-baseline justify-between text-xs py-1 border-b border-border/30 last:border-0"
              >
                <span className="text-foreground truncate pr-2 flex items-center gap-1.5">
                  {isApproved && hasPartialApproval && (
                    <Check size={11} className="text-emerald-600 shrink-0" aria-label="aprovado" />
                  )}
                  <span>{it.procedure.name}</span>
                  {it.notes && (
                    <span className="text-muted-foreground"> · {it.notes}</span>
                  )}
                  {isOutOfProposal && (
                    <span className="text-[9px] text-amber-700 font-semibold bg-amber-500/10 px-1.5 py-0.5 rounded-full shrink-0">
                      em aberto
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground tabular-nums shrink-0">
                  R$ {fmtBRL(Number(it.total_price))}
                </span>
              </li>
            );
          })}
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

      {/* Onda 11.9 — PIX/dinheiro e Cartao de credito lado a lado em grid 2 cols.
          Onda 12.3 — items-stretch + h-full nos botoes pra alinhar alturas. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4 items-stretch">
        {/* Pagamento à vista — Onda 11.6: so PIX/dinheiro */}
        <div className="flex flex-col">
          <p className="text-[11px] font-semibold text-foreground mb-2 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            À vista — com desconto
          </p>
          {options.avista.map((opt) => {
            const isActive = activePaymentKey === opt.key;
            const calc = applyPaymentOption(total, opt);
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => onChangePayment(opt.key)}
                className={`w-full flex-1 p-4 rounded-lg border text-left transition-colors relative ${
                  isActive
                    ? 'border-emerald-500 bg-emerald-500/10'
                    : 'border-border hover:bg-accent/40'
                }`}
              >
                <span className="absolute top-2 right-2 text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-600 text-white">
                  −{opt.discountPercent}%
                </span>
                <p className="text-sm font-semibold flex items-center gap-1.5 mb-2">
                  <Send size={13} />
                  {opt.label}
                </p>
                <div className="flex items-baseline gap-3 flex-wrap">
                  <p className="text-3xl font-bold tabular-nums text-emerald-700">
                    R$ {fmtBRL(calc.finalValue)}
                  </p>
                  <p className="text-base text-muted-foreground line-through tabular-nums">
                    R$ {fmtBRL(total)}
                  </p>
                </div>
                <p className="text-xs text-emerald-700 mt-1 font-medium">
                  economia de R$ {fmtBRL(calc.savedValue)}
                </p>
              </button>
            );
          })}
        </div>

        {/* Onda 11.5 — Cartao de credito (card unico com dropdown inline) */}
        <CardCartao
          options={options.cartao}
          total={total}
          activePaymentKey={activePaymentKey}
          onChangePayment={onChangePayment}
        />
      </div>

      {/* Onda 11.8 — Boleto parcelado vira card reclinavel (nao exposto por padrao).
          Operador abre so quando quer propor essa alternativa ao paciente. */}
      <CardBoletoParcelado
        options={options.parcelado}
        total={total}
        activePaymentKey={activePaymentKey}
        onChangePayment={onChangePayment}
        onOpenCreditCheck={onOpenCreditCheck}
      />

      {/* Resumo "voce esta oferecendo" */}
      <div className="mt-4 pt-3 border-t border-border">
        <p className="text-xs text-muted-foreground">
          você está oferecendo:{' '}
          <strong className="text-foreground">
            {cfg?.label || 'Proposta'} em{' '}
            {activeOption.variant === 'avista'
              ? `${activeOption.label} à vista`
              : activeOption.variant === 'cartao'
              ? `${activeOption.installments}x no cartão`
              : `${activeOption.installments}x no Financiamento Banco PASSOS`}
            {' = '}
            {activeOption.variant === 'avista' ? (
              <>R$ {fmtBRL(activeCalc.finalValue)}</>
            ) : activeOption.variant === 'cartao' ? (
              <>
                {activeOption.installments}x de R$ {fmtBRL(activeCalc.installmentValue)} ·{' '}
                <span className="text-muted-foreground font-normal">
                  total R$ {fmtBRL(activeCalc.finalValue)}
                </span>
              </>
            ) : (
              <>
                entrada R$ {fmtBRL(activeCalc.downPaymentValue)} +{' '}
                R$ {fmtBRL(activeCalc.installmentValue)}/mês ·{' '}
                <span className="text-muted-foreground font-normal">
                  total R$ {fmtBRL(activeCalc.finalValue)}
                </span>
              </>
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

/** Onda 11.5 — Card de cartao de credito com dropdown inline pra escolher
 *  quantidade de parcelas (1x ate 12x). Estilo equivalente aos cards de
 *  "a vista". Click no card alterna dropdown; click numa parcela marca
 *  ativo + fecha dropdown. */
function CardCartao({
  options,
  total,
  activePaymentKey,
  onChangePayment,
}: {
  options: PaymentOption[];
  total: number;
  activePaymentKey: string;
  onChangePayment: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Detecta se ja ha cartao ativo. Senao, usa default 1x pra display.
  const active = options.find((o) => o.key === activePaymentKey);
  const display = active || options[0]; // 1x default pra preview
  const calc = applyPaymentOption(total, display);
  const isSelected = !!active;

  return (
    <div className="flex flex-col">
      <p className="text-[11px] font-semibold text-foreground mb-2 flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-sky-500" />
        Cartão de crédito — 1x a 6x sem juros · 7x a 12x com juros PagBank
      </p>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex-1 p-4 rounded-lg border text-left transition-colors relative ${
          isSelected
            ? 'border-sky-500 bg-sky-500/10 ring-2 ring-sky-500/20'
            : 'border-border hover:bg-accent/40 hover:border-sky-300'
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold flex items-center gap-1.5 mb-2">
              <DollarSign size={13} />
              {isSelected ? `Cartão · ${display.installments}x` : 'Cartão de crédito'}
            </p>
            <p className="text-2xl font-bold tabular-nums text-sky-700">
              {display.installments}x de R$ {fmtBRL(calc.installmentValue)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              total R$ {fmtBRL(calc.finalValue)} ·{' '}
              {(display.interestRate ?? 0) === 0 ? (
                <span className="text-emerald-700 font-semibold">sem juros</span>
              ) : (
                <span className="text-amber-700 font-semibold">
                  +R$ {fmtBRL(calc.extraInterest)} juros
                </span>
              )}
            </p>
          </div>
          <span
            className={`text-muted-foreground transition-transform shrink-0 mt-0.5 ${
              open ? 'rotate-180' : ''
            }`}
            aria-hidden="true"
          >
            <ChevronDown size={14} />
          </span>
        </div>
        {!isSelected && (
          <span className="absolute top-2 right-8 text-[10px] font-bold px-2 py-0.5 rounded-full bg-sky-100 text-sky-700">
            clique pra escolher
          </span>
        )}
      </button>

      {/* Onda 12.4 — Modal overlay (era dropdown inline). UX premium estilo
          Mercado Pago / Asaas — ganha credibilidade do paciente */}
      {open && (
        <CartaoInstallmentsModal
          options={options}
          total={total}
          activePaymentKey={activePaymentKey}
          onSelect={(key) => {
            onChangePayment(key);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/** Onda 12.4 — Modal premium pra escolher parcelas do cartao.
 *  Substitui o dropdown inline anterior. UX inspirado em Mercado Pago / Asaas:
 *  overlay grande centralizado, header destacado, tabela com mais "ar". */
function CartaoInstallmentsModal({
  options,
  total,
  activePaymentKey,
  onSelect,
  onClose,
}: {
  options: PaymentOption[];
  total: number;
  activePaymentKey: string;
  onSelect: (key: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-2xl max-w-2xl w-full overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header destacado com gradient sutil */}
        <div className="px-6 py-4 border-b border-border bg-gradient-to-r from-sky-500/10 to-sky-500/5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <div className="w-8 h-8 rounded-lg bg-sky-500/15 flex items-center justify-center">
                  <DollarSign size={16} className="text-sky-700" />
                </div>
                <h3 className="text-base font-bold text-foreground">
                  Cartão de crédito
                </h3>
              </div>
              <p className="text-xs text-muted-foreground ml-10">
                Escolha em quantas vezes deseja parcelar
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground p-1.5 -mr-1 hover:bg-accent/50 rounded-md transition-colors"
              aria-label="Fechar"
            >
              <X size={18} />
            </button>
          </div>

          {/* Bandeiras aceitas (placeholder via texto + ícones de cartão) */}
          <div className="flex items-center gap-2 mt-3 ml-10 flex-wrap">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
              Aceitamos:
            </span>
            {['Visa', 'Mastercard', 'Hipercard', 'American Express', 'Elo'].map((b) => (
              <span
                key={b}
                className="text-[10px] px-2 py-0.5 rounded border border-border bg-card text-foreground font-medium"
              >
                {b}
              </span>
            ))}
          </div>
        </div>

        {/* Resumo do valor */}
        <div className="px-6 py-3 bg-muted/20 border-b border-border flex items-baseline justify-between gap-3">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
            Valor total
          </span>
          <span className="text-lg font-bold tabular-nums text-foreground">
            R$ {fmtBRL(total)}
          </span>
        </div>

        {/* Cabeçalho da tabela */}
        <div className="grid grid-cols-[80px_1fr_auto] gap-4 px-6 py-2 text-[10px] uppercase tracking-wide text-muted-foreground font-bold border-b border-border bg-muted/10">
          <span>Parcelas</span>
          <span>Valor de cada parcela</span>
          <span className="text-right">Total</span>
        </div>

        {/* Linhas */}
        <ul className="flex-1 overflow-y-auto">
          {options.map((opt) => {
            const isActive = activePaymentKey === opt.key;
            const c = applyPaymentOption(total, opt);
            const hasInterest = (opt.interestRate ?? 0) > 0;
            return (
              <li key={opt.key}>
                <button
                  type="button"
                  onClick={() => onSelect(opt.key)}
                  className={`w-full grid grid-cols-[80px_1fr_auto] gap-4 px-6 py-3 text-left transition-colors border-b border-border/40 last:border-0 ${
                    isActive
                      ? 'bg-sky-500/10 hover:bg-sky-500/15'
                      : 'hover:bg-accent/40'
                  }`}
                >
                  <span className={`text-base tabular-nums ${isActive ? 'font-bold text-sky-700' : 'font-medium text-foreground'}`}>
                    {opt.installments}x
                  </span>
                  <span className="text-sm tabular-nums">
                    de{' '}
                    <strong className={isActive ? 'text-sky-700' : 'text-foreground'}>
                      R$ {fmtBRL(c.installmentValue)}
                    </strong>{' '}
                    {!hasInterest ? (
                      <span className="text-emerald-700 text-xs font-medium">sem juros</span>
                    ) : (
                      <span className="text-amber-700 text-xs font-medium">com juros</span>
                    )}
                  </span>
                  <span className="text-sm tabular-nums text-right text-muted-foreground">
                    R$ {fmtBRL(c.finalValue)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {/* Rodapé: segurança + nota de juros */}
        <div className="px-6 py-3 bg-muted/20 border-t border-border space-y-1">
          <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
            <ShieldCheck size={11} className="text-emerald-700" />
            Pagamento processado de forma segura pelo Asaas + PagBank
          </p>
          <p className="text-[10px] text-muted-foreground">
            Taxa de juros 3,59% a.m. da PagBank aplicada nas parcelas de 7x a 12x.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Onda 11.8 — Card de boleto parcelado reclinavel. Por padrao colapsado pra
 *  nao ficar exposto ao paciente — abre apenas quando operador quer propor
 *  essa alternativa (prazo maior com entrada + juros).
 *  Onda 12 — agora abre dialog de credit-check ao inves de dropdown inline. */
function CardBoletoParcelado({
  options,
  total,
  activePaymentKey,
  onChangePayment,
  onOpenCreditCheck,
}: {
  options: PaymentOption[];
  total: number;
  activePaymentKey: string;
  onChangePayment: (key: string) => void;
  /** Onda 12 — abre dialog de consulta de credito (Banco PASSOS) */
  onOpenCreditCheck: () => void;
}) {
  const activeIdx = options.findIndex((o) => o.key === activePaymentKey);
  const isSelected = activeIdx >= 0;
  const active = isSelected ? options[activeIdx] : null;
  const activeCalc = active ? applyPaymentOption(total, active) : null;

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={onOpenCreditCheck}
        className={`w-full p-3 rounded-lg border text-left transition-colors relative ${
          isSelected
            ? 'border-amber-500 bg-amber-500/10'
            : 'border-border bg-muted/10 hover:bg-accent/40 hover:border-amber-300 border-dashed'
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold flex items-center gap-1.5 mb-0.5">
              <Building2 size={11} className="text-amber-700" />
              Financiamento Banco PASSOS
              {!isSelected && (
                <span className="text-[10px] font-normal text-muted-foreground italic ml-1">
                  (consulta de crédito · aprovação imediata)
                </span>
              )}
            </p>
            {isSelected && active && activeCalc ? (
              <>
                <p className="text-sm font-bold tabular-nums">
                  {active.installments}x · entrada R$ {fmtBRL(activeCalc.downPaymentValue)} +
                  {' '}R$ {fmtBRL(activeCalc.installmentValue)}/mês
                </p>
                <p className="text-[10px] text-muted-foreground">
                  total R$ {fmtBRL(activeCalc.finalValue)} · +R$ {fmtBRL(activeCalc.extraInterest)} juros
                </p>
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                entrada de 20% + juros 1,5%/mês · 12x, 18x ou 24x · clique para iniciar a consulta
              </p>
            )}
          </div>
          <span className="text-amber-700 shrink-0 mt-0.5 text-[10px] font-bold uppercase tracking-wide">
            <Search size={14} className="inline-block" />
          </span>
        </div>
      </button>
    </div>
  );
}

/** Onda 10 — renderiza historico de contrapropostas parseado de Quote.notes.
 *  Onda 11 — destaca a "última oferta" em card separado acima do historico. */
function CounterProposalsHistory({ notes }: { notes: string | null }) {
  const entries = useMemo(() => parseCounterProposals(notes), [notes]);
  if (entries.length === 0) return null;
  const [latest, ...older] = entries;
  return (
    <div className="mt-4 pt-3 border-t border-border space-y-3">
      {/* Onda 11 — Última oferta destacada */}
      <div className="bg-primary/5 border border-primary/30 rounded-md p-2.5">
        <p className="text-[10px] uppercase tracking-wide text-primary font-bold mb-1 flex items-center gap-1.5">
          <MessageSquare size={10} />
          última oferta registrada
          <span className="font-mono text-muted-foreground font-normal ml-auto">
            {latest.timestamp}
          </span>
        </p>
        <p className="text-xs text-foreground">{latest.body}</p>
      </div>

      {/* Histórico anterior (se houver mais de 1) */}
      {older.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold text-foreground mb-2 flex items-center gap-1.5">
            <MessageSquare size={11} className="text-muted-foreground" />
            Anteriores ({older.length})
          </p>
          <ul className="space-y-1">
            {older.map((e, idx) => (
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
      )}
    </div>
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

// ─── Dialog Financiamento Banco PASSOS — Onda 12 ─────────────
// Consulta de credito em tempo real (mock backend). 3 fases:
//   cadastro → consultando → resultado (approved/pending/denied)
// Em producao, substituir o endpoint mock por integracao Serasa Crediscore.

type CreditPhase = 'cadastro' | 'consultando' | 'resultado' | 'gerando' | 'boletos';

interface ApplyFinancingResult {
  quote_id: string;
  plan_id: string;
  total_financed: number;
  charges: Array<{
    kind: 'entrada' | 'parcelado';
    boleto_url: string | null;
    barcode: string | null;
    due_date: string;
    amount: number;
    installment_count?: number;
    installment_value?: number;
  }>;
}

function CreditCheckDialog({
  quoteId,
  valorTotal,
  onCancel,
  onAppliedSuccess,
}: {
  /** Onda 12.2 — id do quote pra fechar via POST /quotes/:id/apply-financing */
  quoteId: string;
  valorTotal: number;
  onCancel: () => void;
  /** Onda 12.2 — chamado quando o fluxo completa (aceita + boletos gerados).
   *  parcelaKey: ex "parcelado-12x" — alimenta activePaymentKey no painel. */
  onAppliedSuccess: (parcelaKey: string) => void;
}) {
  const [phase, setPhase] = useState<CreditPhase>('cadastro');
  const [parcelas, setParcelas] = useState<12 | 18 | 24>(18);
  const [result, setResult] = useState<CreditCheckResult | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyFinancingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMsg, setLoadingMsg] = useState('Consultando Serasa...');

  // Form fields
  const [cpf, setCpf] = useState('');
  const [nome, setNome] = useState('');
  const [dataNasc, setDataNasc] = useState('');
  const [renda, setRenda] = useState('');
  const [telefone, setTelefone] = useState('');
  const [profissao, setProfissao] = useState('');

  // Calcula a parcela alvo baseado no prazo escolhido (sem entrada pra
  // simulacao de credito — o credit-check avalia o comprometimento total).
  const opt: PaymentOption = useMemo(() => ({
    key: `parcelado-${parcelas}x`,
    label: `${parcelas}x`,
    sublabel: '',
    discountPercent: 0,
    installments: parcelas,
    variant: 'parcelado',
    interestRate: 1.5,
    downPaymentPercent: 20,
  }), [parcelas]);
  const calc = applyPaymentOption(valorTotal, opt);

  // Mensagens dinamicas durante consultando
  useEffect(() => {
    if (phase !== 'consultando' && phase !== 'gerando') return;
    const msgsConsulta = [
      'Consultando Serasa...',
      'Avaliando histórico de crédito...',
      'Calculando condições...',
    ];
    const msgsGerando = [
      'Aceitando proposta...',
      'Ativando plano de tratamento...',
      'Gerando boleto de entrada...',
      'Gerando boletos das parcelas...',
    ];
    const msgs = phase === 'consultando' ? msgsConsulta : msgsGerando;
    setLoadingMsg(msgs[0]);
    let i = 0;
    const id = setInterval(() => {
      i = (i + 1) % msgs.length;
      setLoadingMsg(msgs[i]);
    }, 700);
    return () => clearInterval(id);
  }, [phase]);

  const fmtCpf = (v: string) => {
    const c = v.replace(/\D/g, '').slice(0, 11);
    return c
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  };
  const fmtTel = (v: string) => {
    const c = v.replace(/\D/g, '').slice(0, 11);
    if (c.length <= 10) return c.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{4})(\d)/, '$1-$2');
    return c.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d)/, '$1-$2');
  };
  const fmtCurrency = (v: string) => v.replace(/\D/g, '');
  const rendaNum = Number(renda) / 100;

  const canSubmit = cpf.replace(/\D/g, '').length === 11
    && nome.trim().length >= 3
    && dataNasc.length === 10
    && rendaNum > 0
    && telefone.replace(/\D/g, '').length >= 10
    && profissao.trim().length >= 2;

  const submit = async () => {
    setError(null);
    setPhase('consultando');
    try {
      const { data } = await api.post<CreditCheckResult>('/credit-check/simulate', {
        cpf: cpf.replace(/\D/g, ''),
        nome: nome.trim(),
        data_nascimento: dataNasc,
        renda_mensal: rendaNum,
        telefone: telefone.replace(/\D/g, ''),
        profissao: profissao.trim(),
        parcela_alvo: calc.installmentValue,
        parcelas,
        valor_total: valorTotal,
      });
      setResult(data);
      setPhase('resultado');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      setError(e?.response?.data?.message || 'Erro ao consultar crédito');
      setPhase('cadastro');
    }
  };

  // Onda 12.2 — aplica o financiamento: aceita quote + gera boletos Asaas
  const apply = async () => {
    if (!result || result.status !== 'approved') return;
    setError(null);
    setPhase('gerando');
    try {
      const { data } = await api.post<ApplyFinancingResult>(
        `/quotes/${quoteId}/apply-financing`,
        {
          down_payment_value: calc.downPaymentValue,
          installment_count: parcelas,
          installment_value: calc.installmentValue,
          decision_id: result.decision_id,
          source: result.source,
        },
      );
      setApplyResult(data);
      setPhase('boletos');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      setError(
        e?.response?.data?.message ||
        'Erro ao gerar boletos. Verifique se o Asaas esta configurado.',
      );
      setPhase('resultado');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-xl max-w-lg w-full overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-4 border-b border-border bg-amber-500/5">
          <div>
            <h3 className="text-sm font-bold flex items-center gap-2">
              <Building2 size={14} className="text-amber-700" />
              Financiamento Banco PASSOS
            </h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              consulta de crédito em tempo real · aprovação imediata
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

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {phase === 'cadastro' && (
            <>
              {/* Resumo da proposta — Onda 12.1: parcela em destaque, total secundario */}
              <div className="bg-muted/30 border border-border/60 rounded-md p-3 mb-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                      proposta a financiar
                    </p>
                    <p className="text-2xl font-bold tabular-nums leading-tight">
                      {parcelas}x de R$ {fmtBRL(calc.installmentValue)}
                      <span className="text-xs font-normal text-muted-foreground"> /mês</span>
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      entrada R$ {fmtBRL(calc.downPaymentValue)} ·{' '}
                      <span className="opacity-75">total R$ {fmtBRL(valorTotal)}</span>
                    </p>
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    {([12, 18, 24] as const).map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setParcelas(n)}
                        className={`text-[11px] px-2 py-1 rounded-md border transition-colors ${
                          parcelas === n
                            ? 'border-amber-500 bg-amber-500/15 text-amber-800 font-semibold'
                            : 'border-border hover:bg-accent'
                        }`}
                      >
                        {n}x
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Form */}
              <div className="space-y-3">
                <Field label="CPF">
                  <input
                    type="text"
                    value={cpf}
                    onChange={(e) => setCpf(fmtCpf(e.target.value))}
                    placeholder="000.000.000-00"
                    inputMode="numeric"
                    className="w-full text-sm px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                  />
                </Field>
                <Field label="Nome completo">
                  <input
                    type="text"
                    value={nome}
                    onChange={(e) => setNome(e.target.value)}
                    placeholder="Como consta no CPF"
                    className="w-full text-sm px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Data de nascimento">
                    <input
                      type="date"
                      value={dataNasc}
                      onChange={(e) => setDataNasc(e.target.value)}
                      className="w-full text-sm px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                    />
                  </Field>
                  <Field label="Renda mensal (R$)">
                    <input
                      type="text"
                      value={renda ? `R$ ${(Number(renda) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : ''}
                      onChange={(e) => setRenda(fmtCurrency(e.target.value))}
                      placeholder="R$ 0,00"
                      inputMode="numeric"
                      className="w-full text-sm px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                    />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Telefone">
                    <input
                      type="text"
                      value={telefone}
                      onChange={(e) => setTelefone(fmtTel(e.target.value))}
                      placeholder="(00) 00000-0000"
                      inputMode="numeric"
                      className="w-full text-sm px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                    />
                  </Field>
                  <Field label="Profissão">
                    <input
                      type="text"
                      value={profissao}
                      onChange={(e) => setProfissao(e.target.value)}
                      placeholder="Ex: professor"
                      className="w-full text-sm px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                    />
                  </Field>
                </div>
                {error && (
                  <p className="text-[11px] text-red-700 bg-red-500/10 border border-red-500/30 rounded-md px-2.5 py-1.5">
                    {error}
                  </p>
                )}
                <p className="text-[10px] text-muted-foreground italic">
                  🔒 Os dados são enviados criptografados pra consulta na Serasa. Nada é salvo no sistema.
                </p>
              </div>
            </>
          )}

          {(phase === 'consultando' || phase === 'gerando') && (
            <div className="py-12 flex flex-col items-center justify-center text-center">
              <div className="w-16 h-16 rounded-full bg-amber-500/10 flex items-center justify-center mb-4">
                <Loader2 size={32} className="text-amber-600 animate-spin" />
              </div>
              <p className="text-sm font-semibold text-foreground mb-1">{loadingMsg}</p>
              <p className="text-[11px] text-muted-foreground">
                {phase === 'consultando' ? 'isso leva poucos segundos' : 'criando boletos no Asaas...'}
              </p>
            </div>
          )}

          {phase === 'resultado' && result && (
            <>
              <ResultPanel
                result={result}
                parcelas={parcelas}
                calc={calc}
                onApply={apply}
                onRetryWithMore={() => {
                  const next = parcelas === 12 ? 18 : parcelas === 18 ? 24 : 24;
                  setParcelas(next);
                  setResult(null);
                  setPhase('cadastro');
                }}
              />
              {error && (
                <p className="mt-3 text-[11px] text-red-700 bg-red-500/10 border border-red-500/30 rounded-md px-2.5 py-1.5">
                  {error}
                </p>
              )}
            </>
          )}

          {phase === 'boletos' && applyResult && (
            <BoletosResultPanel
              data={applyResult}
              parcelas={parcelas}
              onClose={() => {
                onAppliedSuccess(`parcelado-${parcelas}x`);
                onCancel();
              }}
            />
          )}
        </div>

        {/* Footer */}
        {phase === 'cadastro' && (
          <div className="p-3 border-t border-border flex items-center justify-end gap-2 bg-muted/20">
            <button
              type="button"
              onClick={onCancel}
              className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-accent"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              className="text-xs px-4 py-1.5 rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              <Search size={12} />
              Consultar aprovação
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[11px] font-semibold text-foreground block mb-1">{label}</label>
      {children}
    </div>
  );
}

/** Onda 12.1 — Selo da fonte da decisao + sumario Asaas (quando ha) */
function SourceBadge({ result }: { result: CreditCheckResult }) {
  const source = result.source || 'internal';
  if (source === 'serasa') {
    return (
      <div className="inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-700 border border-blue-500/30 mb-3">
        <ShieldCheck size={10} />
        Validado por Serasa Crediscore
      </div>
    );
  }
  if (source === 'asaas_history' && result.asaas_summary?.is_recurring) {
    const rate = result.asaas_summary.on_time_rate;
    const count = result.asaas_summary.charges_count ?? 0;
    return (
      <div className="inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-700 border border-blue-500/30 mb-3">
        <ShieldCheck size={10} />
        Cliente recorrente · {count} cobrança{count === 1 ? '' : 's'}
        {rate !== undefined && ` · ${Math.round(rate * 100)}% em dia`}
      </div>
    );
  }
  return (
    <div className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground italic mb-3">
      análise interna · paciente novo (sem histórico)
    </div>
  );
}

function ResultPanel({
  result,
  parcelas,
  calc,
  onApply,
  onRetryWithMore,
}: {
  result: CreditCheckResult;
  parcelas: number;
  calc: ReturnType<typeof applyPaymentOption>;
  onApply: () => void;
  onRetryWithMore: () => void;
}) {
  if (result.status === 'approved') {
    return (
      <div className="text-center">
        <div className="w-16 h-16 rounded-full bg-emerald-500/15 flex items-center justify-center mx-auto mb-3">
          <ShieldCheck size={32} className="text-emerald-700" />
        </div>
        <p className="text-base font-bold text-emerald-700 mb-1">{result.message}</p>
        <SourceBadge result={result} />
        <p className="text-[11px] text-muted-foreground mb-4">
          decisão {result.decision_id} · comprometimento {Math.round(100 / result.ratio)}% da renda
        </p>
        <div className="bg-emerald-500/5 border border-emerald-500/30 rounded-md p-3 text-left space-y-1.5 mb-4">
          <p className="text-[10px] uppercase tracking-wide text-emerald-700 font-bold">
            condições liberadas
          </p>
          <p className="text-sm font-bold">
            {parcelas}x · entrada R$ {fmtBRL(calc.downPaymentValue)} + R$ {fmtBRL(calc.installmentValue)}/mês
          </p>
          <p className="text-[11px] text-muted-foreground">
            total R$ {fmtBRL(calc.finalValue)} · juros {result.conditions?.juros_mes}%/mês
          </p>
        </div>
        <button
          type="button"
          onClick={onApply}
          className="w-full text-sm font-semibold px-4 py-2.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 flex items-center justify-center gap-2"
        >
          <Check size={14} />
          Aplicar essa proposta
        </button>
      </div>
    );
  }

  if (result.status === 'pending') {
    return (
      <div className="text-center">
        <div className="w-16 h-16 rounded-full bg-amber-500/15 flex items-center justify-center mx-auto mb-3">
          <AlertTriangle size={32} className="text-amber-700" />
        </div>
        <p className="text-base font-bold text-amber-800 mb-1">{result.message}</p>
        <SourceBadge result={result} />
        <p className="text-[11px] text-muted-foreground mb-4">
          decisão {result.decision_id} · comprometimento {Math.round(100 / result.ratio)}% da renda
        </p>
        <div className="bg-amber-500/5 border border-amber-500/30 rounded-md p-3 text-left space-y-1.5 mb-3">
          <p className="text-[11px] text-foreground">
            <strong>Motivo:</strong> {result.motivo}
          </p>
          {result.suggestion && (
            <p className="text-[11px] text-muted-foreground">
              💡 {result.suggestion}
            </p>
          )}
        </div>
      </div>
    );
  }

  // denied
  return (
    <div className="text-center">
      <div className="w-16 h-16 rounded-full bg-red-500/15 flex items-center justify-center mx-auto mb-3">
        <XCircle size={32} className="text-red-700" />
      </div>
      <p className="text-base font-bold text-red-800 mb-1">{result.message}</p>
      <SourceBadge result={result} />
      <p className="text-[11px] text-muted-foreground mb-4">
        decisão {result.decision_id} · comprometimento {Math.round(100 / result.ratio)}% da renda
      </p>
      <div className="bg-red-500/5 border border-red-500/30 rounded-md p-3 text-left space-y-1.5 mb-3">
        <p className="text-[11px] text-foreground">
          <strong>Motivo:</strong> {result.motivo}
        </p>
        {result.suggestion && (
          <p className="text-[11px] text-muted-foreground">
            💡 {result.suggestion}
          </p>
        )}
      </div>
      {parcelas < 24 && (
        <button
          type="button"
          onClick={onRetryWithMore}
          className="text-xs font-semibold px-3 py-2 rounded-lg border border-amber-500 text-amber-700 hover:bg-amber-500/10 inline-flex items-center gap-1.5"
        >
          Tentar com prazo maior
        </button>
      )}
    </div>
  );
}

/** Onda 12.2 — Painel mostrando os boletos gerados (entrada + parcelado).
 *  Aparece apos o "Aplicar essa proposta" completar com sucesso. */
function BoletosResultPanel({
  data,
  parcelas,
  onClose,
}: {
  data: ApplyFinancingResult;
  parcelas: number;
  onClose: () => void;
}) {
  const entrada = data.charges.find((c) => c.kind === 'entrada');
  const parcelado = data.charges.find((c) => c.kind === 'parcelado');
  return (
    <div className="text-center">
      <div className="w-16 h-16 rounded-full bg-emerald-500/15 flex items-center justify-center mx-auto mb-3">
        <ShieldCheck size={32} className="text-emerald-700" />
      </div>
      <p className="text-base font-bold text-emerald-700 mb-1">
        Boletos gerados com sucesso!
      </p>
      <p className="text-[11px] text-muted-foreground mb-4">
        plano ativado · total financiado R$ {fmtBRL(data.total_financed)}
      </p>

      <div className="space-y-2 text-left mb-4">
        {entrada && (
          <BoletoRow
            label="Entrada"
            sublabel={`1 boleto · vence ${new Date(entrada.due_date).toLocaleDateString('pt-BR')}`}
            amount={entrada.amount}
            url={entrada.boleto_url}
            barcode={entrada.barcode}
            tone="emerald"
          />
        )}
        {parcelado && (
          <BoletoRow
            label={`${parcelas}x parceladas`}
            sublabel={`${parcelas} boletos · primeiro vence ${new Date(parcelado.due_date).toLocaleDateString('pt-BR')}`}
            amount={parcelado.amount}
            url={parcelado.boleto_url}
            barcode={parcelado.barcode}
            tone="amber"
            installmentInfo={
              parcelado.installment_count && parcelado.installment_value
                ? `${parcelado.installment_count}x R$ ${fmtBRL(parcelado.installment_value)}`
                : undefined
            }
          />
        )}
      </div>

      <p className="text-[11px] text-muted-foreground italic mb-3">
        🔔 O Asaas vai enviar os boletos por email/WhatsApp pro paciente automaticamente.
      </p>

      <button
        type="button"
        onClick={onClose}
        className="w-full text-sm font-semibold px-4 py-2.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 flex items-center justify-center gap-2"
      >
        <Check size={14} />
        Concluir
      </button>
    </div>
  );
}

function BoletoRow({
  label,
  sublabel,
  amount,
  url,
  barcode,
  tone,
  installmentInfo,
}: {
  label: string;
  sublabel: string;
  amount: number;
  url: string | null;
  barcode: string | null;
  tone: 'emerald' | 'amber';
  installmentInfo?: string;
}) {
  const borderCls = tone === 'emerald' ? 'border-emerald-500/30' : 'border-amber-500/30';
  const bgCls = tone === 'emerald' ? 'bg-emerald-500/5' : 'bg-amber-500/5';
  const textCls = tone === 'emerald' ? 'text-emerald-700' : 'text-amber-700';
  return (
    <div className={`p-3 rounded-md border ${borderCls} ${bgCls}`}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="min-w-0">
          <p className={`text-xs font-bold ${textCls}`}>{label}</p>
          <p className="text-[10px] text-muted-foreground">{sublabel}</p>
        </div>
        <p className="text-sm font-bold tabular-nums shrink-0">
          R$ {fmtBRL(amount)}
        </p>
      </div>
      {installmentInfo && (
        <p className="text-[10px] text-muted-foreground mb-1">
          {installmentInfo}
        </p>
      )}
      <div className="flex items-center gap-2 mt-2">
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className={`text-[11px] font-semibold px-2.5 py-1 rounded-md border ${borderCls} ${textCls} hover:bg-white inline-flex items-center gap-1`}
          >
            <Send size={10} />
            Abrir boleto
          </a>
        ) : (
          <span className="text-[10px] text-muted-foreground italic">
            URL do boleto será disponibilizada em alguns segundos
          </span>
        )}
        {barcode && (
          <button
            type="button"
            onClick={() => navigator.clipboard?.writeText(barcode)}
            className="text-[10px] text-muted-foreground hover:text-foreground font-mono truncate"
            title="Clique pra copiar"
          >
            {barcode.slice(0, 20)}...
          </button>
        )}
      </div>
    </div>
  );
}
