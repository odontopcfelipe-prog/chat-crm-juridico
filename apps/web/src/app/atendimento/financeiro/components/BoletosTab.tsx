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
  Copy, MessageCircle, DollarSign, FileText, Filter, X, Trash2, Users, ChevronRight, ChevronDown,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { PatientAvatar } from '@/components/PatientAvatar';
// Apagar boleto é ADMIN-only.
import { useRole } from '@/lib/useRole';
import BoletosKpis, { type ChargesKpis } from './BoletosKpis';

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
  // Onda 18.x — "Negativados" no lugar de "Em aberto": visão POR PACIENTE (ordem
  // alfabética) de quem tem ≥1 boleto atrasado; cada paciente expande e mostra
  // todos os boletos em aberto dele (atrasados + a vencer). O backend traz a
  // carteira inteira dos devedores (statusGroup=negativados).
  { key: 'negativados', label: 'Negativados', icon: Users, color: 'text-red-400' },
  { key: 'upcoming', label: 'Vencem 7d', icon: Clock, color: 'text-amber-400' },
  { key: 'paid', label: 'Pagos', icon: Check, color: 'text-emerald-400' },
  { key: 'all', label: 'Todos', icon: Users, color: 'text-foreground' },
] as const;
// Abas EXCLUSIVAS: cada chip mostra SÓ o seu status (lista única). O chip "Todos"
// (Onda 18.x) é POR PACIENTE: todo mundo que tem boleto, com pagos/abertos/atrasados/
// cancelados. Abre em "Negativados".
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
  // Abre em "Negativados". Chips são abas exclusivas — clicar troca o status mostrado
  // (o chip "Todos" volta pra visão agrupada). Nunca fica sem nenhum ativo.
  const [statusGroup, setStatusGroup] = useState<StatusGroup>('negativados');
  // Negativados: pacientes expandidos (id → true). Começa tudo recolhido.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleExpanded = (id: string) => setExpanded((p) => ({ ...p, [id]: !p[id] }));
  const [kind, setKind] = useState<string>('');
  const [billingType, setBillingType] = useState<string>('');
  const [search, setSearch] = useState('');
  // Busca é SERVER-SIDE (atravessa toda a carteira, não só as 200 carregadas).
  // Debounce pra não bater na API a cada tecla.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(t);
  }, [search]);
  const searching = debouncedSearch.trim().length > 0;
  const [markingCash, setMarkingCash] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const role = useRole(); // role.isAdmin gateia o botão de apagar boleto
  // Onda 18.x — KPIs do dashboard (carteira inteira, por chip). Recarrega junto com a lista.
  const [kpis, setKpis] = useState<ChargesKpis | null>(null);
  const [kpisLoading, setKpisLoading] = useState(true);
  const fetchKpis = useCallback(async () => {
    setKpisLoading(true);
    try {
      const r = await api.get<ChargesKpis>('/financeiro/charges/kpis', { params: dentistId ? { dentistId } : {} });
      setKpis(r.data);
    } catch { /* dashboard é best-effort — a lista continua */ }
    finally { setKpisLoading(false); }
  }, [dentistId]);
  useEffect(() => { fetchKpis(); }, [fetchKpis]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const term = debouncedSearch.trim();
      // Negativados/Todos agrupam por paciente no front → pedem a carteira (tetos 2000/5000 no back).
      const params: any = { limit: term ? 500 : statusGroup === 'negativados' ? 2000 : statusGroup === 'all' ? 5000 : 200 };
      // Buscando um paciente → traz TODOS os status dele (pago/aberto/atrasado):
      // manda `search` e NÃO manda statusGroup (o chip é ignorado durante a busca).
      if (term) params.search = term;
      else params.statusGroup = statusGroup === 'all' ? 'all_patients' : statusGroup;
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
  }, [statusGroup, kind, billingType, dentistId, debouncedSearch]);

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
      fetchKpis();
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
      fetchKpis();
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
  type Group = {
    key: string; label: string; icon: any; color: string; rows: Charge[]; total: number;
    // Negativados (por paciente): cabeçalho recolhível + resumo.
    patient?: Charge['patient'];
    overdueCount?: number; overdueTotal?: number; openCount?: number;
    paidCount?: number; paidTotal?: number; cancelledCount?: number; openTotal?: number;
    // Pagos: divisória por DIA do pagamento.
    dateGroup?: boolean;
  };
  const groups = useMemo<Group[]>(() => {
    // Onda 18.x — POR PACIENTE (ordem alfabética, recolhido por padrão):
    //  • NEGATIVADOS: só quem tem ≥1 atrasado (back manda a carteira em aberto deles);
    //  • TODOS: todo paciente com boleto no sistema, com TUDO que negociou — pagos,
    //    em aberto, atrasados e cancelados/apagados (back manda a carteira inteira).
    // Sem paciente resolvido → "Sem nome" no fim.
    if ((statusGroup === 'negativados' || statusGroup === 'all') && !searching) {
      const onlyDebtors = statusGroup === 'negativados';
      const byPatient = new Map<string, Group>();
      for (const c of filtered) {
        const pid = c.patient?.id || '__sem_nome__';
        let g = byPatient.get(pid);
        if (!g) {
          g = {
            key: `p-${pid}`, label: c.patient?.name || 'Sem nome', icon: Users, color: onlyDebtors ? 'text-red-400' : 'text-foreground',
            rows: [], total: 0, patient: c.patient,
            overdueCount: 0, overdueTotal: 0, openCount: 0, paidCount: 0, paidTotal: 0, cancelledCount: 0, openTotal: 0,
          };
          byPatient.set(pid, g);
        }
        g.rows.push(c);
        g.total += c.amount;
        if (c.computed_status === 'ATRASADO') { g.overdueCount!++; g.overdueTotal! += c.amount; g.openTotal! += c.amount; }
        else if (c.computed_status === 'EM_ABERTO') { g.openCount!++; g.openTotal! += c.amount; }
        else if (c.computed_status === 'PAGO') { g.paidCount!++; g.paidTotal! += c.amount; }
        else if (c.computed_status === 'CANCELADO') g.cancelledCount!++;
      }
      const byDueAsc = (a: Charge, b: Charge) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime();
      return [...byPatient.values()]
        // Negativados: só quem tem ≥1 atrasado (o back já garante; defesa se um filtro
        // secundário — tipo/forma — deixou o paciente só com boletos a vencer).
        .filter((g) => !onlyDebtors || (g.overdueCount || 0) > 0)
        .map((g) => ({ ...g, rows: g.rows.sort(byDueAsc) }))
        .sort((a, b) => {
          if (a.key === 'p-__sem_nome__') return 1;
          if (b.key === 'p-__sem_nome__') return -1;
          return a.label.localeCompare(b.label, 'pt-BR', { sensitivity: 'base' });
        });
    }
    // Onda 18.x — PAGOS: uma divisória por DIA do pagamento (mais recente primeiro),
    // com quantidade e total do dia. Dentro do dia, do pagamento mais recente ao mais
    // antigo. Sem data de pagamento → "Sem data" no fim.
    if (statusGroup === 'paid' && !searching) {
      const paidIso = (c: Charge) => c.paid_at || c.payment_date || null;
      const dayKey = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('sv-SE') : '');
      const byDay = new Map<string, Group>();
      for (const c of filtered) {
        const iso = paidIso(c);
        const k = dayKey(iso);
        let g = byDay.get(k);
        if (!g) {
          const label = iso
            ? new Date(iso).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }).replace('.', '')
            : 'Sem data de pagamento';
          g = { key: `d-${k || 'none'}`, label, icon: Check, color: 'text-emerald-400', rows: [], total: 0, dateGroup: true };
          byDay.set(k, g);
        }
        g.rows.push(c);
        g.total += c.amount;
      }
      const t = (c: Charge) => new Date(paidIso(c) || 0).getTime();
      return [...byDay.entries()]
        .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : b.localeCompare(a))) // dia mais recente primeiro
        .map(([, g]) => ({ ...g, rows: g.rows.sort((a, b) => t(b) - t(a)) }));
    }
    // Buscando um paciente → sempre a visão agrupada (mostra pago + aberto + atrasado
    // dele de uma vez), ignorando o chip de status que estiver ativo.
    if (statusGroup !== 'all' && !searching) {
      // Lista única do filtro ativo, com cabeçalho (nome + contagem + total) pra
      // deixar claro qual status está sendo mostrado.
      const active = STATUS_GROUPS.find((g) => g.key === statusGroup);
      return [{ key: 'flat', label: active?.label || '', icon: active?.icon || FileText, color: active?.color || 'text-foreground', rows: filtered, total: filtered.reduce((s, c) => s + c.amount, 0) }];
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
  }, [filtered, statusGroup, searching]);

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
                title={searching ? 'Filtro de status ignorado durante a busca por paciente' : undefined}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${
                  searching ? 'opacity-40' : ''
                } ${
                  statusGroup === g.key && !searching
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

        {/* Onda 18.x — contagem da listagem (os KPIs de valor vivem no dashboard abaixo). */}
        <div className="flex items-center gap-2 pt-2 border-t border-border/50 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          <span>{filtered.length} de {total} cobrança(s) carregada(s)</span>
          <span className="ml-auto flex items-center gap-1.5">
            <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary">Este mês ({mesLabel})</span>
            {monthStats.count} cobrança(s) · {fmtBRL(monthStats.totalValue)}
          </span>
        </div>
      </div>

      {/* Onda 18.x — Dashboard de KPIs contextual ao chip (carteira inteira). */}
      <BoletosKpis kpis={kpis} chip={searching ? "all" : statusGroup} loading={kpisLoading} />

      {/* Lista */}
      {loading ? (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <Loader2 size={24} className="mx-auto animate-spin text-primary" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <FileText size={32} className="mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">
            {statusGroup === 'negativados' && !searching ? 'Nenhum paciente negativado — carteira em dia 🎉' : 'Nenhuma cobrança encontrada nos filtros'}
          </p>
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
                  const isPatientGroup = g.patient !== undefined;
                  const isOpen = !isPatientGroup || !!expanded[g.key];
                  return (
                  <Fragment key={g.key}>
                  {g.label && isPatientGroup ? (
                    // Negativados — linha do PACIENTE: clica pra expandir/recolher os boletos dele.
                    <tr
                      className="bg-muted/40 border-y border-border cursor-pointer hover:bg-accent/20 transition-colors"
                      onClick={() => toggleExpanded(g.key)}
                    >
                      <td colSpan={7} className="px-3 py-2.5">
                        <div className="flex items-center gap-2.5">
                          {isOpen ? <ChevronDown size={14} className="text-muted-foreground shrink-0" /> : <ChevronRight size={14} className="text-muted-foreground shrink-0" />}
                          {g.patient ? (
                            <PatientAvatar patientId={g.patient.id} patientName={g.label} avatarUrl={g.patient.avatar_url} size={28} shape="circle" />
                          ) : (
                            <div className="w-7 h-7 rounded-full bg-muted grid place-items-center"><Users size={13} className="text-muted-foreground" /></div>
                          )}
                          <div className="flex flex-col min-w-0">
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); g.patient?.id && router.push(`/atendimento/pacientes/${g.patient.id}?tab=financial`); }}
                              className="text-sm font-bold text-foreground hover:text-primary text-left truncate"
                              title="Abrir a ficha financeira do paciente"
                            >
                              {g.label}
                            </button>
                            {g.patient?.phone && <span className="text-[10px] text-muted-foreground">{g.patient.phone}</span>}
                          </div>
                          {/* Badges por status — só os que existem pro paciente. */}
                          <span className="flex items-center gap-1 flex-wrap">
                            {(g.overdueCount || 0) > 0 && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-500/15 text-red-400 whitespace-nowrap">
                                {g.overdueCount} atrasado{(g.overdueCount || 0) > 1 ? 's' : ''} · {fmtBRL(g.overdueTotal || 0)}
                              </span>
                            )}
                            {(g.openCount || 0) > 0 && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-500/15 text-blue-400 whitespace-nowrap">
                                {g.openCount} a vencer
                              </span>
                            )}
                            {(g.paidCount || 0) > 0 && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-500 whitespace-nowrap">
                                {g.paidCount} pago{(g.paidCount || 0) > 1 ? 's' : ''} · {fmtBRL(g.paidTotal || 0)}
                              </span>
                            )}
                            {(g.cancelledCount || 0) > 0 && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-muted text-muted-foreground whitespace-nowrap">
                                {g.cancelledCount} cancelado{(g.cancelledCount || 0) > 1 ? 's' : ''}
                              </span>
                            )}
                          </span>
                          <span className="ml-auto text-right whitespace-nowrap">
                            <span className="block text-[9px] uppercase tracking-wider text-muted-foreground">
                              {g.rows.length} boleto{g.rows.length > 1 ? 's' : ''} · {(g.openTotal || 0) > 0 ? 'em aberto' : 'nada em aberto'}
                            </span>
                            <span className={`text-[12px] font-bold tabular-nums ${(g.openTotal || 0) > 0 ? 'text-foreground' : 'text-emerald-500'}`}>
                              {(g.openTotal || 0) > 0 ? fmtBRL(g.openTotal || 0) : '✓ quitado'}
                            </span>
                          </span>
                        </div>
                      </td>
                    </tr>
                  ) : g.label && g.dateGroup ? (
                    <>
                    {/* Respiro em branco entre um dia e o próximo (não antes do primeiro). */}
                    {groups[0]?.key !== g.key && (
                      <tr aria-hidden className="bg-background">
                        <td colSpan={7} className="h-7 p-0 border-0" />
                      </tr>
                    )}
                    {/* Pagos — divisória por DIA: faixa verde forte com data, quantidade e total do dia. */}
                    {/* Mesma proporção dos cabeçalhos das outras abas (11px, py-2) — só a
                        cor verde e a borda de cima marcam a troca de dia. */}
                    <tr className="bg-emerald-500/[0.07] border-t-2 border-t-emerald-500/40 border-b border-border">
                      <td colSpan={7} className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <Check size={13} className="text-emerald-500" strokeWidth={3} />
                          <span className="text-[11px] font-bold uppercase tracking-wide text-foreground">{g.label}</span>
                          <span className="text-[10px] text-muted-foreground">
                            ({g.rows.length} pagamento{g.rows.length > 1 ? 's' : ''})
                          </span>
                          <span className="ml-auto text-[11px] font-bold tabular-nums text-emerald-500">{fmtBRL(g.total)}</span>
                        </div>
                      </td>
                    </tr>
                    </>
                  ) : g.label ? (
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
                  ) : null}
                  {isOpen && g.rows.map((c) => {
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
