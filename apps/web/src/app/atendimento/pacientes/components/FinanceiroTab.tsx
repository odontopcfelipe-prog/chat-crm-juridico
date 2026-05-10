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
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Props {
  patientId: string;
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
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<{ data: Installment[] } | Installment[]>(
        `/installments?patient_id=${patientId}&limit=200`,
      );
      // API pode retornar array direto OU envelope { data, total }
      const list = Array.isArray(data) ? data : data?.data || [];
      setInstallments(list);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao carregar parcelas');
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => { load(); }, [load]);

  // Resumo: agrega valores por status. Pago = soma dos amount_paid de PAGA +
  // PARCIAL. Em aberto = ABERTA + PARCIAL (saldo restante). Atrasado = ATRASADA.
  const summary = useMemo(() => {
    let total = 0;
    let paid = 0;
    let pending = 0;
    let overdue = 0;
    for (const it of installments) {
      const amt = Number(it.amount);
      const amtPaid = Number(it.amount_paid);
      total += amt;
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
    return { total, paid, pending, overdue };
  }, [installments]);

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

  if (installments.length === 0) {
    return (
      <div className="bg-card border border-border border-dashed rounded-xl p-10 text-center">
        <DollarSign size={32} className="mx-auto text-muted-foreground/60 mb-3" />
        <p className="text-sm font-medium text-foreground mb-1">
          Sem movimentação financeira
        </p>
        <p className="text-xs text-muted-foreground max-w-md mx-auto">
          Quando um orçamento for aceito e gerar parcelas, elas aparecem aqui
          com status de pagamento, datas de vencimento e ações rápidas (baixar
          como pago, renegociar, etc).
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
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

      {/* Lista de parcelas */}
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
