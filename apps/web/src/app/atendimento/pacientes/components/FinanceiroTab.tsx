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
  Receipt, Send, Building2, Copy, ChevronDown, ChevronRight, FileText, Eye, X,
  ClipboardList, Shield,
} from 'lucide-react';
import Link from 'next/link';
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
  /** Onda 17.32.43 — Tipo da charge no plano: SINAL / ENTRADA / PARCELA / etc. */
  kind?: 'SINAL' | 'ENTRADA' | 'PARCELA' | string | null;
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
    //    Status sincronizado pelo webhook (PaymentGatewayCharge.status).
    //
    //    Onda 17.32.51 — Antes contava SO PENDING/OVERDUE/RECEIVED/CONFIRMED,
    //    e charges com status intermediario (AWAITING_RISK_ANALYSIS,
    //    ANTICIPATED, DUNNING_*, CHARGEBACK_*, etc) caiam num "buraco" e a
    //    soma nao batia com o Total contratado. Agora: tudo que nao eh
    //    paga/cancelada/estornada conta como "Em aberto" — garantindo
    //    paid + pending + overdue = total ativo.
    for (const c of charges) {
      const amt = Number(c.amount);
      const st = c.status;
      // Canceladas/estornadas nao contam
      if (st === 'DELETED' || st === 'REFUNDED') continue;
      // Pagas
      if (st === 'RECEIVED' || st === 'CONFIRMED' || st === 'RECEIVED_IN_CASH') {
        paid += amt;
        continue;
      }
      // Atrasadas
      if (st === 'OVERDUE') {
        overdue += amt;
        continue;
      }
      // Tudo o resto conta como "Em aberto" (PENDING + estados intermediarios)
      pending += amt;
    }
    // Onda 17.32.51 — "A gerar" = valor do contrato que ainda nao tem
    // charge correspondente no Asaas (ex: proposta aceita mas algumas
    // parcelas ainda nao foram emitidas, ou desconto/juros diferente
    // do calculo padrao). Sempre >= 0.
    const aGerar = Math.max(0, total - paid - pending - overdue);
    return { total, paid, pending, overdue, aGerar };
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

  // Onda 17.32.35 — Conta ativos (proposta com pelo menos 1 charge nao paga)
  const activeCount = acceptedQuotes.filter((q) => {
    const qCharges = charges.filter((c: any) => c.quote_id === q.id);
    return qCharges.some((c: any) => {
      const s = (c.status || '').toUpperCase();
      return s !== 'PAID' && s !== 'RECEIVED' && s !== 'CONFIRMED' && s !== 'RECEIVED_IN_CASH' && s !== 'CANCELLED';
    });
  }).length;
  const contractsCount = acceptedQuotes.length;

  return (
    <div className="space-y-4">
      {/* Header — Onda 17.32.35: visual mais rico igual ao design proposto */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            Webhook Asaas em tempo real
          </span>
          <span className="text-[11px] text-muted-foreground">· atualiza a cada 30s</span>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="text-[11px] text-primary hover:underline disabled:opacity-50"
          title="Atualizar agora"
        >
          {loading ? <Loader2 size={11} className="animate-spin inline" /> : '↻ Atualizar agora'}
        </button>
      </div>

      {/* Resumo do paciente */}
      <div>
        <p className="text-[11px] uppercase tracking-wider font-bold text-foreground mb-2">
          Resumo do paciente
          <span className="ml-2 font-normal normal-case text-muted-foreground">
            {contractsCount} {contractsCount === 1 ? 'contrato' : 'contratos'} · {activeCount} {activeCount === 1 ? 'ativo' : 'ativo(s)'}
          </span>
        </p>

        {/* 4 KPIs grandes */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <BigKpiCard
            label="Total contratado"
            value={fmtBRL(summary.total)}
            // Onda 17.32.51 — mostra "+ Rxxx a gerar" quando ha gap entre
            // o valor do contrato e a soma das charges ativas (Asaas nao
            // emitiu todas as cobrancas ainda, ou ha desconto/juros).
            subValue={summary.aGerar > 0.5 ? `+ ${fmtBRL(summary.aGerar)} a gerar` : undefined}
            icon={<DollarSign size={14} />}
            tone="neutral"
          />
          <BigKpiCard
            label="Já recebido"
            value={fmtBRL(summary.paid)}
            icon={<Check size={14} />}
            tone="emerald"
          />
          <BigKpiCard
            label="Em aberto"
            value={fmtBRL(summary.pending)}
            icon={<Clock size={14} />}
            tone="amber"
          />
          <BigKpiCard
            label="Atrasado"
            value={fmtBRL(summary.overdue)}
            icon={<AlertTriangle size={14} />}
            tone={summary.overdue > 0 ? 'red' : 'neutral'}
          />
        </div>
      </div>

      <ContratosTratamentosBloco
        acceptedQuotes={acceptedQuotes}
        charges={charges}
        patientId={patientId}
        onOpenDetail={(id) => setDetailQuoteId(id)}
        onNewContract={() => { /* TODO Onda 17.32.42: dialog de novo contrato */ }}
      />

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
  /** Onda 14.52 — id da charge mae (PaymentGatewayCharge) pra resend via WhatsApp */
  chargeId: string;
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
  /** Onda 17.32.43 — Tipo (SINAL / ENTRADA / PARCELA) pra label no card. */
  kind?: string | null;
}

/** Onda 14.51 — detalhe expandido do quote (procedimentos + negociacao escolhida) */
interface QuoteFullDetail {
  id: string;
  title: string | null;
  total_value: string | number;
  status: string;
  accepted_at: string | null;
  chosen_payment_key?: string | null;
  chosen_down_payment?: string | number | null;
  is_chosen_proposal?: boolean;
  treatment_plan?: { id: string; status: string } | null;
  items: Array<{
    id: string;
    quantity: number;
    total_price: string | number;
    tooth_fdi: string | null;
    approved_at: string | null;
    procedure: {
      name: string;
      specialty?: { name: string } | null;
    };
    dentist?: { id: string; name: string } | null;
  }>;
}

/** Onda 14.51 — info do contrato vinculado ao quote (pode ser null) */
interface ContractInfo {
  id: string;
  status: string;
  template_type: string;
  skipped: boolean;
  signed_at: string | null;
  sent_at: string | null;
  patient_signed_at: string | null;
  clinic_signed_at: string | null;
  signing_url: string | null;
  pdf_url: string | null;
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
  // Onda 17.32.46 — Modal pra ver PDF do boleto / pagina PIX com QR code
  // dentro do proprio sistema, sem precisar mandar pro paciente ver.
  const [viewerParcela, setViewerParcela] = useState<ParcelaItem | null>(null);
  // Onda 17.32.52 — Modais separados pros 2 botoes do header:
  //   - icone FileText: PDF do contrato assinado (ClickSign)
  //   - icone ClipboardList: lista de procedimentos solicitados
  const [showContract, setShowContract] = useState(false);
  const [showProcedures, setShowProcedures] = useState(false);
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
  // Onda 14.51 — quote completo (procedimentos + negociacao aceita) + contrato
  const [quoteDetail, setQuoteDetail] = useState<QuoteFullDetail | null>(null);
  const [contract, setContract] = useState<ContractInfo | null>(null);
  const [loadingContract, setLoadingContract] = useState(false);

  // Onda 14.17 — pré-carrega planId no mount (não só ao expandir) pra
  // calcular a barra de progresso e o agregado no header colapsado.
  // Onda 14.51 — Captura quote completo (items + chosen_payment_key) e
  // contrato vinculado em paralelo. Tudo cacheado no estado pra reuso.
  useEffect(() => {
    if (quoteDetail) return;
    setLoadingQuoteDetail(true);
    setLoadingContract(true);
    Promise.allSettled([
      api.get<QuoteFullDetail>(`/quotes/${quote.id}`),
      api.get<ContractInfo | null>(`/quotes/${quote.id}/contract`),
    ])
      .then(([qResp, cResp]) => {
        if (qResp.status === 'fulfilled') {
          setQuoteDetail(qResp.value.data);
          setPlanId(qResp.value.data.treatment_plan?.id || null);
        }
        if (cResp.status === 'fulfilled') {
          setContract(cResp.value.data || null);
        }
      })
      .finally(() => {
        setLoadingQuoteDetail(false);
        setLoadingContract(false);
      });
  }, [quoteDetail, quote.id]);

  // Charges filtradas pelo planId real (depois de carregado)
  const relatedChargesRaw = useMemo(() => {
    if (!planId) return initialRelatedCharges;
    return allCharges.filter((c) =>
      c.description?.includes(`plan:${planId}`),
    );
  }, [allCharges, planId, initialRelatedCharges]);

  // Onda 17.32.53 — Dedup de charges duplicadas. Quando "Encaminhar ao
  // financeiro" eh clicado mais de uma vez antes do backend confirmar,
  // a idempotencia do createSimpleCharge as vezes nao previne (race
  // condition). Resultado: 2-3 charges identicas (mesmo billing_type,
  // amount e due_date) pra mesma proposta. Aqui agrupa pela "chave de
  // identidade da cobranca" e mantem so a mais antiga (a "valida").
  // As duplicatas ficam contabilizadas em `dupCharges` pra mostrar
  // aviso no header.
  const { relatedCharges, dupChargesCount } = useMemo(() => {
    const byKey = new Map<string, Charge>();
    const dups: Charge[] = [];
    // Ordena por created_at ASC pra manter a mais antiga
    const sorted = [...relatedChargesRaw].sort((a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    for (const c of sorted) {
      // Chave: tipo + valor + vencimento + kind (sinal vs entrada vs parcela)
      const key = `${c.billing_type}|${Number(c.amount).toFixed(2)}|${c.due_date}|${c.kind || ''}`;
      if (byKey.has(key)) {
        // Duplicata — mantém apenas se a "vencedora" foi cancelada
        const winner = byKey.get(key)!;
        const winnerCancelled = winner.status === 'DELETED' || winner.status === 'REFUNDED';
        if (winnerCancelled) {
          byKey.set(key, c); // troca pela viva
          dups.push(winner);
        } else {
          dups.push(c); // marca a nova como duplicata
        }
      } else {
        byKey.set(key, c);
      }
    }
    return { relatedCharges: Array.from(byKey.values()), dupChargesCount: dups.length };
  }, [relatedChargesRaw]);

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
        // Parcelada: usa as filhas. chargeId = id da mae (resend reenvia a mae).
        for (const s of subs) {
          list.push({
            chargeId: c.id,
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
            kind: c.kind || 'PARCELA',
          });
        }
      } else {
        // 1x (cobrança única)
        list.push({
          chargeId: c.id,
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
          kind: c.kind || null,
        });
      }
    }
    // Onda 17.32.45 — Ordenacao logica em camadas:
    //  1. KIND: Sinal -> Entrada -> Parcelas (operador ve o "começo" do
    //     contrato no topo, parcelas longas embaixo).
    //  2. METODO: dentro de PARCELAS, agrupa por metodo de pagamento
    //     (PIX juntas, BOLETO juntas, CARTAO juntas). Antes vinha
    //     intercalado e o operador se perdia.
    //  3. CHARGE: mesmo metodo, agrupa parcelas da mesma cobranca pai
    //     (ex: 1 boleto parcelado em 5x fica com as 5 parcelas em
    //     sequencia, sem que outra charge se misture).
    //  4. NUMERO: dentro da mesma charge, ordem natural 1/5, 2/5, ...
    const kindOrder = (k: string | null | undefined): number => {
      if (k === 'SINAL') return 0;
      if (k === 'ENTRADA') return 1;
      return 2; // PARCELA (default)
    };
    const methodOrder = (m: string | null | undefined): number => {
      // PIX = 0 (instantaneo), BOLETO = 1, CREDIT_CARD = 2, outros = 3
      if (m === 'PIX') return 0;
      if (m === 'BOLETO') return 1;
      if (m === 'CREDIT_CARD') return 2;
      return 3;
    };
    list.sort((a, b) => {
      const ka = kindOrder(a.kind);
      const kb = kindOrder(b.kind);
      if (ka !== kb) return ka - kb;
      // Mesmo kind: agrupa por metodo (PIX juntas, BOLETO juntas, ...)
      const ma = methodOrder(a.method);
      const mb = methodOrder(b.method);
      if (ma !== mb) return ma - mb;
      // Mesmo metodo: mantem parcelas da mesma cobranca pai juntas
      if (a.chargeId !== b.chargeId) return a.chargeId.localeCompare(b.chargeId);
      // Mesma charge: ordem natural pelo numero da parcela
      return a.number - b.number;
    });
    // Marca a primeira não-paga como "próxima" (apos ordenacao)
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

  // Onda 17.32.43 — Helper: tipo de pagamento legivel ("Boleto financiado",
  // "Cartao de credito · 6x sem juros", "PIX a vista", etc) derivado do
  // chosen_payment_key OU do billing_type dominante das charges.
  const paymentFormLabel = (() => {
    const key = quoteDetail?.chosen_payment_key || '';
    if (key.startsWith('parcelado-') || key === 'boleto-avista') {
      const installments = Number(key.split('-')[1]) || 1;
      const entry = Number(quoteDetail?.chosen_down_payment || 0) > 0 ? 'entrada + ' : '';
      return `Boleto financiado · ${entry}${installments}×`;
    }
    if (key.startsWith('cartao-')) {
      const installments = Number(key.split('-')[1]) || 1;
      return `Cartão de crédito · ${installments}× sem juros`;
    }
    if (key === 'pix' || key === 'pix-avista') return 'PIX à vista';
    // Fallback pelo billing type dominante
    const bt = relatedCharges[0]?.billing_type;
    if (bt === 'BOLETO') return 'Boleto';
    if (bt === 'PIX') return 'PIX';
    if (bt === 'CREDIT_CARD') return 'Cartão de crédito';
    return 'Cobrança';
  })();

  // Onda 17.32.43 — Status compacto no header (ATRASADO / EM DIA / QUITADO).
  // Baseado no estado da proxima parcela e do total pago.
  const headerStatus = (() => {
    if (agg.pct >= 100 && agg.contratado > 0) {
      return { label: 'QUITADO', cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30' };
    }
    const hasOverdue = parcelas.some((p) => {
      const isUnpaid = p.status !== 'RECEIVED' && p.status !== 'CONFIRMED' && p.status !== 'DELETED' && p.status !== 'REFUNDED';
      if (!isUnpaid) return false;
      const dueMs = p.dueDate ? new Date(p.dueDate).getTime() : 0;
      return dueMs && dueMs < Date.now();
    });
    if (hasOverdue) {
      return { label: 'ATRASADO', cls: 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30' };
    }
    if (agg.totalCount === 0) {
      return { label: 'SEM COBRANÇA', cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30' };
    }
    return { label: 'EM DIA', cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30' };
  })();

  // Onda 17.32.47 — Mostra o nome que o operador colocou no orcamento
  // (quote.title). So cai pra label de prioridade (Urgente/Essencial/
  // Completo) se nao houver titulo. Antes priorizava prioridade e o
  // nome customizado nunca aparecia.
  const priorityLabel = (() => {
    if (quote.title && quote.title.trim()) return quote.title;
    const p = (quote.priority || '').toUpperCase();
    if (p === 'URGENTE') return 'Urgente';
    if (p === 'ESSENCIAL') return 'Essencial';
    if (p === 'COMPLETO') return 'Completo';
    return 'Plano';
  })();

  // Onda 17.32.43 — Procedimento dominante (mais frequente) pra subtitle.
  const dominantProcedure = (() => {
    if (!quoteDetail?.items?.length) return null;
    const counts = new Map<string, number>();
    for (const it of quoteDetail.items) {
      const name = it.procedure.name;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    let best = '';
    let max = 0;
    counts.forEach((cnt, name) => {
      if (cnt > max) { max = cnt; best = name; }
    });
    return best;
  })();

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      {/* Header colapsavel — Onda 17.32.43 visual da referencia */}
      <div className="grid grid-cols-[auto_1fr_minmax(140px,200px)_auto_auto] gap-3 items-center px-4 py-3 hover:bg-accent/30 transition-colors">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-muted-foreground hover:text-foreground p-1 -ml-1 rounded transition-colors"
          aria-label={expanded ? 'Recolher' : 'Expandir'}
        >
          {expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </button>

        <div className="min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm font-bold text-foreground">Contrato</span>
            <span className="text-[11px] font-mono font-semibold px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20">
              {getQuoteNumberBadge(quote) || `#${index}`}
            </span>
            <span className="text-sm text-muted-foreground">·</span>
            <span className="text-sm font-bold text-foreground">{priorityLabel}</span>
            <span className={`text-[10px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded border ${headerStatus.cls}`}>
              {headerStatus.label}
            </span>
            {/* Onda 17.32.53 — Aviso de cobrancas duplicadas (cliques
                multiplos no "Encaminhar ao financeiro" historicamente).
                As duplicatas estao escondidas mas continuam no Asaas. */}
            {dupChargesCount > 0 && (
              <span
                className="text-[10px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded border bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30 inline-flex items-center gap-1"
                title={`${dupChargesCount} cobranca(s) duplicada(s) escondidas. Cancele no Asaas pra limpar.`}
              >
                <AlertTriangle size={9} />
                {dupChargesCount} dup.
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
            {contract?.signed_at ? `Assinado ${fmtDate(contract.signed_at)} · ` : `Aceito ${fmtDate(quote.accepted_at)} · `}
            {paymentFormLabel}
            {dominantProcedure && ` · ${dominantProcedure}`}
            {quoteDetail?.items?.length ? ` · ${quoteDetail.items.length} itens` : ''}
          </p>
        </div>

        <div>
          <div className="flex items-baseline justify-between gap-2 mb-1">
            <span className="text-[10px] text-muted-foreground">pago</span>
            <span className={`text-[11px] font-bold tabular-nums ${agg.pct >= 100 ? 'text-emerald-700' : agg.pct > 0 ? 'text-emerald-700' : 'text-muted-foreground'}`}>
              {agg.pct}%
            </span>
          </div>
          <div className="w-full bg-muted h-2 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-600 transition-all"
              style={{ width: `${Math.min(agg.pct, 100)}%` }}
            />
          </div>
        </div>

        <div className="text-right shrink-0">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-bold">Total</p>
          <p className="text-lg font-extrabold tabular-nums text-foreground">{fmtBRL(agg.contratado)}</p>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {/* Onda 17.32.52 — Contrato assinado (PDF / link ClickSign) */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowContract(true); }}
            className="p-2 rounded-md border border-border bg-card hover:bg-accent/40 text-muted-foreground hover:text-foreground transition-colors"
            title="Contrato assinado"
          >
            <FileText size={14} />
          </button>
          {/* Onda 17.32.52 — Lista de procedimentos solicitados pelo orcamento */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowProcedures(true); }}
            className="p-2 rounded-md border border-border bg-card hover:bg-accent/40 text-muted-foreground hover:text-foreground transition-colors"
            title="Procedimentos solicitados"
          >
            <ClipboardList size={14} />
          </button>
          {/* Onda 17.32.54 — Validar tratamento: navega pra dashboard de
              validacoes onde o dentista atesta os procedimentos como
              clinicamente executados. */}
          <Link
            href="/atendimento/validacoes"
            onClick={(e) => e.stopPropagation()}
            className="p-2 rounded-md border border-border bg-card hover:bg-accent/40 text-muted-foreground hover:text-foreground transition-colors inline-flex items-center justify-center"
            title="Validar tratamento (atestar execucao clinica)"
          >
            <Shield size={14} />
          </Link>
        </div>
      </div>

      {/* Onda 17.32.46 — Modal pra ver boleto/QR PIX in-place */}
      {viewerParcela && (
        <ChargeViewerModal
          parcela={viewerParcela}
          onClose={() => setViewerParcela(null)}
        />
      )}
      {/* Onda 17.32.52 — Modal: PDF do contrato assinado / link ClickSign */}
      {showContract && (
        <ContractDocModal
          contract={contract}
          loading={loadingContract}
          onClose={() => setShowContract(false)}
        />
      )}
      {/* Onda 17.32.52 — Modal: lista de procedimentos solicitados pelo orcamento */}
      {showProcedures && (
        <ProceduresListModal
          quoteDetail={quoteDetail}
          loading={loadingQuoteDetail}
          quoteName={priorityLabel}
          onClose={() => setShowProcedures(false)}
        />
      )}
      {/* Body expansível — Onda 17.32.43: lista de parcelas no estilo da referencia */}
      {expanded && (
        <div className="border-t border-border bg-muted/5">
          {loadingSubs || loadingQuoteDetail ? (
            <div className="py-6 flex items-center justify-center text-[11px] text-muted-foreground">
              <Loader2 size={12} className="animate-spin mr-1.5" />
              Carregando parcelas...
            </div>
          ) : parcelas.length === 0 ? (
            <div className="px-4 py-4 text-[11px] text-amber-800 bg-amber-500/5 border-y border-amber-500/30">
              ⚠ Sem cobrança gerada ainda — aprove a proposta na aba Plano de tratamento pra gerar.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {parcelas.map((p, idx) => (
                <ParcelaLinha
                  key={idx}
                  parcela={p}
                  onView={() => setViewerParcela(p)}
                  onRegistrar={() => onOpenDetail()}
                  onReenviar={() => onOpenDetail()}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Onda 17.32.43 — Linha de parcela no estilo da referencia do operador.
 *  Cada linha mostra icone colorido por tipo + label/status + vencimento +
 *  valor + 3 botoes (Ver boleto/QR + Reenviar/Cobrar + Registrar). */
function ParcelaLinha({
  parcela: p,
  onView,
  onRegistrar,
  onReenviar,
}: {
  parcela: ParcelaItem;
  onView: () => void;
  onRegistrar: () => void;
  onReenviar: () => void;
}) {
  const isPaid = p.status === 'RECEIVED' || p.status === 'CONFIRMED';
  const isOverdue = !isPaid && p.dueDate && new Date(p.dueDate).getTime() < Date.now();
  const isCancelled = p.status === 'DELETED' || p.status === 'REFUNDED';
  const isSinal = p.kind === 'SINAL' || (p.totalCount === 1 && !p.kind);
  // Status badge
  const status = (() => {
    if (isCancelled) return { label: 'CANCELADA', cls: 'bg-muted text-muted-foreground border-border' };
    if (isPaid) return { label: 'PAGA', cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30' };
    if (isOverdue) return { label: 'VENCIDO', cls: 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30' };
    if (p.isNext) return { label: 'EM ABERTO', cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30' };
    return { label: 'AGENDADA', cls: 'bg-muted/50 text-muted-foreground border-border' };
  })();
  // Label da parcela
  const label = isSinal
    ? 'Sinal de fechamento'
    : p.kind === 'ENTRADA'
    ? 'Entrada'
    : `Parcela ${p.number} de ${p.totalCount}`;
  // Metodo legivel
  const methodLabel = (() => {
    if (p.method === 'PIX') return 'PIX';
    if (p.method === 'BOLETO') return 'Boleto';
    if (p.method === 'CREDIT_CARD') return 'Cartão';
    return p.method || '—';
  })();
  // Cor do icone
  const iconBg = isSinal
    ? 'bg-emerald-500/10 text-emerald-700'
    : p.method === 'PIX'
    ? 'bg-sky-500/10 text-sky-700'
    : p.method === 'BOLETO'
    ? 'bg-amber-500/10 text-amber-700'
    : p.method === 'CREDIT_CARD'
    ? 'bg-blue-500/10 text-blue-700'
    : 'bg-muted text-muted-foreground';
  const Icon = isSinal ? Receipt : p.method === 'PIX' ? DollarSign : Building2;
  return (
    <li className="px-4 py-3 grid grid-cols-[auto_minmax(0,1fr)_auto_auto] gap-3 items-center hover:bg-accent/20 transition-colors">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${iconBg}`}>
        <Icon size={18} />
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-bold text-foreground">{label}</span>
          <span className={`text-[10px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded border ${status.cls}`}>
            {status.label}
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Vencimento {fmtDate(p.dueDate)} · via {methodLabel}
        </p>
      </div>
      <p className="text-sm font-bold tabular-nums text-foreground text-right shrink-0">
        {fmtBRL(p.value)}
      </p>
      {/* Onda 17.32.48 — Grupo de acoes em flex pra nao quebrar linha.
          Antes cada botao era uma coluna do grid e o 3o botao caia
          pra linha de baixo. */}
      <div className="flex items-center gap-1.5 shrink-0 flex-nowrap">
        {!isPaid && !isCancelled && (
          <button
            type="button"
            onClick={onReenviar}
            className={`text-xs font-semibold px-3 py-1.5 rounded-md border inline-flex items-center gap-1.5 transition-colors whitespace-nowrap ${
              isOverdue
                ? 'border-red-500/40 bg-red-500/5 text-red-700 dark:text-red-400 hover:bg-red-500/15'
                : 'border-border bg-card text-foreground hover:bg-accent/40'
            }`}
          >
            <Send size={11} />
            {isOverdue ? 'Cobrar agora' : 'Reenviar'}
          </button>
        )}
        {isPaid && (
          <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1.5 px-2 py-1.5 whitespace-nowrap">
            <Check size={12} strokeWidth={3} />
            Pago
          </span>
        )}
        {(p.boletoUrl || p.invoiceUrl) && !isCancelled && (
          <button
            type="button"
            onClick={onView}
            className="text-xs font-semibold px-3 py-1.5 rounded-md border border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400 hover:bg-sky-500/20 inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
            title={p.method === 'PIX' ? 'Ver QR code PIX' : p.method === 'BOLETO' ? 'Ver PDF do boleto' : 'Ver cobrança'}
          >
            <Eye size={11} />
            Ver
          </button>
        )}
        <button
          type="button"
          onClick={onRegistrar}
          disabled={isPaid || isCancelled}
          className="text-xs font-semibold px-3 py-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20 inline-flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
          title={isPaid ? 'Pagamento já registrado' : 'Marcar como recebido (PIX/Espécie)'}
        >
          <Check size={11} />
          Registrar
        </button>
      </div>
    </li>
  );
}

/** Onda 17.32.46 — Modal pra ver boleto PDF ou pagina PIX (com QR code).
 *  Carrega o iframe direto da URL hospedada pelo Asaas (boletoUrl pra PDF
 *  do boleto; invoiceUrl pra pagina PIX com QR + Pix Copia e Cola).
 *  Botao "Abrir em nova aba" caso o iframe seja bloqueado por X-Frame.
 *  Botao "Copiar link" pra mandar pro paciente fora do sistema.
 */
function ChargeViewerModal({
  parcela: p,
  onClose,
}: {
  parcela: ParcelaItem;
  onClose: () => void;
}) {
  // Onda 17.32.46 — Pra BOLETO, prefere boletoUrl (PDF direto). Pra PIX e
  // CARTAO, prefere invoiceUrl (pagina hospedada que mostra QR/dados).
  const url = p.method === 'BOLETO'
    ? (p.boletoUrl || p.invoiceUrl)
    : (p.invoiceUrl || p.boletoUrl);
  // Onda 17.32.49 — URL pra embed no iframe: passa pelo proxy do backend
  // pra remover o X-Frame-Options do Asaas (que bloqueia iframe direto).
  const apiBase = process.env.NEXT_PUBLIC_API_URL || '';
  const proxyUrl: string | undefined = url && apiBase
    ? `${apiBase}/payment-gateway/proxy-asaas?url=${encodeURIComponent(url)}`
    : undefined;
  // Onda 17.32.50 — Verifica se o proxy responde 2xx antes de embed.
  // Se o backend nao tem a rota (404) ou erro, mostra fallback claro
  // ("Abrir em nova aba") em vez de exibir o JSON de erro dentro do
  // iframe (UX terrivel).
  const [embedState, setEmbedState] = useState<'checking' | 'ok' | 'fail'>(
    'checking',
  );
  useEffect(() => {
    if (!proxyUrl) {
      setEmbedState('fail');
      return;
    }
    let cancelled = false;
    // HEAD pra detectar 404 sem baixar PDF inteiro
    fetch(proxyUrl, { method: 'HEAD' })
      .then((r) => {
        if (cancelled) return;
        setEmbedState(r.ok ? 'ok' : 'fail');
      })
      .catch(() => {
        if (!cancelled) setEmbedState('fail');
      });
    return () => { cancelled = true; };
  }, [proxyUrl]);
  const label = (() => {
    if (p.kind === 'SINAL' || (p.totalCount === 1 && !p.kind)) return 'Sinal de fechamento';
    if (p.kind === 'ENTRADA') return 'Entrada';
    return `Parcela ${p.number} de ${p.totalCount}`;
  })();
  const methodLabel = p.method === 'PIX' ? 'PIX'
    : p.method === 'BOLETO' ? 'Boleto'
    : p.method === 'CREDIT_CARD' ? 'Cartão'
    : (p.method || '—');
  const handleCopy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      showSuccess('Link copiado pra area de transferencia');
    } catch {
      showError('Nao foi possivel copiar');
    }
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border bg-muted/30 shrink-0">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm font-bold text-foreground">{label}</h2>
              <span className="text-[10px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded border border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400">
                {methodLabel}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Vencimento {fmtDate(p.dueDate)} · {fmtBRL(p.value)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-accent/40 text-muted-foreground hover:text-foreground transition-colors shrink-0"
            title="Fechar"
          >
            <X size={18} />
          </button>
        </div>
        {/* Conteudo: iframe via proxy, fallback ou msg sem-url */}
        <div className="flex-1 overflow-hidden bg-muted/10 min-h-[500px]">
          {!url ? (
            <div className="h-full flex items-center justify-center p-8 text-center">
              <div>
                <AlertTriangle size={32} className="mx-auto mb-2 text-amber-600" />
                <p className="text-sm font-semibold text-foreground mb-1">
                  Link nao disponivel
                </p>
                <p className="text-xs text-muted-foreground">
                  Essa parcela nao tem URL de boleto ou pagina Asaas associada.
                  Pode ser que a cobranca ainda nao foi processada ou foi
                  cancelada.
                </p>
              </div>
            </div>
          ) : embedState === 'checking' ? (
            <div className="h-full flex items-center justify-center p-8 text-center">
              <div className="text-muted-foreground inline-flex items-center gap-2">
                <Loader2 size={16} className="animate-spin" />
                Carregando visualizacao...
              </div>
            </div>
          ) : embedState === 'ok' && proxyUrl ? (
            <iframe
              src={proxyUrl}
              className="w-full h-full border-0"
              title={`${label} — ${methodLabel}`}
            />
          ) : (
            // Onda 17.32.50 — Fallback quando proxy nao responde
            // (deploy do API antigo, sem a rota /proxy-asaas, ou erro
            // de rede). Mostra CTA grande pra abrir em nova aba.
            <div className="h-full flex items-center justify-center p-8 text-center">
              <div className="max-w-sm">
                {p.method === 'BOLETO' ? (
                  <Building2 size={48} className="mx-auto mb-3 text-amber-600" />
                ) : p.method === 'PIX' ? (
                  <DollarSign size={48} className="mx-auto mb-3 text-sky-600" />
                ) : (
                  <CreditCard size={48} className="mx-auto mb-3 text-blue-600" />
                )}
                <p className="text-base font-bold text-foreground mb-1">
                  {p.method === 'BOLETO' ? 'Boleto pronto' : p.method === 'PIX' ? 'PIX pronto pra pagar' : 'Cobranca gerada'}
                </p>
                <p className="text-xs text-muted-foreground mb-4">
                  A visualizacao embutida nao esta disponivel no momento.
                  Use o botao abaixo pra abrir o {p.method === 'BOLETO' ? 'PDF do boleto' : 'QR code / link de pagamento'} numa
                  nova aba.
                </p>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-bold px-4 py-2 rounded-md bg-sky-600 hover:bg-sky-700 text-white inline-flex items-center gap-2 transition-colors"
                >
                  <ExternalLink size={14} />
                  Abrir {p.method === 'BOLETO' ? 'boleto' : 'cobranca'} em nova aba
                </a>
              </div>
            </div>
          )}
        </div>
        {/* Footer com acoes */}
        {url && (
          <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-border bg-muted/30 shrink-0">
            <button
              type="button"
              onClick={handleCopy}
              className="text-xs font-semibold px-3 py-1.5 rounded-md border border-border bg-card text-foreground hover:bg-accent/40 inline-flex items-center gap-1.5 transition-colors"
            >
              <Copy size={11} />
              Copiar link
            </button>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-semibold px-3 py-1.5 rounded-md border border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400 hover:bg-sky-500/20 inline-flex items-center gap-1.5 transition-colors"
            >
              <ExternalLink size={11} />
              Abrir em nova aba
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

/** Onda 17.32.52 — Modal do contrato assinado (PDF do ClickSign ou
 *  link de assinatura). Mostra mini-timeline de etapas (Enviado /
 *  Paciente assinou / Clinica assinou / Finalizado). */
function ContractDocModal({
  contract,
  loading,
  onClose,
}: {
  contract: ContractInfo | null;
  loading: boolean;
  onClose: () => void;
}) {
  const statusInfo = contract ? (() => {
    if (contract.skipped) return { label: 'Pulado', cls: 'bg-muted text-muted-foreground border-border' };
    switch (contract.status) {
      case 'SIGNED': return { label: '✓ Assinado', cls: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30' };
      case 'PATIENT_SIGNED': return { label: 'Paciente assinou', cls: 'bg-amber-500/15 text-amber-700 border-amber-500/30' };
      case 'OPENED': return { label: 'Paciente abriu', cls: 'bg-blue-500/15 text-blue-700 border-blue-500/30' };
      case 'SENT': return { label: 'Enviado', cls: 'bg-blue-500/15 text-blue-700 border-blue-500/30' };
      case 'DRAFT': return { label: 'Rascunho', cls: 'bg-muted text-muted-foreground border-border' };
      case 'EXPIRED': return { label: 'Expirou', cls: 'bg-red-500/15 text-red-700 border-red-500/30' };
      case 'CANCELLED': return { label: 'Cancelado', cls: 'bg-muted text-muted-foreground border-border' };
      default: return { label: contract.status, cls: 'bg-muted text-muted-foreground border-border' };
    }
  })() : null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border bg-muted/30 shrink-0">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm font-bold text-foreground inline-flex items-center gap-2">
                <FileText size={14} className="text-muted-foreground" />
                Contrato assinado
              </h2>
              {statusInfo && (
                <span className={`text-[10px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded border ${statusInfo.cls}`}>
                  {statusInfo.label}
                </span>
              )}
            </div>
            {contract?.template_type && (
              <p className="text-[11px] text-muted-foreground">
                {contract.template_type.replace(/_/g, ' ').toLowerCase()}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-accent/40 text-muted-foreground hover:text-foreground transition-colors shrink-0"
            title="Fechar"
          >
            <X size={18} />
          </button>
        </div>
        {/* Conteudo */}
        <div className="flex-1 overflow-auto bg-muted/10">
          {loading ? (
            <div className="h-full flex items-center justify-center p-8 text-muted-foreground">
              <Loader2 size={16} className="animate-spin mr-2" />
              Carregando contrato...
            </div>
          ) : !contract ? (
            <div className="h-full flex items-center justify-center p-8 text-center">
              <div className="max-w-sm">
                <AlertTriangle size={48} className="mx-auto mb-3 text-amber-600" />
                <p className="text-base font-bold text-foreground mb-1">
                  Sem contrato criado
                </p>
                <p className="text-xs text-muted-foreground">
                  Nenhum contrato foi criado pra essa proposta ainda. Pra gerar
                  um contrato ClickSign, vai na aba <strong>Plano de tratamento</strong>{' '}
                  e use o botao "Criar contrato".
                </p>
              </div>
            </div>
          ) : (
            <div className="p-5 space-y-4">
              {/* Mini-timeline */}
              <div>
                <p className="text-[11px] uppercase tracking-wider font-bold text-foreground mb-2">
                  Etapas
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <ContractStepCard label="Enviado" done={!!contract.sent_at} date={contract.sent_at} />
                  <ContractStepCard label="Paciente assinou" done={!!contract.patient_signed_at} date={contract.patient_signed_at} />
                  <ContractStepCard label="Clinica assinou" done={!!contract.clinic_signed_at} date={contract.clinic_signed_at} />
                  <ContractStepCard label="Finalizado" done={!!contract.signed_at || contract.skipped} date={contract.signed_at} />
                </div>
              </div>
              {/* Acoes */}
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border">
                {contract.pdf_url && (
                  <a
                    href={contract.pdf_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-bold px-3 py-2 rounded-md bg-sky-600 hover:bg-sky-700 text-white inline-flex items-center gap-2 transition-colors"
                  >
                    <ExternalLink size={14} />
                    Abrir PDF do contrato
                  </a>
                )}
                {contract.signing_url && contract.status !== 'SIGNED' && !contract.skipped && (
                  <a
                    href={contract.signing_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-semibold px-3 py-2 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 inline-flex items-center gap-2 transition-colors"
                  >
                    <ExternalLink size={14} />
                    Link de assinatura
                  </a>
                )}
                {!contract.pdf_url && !contract.signing_url && (
                  <p className="text-xs text-muted-foreground italic">
                    Sem PDF ou link disponivel ainda — o ClickSign envia o PDF
                    apos a assinatura final.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ContractStepCard({ label, done, date }: { label: string; done: boolean; date: string | null }) {
  return (
    <div
      className={`flex flex-col gap-0.5 px-2 py-2 rounded border text-[11px] ${
        done
          ? 'bg-emerald-500/5 border-emerald-500/30 text-emerald-800 dark:text-emerald-300'
          : 'bg-muted/30 border-border text-muted-foreground'
      }`}
    >
      <span className="flex items-center gap-1 font-semibold">
        {done ? <Check size={11} strokeWidth={3} /> : <Clock size={11} />}
        {label}
      </span>
      {date && <span className="text-[10px] opacity-80">{fmtDate(date)}</span>}
    </div>
  );
}

/** Onda 17.32.52 — Modal de procedimentos solicitados do orcamento.
 *  Lista cada item com nome, dente FDI (se houver), quantidade, dentista
 *  (se houver) e valor. Soma o total no rodape. */
function ProceduresListModal({
  quoteDetail,
  loading,
  quoteName,
  onClose,
}: {
  quoteDetail: QuoteFullDetail | null;
  loading: boolean;
  quoteName: string;
  onClose: () => void;
}) {
  const total = quoteDetail?.items.reduce((s, it) => s + Number(it.total_price), 0) || 0;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border bg-muted/30 shrink-0">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-bold text-foreground inline-flex items-center gap-2">
              <ClipboardList size={14} className="text-muted-foreground" />
              Procedimentos solicitados
            </h2>
            <p className="text-[11px] text-muted-foreground">
              {quoteName}
              {quoteDetail?.items?.length ? ` · ${quoteDetail.items.length} ${quoteDetail.items.length === 1 ? 'item' : 'itens'}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-accent/40 text-muted-foreground hover:text-foreground transition-colors shrink-0"
            title="Fechar"
          >
            <X size={18} />
          </button>
        </div>
        {/* Lista de procedimentos */}
        <div className="flex-1 overflow-auto bg-muted/10">
          {loading ? (
            <div className="h-full flex items-center justify-center p-8 text-muted-foreground">
              <Loader2 size={16} className="animate-spin mr-2" />
              Carregando procedimentos...
            </div>
          ) : !quoteDetail?.items?.length ? (
            <div className="h-full flex items-center justify-center p-8 text-center">
              <p className="text-sm text-muted-foreground italic">
                Nenhum procedimento listado nesse orcamento.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {quoteDetail.items.map((it) => {
                const approved = !!it.approved_at;
                return (
                  <li key={it.id} className="px-4 py-3 flex items-start gap-3">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                      approved ? 'bg-emerald-500/10 text-emerald-700' : 'bg-muted text-muted-foreground'
                    }`}>
                      {approved ? <Check size={13} strokeWidth={3} /> : <Clock size={13} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-foreground">{it.procedure.name}</p>
                      <div className="flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground mt-0.5">
                        {it.tooth_fdi && <span>Dente {it.tooth_fdi}</span>}
                        {it.quantity > 1 && <span>· {it.quantity}x</span>}
                        {it.dentist?.name && <span>· {it.dentist.name}</span>}
                        {!approved && <span className="text-amber-700">· aguardando aprovacao</span>}
                      </div>
                    </div>
                    <p className="text-sm font-bold tabular-nums text-foreground shrink-0">
                      {fmtBRL(Number(it.total_price))}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {/* Footer com total */}
        {quoteDetail?.items?.length ? (
          <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-border bg-muted/30 shrink-0">
            <span className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground">Total solicitado</span>
            <span className="text-lg font-extrabold tabular-nums text-foreground">{fmtBRL(total)}</span>
          </div>
        ) : null}
      </div>
    </div>
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

/** Onda 17.32.35 — Card KPI grande pro topo do FinanceiroTab.
 *  Maior, com cores mais saturadas + valor grande pra impacto visual.
 *  Toneles: neutral (cinza) · emerald (verde) · amber (laranja) · red (vermelho).
 *  Onda 17.32.42 — Fix bug "R$ R$": value JA vem com prefixo "R$" do chamador. */
function BigKpiCard({
  label, value, subValue, icon, tone,
}: {
  label: string;
  value: string;
  subValue?: string;
  icon: React.ReactNode;
  tone: 'neutral' | 'emerald' | 'amber' | 'red';
}) {
  const styles = {
    neutral: { border: 'border-border', bg: 'bg-card', icon: 'text-muted-foreground', text: 'text-foreground', label: 'text-muted-foreground' },
    emerald: { border: 'border-emerald-500/30', bg: 'bg-emerald-500/5', icon: 'text-emerald-700 dark:text-emerald-400', text: 'text-emerald-700 dark:text-emerald-400', label: 'text-emerald-700 dark:text-emerald-400' },
    amber: { border: 'border-amber-500/30', bg: 'bg-amber-500/5', icon: 'text-amber-700 dark:text-amber-400', text: 'text-amber-700 dark:text-amber-400', label: 'text-amber-700 dark:text-amber-400' },
    red: { border: 'border-red-500/30', bg: 'bg-red-500/5', icon: 'text-red-700 dark:text-red-400', text: 'text-red-700 dark:text-red-400', label: 'text-red-700 dark:text-red-400' },
  }[tone];
  // Sanitiza prefixo "R$" duplicado caso chamador ja tenha colocado.
  const cleanValue = value.replace(/^R\$\s*/, '');
  return (
    <div className={`border-2 ${styles.border} ${styles.bg} rounded-xl p-4`}>
      <div className="flex items-center gap-1.5 mb-2">
        <span className={styles.icon}>{icon}</span>
        <p className={`text-[10px] uppercase tracking-wider font-bold ${styles.label}`}>{label}</p>
      </div>
      <p className={`text-2xl font-extrabold tabular-nums ${styles.text}`}>R$ {cleanValue}</p>
      {subValue && (
        <p className="text-[10px] mt-1 text-muted-foreground tabular-nums">{subValue}</p>
      )}
    </div>
  );
}

/** Onda 17.32.42 — Bloco "Contratos & tratamentos" com tabs Todos/Ativos/Quitados
 *  + botão "+ Novo contrato". Filtra acceptedQuotes pelas charges associadas:
 *   - Ativos: pelo menos uma charge nao paga
 *   - Quitados: todas as charges pagas (ou nao tem charge)
 *   - Todos: ambos */
function ContratosTratamentosBloco({
  acceptedQuotes,
  charges,
  patientId,
  onOpenDetail,
  onNewContract,
}: {
  acceptedQuotes: AcceptedQuote[];
  charges: Charge[];
  patientId: string;
  onOpenDetail: (id: string) => void;
  onNewContract: () => void;
}) {
  const [tab, setTab] = useState<'todos' | 'ativos' | 'quitados'>('todos');

  const isPaidStatus = (s: string | null | undefined) => {
    const x = (s || '').toUpperCase();
    return x === 'PAID' || x === 'RECEIVED' || x === 'CONFIRMED' || x === 'RECEIVED_IN_CASH';
  };

  const filtered = useMemo(() => {
    return acceptedQuotes.filter((q) => {
      const qCharges = charges.filter((c: any) => c.quote_id === q.id);
      if (qCharges.length === 0) {
        // Sem charges = considera ativo (precisa cobrar)
        return tab === 'todos' || tab === 'ativos';
      }
      const allPaid = qCharges.every((c: any) => isPaidStatus(c.status));
      if (tab === 'ativos') return !allPaid;
      if (tab === 'quitados') return allPaid;
      return true;
    });
  }, [acceptedQuotes, charges, tab]);

  return (
    <div>
      <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
        <div className="flex items-center gap-2">
          <Receipt size={16} className="text-orange-600" />
          <h2 className="text-base font-bold text-foreground">Contratos &amp; tratamentos</h2>
          {/* Tabs */}
          <div className="flex items-center gap-1 ml-2">
            {(['todos', 'ativos', 'quitados'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`text-[11px] font-bold uppercase tracking-wide px-3 py-1.5 rounded-md transition-colors ${
                  tab === t
                    ? 'bg-foreground text-background'
                    : 'border border-border bg-card text-muted-foreground hover:bg-accent/40'
                }`}
              >
                {t === 'todos' ? 'Todos' : t === 'ativos' ? 'Ativos' : 'Quitados'}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={onNewContract}
          className="text-xs font-bold text-orange-600 hover:bg-orange-500/10 px-3 py-2 rounded-md inline-flex items-center gap-1.5 transition-colors border border-orange-500/30"
          title="Em breve: criar novo contrato direto pelo Financeiro"
        >
          <span className="text-base leading-none">+</span>
          Novo contrato
        </button>
      </div>

      {filtered.length > 0 ? (
        <div className="space-y-3">
          {filtered.map((q, idx) => (
            <ProposalFinancialCard
              key={q.id}
              index={idx + 1}
              quote={q}
              allCharges={charges}
              patientId={patientId}
              onOpenDetail={() => onOpenDetail(q.id)}
            />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground italic px-3 py-4 border border-dashed border-border rounded-md text-center">
          {tab === 'todos'
            ? 'Nenhum contrato ativo ainda. Quando uma proposta for aceita e o contrato assinado, aparece aqui.'
            : tab === 'ativos'
            ? 'Nenhum contrato ativo. Todos os contratos deste paciente estão quitados.'
            : 'Nenhum contrato quitado ainda.'}
        </p>
      )}
    </div>
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
