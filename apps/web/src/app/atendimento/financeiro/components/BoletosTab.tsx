'use client';

/**
 * BoletosTab — Onda 16 (Sistema Financeiro Completo).
 *
 * Lista TODAS as cobranças do tenant (sinal/entrada/parcelas de tratamento)
 * com filtros pesados:
 *  - Status (todos / em aberto / pagos / atrasados / vencendo)
 *  - Tipo (sinal / entrada / parcela)
 *  - Forma (PIX / BOLETO / CARTAO)
 *  - Período (por due_date)
 *  - Por paciente
 *  - Por dentista
 *
 * E ações por linha: Abrir boleto, copiar PIX, lembrete WhatsApp, marcar
 * pago em espécie (quando aplicável), abrir ficha do paciente.
 *
 * Endpoint: GET /financeiro/charges
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2, Search, AlertTriangle, Clock, Check, ExternalLink,
  Copy, MessageCircle, DollarSign, FileText, Filter, X,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Charge {
  id: string;
  external_id: string;
  gateway: string;
  billing_type: string;
  kind: string | null;
  status: string;
  computed_status: 'PAGO' | 'CANCELADO' | 'ATRASADO' | 'EM_ABERTO';
  amount: number;
  net_value: number | null;
  due_date: string;
  paid_at: string | null;
  payment_date: string | null;
  received_in_cash: boolean;
  days_overdue: number;
  description: string | null;
  boleto_url: string | null;
  pix_qr_code: string | null;
  pix_copy_paste: string | null;
  invoice_url: string | null;
  treatment_plan_id: string | null;
  installment_id: string | null;
  installment_label: string | null;
  patient: { id: string; name: string | null; phone: string | null } | null;
  dentist: { id: string; name: string } | null;
  quote_number: number | null;
  created_at: string;
}

interface Props {
  dentistId?: string;
}

const fmtBRL = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');

const STATUS_GROUPS = [
  { key: 'all', label: 'Todos', icon: FileText, color: 'text-foreground' },
  { key: 'open', label: 'Em aberto', icon: Clock, color: 'text-blue-400' },
  { key: 'overdue', label: 'Atrasados', icon: AlertTriangle, color: 'text-red-400' },
  { key: 'upcoming', label: 'Vencem 7d', icon: Clock, color: 'text-amber-400' },
  { key: 'paid', label: 'Pagos', icon: Check, color: 'text-emerald-400' },
] as const;

const KIND_LABEL: Record<string, string> = {
  SINAL: 'Sinal',
  ENTRADA: 'Entrada',
  INSTALLMENT: 'Parcela',
};

const computedStatusBadge = (status: Charge['computed_status']) => {
  const map = {
    PAGO: { bg: 'bg-emerald-500/15', text: 'text-emerald-400', label: 'Pago' },
    EM_ABERTO: { bg: 'bg-blue-500/15', text: 'text-blue-400', label: 'Em aberto' },
    ATRASADO: { bg: 'bg-red-500/15', text: 'text-red-400', label: 'Atrasado' },
    CANCELADO: { bg: 'bg-muted', text: 'text-muted-foreground', label: 'Cancelado' },
  } as const;
  const s = map[status];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${s.bg} ${s.text}`}>
      {s.label}
    </span>
  );
};

const waLink = (phone: string | null, msg: string) => {
  if (!phone) return null;
  const clean = phone.replace(/\D/g, '');
  return `https://wa.me/${clean}?text=${encodeURIComponent(msg)}`;
};

export default function BoletosTab({ dentistId }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [charges, setCharges] = useState<Charge[]>([]);
  const [total, setTotal] = useState(0);
  // Default 'all' — mostra TODOS os boletos ja gerados (pagos +
  // em aberto + atrasados + cancelados? -> cancelados filtrados na
  // query). Quer filtrar? Os chips no topo trocam o grupo.
  const [statusGroup, setStatusGroup] = useState<typeof STATUS_GROUPS[number]['key']>('all');
  const [kind, setKind] = useState<string>('');
  const [billingType, setBillingType] = useState<string>('');
  const [search, setSearch] = useState('');
  const [markingCash, setMarkingCash] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params: any = { limit: 200 };
      if (statusGroup !== 'all') params.statusGroup = statusGroup;
      if (kind) params.kind = kind;
      if (billingType) params.billingType = billingType;
      if (dentistId) params.dentistId = dentistId;
      const r = await api.get('/financeiro/charges', { params });
      setCharges(r.data?.data || []);
      setTotal(r.data?.total || 0);
    } catch (e: any) {
      // Onda 16.1 — mostra status code + mensagem do backend pra debugar.
      // Quando backend ainda nao deployou, da 404; quando query falha, 500
      // + mensagem clara. Ajuda muito pra ngm ficar adivinhando.
      const status = e?.response?.status;
      const msg = e?.response?.data?.message || e?.message || 'erro desconhecido';
      if (status === 404) {
        showError('Endpoint /financeiro/charges não disponível. Backend ainda não deployou — aguarde o redeploy completar.');
      } else {
        showError(`Erro ao carregar boletos (${status || 'sem status'}): ${msg}`);
      }
    } finally {
      setLoading(false);
    }
  }, [statusGroup, kind, billingType, dentistId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const filtered = useMemo(() => {
    if (!search.trim()) return charges;
    const s = search.toLowerCase();
    return charges.filter(
      (c) =>
        c.patient?.name?.toLowerCase().includes(s) ||
        c.dentist?.name?.toLowerCase().includes(s) ||
        c.installment_label?.toLowerCase().includes(s) ||
        String(c.quote_number || '').includes(s),
    );
  }, [charges, search]);

  // Stats da lista atual (count + R$)
  const stats = useMemo(() => {
    return filtered.reduce(
      (acc, c) => {
        acc.totalValue += c.amount;
        if (c.computed_status === 'PAGO') acc.paid += c.amount;
        else if (c.computed_status === 'ATRASADO') acc.overdue += c.amount;
        else if (c.computed_status === 'EM_ABERTO') acc.open += c.amount;
        return acc;
      },
      { totalValue: 0, paid: 0, open: 0, overdue: 0 },
    );
  }, [filtered]);

  const handleMarkCash = async (c: Charge) => {
    if (!confirm(`Marcar ${c.installment_label || 'cobrança'} de ${c.patient?.name} (${fmtBRL(c.amount)}) como recebida em espécie?`)) return;
    setMarkingCash(c.id);
    try {
      await api.post(`/payment-gateway/charges/${c.id}/mark-cash-received`);
      showSuccess('Marcado como recebido em espécie');
      fetchData();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao marcar como pago');
    } finally {
      setMarkingCash(null);
    }
  };

  const handleCopyPix = async (pix: string) => {
    try {
      await navigator.clipboard.writeText(pix);
      showSuccess('PIX copia-e-cola copiado');
    } catch {
      showError('Não foi possível copiar');
    }
  };

  // Agrupa a visão "Todos" em Em Aberto / Vencidos / Pagos, cada grupo por data
  // (aberto e vencidos por vencimento; pagos pelo pagamento mais recente). Com um
  // chip específico selecionado o backend já filtrou → lista única, sem cabeçalho.
  const groups = useMemo(() => {
    if (statusGroup !== 'all') {
      return [{ key: 'flat', label: '', icon: FileText, color: 'text-foreground', rows: filtered, total: filtered.reduce((s, c) => s + c.amount, 0) }];
    }
    const byDueAsc = (a: Charge, b: Charge) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime();
    const paidTime = (c: Charge) => new Date(c.paid_at || c.payment_date || c.due_date).getTime();
    const emAberto = filtered.filter((c) => c.computed_status === 'EM_ABERTO').sort(byDueAsc);
    const vencidos = filtered.filter((c) => c.computed_status === 'ATRASADO').sort(byDueAsc);
    const pagos = filtered.filter((c) => c.computed_status === 'PAGO').sort((a, b) => paidTime(b) - paidTime(a));
    const sum = (rows: Charge[]) => rows.reduce((s, c) => s + c.amount, 0);
    return [
      { key: 'aberto', label: 'Em Aberto', icon: Clock, color: 'text-blue-400', rows: emAberto, total: sum(emAberto) },
      { key: 'vencidos', label: 'Vencidos', icon: AlertTriangle, color: 'text-red-400', rows: vencidos, total: sum(vencidos) },
      { key: 'pagos', label: 'Pagos', icon: Check, color: 'text-emerald-400', rows: pagos, total: sum(pagos) },
    ].filter((g) => g.rows.length > 0);
  }, [filtered, statusGroup]);

  return (
    <div className="space-y-4">
      {/* Filtros */}
      <div className="bg-card border border-border rounded-xl p-3 space-y-3">
        {/* Status chips */}
        <div className="flex items-center gap-1 overflow-x-auto">
          {STATUS_GROUPS.map((g) => {
            const Icon = g.icon;
            return (
              <button
                key={g.key}
                onClick={() => setStatusGroup(g.key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${
                  statusGroup === g.key
                    ? 'bg-primary text-primary-foreground'
                    : `bg-background border border-border ${g.color} hover:bg-accent/30`
                }`}
              >
                <Icon size={13} />
                {g.label}
              </button>
            );
          })}
        </div>

        {/* Filtros secundários */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-background border border-border rounded-lg flex-1 min-w-[200px]">
            <Search size={13} className="text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar paciente, dentista, parcela..."
              className="flex-1 bg-transparent text-xs focus:outline-none"
            />
          </div>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="px-3 py-1.5 text-xs bg-background border border-border rounded-lg focus:outline-none"
          >
            <option value="">Todos os tipos</option>
            <option value="SINAL">Sinal</option>
            <option value="ENTRADA">Entrada</option>
            <option value="INSTALLMENT">Parcela</option>
          </select>
          <select
            value={billingType}
            onChange={(e) => setBillingType(e.target.value)}
            className="px-3 py-1.5 text-xs bg-background border border-border rounded-lg focus:outline-none"
          >
            <option value="">Toda forma</option>
            <option value="PIX">PIX</option>
            <option value="BOLETO">Boleto</option>
            <option value="CREDIT_CARD">Cartão</option>
          </select>
        </div>

        {/* Stats da listagem atual */}
        <div className="flex items-center gap-4 pt-2 border-t border-border/50 text-[10px] font-bold uppercase tracking-wider">
          <span className="text-muted-foreground">
            {filtered.length} de {total} cobrança(s)
          </span>
          <span className="text-foreground">
            Total: <span className="tabular-nums">{fmtBRL(stats.totalValue)}</span>
          </span>
          {stats.overdue > 0 && (
            <span className="text-red-400">
              Atrasado: <span className="tabular-nums">{fmtBRL(stats.overdue)}</span>
            </span>
          )}
          {stats.open > 0 && (
            <span className="text-blue-400">
              Em aberto: <span className="tabular-nums">{fmtBRL(stats.open)}</span>
            </span>
          )}
        </div>
      </div>

      {/* Lista */}
      {loading ? (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <Loader2 size={24} className="mx-auto animate-spin text-primary" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <FileText size={32} className="mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">Nenhuma cobrança encontrada nos filtros</p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Paciente</th>
                  <th className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Tipo</th>
                  <th className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide text-right">Valor</th>
                  <th className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Vencimento</th>
                  <th className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Forma</th>
                  <th className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide text-center">Status</th>
                  <th className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide text-center">Ações</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const GIcon = g.icon;
                  return (
                  <Fragment key={g.key}>
                  {g.label && (
                    <tr className="bg-muted/40 border-y border-border">
                      <td colSpan={7} className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <GIcon size={13} className={g.color} />
                          <span className="text-[11px] font-bold uppercase tracking-wide text-foreground">{g.label}</span>
                          <span className="text-[10px] text-muted-foreground">({g.rows.length})</span>
                          <span className={`ml-auto text-[11px] font-bold tabular-nums ${g.color}`}>{fmtBRL(g.total)}</span>
                        </div>
                      </td>
                    </tr>
                  )}
                  {g.rows.map((c) => {
                  const isOverdue = c.computed_status === 'ATRASADO';
                  const isPaid = c.computed_status === 'PAGO';
                  const reminderMsg = `Olá ${c.patient?.name || ''}! Lembrando do pagamento de ${fmtBRL(c.amount)} (${c.installment_label}) com vencimento em ${fmtDate(c.due_date)}.${
                    c.boleto_url ? ` Boleto: ${c.boleto_url}` : ''
                  }`;
                  return (
                    <tr key={c.id} className="border-b border-border/50 hover:bg-accent/10 transition-colors">
                      <td className="px-3 py-2.5">
                        <div className="flex flex-col">
                          <button
                            onClick={() => c.patient?.id && router.push(`/atendimento/pacientes/${c.patient.id}`)}
                            className="text-sm font-semibold text-foreground hover:text-primary text-left"
                          >
                            {c.patient?.name || 'Sem nome'}
                          </button>
                          {c.dentist?.name && (
                            <span className="text-[10px] text-muted-foreground">{c.dentist.name}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="text-xs text-foreground">
                          {c.installment_label || KIND_LABEL[c.kind || ''] || '—'}
                        </span>
                        {c.quote_number && (
                          <span className="text-[10px] text-muted-foreground ml-1.5">#{c.quote_number}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <span className={`text-sm font-bold tabular-nums ${isPaid ? 'text-emerald-400' : isOverdue ? 'text-red-400' : 'text-foreground'}`}>
                          {fmtBRL(c.amount)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-col">
                          <span className="text-xs text-foreground tabular-nums">{fmtDate(c.due_date)}</span>
                          {isOverdue && (
                            <span className="text-[10px] text-red-400 font-semibold">{c.days_overdue}d em atraso</span>
                          )}
                          {isPaid && c.paid_at && (
                            <span className="text-[10px] text-emerald-400">Pago em {fmtDate(c.paid_at)}</span>
                          )}
                          {c.received_in_cash && (
                            <span className="text-[10px] text-emerald-400 font-semibold">Espécie</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="text-[10px] text-muted-foreground">{c.billing_type}</span>
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        {computedStatusBadge(c.computed_status)}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center justify-center gap-1">
                          {c.boleto_url && (
                            <a
                              href={c.boleto_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="p-1.5 rounded-lg hover:bg-accent/30 text-muted-foreground hover:text-primary transition-colors"
                              title="Abrir boleto"
                            >
                              <ExternalLink size={13} />
                            </a>
                          )}
                          {c.pix_copy_paste && (
                            <button
                              onClick={() => handleCopyPix(c.pix_copy_paste!)}
                              className="p-1.5 rounded-lg hover:bg-accent/30 text-muted-foreground hover:text-primary transition-colors"
                              title="Copiar PIX copia-e-cola"
                            >
                              <Copy size={13} />
                            </button>
                          )}
                          {!isPaid && c.patient?.phone && (
                            <a
                              href={waLink(c.patient.phone, reminderMsg) || '#'}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="p-1.5 rounded-lg hover:bg-emerald-500/15 text-emerald-400 transition-colors"
                              title="Lembrete via WhatsApp"
                            >
                              <MessageCircle size={13} />
                            </a>
                          )}
                          {!isPaid && c.gateway !== 'CASH' && (
                            <button
                              onClick={() => handleMarkCash(c)}
                              disabled={markingCash === c.id}
                              className="p-1.5 rounded-lg hover:bg-emerald-500/15 text-emerald-400 transition-colors disabled:opacity-50"
                              title="Marcar como recebido em espécie"
                            >
                              {markingCash === c.id ? <Loader2 size={13} className="animate-spin" /> : <DollarSign size={13} />}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                  })}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
