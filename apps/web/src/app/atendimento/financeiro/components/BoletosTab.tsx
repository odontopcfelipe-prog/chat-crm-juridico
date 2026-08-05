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
  Copy, MessageCircle, DollarSign, FileText, Filter, X, Trash2,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { PatientAvatar } from '@/components/PatientAvatar';
// Apagar boleto é ADMIN-only.
import { useRole } from '@/lib/useRole';

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
  patient: { id: string; name: string | null; phone: string | null; cpf: string | null; avatar_url?: string | null } | null;
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
  { key: 'open', label: 'Em aberto', icon: Clock, color: 'text-blue-400' },
  { key: 'overdue', label: 'Atrasados', icon: AlertTriangle, color: 'text-red-400' },
  { key: 'upcoming', label: 'Vencem 7d', icon: Clock, color: 'text-amber-400' },
  { key: 'paid', label: 'Pagos', icon: Check, color: 'text-emerald-400' },
] as const;
// "Todos" saiu dos chips: a visão SEM filtro já é a agrupada (Em Aberto/Vencidos/Pagos).
// 'all' segue como estado-base (nenhum chip ativo); clicar no chip ativo volta pra ele.
type StatusGroup = 'all' | typeof STATUS_GROUPS[number]['key'];

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
  // Default 'all' = visão agrupada (Em Aberto / Vencidos / Pagos), sem chip ativo.
  // Clicar num chip filtra; clicar de novo no chip ativo volta pra visão agrupada.
  const [statusGroup, setStatusGroup] = useState<StatusGroup>('all');
  const [kind, setKind] = useState<string>('');
  const [billingType, setBillingType] = useState<string>('');
  const [search, setSearch] = useState('');
  const [markingCash, setMarkingCash] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const role = useRole(); // role.isAdmin gateia o botão de apagar boleto

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
    const s = search.trim().toLowerCase();
    if (!s) return charges;
    const digits = s.replace(/\D/g, ''); // dígitos do termo — pra casar telefone/CPF sem máscara
    return charges.filter((c) => {
      if (
        c.patient?.name?.toLowerCase().includes(s) ||
        c.dentist?.name?.toLowerCase().includes(s) ||
        c.installment_label?.toLowerCase().includes(s) ||
        String(c.quote_number || '').includes(s)
      ) return true;
      // Telefone / CPF: compara SÓ dígitos (ignora máscara/pontuação dos dois lados).
      if (digits.length >= 3) {
        const phoneDigits = (c.patient?.phone || '').replace(/\D/g, '');
        const cpfDigits = (c.patient?.cpf || '').replace(/\D/g, '');
        if (phoneDigits.includes(digits) || cpfDigits.includes(digits)) return true;
      }
      return false;
    });
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

  // "Este mês": só as cobranças com VENCIMENTO no mês atual (respeita a busca).
  const monthStats = useMemo(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    return filtered.reduce(
      (acc, c) => {
        const d = new Date(c.due_date);
        if (d.getFullYear() !== y || d.getMonth() !== m) return acc;
        acc.count += 1;
        acc.totalValue += c.amount;
        if (c.computed_status === 'ATRASADO') acc.overdue += c.amount;
        else if (c.computed_status === 'EM_ABERTO') acc.open += c.amount;
        else if (c.computed_status === 'PAGO') acc.paid += c.amount;
        return acc;
      },
      { count: 0, totalValue: 0, paid: 0, open: 0, overdue: 0 },
    );
  }, [filtered]);
  const mesLabel = new Date().toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');

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

  // Apagar boleto (ADMIN) — apaga no Asaas E no sistema, silenciosamente.
  const handleDeleteBoleto = async (c: Charge) => {
    if (deletingId) return;
    if (c.status === 'RECEIVED' || c.status === 'CONFIRMED' || c.received_in_cash) {
      showError('Cobrança já paga — não pode ser apagada.');
      return;
    }
    if (!c.external_id) { showError('Cobrança sem ID do Asaas — não dá pra apagar.'); return; }
    if (!confirm(
      `APAGAR o boleto de ${c.patient?.name || 'paciente'} (${fmtBRL(c.amount)})?\n\n` +
      `Apaga NO ASAAS e NO SISTEMA — não dá pra desfazer. O paciente NÃO é avisado.\n` +
      `Use só pra cobrança gerada por engano (nunca em cobrança já paga).`,
    )) return;
    setDeletingId(c.id);
    try {
      await api.delete(`/payment-gateway/charges/asaas/${c.external_id}`);
      showSuccess('Boleto apagado (Asaas + sistema).');
      fetchData();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao apagar o boleto.');
    } finally {
      setDeletingId(null);
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
                onClick={() => setStatusGroup((prev) => (prev === g.key ? 'all' : g.key))}
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
              placeholder="Buscar por nome, telefone ou CPF..."
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
        <div className="flex items-center gap-x-4 gap-y-1 flex-wrap pt-2 border-t border-border/50 text-[10px] font-bold uppercase tracking-wider">
          {/* Esquerda: geral (todas as cobranças carregadas) */}
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

          {/* Direita: só o mês atual (por vencimento) */}
          <span className="ml-auto flex items-center gap-1.5 text-muted-foreground">
            <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary">Este mês ({mesLabel})</span>
            {monthStats.count} cobrança(s)
          </span>
          <span className="text-foreground">
            Total: <span className="tabular-nums">{fmtBRL(monthStats.totalValue)}</span>
          </span>
          {monthStats.overdue > 0 && (
            <span className="text-red-400">
              Atrasado: <span className="tabular-nums">{fmtBRL(monthStats.overdue)}</span>
            </span>
          )}
          {monthStats.open > 0 && (
            <span className="text-blue-400">
              Em aberto: <span className="tabular-nums">{fmtBRL(monthStats.open)}</span>
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
                        <div className="flex items-center gap-2.5">
                          {c.patient && (
                            <PatientAvatar
                              patientId={c.patient.id}
                              patientName={c.patient.name || 'Sem nome'}
                              avatarUrl={c.patient.avatar_url}
                              size={28}
                              shape="circle"
                            />
                          )}
                          <div className="flex flex-col min-w-0">
                            <button
                              onClick={() => c.patient?.id && router.push(`/atendimento/pacientes/${c.patient.id}`)}
                              className="text-sm font-semibold text-foreground hover:text-primary text-left truncate"
                            >
                              {c.patient?.name || 'Sem nome'}
                            </button>
                            {c.dentist?.name && (
                              <span className="text-[10px] text-muted-foreground">{c.dentist.name}</span>
                            )}
                          </div>
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
                          {/* Apagar — SOMENTE ADMIN, só enquanto NÃO paga. Apaga no Asaas + sistema. */}
                          {role.isAdmin && !isPaid && c.external_id && (
                            <button
                              onClick={() => handleDeleteBoleto(c)}
                              disabled={deletingId === c.id}
                              className="p-1.5 rounded-lg hover:bg-red-500/15 text-red-500 transition-colors disabled:opacity-50"
                              title="Apagar cobrança no Asaas e no sistema (admin)"
                            >
                              {deletingId === c.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
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
