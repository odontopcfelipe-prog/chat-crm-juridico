'use client';

/**
 * FinanceiroTab — Onda 3.23.
 *
 * Aba "Financeiro" da ficha do paciente. Mostra:
 *  - Resumo: total contratado, pago, em aberto, atrasado
 *  - Lista de parcelas (Installment) ligadas a orcamentos ACEITOS,
 *    com status (ABERTA/PAGA/PARCIAL/ATRASADA/CANCELADA/RENEGOCIADA).
 *  - Acoes rapidas: marcar como paga, abrir parcela na pagina financeira
 *    global pra detalhe completo.
 *
 * Endpoint: GET /installments?patient_id=X
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Loader2, DollarSign, Check, AlertTriangle, Clock, CreditCard, ExternalLink,
  Receipt, Send, Building2, Copy,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
// Onda 14.18 — identificador unificado entre as 4 abas
import { getQuoteDisplayName, getQuoteNumberBadge } from '@/lib/quote-display';

interface Props {
  patientId: string;
}

/** Onda 14.12 — proposta aceita do paciente (Quote.status=ACCEPTED) */
interface AcceptedQuote {
  id: string;
  status: string;
  title: string | null;
  /** Onda 14.18 — numero sequencial global por tenant. Identificador unificado
   *  entre as 4 abas (Avaliacao/Orcamentos/Propostas/Financeiro). */
  quote_number?: number;
  total_value: string | number;
  created_at: string;
  accepted_at: string | null;
  closing_category?: string | null;
  _count?: { items: number };
  approved_count?: number;
  pending_count?: number;
  priority?: 'COMPLETO' | 'ESSENCIAL' | 'URGENTE' | null;
}

/** Onda 14.9 — cobrancas Asaas geradas pro paciente (PaymentGatewayCharge) */
interface Charge {
  id: string;
  external_id: string;
  billing_type: 'PIX' | 'BOLETO' | 'CREDIT_CARD' | string;
  amount: string | number;
  net_value?: string | number | null;
  due_date: string;
  paid_at?: string | null;
  status: string; // PENDING|RECEIVED|CONFIRMED|OVERDUE|REFUNDED|DELETED
  description: string | null;
  boleto_url?: string | null;
  boleto_barcode?: string | null;
  invoice_url?: string | null;
  pix_qr_code?: string | null;
  pix_copy_paste?: string | null;
  created_at: string;
}

interface Installment {
  id: string;
  quote_id: string | null;
  sequence: number;
  total_count: number;
  amount: string | number;
  amount_paid: string | number;
  discount_value: string | number;
  fee_value: string | number;
  due_date: string;
  paid_at: string | null;
  payment_method: string | null;
  status: 'ABERTA' | 'PAGA' | 'PARCIAL' | 'ATRASADA' | 'CANCELADA' | 'RENEGOCIADA';
  notes: string | null;
}

const STATUS_LABEL: Record<Installment['status'], string> = {
  ABERTA: 'Em aberto',
  PAGA: 'Paga',
  PARCIAL: 'Parcial',
  ATRASADA: 'Atrasada',
  CANCELADA: 'Cancelada',
  RENEGOCIADA: 'Renegociada',
};

const STATUS_CLS: Record<Installment['status'], string> = {
  ABERTA:      'bg-blue-500/10 text-blue-700 border-blue-500/20',
  PAGA:        'bg-emerald-500/10 text-emerald-700 border-emerald-500/20',
  PARCIAL:     'bg-amber-500/10 text-amber-700 border-amber-500/20',
  ATRASADA:    'bg-red-500/10 text-red-700 border-red-500/20',
  CANCELADA:   'bg-muted text-muted-foreground border-border',
  RENEGOCIADA: 'bg-purple-500/10 text-purple-700 border-purple-500/20',
};

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  PIX: 'PIX',
  BOLETO: 'Boleto',
  CARTAO: 'Cartão',
  DINHEIRO: 'Dinheiro',
  TRANSFERENCIA: 'Transferência',
  MAQUININHA: 'Maquininha',
};

const fmtBRL = (v: string | number) =>
  Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const fmtDate = (iso: string | null) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('pt-BR');
};

export default function FinanceiroTab({ patientId }: Props) {
  const [installments, setInstallments] = useState<Installment[]>([]);
  // Onda 14.9 — cobrancas Asaas geradas pelo approveAndBill
  const [charges, setCharges] = useState<Charge[]>([]);
  // Onda 14.12 — propostas aceitas (Quote.status=ACCEPTED)
  const [acceptedQuotes, setAcceptedQuotes] = useState<AcceptedQuote[]>([]);
  // Onda 14.13 — quote aberto no modal de detalhe
  const [detailQuoteId, setDetailQuoteId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Carrega parcelas, charges e quotes aceitos em paralelo
      const [instResp, chargesResp, quotesResp] = await Promise.allSettled([
        api.get<{ data: Installment[] } | Installment[]>(
          `/installments?patient_id=${patientId}&limit=200`,
        ),
        api.get<Charge[]>(`/payment-gateway/patients/${patientId}/charges`),
        api.get<AcceptedQuote[]>(`/patients/${patientId}/quotes`),
      ]);

      if (instResp.status === 'fulfilled') {
        const data = instResp.value.data;
        const list = Array.isArray(data) ? data : data?.data || [];
        setInstallments(list);
      }
      if (chargesResp.status === 'fulfilled') {
        setCharges(chargesResp.value.data || []);
      }
      if (quotesResp.status === 'fulfilled') {
        // Filtra so ACCEPTED
        const accepted = (quotesResp.value.data || []).filter(
          (q) => q.status === 'ACCEPTED',
        );
        setAcceptedQuotes(accepted);
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao carregar financeiro');
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => { load(); }, [load]);

  // Onda 14.15 — Polling a cada 30s pra atualizar status em tempo real
  // (charges atualizadas pelo webhook do Asaas). Reload silencioso (sem
  // mostrar spinner) pra nao incomodar o operador.
  useEffect(() => {
    const id = setInterval(() => {
      // Reload silencioso: nao mexe em `loading` state
      api.get<Charge[]>(`/payment-gateway/patients/${patientId}/charges`)
        .then(({ data }) => setCharges(data || []))
        .catch(() => { /* silencia */ });
      api.get<{ data: Installment[] } | Installment[]>(
        `/installments?patient_id=${patientId}&limit=200`,
      )
        .then(({ data }) => {
          const list = Array.isArray(data) ? data : data?.data || [];
          setInstallments(list);
        })
        .catch(() => { /* silencia */ });
    }, 30_000);
    return () => clearInterval(id);
  }, [patientId]);

  // Onda 14.15 — Resumo agrega installments + charges + accepted quotes.
  //   Total contratado = soma dos quotes ACCEPTED (ou installments se nao ha quotes)
  //   Já recebido     = installments PAGAS + charges RECEIVED/CONFIRMED
  //   Em aberto       = installments ABERTA/PARCIAL + charges PENDING
  //   Atrasado        = installments ATRASADA + charges OVERDUE
  const summary = useMemo(() => {
    let total = 0;
    let paid = 0;
    let pending = 0;
    let overdue = 0;

    // 1. Total contratado: prioriza quotes ACCEPTED (visão de negocio).
    //    Se nao ha quotes (orcamentos antigos via Installments), cai pra installments.
    if (acceptedQuotes.length > 0) {
      for (const q of acceptedQuotes) {
        total += Number(q.total_value);
      }
    } else {
      for (const it of installments) {
        total += Number(it.amount);
      }
    }

    // 2. Installments (fluxo antigo de parcelas odontologicas)
    for (const it of installments) {
      const amt = Number(it.amount);
      const amtPaid = Number(it.amount_paid);
      if (it.status === 'PAGA' || it.status === 'PARCIAL') {
        paid += amtPaid;
      }
      if (it.status === 'ABERTA' || it.status === 'PARCIAL') {
        pending += Math.max(amt - amtPaid, 0);
      }
      if (it.status === 'ATRASADA') {
        overdue += Math.max(amt - amtPaid, 0);
      }
    }

    // 3. Charges Asaas (fluxo novo via approveAndBill)
    //    Status sincronizado pelo webhook (PaymentGatewayCharge.status)
    for (const c of charges) {
      const amt = Number(c.amount);
      if (c.status === 'RECEIVED' || c.status === 'CONFIRMED') {
        paid += amt;
      } else if (c.status === 'OVERDUE') {
        overdue += amt;
      } else if (c.status === 'PENDING') {
        pending += amt;
      }
      // DELETED/REFUNDED nao contam (canceladas/estornadas)
    }
    return { total, paid, pending, overdue };
  }, [installments, charges, acceptedQuotes]);

  const markPaid = async (id: string) => {
    if (!confirm('Marcar parcela como PAGA hoje?')) return;
    setPaying(id);
    try {
      await api.post(`/installments/${id}/pay`, {
        paid_at: new Date().toISOString(),
      });
      showSuccess('Parcela marcada como paga');
      await load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao baixar parcela');
    } finally {
      setPaying(null);
    }
  };

  if (loading) {
    return (
      <div className="py-12 flex items-center justify-center text-muted-foreground">
        <Loader2 size={18} className="animate-spin mr-2" /> Carregando parcelas...
      </div>
    );
  }

  if (installments.length === 0 && charges.length === 0 && acceptedQuotes.length === 0) {
    return (
      <div className="bg-card border border-border border-dashed rounded-xl p-10 text-center">
        <DollarSign size={32} className="mx-auto text-muted-foreground/60 mb-3" />
        <p className="text-sm font-medium text-foreground mb-1">
          Sem movimentação financeira
        </p>
        <p className="text-xs text-muted-foreground max-w-md mx-auto">
          Quando um orçamento for aceito ou uma cobrança for gerada (PIX, boleto,
          cartão), as movimentações aparecem aqui com status de pagamento, datas
          e ações rápidas.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Onda 14.15 — Header com indicador de sincronizacao */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-[10px] text-muted-foreground italic flex items-center gap-1.5">
          <Clock size={10} />
          Atualiza automaticamente a cada 30s · webhook Asaas em tempo real
        </p>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="text-[10px] text-primary hover:underline disabled:opacity-50"
          title="Atualizar agora"
        >
          {loading ? <Loader2 size={11} className="animate-spin inline" /> : '↻ Atualizar agora'}
        </button>
      </div>

      {/* Resumo financeiro do paciente */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard
          label="Total contratado"
          value={fmtBRL(summary.total)}
          icon={<DollarSign size={14} className="text-muted-foreground" />}
        />
        <SummaryCard
          label="Já recebido"
          value={fmtBRL(summary.paid)}
          icon={<Check size={14} className="text-emerald-600" />}
          highlight="emerald"
        />
        <SummaryCard
          label="Em aberto"
          value={fmtBRL(summary.pending)}
          icon={<Clock size={14} className="text-blue-600" />}
          highlight="blue"
        />
        <SummaryCard
          label="Atrasado"
          value={fmtBRL(summary.overdue)}
          icon={<AlertTriangle size={14} className="text-red-600" />}
          highlight={summary.overdue > 0 ? 'red' : undefined}
        />
      </div>

      {/* Onda 14.16 — Cards expansíveis por proposta aceita.
          Substitui as 2 seções separadas (Aprovados + Cobranças geradas)
          por 1 card rico por proposta com tudo dentro (mini-cards de
          status, barra de progresso, lista de parcelas com pagamentos).
          Status atualizado em tempo real pelo webhook Asaas + polling 30s. */}
      {acceptedQuotes.length > 0 && (
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-foreground mb-2">
            Propostas aceitas
          </p>
          <div className="space-y-3">
            {acceptedQuotes.map((q, idx) => (
              <ProposalFinancialCard
                key={q.id}
                index={idx + 1}
                quote={q}
                allCharges={charges}
                patientId={patientId}
                onOpenDetail={() => setDetailQuoteId(q.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Onda 14.13 — Modal de detalhe da proposta aceita (fallback) */}
      {detailQuoteId && (
        <ProposalDetailModal
          quoteId={detailQuoteId}
          patientId={patientId}
          allCharges={charges}
          onClose={() => setDetailQuoteId(null)}
        />
      )}

      {/* Onda 14.9 — Cobranças "órfãs" (sem quote aceito vinculado).
          Caso raro mas mantém — ex: charges legadas via Installment. */}
      {charges.length > 0 && acceptedQuotes.length === 0 && (
        <ChargesSection charges={charges} />
      )}

      {/* Lista de parcelas — so renderiza se ha installments. Onda 14.9 */}
      {installments.length > 0 && (
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <p className="text-sm font-semibold">Parcelas</p>
          <span className="text-xs text-muted-foreground">
            {installments.length} {installments.length === 1 ? 'parcela' : 'parcelas'}
          </span>
        </div>
        <ul className="divide-y divide-border">
          {installments.map((it) => {
            const overdueDays = it.status === 'ATRASADA' && it.due_date
              ? Math.floor((Date.now() - new Date(it.due_date).getTime()) / (1000 * 60 * 60 * 24))
              : 0;
            return (
              <li key={it.id} className="px-4 py-3 flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-[200px]">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold">
                      Parcela {it.sequence}/{it.total_count}
                    </span>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${STATUS_CLS[it.status]}`}>
                      {STATUS_LABEL[it.status]}
                    </span>
                    {it.payment_method && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground inline-flex items-center gap-1">
                        <CreditCard size={9} />
                        {PAYMENT_METHOD_LABEL[it.payment_method] || it.payment_method}
                      </span>
                    )}
                    {overdueDays > 0 && (
                      <span className="text-[10px] text-red-600 font-medium">
                        atrasada há {overdueDays} {overdueDays === 1 ? 'dia' : 'dias'}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Vencimento: {fmtDate(it.due_date)}
                    {it.paid_at && ` · Pago em: ${fmtDate(it.paid_at)}`}
                  </p>
                </div>
                <div className="text-right min-w-[120px]">
                  <p className="text-sm font-bold">{fmtBRL(it.amount)}</p>
                  {Number(it.amount_paid) > 0 && Number(it.amount_paid) < Number(it.amount) && (
                    <p className="text-[10px] text-emerald-600">
                      pago {fmtBRL(it.amount_paid)}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {it.status !== 'PAGA' && it.status !== 'CANCELADA' && it.status !== 'RENEGOCIADA' && (
                    <button
                      type="button"
                      onClick={() => markPaid(it.id)}
                      disabled={paying === it.id}
                      className="text-xs inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                      title="Marcar como paga (data = hoje)"
                    >
                      {paying === it.id ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                      Baixar
                    </button>
                  )}
                  <a
                    href={`/atendimento/financeiro/parcelas?id=${it.id}`}
                    className="p-1.5 rounded text-muted-foreground hover:text-primary hover:bg-primary/10"
                    title="Abrir parcela na aba financeira global"
                  >
                    <ExternalLink size={12} />
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      )}
    </div>
  );
}

/** Onda 14.12 — Seção "APROVADOS" mostra Quote.status=ACCEPTED.
 *  Onda 14.13 — Click no card abre modal de detalhe (não navega mais). */
function AcceptedQuotesSection({
  quotes,
  patientId: _patientId,
  allCharges,
  onOpenDetail,
}: {
  quotes: AcceptedQuote[];
  patientId: string;
  allCharges: Charge[];
  onOpenDetail: (quoteId: string) => void;
}) {
  const CATEGORY_LABEL: Record<string, string> = {
    OUTROS: 'OUTROS',
    FACETAS: 'FACETAS',
    LENTES: 'LENTES',
    IMPLANTES: 'IMPLANTES',
    ORTODONTIA: 'ORTODONTIA',
    PROTESES: 'PRÓTESES',
    HARMONIZACAO: 'HARMONIZAÇÃO',
  };

  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-wide text-foreground mb-2">
        Aprovados
      </p>
      <ul className="space-y-2">
        {quotes.map((q, idx) => {
          const category = q.closing_category || 'OUTROS';
          const categoryLabel = CATEGORY_LABEL[category] || category;
          const value = Number(q.total_value);
          // Onda 14.13 — quantas cobrancas vinculadas a esse quote (via description)
          const relatedChargesCount = allCharges.filter((c) =>
            c.description?.includes(`quote:${q.id}`) ||
            c.description?.toLowerCase().includes(q.title?.toLowerCase() || '__nomatch__')
          ).length;
          return (
            <li key={q.id}>
              <button
                type="button"
                onClick={() => onOpenDetail(q.id)}
                className="block w-full bg-emerald-500/5 border border-emerald-500/30 rounded-lg px-4 py-3 hover:bg-emerald-500/10 transition-colors text-left"
              >
                <div className="flex items-center gap-3 flex-wrap">
                  {/* Onda 14.18 — numero global do orcamento (#NNN) substitui o
                      indice local da lista. Identifica o mesmo orcamento em
                      todas as abas (Avaliacao/Orcamentos/Propostas/Financeiro). */}
                  <span
                    className="text-xs font-mono font-semibold text-primary"
                    title="Numero do orcamento (global da clinica)"
                  >
                    {getQuoteNumberBadge(q) || `#${idx + 1}`}
                  </span>
                  <span className="text-sm font-bold text-foreground truncate">
                    {getQuoteDisplayName(q)}
                  </span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-700 font-semibold inline-flex items-center gap-1">
                    <Check size={9} strokeWidth={3} />
                    ACEITO
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase font-medium">
                    {categoryLabel}
                  </span>
                  {relatedChargesCount > 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      ({relatedChargesCount} cobr.)
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-3">
                    <span className="text-sm font-bold text-foreground tabular-nums">
                      {fmtBRL(value)}
                    </span>
                    {q.accepted_at && (
                      <span className="text-[10px] text-muted-foreground">
                        aceito em {fmtDate(q.accepted_at)}
                      </span>
                    )}
                    <span className="text-muted-foreground">›</span>
                  </span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Onda 14.9 — Seção "Cobranças geradas" mostra PaymentGatewayCharges do
 *  paciente. Atualizado em tempo real pelo webhook Asaas. */
// ─── Onda 14.16 — Card rico por proposta aceita ───────────────────
//
// Header colapsado: titulo + badge status + valor + % pago + chevron
// Expandido: 4 mini-cards de resumo + barra de progresso + lista de
// parcelas (combina charges 1x + sub_installments de charges parceladas).
// Status atualizado em tempo real (charges vem do banco, atualizado
// pelo webhook Asaas; sub_installments puxado do Asaas sob demanda).

interface ParcelaItem {
  number: number;
  totalCount: number;
  method: 'PIX' | 'BOLETO' | 'CREDIT_CARD' | string;
  status: string; // RECEIVED|CONFIRMED|PENDING|OVERDUE|DELETED|REFUNDED
  value: number;
  dueDate: string;
  paymentDate: string | null;
  boletoUrl: string | null;
  invoiceUrl: string | null;
  isNext: boolean; // primeira não-paga
}

function ProposalFinancialCard({
  index,
  quote,
  allCharges,
  patientId,
  onOpenDetail,
}: {
  index: number;
  quote: AcceptedQuote;
  allCharges: Charge[];
  patientId: string;
  onOpenDetail: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [subInstallmentsByCharge, setSubInstallmentsByCharge] = useState<
    Record<string, SubInstallment[]>
  >({});
  const [loadingSubs, setLoadingSubs] = useState(false);

  // Charges DESTA proposta (filtra via description: 'plan:{planId}').
  // Como `acceptedQuotes` não retorna treatment_plan direto, uso heurística:
  // 1. Tenta match exato pelo título do quote
  // 2. Fallback: charges sem dono claro
  // Esse filtro real será feito quando expandir (busca quote completo + plan_id).
  const initialRelatedCharges = useMemo(() => {
    // Mostra apenas charges que mencionem o titulo OU sem associação clara
    if (!quote.title) return allCharges;
    return allCharges.filter((c) =>
      c.description?.toLowerCase().includes(quote.title?.toLowerCase() || ''),
    );
  }, [allCharges, quote.title]);

  // Quando expande, carrega quote completo (pra ter plan_id) e sub_installments
  const [planId, setPlanId] = useState<string | null>(null);
  const [loadingQuoteDetail, setLoadingQuoteDetail] = useState(false);

  // Onda 14.17 — pré-carrega planId no mount (não só ao expandir) pra
  // calcular a barra de progresso e o agregado no header colapsado.
  useEffect(() => {
    if (planId) return;
    setLoadingQuoteDetail(true);
    api.get<{ treatment_plan?: { id: string } | null }>(`/quotes/${quote.id}`)
      .then(({ data }) => {
        setPlanId(data.treatment_plan?.id || null);
      })
      .catch(() => { /* silencia */ })
      .finally(() => setLoadingQuoteDetail(false));
  }, [planId, quote.id]);

  // Charges filtradas pelo planId real (depois de carregado)
  const relatedCharges = useMemo(() => {
    if (!planId) return initialRelatedCharges;
    return allCharges.filter((c) =>
      c.description?.includes(`plan:${planId}`),
    );
  }, [allCharges, planId, initialRelatedCharges]);

  // Onda 14.17 — pré-carrega sub_installments no mount (não só ao expandir)
  // pra calcular barra de progresso + agregado no header colapsado.
  useEffect(() => {
    if (relatedCharges.length === 0) return;
    setLoadingSubs(true);
    const fetchAll = async () => {
      const results: Record<string, SubInstallment[]> = {};
      for (const c of relatedCharges) {
        if (subInstallmentsByCharge[c.id] !== undefined) {
          results[c.id] = subInstallmentsByCharge[c.id];
          continue;
        }
        try {
          const { data } = await api.get<{ sub_installments: SubInstallment[] }>(
            `/payment-gateway/charges/${c.id}/sub-installments`,
          );
          results[c.id] = data.sub_installments || [];
        } catch {
          results[c.id] = [];
        }
      }
      setSubInstallmentsByCharge((prev) => ({ ...prev, ...results }));
      setLoadingSubs(false);
    };
    fetchAll();
  }, [relatedCharges, subInstallmentsByCharge]);

  // Constrói lista de parcelas (combinando charges 1x + sub_installments de parcelas)
  const parcelas: ParcelaItem[] = useMemo(() => {
    const list: ParcelaItem[] = [];
    for (const c of relatedCharges) {
      const subs = subInstallmentsByCharge[c.id];
      if (subs && subs.length > 0) {
        // Parcelada: usa as filhas
        for (const s of subs) {
          list.push({
            number: s.installment_number,
            totalCount: subs.length,
            method: c.billing_type,
            status: s.status,
            value: s.value,
            dueDate: s.due_date,
            paymentDate: s.payment_date,
            boletoUrl: s.boleto_url,
            invoiceUrl: s.invoice_url,
            isNext: false,
          });
        }
      } else {
        // 1x (cobrança única)
        list.push({
          number: 1,
          totalCount: 1,
          method: c.billing_type,
          status: c.status,
          value: Number(c.amount),
          dueDate: c.due_date,
          paymentDate: c.paid_at || null,
          boletoUrl: c.boleto_url || null,
          invoiceUrl: c.invoice_url || null,
          isNext: false,
        });
      }
    }
    // Marca a primeira não-paga como "próxima"
    const firstUnpaidIdx = list.findIndex(
      (p) => p.status !== 'RECEIVED' && p.status !== 'CONFIRMED'
        && p.status !== 'DELETED' && p.status !== 'REFUNDED',
    );
    if (firstUnpaidIdx >= 0) list[firstUnpaidIdx].isNext = true;
    return list;
  }, [relatedCharges, subInstallmentsByCharge]);

  // Agrega valores
  const agg = useMemo(() => {
    const contratado = Number(quote.total_value);
    let recebido = 0;
    let emAberto = 0;
    let aVencer = 0;
    const now = Date.now();
    for (const p of parcelas) {
      const paid = p.status === 'RECEIVED' || p.status === 'CONFIRMED';
      const cancelled = p.status === 'DELETED' || p.status === 'REFUNDED';
      if (cancelled) continue;
      if (paid) {
        recebido += p.value;
      } else {
        const dueMs = p.dueDate ? new Date(p.dueDate).getTime() : 0;
        if (dueMs && dueMs <= now + 7 * 86400000) {
          emAberto += p.value; // vencendo nos próximos 7 dias ou vencida
        } else {
          aVencer += p.value;
        }
      }
    }
    const pagasCount = parcelas.filter(
      (p) => p.status === 'RECEIVED' || p.status === 'CONFIRMED',
    ).length;
    const pct = contratado > 0 ? Math.round((recebido / contratado) * 100) : 0;
    return { contratado, recebido, emAberto, aVencer, pagasCount, totalCount: parcelas.length, pct };
  }, [parcelas, quote.total_value]);

  // Status badge no header
  let statusBadge = { label: 'Aguardando pagamento', cls: 'bg-blue-500/15 text-blue-700' };
  if (agg.totalCount === 0) {
    statusBadge = { label: 'Sem cobrança gerada', cls: 'bg-amber-500/15 text-amber-700' };
  } else if (agg.recebido >= agg.contratado && agg.contratado > 0) {
    statusBadge = { label: 'Pago integral', cls: 'bg-emerald-500/15 text-emerald-700' };
  } else if (agg.recebido > 0) {
    statusBadge = { label: 'Em pagamento', cls: 'bg-amber-500/15 text-amber-700' };
  }

  // Onda 14.17 — proxima parcela pendente (pra mostrar "próx. vence DD/MM")
  const nextParcela = useMemo(
    () => parcelas.find((p) => p.isNext),
    [parcelas],
  );

  const subtitle = (() => {
    if (agg.totalCount === 0) return 'sem cobrança gerada ainda';
    if (agg.totalCount === 1) return `pagamento à vista (${agg.pagasCount === 1 ? 'pago' : 'pendente'})`;
    return `parcelado em ${agg.totalCount}× · ${agg.pagasCount} de ${agg.totalCount} pagas`;
  })();

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      {/* Header — sempre visível. Onda 14.17: barra de progresso colapsada. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-4 py-3 hover:bg-accent/30 transition-colors text-left"
      >
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            {/* Onda 14.18 — identificador unificado (#NNN). Fallback pra
                indice local quando legado sem quote_number. */}
            <span
              className="text-xs font-mono font-semibold text-primary mt-0.5"
              title="Numero do orcamento (global da clinica)"
            >
              {getQuoteNumberBadge(quote) || `#${index}`}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-bold text-foreground">
                  {getQuoteDisplayName(quote)}
                </span>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${statusBadge.cls}`}>
                  {statusBadge.label}
                </span>
              </div>
              {/* Onda 14.17 — Barra de progresso compacta no header (sempre visível) */}
              {agg.contratado > 0 && (
                <div className="mt-2 mb-1 max-w-md">
                  <div className="w-full bg-muted h-1.5 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-emerald-500 to-emerald-600 transition-all"
                      style={{ width: `${Math.min(agg.pct, 100)}%` }}
                    />
                  </div>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">
                {agg.totalCount === 0
                  ? `Aceito em ${fmtDate(quote.accepted_at || quote.created_at)} · ${subtitle}`
                  : (
                    <>
                      <span className="tabular-nums">
                        {fmtBRL(agg.recebido)} / {fmtBRL(agg.contratado)}
                      </span>
                      {nextParcela && (
                        <> · próx. vence {fmtDate(nextParcela.dueDate).slice(0, 5)}</>
                      )}
                      {agg.pct >= 100 && <> · ✓ quitado</>}
                    </>
                  )}
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-sm font-bold tabular-nums">
              {fmtBRL(agg.contratado)}
            </p>
            {agg.pct > 0 && (
              <p className="text-[10px] text-emerald-700 font-semibold">
                {agg.pct}% pago
              </p>
            )}
          </div>
          <span className="text-muted-foreground self-center">
            {expanded ? '▴' : '▾'}
          </span>
        </div>
      </button>

      {/* Body expansível */}
      {expanded && (
        <div className="border-t border-border p-4 space-y-4 bg-muted/10">
          {/* Mini-cards de resumo */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <MiniSummary label="Contratado" value={fmtBRL(agg.contratado)} />
            <MiniSummary label="Recebido" value={fmtBRL(agg.recebido)} tone="emerald" />
            <MiniSummary label="Em aberto" value={fmtBRL(agg.emAberto)} tone="blue" />
            <MiniSummary label="A vencer" value={fmtBRL(agg.aVencer)} />
          </div>

          {/* Barra de progresso */}
          {agg.contratado > 0 && (
            <div>
              <div className="flex items-center justify-between text-[11px] mb-1">
                <span className="text-muted-foreground">Recebimento</span>
                <span className="text-foreground font-semibold tabular-nums">
                  {fmtBRL(agg.recebido)} / {fmtBRL(agg.contratado)}
                </span>
              </div>
              <div className="w-full bg-muted h-2 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-emerald-500 to-emerald-600 transition-all"
                  style={{ width: `${Math.min(agg.pct, 100)}%` }}
                />
              </div>
            </div>
          )}

          {/* Lista de parcelas */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[11px] font-semibold text-foreground">
                Parcelas ({agg.totalCount})
              </p>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenDetail();
                }}
                className="text-[10px] text-primary hover:underline"
              >
                Ver detalhe completo →
              </button>
            </div>

            {loadingSubs || loadingQuoteDetail ? (
              <div className="py-4 flex items-center justify-center text-[11px] text-muted-foreground">
                <Loader2 size={12} className="animate-spin mr-1.5" />
                Carregando parcelas...
              </div>
            ) : parcelas.length === 0 ? (
              <div className="bg-amber-500/5 border border-amber-500/30 rounded-md px-3 py-2 text-[11px] text-amber-800">
                ⚠ Sem cobrança gerada ainda — aprove a proposta na aba Propostas pra gerar.
              </div>
            ) : (
              <ul className="border border-border rounded-md overflow-hidden divide-y divide-border/40">
                {parcelas.map((p, idx) => (
                  <ParcelaRow key={idx} parcela={p} />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );

  // Helper interno
  function MiniSummary({
    label,
    value,
    tone,
  }: {
    label: string;
    value: string;
    tone?: 'emerald' | 'blue';
  }) {
    const cls =
      tone === 'emerald' ? 'text-emerald-700' :
      tone === 'blue' ? 'text-blue-700' :
      'text-foreground';
    return (
      <div className="bg-card border border-border rounded-md p-2.5">
        <p className="text-[10px] text-muted-foreground font-semibold mb-0.5">{label}</p>
        <p className={`text-sm font-bold tabular-nums ${cls}`}>{value}</p>
      </div>
    );
  }
}

function ParcelaRow({ parcela: p }: { parcela: ParcelaItem }) {
  const paid = p.status === 'RECEIVED' || p.status === 'CONFIRMED';
  const overdue = p.status === 'OVERDUE';
  const cancelled = p.status === 'DELETED' || p.status === 'REFUNDED';
  const statusLabel =
    paid ? 'Pago' :
    overdue ? 'Vencido' :
    cancelled ? 'Cancelado' :
    'Pendente';
  const statusCls =
    paid ? 'bg-emerald-500/15 text-emerald-700' :
    overdue ? 'bg-red-500/15 text-red-700' :
    cancelled ? 'bg-muted text-muted-foreground' :
    'bg-blue-500/15 text-blue-700';

  const methodLabel = p.method === 'PIX' ? '⇗ PIX' :
    p.method === 'BOLETO' ? '🏛 Boleto' :
    p.method === 'CREDIT_CARD' ? '💳 Cartão' :
    p.method;

  const dueText = paid
    ? `Pago em ${fmtDate(p.paymentDate)}`
    : `Vence ${fmtDate(p.dueDate)}${p.isNext ? ' · próxima' : ''}`;

  return (
    <li className={`px-3 py-2 flex items-center gap-2 flex-wrap text-xs ${
      p.isNext ? 'bg-blue-500/5 border-l-2 border-blue-500' : ''
    } ${cancelled ? 'opacity-60' : ''}`}>
      <span className="font-mono font-bold text-foreground text-[11px] min-w-[44px]">
        {p.number}/{p.totalCount}
      </span>
      <span className="text-foreground">{methodLabel}</span>
      <span className="text-muted-foreground text-[11px]">{dueText}</span>
      <span className="ml-auto flex items-center gap-2">
        <span className="font-bold tabular-nums">{fmtBRL(p.value)}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${statusCls}`}>
          {statusLabel}
        </span>
        {(p.boletoUrl || p.invoiceUrl) && (
          <a
            href={p.boletoUrl || p.invoiceUrl!}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-amber-700 hover:underline"
          >
            ↗
          </a>
        )}
      </span>
    </li>
  );
}

function ChargesSection({ charges }: { charges: Charge[] }) {
  const summary = useMemo(() => {
    let paid = 0;
    let pending = 0;
    let overdue = 0;
    for (const c of charges) {
      const amt = Number(c.amount);
      if (c.status === 'RECEIVED' || c.status === 'CONFIRMED') paid += amt;
      else if (c.status === 'PENDING') pending += amt;
      else if (c.status === 'OVERDUE') overdue += amt;
    }
    return { paid, pending, overdue };
  }, [charges]);

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Receipt size={14} className="text-amber-700" />
          <p className="text-sm font-semibold">Cobranças geradas</p>
          <span className="text-xs text-muted-foreground">
            ({charges.length})
          </span>
        </div>
        <div className="flex items-center gap-3 text-[11px]">
          {summary.paid > 0 && (
            <span className="text-emerald-700 font-semibold">
              ✓ {fmtBRL(summary.paid)} pago
            </span>
          )}
          {summary.pending > 0 && (
            <span className="text-blue-700">
              {fmtBRL(summary.pending)} pendente
            </span>
          )}
          {summary.overdue > 0 && (
            <span className="text-red-700 font-semibold">
              {fmtBRL(summary.overdue)} vencido
            </span>
          )}
        </div>
      </div>
      <ul className="divide-y divide-border">
        {charges.map((c) => (
          <ChargeRow key={c.id} charge={c} />
        ))}
      </ul>
    </div>
  );
}

/** Onda 14.9 — Renderiza uma linha de cobranca com tipo, valor, status e ações */
function ChargeRow({ charge: c }: { charge: Charge }) {
  const isPix = c.billing_type === 'PIX';
  const isBoleto = c.billing_type === 'BOLETO';
  const isCartao = c.billing_type === 'CREDIT_CARD';
  const isPaid = c.status === 'RECEIVED' || c.status === 'CONFIRMED';
  const isPending = c.status === 'PENDING';
  const isOverdue = c.status === 'OVERDUE';
  const isCancelled = c.status === 'DELETED' || c.status === 'REFUNDED';

  const statusLabel =
    isPaid ? 'Pago' :
    isOverdue ? 'Vencido' :
    isPending ? 'Pendente' :
    c.status === 'REFUNDED' ? 'Estornado' :
    c.status === 'DELETED' ? 'Cancelado' :
    c.status;

  const statusCls =
    isPaid ? 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20' :
    isOverdue ? 'bg-red-500/10 text-red-700 border-red-500/20' :
    isPending ? 'bg-blue-500/10 text-blue-700 border-blue-500/20' :
    'bg-muted text-muted-foreground border-border';

  const typeLabel = isPix ? 'PIX' : isBoleto ? 'Boleto' : isCartao ? 'Cartão' : c.billing_type;
  const TypeIcon = isPix ? Send : isBoleto ? Building2 : CreditCard;

  const copyBarcode = () => {
    if (c.boleto_barcode) {
      navigator.clipboard?.writeText(c.boleto_barcode);
      showSuccess('Código copiado');
    }
  };
  const copyPix = () => {
    if (c.pix_copy_paste) {
      navigator.clipboard?.writeText(c.pix_copy_paste);
      showSuccess('Código PIX copiado');
    }
  };

  return (
    <li className={`px-4 py-3 flex items-center gap-3 flex-wrap ${isCancelled ? 'opacity-50' : ''}`}>
      <div className="flex-1 min-w-[220px]">
        <div className="flex items-center gap-2 flex-wrap">
          <TypeIcon size={12} className="text-amber-700" />
          <span className="text-sm font-semibold">{typeLabel}</span>
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${statusCls}`}>
            {statusLabel}
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          Vencimento: {fmtDate(c.due_date)}
          {c.paid_at && ` · Pago em: ${fmtDate(c.paid_at)}`}
          {c.description && ` · ${c.description.replace(/\[plan:[^\]]+\]/, '').trim()}`}
        </p>
      </div>
      <div className="text-right min-w-[100px]">
        <p className="text-sm font-bold">{fmtBRL(c.amount)}</p>
      </div>
      <div className="flex items-center gap-1">
        {/* Ações específicas por tipo */}
        {isBoleto && c.boleto_url && (
          <a
            href={c.boleto_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-amber-500/50 text-amber-800 hover:bg-amber-500/10"
            title="Abrir PDF do boleto"
          >
            <ExternalLink size={11} />
            Boleto
          </a>
        )}
        {isBoleto && c.boleto_barcode && (
          <button
            type="button"
            onClick={copyBarcode}
            className="p-1.5 rounded text-muted-foreground hover:text-amber-700 hover:bg-amber-500/10"
            title="Copiar código de barras"
          >
            <Copy size={12} />
          </button>
        )}
        {isPix && c.pix_copy_paste && (
          <button
            type="button"
            onClick={copyPix}
            className="text-xs inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-emerald-500/50 text-emerald-800 hover:bg-emerald-500/10"
            title="Copiar código PIX"
          >
            <Copy size={11} />
            PIX
          </button>
        )}
        {isCartao && c.invoice_url && (
          <a
            href={c.invoice_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-sky-500/50 text-sky-800 hover:bg-sky-500/10"
            title="Abrir link de pagamento do cartão"
          >
            <ExternalLink size={11} />
            Cartão
          </a>
        )}
      </div>
    </li>
  );
}

function SummaryCard({
  label, value, icon, highlight,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  highlight?: 'emerald' | 'blue' | 'red';
}) {
  const ringCls =
    highlight === 'emerald' ? 'ring-1 ring-emerald-500/20' :
    highlight === 'blue' ? 'ring-1 ring-blue-500/20' :
    highlight === 'red' ? 'ring-1 ring-red-500/30 bg-red-500/5' :
    '';
  return (
    <div className={`bg-card border border-border rounded-xl p-3 ${ringCls}`}>
      <div className="flex items-center gap-1 mb-1">
        {icon}
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
          {label}
        </p>
      </div>
      <p className="text-base font-bold text-foreground">{value}</p>
    </div>
  );
}

// ─── Onda 14.13 — Modal de Detalhe da Proposta Aceita ──────────────

interface QuoteDetail {
  id: string;
  title: string | null;
  /** Onda 14.18 — numero sequencial global por tenant. Identificador unificado
   *  entre as 4 abas (Avaliacao/Orcamentos/Propostas/Financeiro). */
  quote_number?: number;
  total_value: string | number;
  status: string;
  accepted_at: string | null;
  notes: string | null;
  /** Onda 14.14 — plan vinculado, usado pra filtrar charges pelo description */
  treatment_plan?: { id: string; status: string } | null;
  items: Array<{
    id: string;
    quantity: number;
    unit_price: string | number;
    total_price: string | number;
    tooth_fdi: string | null;
    notes: string | null;
    approved_at: string | null;
    procedure: { name: string };
  }>;
}

interface SubInstallment {
  external_id: string;
  installment_number: number;
  value: number;
  due_date: string;
  status: string;
  boleto_url: string | null;
  invoice_url: string | null;
  payment_date: string | null;
}

interface BonusEntry {
  timestamp: string;
  type: string;
  validUntil: Date;
  body: string;
  expired: boolean;
}

interface CounterPropEntry {
  timestamp: string;
  body: string;
}

function parseBonuses(notes: string | null): BonusEntry[] {
  if (!notes) return [];
  const re = /^\[BONUS (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) type=(\w+) valido_ate=([^\s\]]+)(?:\s+delta=[\d.]+)?\]\s*(.+)$/;
  const now = new Date();
  return notes
    .split('\n')
    .map((line) => {
      const m = line.match(re);
      if (!m) return null;
      const validUntil = new Date(m[3]);
      return {
        timestamp: m[1],
        type: m[2],
        validUntil,
        body: m[4].trim(),
        expired: validUntil.getTime() < now.getTime(),
      };
    })
    .filter((e): e is BonusEntry => e !== null)
    .reverse();
}

function parseCounterProps(notes: string | null): CounterPropEntry[] {
  if (!notes) return [];
  const re = /^\[CONTRAPROPOSTA (\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s*(.+)$/;
  return notes
    .split('\n')
    .map((line) => {
      const m = line.match(re);
      return m ? { timestamp: m[1], body: m[2].trim() } : null;
    })
    .filter((e): e is CounterPropEntry => e !== null)
    .reverse();
}

function ProposalDetailModal({
  quoteId,
  patientId,
  allCharges,
  onClose,
}: {
  quoteId: string;
  patientId: string;
  allCharges: Charge[];
  onClose: () => void;
}) {
  const [quote, setQuote] = useState<QuoteDetail | null>(null);
  const [loadingQuote, setLoadingQuote] = useState(true);
  const [subInstallments, setSubInstallments] = useState<Record<string, SubInstallment[]>>({});
  const [loadingSubs, setLoadingSubs] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    setLoadingQuote(true);
    api.get<QuoteDetail>(`/quotes/${quoteId}`)
      .then(({ data }) => {
        if (!cancelled) setQuote(data);
      })
      .catch(() => {
        if (!cancelled) showError('Erro ao carregar detalhe da proposta');
      })
      .finally(() => {
        if (!cancelled) setLoadingQuote(false);
      });
    return () => { cancelled = true; };
  }, [quoteId]);

  // Onda 14.14 — Filtra charges DESTA proposta pelo description.
  // Backend cria charges com description: '...[plan:{planId}]'
  // Se o quote tem treatment_plan, filtramos pelo plan.id. Se não tiver
  // (caso raro), mostramos todas como fallback.
  const planId = quote?.treatment_plan?.id;
  const relatedCharges = useMemo(() => {
    if (!planId) return [];
    return allCharges.filter((c) =>
      c.description?.includes(`plan:${planId}`),
    );
  }, [allCharges, planId]);

  const bonuses = useMemo(() => parseBonuses(quote?.notes || null), [quote?.notes]);
  const counterProps = useMemo(() => parseCounterProps(quote?.notes || null), [quote?.notes]);

  const loadSubInstallments = useCallback(async (chargeId: string) => {
    if (subInstallments[chargeId] !== undefined) return; // já carregou
    setLoadingSubs((p) => ({ ...p, [chargeId]: true }));
    try {
      const { data } = await api.get<{ sub_installments: SubInstallment[] }>(
        `/payment-gateway/charges/${chargeId}/sub-installments`,
      );
      setSubInstallments((p) => ({ ...p, [chargeId]: data.sub_installments || [] }));
    } catch (err) {
      setSubInstallments((p) => ({ ...p, [chargeId]: [] }));
    } finally {
      setLoadingSubs((p) => ({ ...p, [chargeId]: false }));
    }
  }, [subInstallments]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-2xl max-w-3xl w-full overflow-hidden flex flex-col max-h-[92vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-border bg-emerald-500/10">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-bold uppercase tracking-wide text-emerald-700">
                  Proposta aceita
                </span>
                {/* Onda 14.18 — numero global do orcamento no header do modal,
                    pra confirmar visualmente que e a mesma proposta vista
                    nas outras abas. */}
                {quote && getQuoteNumberBadge(quote) && (
                  <span className="text-[10px] font-mono font-semibold text-primary">
                    {getQuoteNumberBadge(quote)}
                  </span>
                )}
              </div>
              <h3 className="text-base font-bold text-foreground">
                {quote ? getQuoteDisplayName(quote) : 'Plano de tratamento'}
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Total: <strong className="text-foreground">{quote ? fmtBRL(Number(quote.total_value)) : '...'}</strong>
                {quote?.accepted_at && ` · Aceito em ${fmtDate(quote.accepted_at)}`}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground p-1.5 -mr-1 hover:bg-accent/50 rounded-md"
              aria-label="Fechar"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {loadingQuote && (
            <div className="py-8 flex items-center justify-center text-muted-foreground">
              <Loader2 size={16} className="animate-spin mr-2" />
              Carregando detalhes...
            </div>
          )}

          {!loadingQuote && quote && (
            <>
              {/* Items */}
              <section>
                <p className="text-[11px] uppercase tracking-wide text-foreground font-bold mb-2">
                  📋 Itens aprovados ({quote.items.length})
                </p>
                <ul className="space-y-1 bg-muted/20 rounded-md p-3">
                  {quote.items.map((it) => {
                    const isApproved = !!it.approved_at;
                    return (
                      <li key={it.id} className="flex items-baseline justify-between text-xs py-1 border-b border-border/30 last:border-0">
                        <span className="text-foreground flex items-center gap-1.5">
                          {isApproved && <Check size={11} className="text-emerald-600" />}
                          {it.procedure.name}
                          {it.tooth_fdi && <span className="text-muted-foreground"> · Dente {it.tooth_fdi}</span>}
                        </span>
                        <span className="text-muted-foreground tabular-nums">
                          {fmtBRL(Number(it.total_price))}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>

              {/* Cobranças vinculadas — Onda 14.14: filtra pelo plan_id */}
              {relatedCharges.length === 0 ? (
                <div className="bg-amber-500/5 border border-amber-500/30 rounded-md p-3 text-xs text-amber-800">
                  ⚠ Nenhuma cobrança gerada ainda pra essa proposta.
                  {' '}<a
                    href={`/atendimento/pacientes/${patientId}?tab=proposals`}
                    className="underline font-semibold"
                  >
                    Abrir aba Propostas
                  </a>
                  {' '}pra gerar.
                </div>
              ) : (
                <section>
                  <p className="text-[11px] uppercase tracking-wide text-foreground font-bold mb-2">
                    🧾 Cobranças geradas ({relatedCharges.length})
                  </p>
                  <ul className="space-y-2">
                    {relatedCharges.map((c) => {
                      const isPaid = c.status === 'RECEIVED' || c.status === 'CONFIRMED';
                      const subs = subInstallments[c.id];
                      const isLoadingSubs = loadingSubs[c.id];
                      return (
                        <li key={c.id} className="border border-border rounded-md overflow-hidden">
                          <div className="px-3 py-2 bg-muted/20 flex items-center justify-between gap-3 flex-wrap">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-bold">
                                {c.billing_type === 'PIX' ? '⇗ PIX' :
                                 c.billing_type === 'BOLETO' ? '🏛 Boleto' :
                                 c.billing_type === 'CREDIT_CARD' ? '💳 Cartão' :
                                 c.billing_type}
                              </span>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
                                isPaid ? 'bg-emerald-500/15 text-emerald-700' :
                                c.status === 'OVERDUE' ? 'bg-red-500/15 text-red-700' :
                                'bg-blue-500/15 text-blue-700'
                              }`}>
                                {isPaid ? 'Pago' : c.status === 'OVERDUE' ? 'Vencido' : 'Pendente'}
                              </span>
                              <span className="text-[10px] text-muted-foreground">
                                Vence {fmtDate(c.due_date)}
                              </span>
                            </div>
                            <span className="text-sm font-bold tabular-nums">{fmtBRL(Number(c.amount))}</span>
                          </div>

                          {/* Botão expandir parcelas + atalhos. Onda 14.14:
                              removido "Link Asaas" externo. Operador acessa
                              boleto direto. */}
                          <div className="px-3 py-2 border-t border-border/40 flex items-center gap-3 flex-wrap">
                            <button
                              type="button"
                              onClick={() => loadSubInstallments(c.id)}
                              className="text-[11px] text-primary hover:underline font-medium"
                            >
                              {subs === undefined
                                ? '▾ Ver parcelas e pagamentos'
                                : subs.length === 0
                                  ? '— Pagamento único (sem parcelas)'
                                  : `▾ ${subs.length} parcelas`}
                            </button>
                            {c.boleto_url && (
                              <a
                                href={c.boleto_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[11px] text-amber-700 hover:underline"
                              >
                                Abrir boleto PDF ↗
                              </a>
                            )}
                          </div>

                          {/* Lista de parcelas filhas */}
                          {isLoadingSubs && (
                            <div className="px-3 py-2 text-[11px] text-muted-foreground flex items-center gap-2">
                              <Loader2 size={11} className="animate-spin" />
                              Carregando parcelas...
                            </div>
                          )}
                          {subs && subs.length > 0 && (
                            <ul className="divide-y divide-border/40">
                              {subs.map((s) => {
                                const subPaid = s.status === 'RECEIVED' || s.status === 'CONFIRMED';
                                const subOverdue = s.status === 'OVERDUE';
                                return (
                                  <li key={s.external_id} className="px-3 py-2 flex items-center justify-between gap-2 flex-wrap text-[11px]">
                                    <div className="flex items-center gap-2">
                                      <span className="font-mono font-bold text-foreground">
                                        {s.installment_number}x
                                      </span>
                                      <span className={`px-1.5 py-0.5 rounded-full font-semibold ${
                                        subPaid ? 'bg-emerald-500/15 text-emerald-700' :
                                        subOverdue ? 'bg-red-500/15 text-red-700' :
                                        'bg-blue-500/15 text-blue-700'
                                      }`}>
                                        {subPaid ? 'Pago' : subOverdue ? 'Vencido' : 'Pendente'}
                                      </span>
                                      <span className="text-muted-foreground">
                                        Vence {fmtDate(s.due_date)}
                                        {s.payment_date && ` · Pago em ${fmtDate(s.payment_date)}`}
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <span className="font-bold tabular-nums">{fmtBRL(s.value)}</span>
                                      {s.boleto_url && (
                                        <a href={s.boleto_url} target="_blank" rel="noopener noreferrer" className="text-amber-700 hover:underline">Boleto</a>
                                      )}
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              {/* Histórico de negociação */}
              {(bonuses.length > 0 || counterProps.length > 0) && (
                <section>
                  <p className="text-[11px] uppercase tracking-wide text-foreground font-bold mb-2">
                    📜 Histórico de negociação
                  </p>
                  <ul className="space-y-1.5">
                    {bonuses.map((b, idx) => (
                      <li key={`b-${idx}`} className={`text-[11px] px-3 py-2 rounded-md border ${
                        b.expired ? 'bg-muted/30 opacity-60 line-through' : 'bg-amber-500/10 border-amber-500/30'
                      }`}>
                        <span className="font-bold">🎁 Bônus</span> · {b.body}
                        {!b.expired && (
                          <span className="text-[10px] text-amber-700 ml-1">
                            (válido até {b.validUntil.toLocaleDateString('pt-BR')})
                          </span>
                        )}
                      </li>
                    ))}
                    {counterProps.map((cp, idx) => (
                      <li key={`cp-${idx}`} className="text-[11px] px-3 py-2 rounded-md bg-muted/30 border border-border">
                        <span className="font-bold">💬 Contraproposta</span> · {cp.body}
                        <span className="font-mono text-[10px] text-muted-foreground ml-2">{cp.timestamp}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-border flex items-center justify-end gap-2 bg-muted/20">
          <a
            href={`/atendimento/pacientes/${patientId}?tab=proposals`}
            className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-accent inline-flex items-center gap-1.5"
          >
            <ExternalLink size={12} />
            Abrir na aba Propostas
          </a>
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-4 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 font-semibold"
          >
            Concluir
          </button>
        </div>
      </div>
    </div>
  );
}
