'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  DollarSign, TrendingUp, TrendingDown, AlertTriangle, Clock, Target,
  Plus, X, Search, Loader2, Phone, MessageSquare,
  ArrowUpDown, ChevronDown, ChevronRight, Trash2, Pencil, Check, Handshake,
  BarChart3, Receipt, CreditCard, Ban, Users, Link2, Unlink, ExternalLink, FileText,
  CalendarClock, CheckCircle2,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useRole } from '@/lib/useRole';
import { useUserPermissions } from '@/lib/useUserPermissions';
// Onda 16 — abas novas do sistema financeiro completo
import BoletosTab from './components/BoletosTab';
import PacientesSummaryTab from './components/PacientesSummaryTab';
import ValidarTab from './components/ValidarTab';
// Fase 5 — lançador de diária (DESPESA category='DIARIA')
import DailyRateTab from './components/DailyRateTab';

/** Rótulo amigável da forma de pagamento no caixa (evita exibir o valor cru). */
const PAYMENT_METHOD_LABEL: Record<string, string> = {
  PIX: 'PIX',
  PIX_MAQUININHA: 'PIX maquininha',
  BOLETO: 'Boleto',
  CARTAO: 'Cartão',
  DINHEIRO: 'Dinheiro',
  TRANSFERENCIA: 'Transferência',
  MAQUININHA: 'Maquininha',
};
const methodLabel = (m: string | null | undefined): string =>
  m ? (PAYMENT_METHOD_LABEL[m] ?? m) : '--';

/* ──────────────────────────────────────────────────────────────
   Types
────────────────────────────────────────────────────────────── */
interface FinancialSummary {
  totalRevenue: number;
  totalExpenses: number;
  totalPayable: number;
  totalReceivable: number;
  totalOverdue: number;
  balance: number;
}

interface Transaction {
  id: string;
  type: 'RECEITA' | 'DESPESA';
  category: string;
  description: string;
  amount: string;
  date: string;
  due_date: string | null;
  paid_at: string | null;
  payment_method: string | null;
  status: 'PAGO' | 'PENDENTE' | 'CANCELADO';
  lead: { id: string; name: string; phone: string } | null;
  dentist: { id: string; name: string } | null;
  dentist_id?: string | null;
  honorario_payment_id?: string | null;
  notes?: string | null;
  interest_amount?: number;
  total_with_interest?: number;
  is_recurring?: boolean;
  recurrence_pattern?: string | null;
  parent_transaction_id?: string | null;
  honorario_payment?: {
    id: string;
    honorario: { type: string; notes: string | null; sentence_value: string | null; success_percentage: string | null } | null;
  } | null;
}

/**
 * Onda 16 — KPIs odontologicos vindos de GET /financeiro/dashboard.
 * Soma PaymentGatewayCharge (sinal/entrada/parcelas) + transactions.
 */
interface DashboardData {
  recebido_no_periodo: { value: number; count: number };
  a_receber_total: { value: number; count: number };
  atrasado: {
    value: number; count: number; dias_medio: number;
    /** Aging por faixa de atraso (opcional: backend pre-deploy nao retorna). */
    aging?: {
      d0_7: { count: number; value: number };
      d8_30: { count: number; value: number };
      d31_60: { count: number; value: number };
      d60_plus: { count: number; value: number };
    };
  };
  a_vencer_7d: { value: number; count: number };
  /** Taxa de realizacao: contratado x recebido acumulado (opcional pre-deploy). */
  realizacao?: { contratado: number; recebido: number; pct: number };
  /** Projecao de recebimento por janela futura (opcional pre-deploy). */
  projecao?: {
    d30: { value: number; count: number };
    d60: { value: number; count: number };
    d90: { value: number; count: number };
  };
  cashflow_30d: { date: string; value: number }[];
  proximos_vencimentos: {
    id: string;
    kind: string | null;
    amount: number;
    due_date: string;
    status: string;
    days_overdue: number;
    boleto_url: string | null;
    patient: { id: string; name: string | null; phone: string | null } | null;
  }[];
  top_atrasos: {
    id: string;
    kind: string | null;
    amount: number;
    due_date: string;
    status: string;
    days_overdue: number;
    boleto_url: string | null;
    patient: { id: string; name: string | null; phone: string | null } | null;
  }[];
  /** Onda 16.2 — entradas que efetivamente cairam HOJE (paid_at ou
   *  received_at no dia corrente). Opcional porque o backend antigo
   *  (pre-deploy) nao retorna esse campo — front cai pro fallback. */
  entrada_do_dia?: {
    value: number;
    count: number;
    items: {
      id: string;
      kind: string | null;
      amount: number;
      paid_at: string;
      billing_type: string;
      received_in_cash: boolean;
      patient: { id: string; name: string | null; phone: string | null } | null;
    }[];
  };
  /** Vendas do dia (produção): orçamentos aceitos hoje. */
  vendas_do_dia?: { value: number; count: number };
  now: string;
}

/* ──────────────────────────────────────────────────────────────
   Constants
────────────────────────────────────────────────────────────── */
// Onda 16 — TABS reorganizadas pra foco odontologico.
// Removidas (codigo preservado, so nao listadas): Cobrancas, Processos,
// Clientes, Inadimplencia — substituidas por Boletos + Pacientes.
// Fase 5 — "Diárias" entra na lista; a renderização da aba é gateada por
// manage_financial via useUserPermissions (ver visibleTabs no componente).
const TABS = ['Resumo', 'Validar', 'Receitas', 'Despesas', 'Boletos', 'Pacientes', 'Diárias', 'Log'] as const;
type Tab = typeof TABS[number];

const PERIODS = [
  { label: 'Hoje', value: 'hoje' },
  { label: 'Semana', value: 'semana' },
  { label: 'Mes', value: 'mes' },
  { label: 'Trimestre', value: 'trimestre' },
  { label: 'Ano', value: 'ano' },
] as const;

const MONTH_NAMES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

const RECEITA_CATEGORIES = ['Procedimento', 'Consulta', 'Produto', 'Outros'];
const DESPESA_CATEGORIES = ['Aluguel', 'Material Odontologico', 'Laboratorio', 'Folha de Pagamento', 'Contas (agua/luz/internet)', 'Equipamento', 'Outros'];

/* ──────────────────────────────────────────────────────────────
   Helpers
────────────────────────────────────────────────────────────── */
const fmt = (v: number | string) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    Math.round((typeof v === 'string' ? parseFloat(v) : v) * 100) / 100,
  );

const fmtDate = (d: string) => {
  const dt = new Date(d);
  return `${String(dt.getUTCDate()).padStart(2, '0')}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${dt.getUTCFullYear()}`;
};

function getPeriodRange(period: string): { startDate: string; endDate: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  let start: Date;
  let end: Date;

  // Mês específico: "mes-0" (jan) a "mes-11" (dez)
  if (period.startsWith('mes-')) {
    const monthIdx = parseInt(period.split('-')[1]);
    start = new Date(Date.UTC(y, monthIdx, 1));
    end = new Date(Date.UTC(y, monthIdx + 1, 0, 23, 59, 59));
  } else switch (period) {
    case 'hoje':
      start = new Date(Date.UTC(y, m, d));
      end = new Date(Date.UTC(y, m, d, 23, 59, 59));
      break;
    case 'semana': {
      const day = now.getUTCDay();
      const diff = day === 0 ? 6 : day - 1;
      start = new Date(Date.UTC(y, m, d - diff));
      end = new Date(Date.UTC(y, m, d - diff + 6, 23, 59, 59));
      break;
    }
    case 'trimestre':
      start = new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1));
      end = new Date(Date.UTC(y, Math.floor(m / 3) * 3 + 3, 0, 23, 59, 59));
      break;
    case 'ano':
      start = new Date(Date.UTC(y, 0, 1));
      end = new Date(Date.UTC(y, 11, 31, 23, 59, 59));
      break;
    default: // mes atual
      start = new Date(Date.UTC(y, m, 1));
      end = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59));
      break;
  }

  return {
    startDate: start.toISOString(),
    endDate: end.toISOString(),
  };
}

function daysOverdue(dueDate: string): number {
  const due = new Date(dueDate);
  const now = new Date();
  return Math.max(0, Math.floor((now.getTime() - due.getTime()) / (1000 * 60 * 60 * 24)));
}

function whatsappLink(phone: string, message: string): string {
  const clean = phone.replace(/\D/g, '');
  return `https://wa.me/${clean}?text=${encodeURIComponent(message)}`;
}

/* ──────────────────────────────────────────────────────────────
   KPI Card
────────────────────────────────────────────────────────────── */
function KpiCard({ icon: Icon, label, value, color, bgColor, hint, onClick }: {
  icon: any; label: string; value: string; color: string; bgColor: string; hint?: string; onClick?: () => void;
}) {
  return (
    <div
      className={`bg-card border border-border rounded-xl p-4 text-left w-full ${onClick ? 'cursor-pointer hover:border-emerald-500/40 hover:shadow-sm transition' : ''}`}
      title={hint}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
    >
      <div className={`w-8 h-8 rounded-lg ${bgColor} flex items-center justify-center mb-2`}>
        <Icon size={16} className={color} />
      </div>
      <p className={`text-lg font-bold ${color} tabular-nums whitespace-nowrap`}>{value}</p>
      <p className="text-[10px] text-muted-foreground mt-0.5 font-semibold uppercase tracking-wide whitespace-nowrap overflow-hidden text-ellipsis">
        {label}{onClick && <span className="text-emerald-500 ml-0.5">→</span>}
      </p>
    </div>
  );
}

/** Taxa de realização: quanto do contratado (planos com cobrança) já entrou. */
function RealizacaoCard({ contratado, recebido, pct }: { contratado: number; recebido: number; pct: number }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
          <Target size={15} className="text-primary" /> Taxa de realização
        </h3>
        <span className="text-lg font-bold text-primary tabular-nums">{pct}%</span>
      </div>
      <div className="h-2.5 w-full rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-primary rounded-full transition-all duration-500" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="flex items-center justify-between mt-2 text-xs">
        <span className="text-muted-foreground">Recebido <span className="font-bold text-emerald-400 tabular-nums">{fmt(recebido)}</span></span>
        <span className="text-muted-foreground">Contratado <span className="font-bold text-foreground tabular-nums">{fmt(contratado)}</span></span>
      </div>
      <p className="text-[10px] text-muted-foreground mt-1">% do valor contratado (planos que já geraram cobrança) que entrou no caixa.</p>
    </div>
  );
}

/** Aging de inadimplência: distribuição do atrasado por faixa de dias. */
function AgingBar({ aging }: { aging: NonNullable<DashboardData['atrasado']['aging']> }) {
  const buckets = [
    { key: 'd0_7', label: '0-7d', count: aging.d0_7.count, value: aging.d0_7.value, color: 'bg-yellow-500' },
    { key: 'd8_30', label: '8-30d', count: aging.d8_30.count, value: aging.d8_30.value, color: 'bg-amber-500' },
    { key: 'd31_60', label: '31-60d', count: aging.d31_60.count, value: aging.d31_60.value, color: 'bg-orange-500' },
    { key: 'd60_plus', label: '60+d', count: aging.d60_plus.count, value: aging.d60_plus.value, color: 'bg-red-600' },
  ];
  const sum = buckets.reduce((s, b) => s + b.value, 0) || 1;
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <h3 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
        <AlertTriangle size={14} className="text-red-400" /> Inadimplência por faixa
      </h3>
      <div className="flex h-3 w-full rounded-full overflow-hidden bg-muted">
        {buckets.map((b) => (b.value > 0 ? (
          <div key={b.key} className={b.color} style={{ width: `${(b.value / sum) * 100}%` }} title={`${b.label}: ${fmt(b.value)} · ${b.count} cobrança(s)`} />
        ) : null))}
      </div>
      <div className="grid grid-cols-4 gap-2 mt-3">
        {buckets.map((b) => (
          <div key={b.key} className="text-center">
            <div className="flex items-center justify-center gap-1">
              <span className={`w-2 h-2 rounded-full ${b.color}`} />
              <span className="text-[10px] text-muted-foreground font-semibold">{b.label}</span>
            </div>
            <p className="text-xs font-bold text-foreground tabular-nums mt-0.5">{fmt(b.value)}</p>
            <p className="text-[10px] text-muted-foreground">{b.count} cob.</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Projeção de recebimento: cobranças em aberto com vencimento nos próximos 30/60/90 dias. */
function ProjecaoCard({ d30, d60, d90 }: {
  d30: { value: number; count: number };
  d60: { value: number; count: number };
  d90: { value: number; count: number };
}) {
  const rows = [
    { label: 'Próximos 30 dias', ...d30 },
    { label: '31 a 60 dias', ...d60 },
    { label: '61 a 90 dias', ...d90 },
  ];
  const total = d30.value + d60.value + d90.value;
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <h3 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
        <CalendarClock size={15} className="text-blue-400" /> Projeção de recebimento
      </h3>
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{r.label} <span className="text-[10px]">({r.count})</span></span>
            <span className="font-bold text-blue-400 tabular-nums">{fmt(r.value)}</span>
          </div>
        ))}
        <div className="h-px bg-border my-1" />
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground font-semibold">Total 90 dias</span>
          <span className="font-bold text-foreground tabular-nums">{fmt(total)}</span>
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground mt-2">Cobranças em aberto com vencimento futuro (não inclui as já atrasadas).</p>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Despesa Section (seção colapsável por status)
────────────────────────────────────────────────────────────── */
function DespesaSection({ icon: Icon, label, count, total, color, bgColor, borderColor, defaultOpen, rows, onRefresh, currentUserId, canManageAll }: {
  icon: any; label: string; count: number; total: number;
  color: string; bgColor: string; borderColor: string; defaultOpen: boolean;
  rows: Transaction[]; onRefresh: () => void; currentUserId?: string; canManageAll: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (count === 0) return null;
  return (
    <div className={`border ${borderColor} rounded-xl overflow-hidden`}>
      <button
        onClick={() => setOpen(v => !v)}
        className={`w-full flex items-center justify-between px-4 py-3 ${bgColor} hover:opacity-90 transition-opacity`}
      >
        <div className="flex items-center gap-2">
          <Icon size={15} className={color} />
          <span className={`text-sm font-bold ${color}`}>{label}</span>
          <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${bgColor} ${color}`}>{count}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-sm font-bold tabular-nums ${color}`}>
            {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(total)}
          </span>
          <ChevronDown size={14} className={`${color} transition-transform ${open ? 'rotate-180' : ''}`} />
        </div>
      </button>
      {open && (
        <div className="bg-card">
          <TransactionTable rows={rows} onRefresh={onRefresh} currentUserId={currentUserId} canManageAll={canManageAll} />
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Status Badge
────────────────────────────────────────────────────────────── */
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; text: string; label: string }> = {
    PAGO: { bg: 'bg-emerald-500/15', text: 'text-emerald-400', label: 'Pago' },
    PENDENTE: { bg: 'bg-amber-500/15', text: 'text-amber-400', label: 'Pendente' },
    CANCELADO: { bg: 'bg-gray-500/15', text: 'text-gray-400', label: 'Cancelado' },
  };
  const s = map[status] || map.PENDENTE;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${s.bg} ${s.text}`}>
      {s.label}
    </span>
  );
}

/* ──────────────────────────────────────────────────────────────
   Quick-Add Form
────────────────────────────────────────────────────────────── */
function QuickAddForm({ type, categories, onCreated, onManageCategories, allDbCategories }: {
  type: 'RECEITA' | 'DESPESA';
  categories: string[];
  onCreated: () => void;
  onManageCategories?: () => void;
  allDbCategories?: { id: string; type: string; name: string; icon: string | null }[];
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [desc, setDesc] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState(categories[0]);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [visibleToDentist, setVisibleToDentist] = useState(true);
  const [isPaid, setIsPaid] = useState(false);
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurrencePattern, setRecurrencePattern] = useState('MENSAL');
  const [recurrenceDay, setRecurrenceDay] = useState('');
  const [recurrenceEndDate, setRecurrenceEndDate] = useState('');
  const [showCatManager, setShowCatManager] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [savingCat, setSavingCat] = useState(false);
  const [deletingCatId, setDeletingCatId] = useState<string | null>(null);

  const reset = () => { setDesc(''); setAmount(''); setCategory(categories[0]); setDate(new Date().toISOString().slice(0, 10)); setDueDate(''); setPaymentMethod(''); setVisibleToDentist(true); setIsPaid(false); setIsRecurring(false); setRecurrencePattern('MENSAL'); setRecurrenceDay(''); setRecurrenceEndDate(''); };

  const handleAddCategory = async () => {
    if (!newCatName.trim()) return;
    setSavingCat(true);
    try {
      await api.post('/financeiro/categories', { type, name: newCatName.trim() });
      showSuccess(`Categoria "${newCatName.trim()}" adicionada`);
      setNewCatName('');
      onManageCategories?.();
    } catch { showError('Erro ao criar categoria'); }
    finally { setSavingCat(false); }
  };

  const handleDeleteCategory = async (catId: string) => {
    if (!confirm('Excluir esta categoria?')) return;
    setDeletingCatId(catId);
    try {
      await api.delete(`/financeiro/categories/${catId}`);
      showSuccess('Categoria removida');
      onManageCategories?.();
    } catch { showError('Erro ao excluir'); }
    finally { setDeletingCatId(null); }
  };

  const typeCats = (allDbCategories || []).filter(c => c.type === type);

  const handleSubmit = async () => {
    if (!desc.trim() || !amount) { showError('Preencha descricao e valor'); return; }
    const numVal = parseFloat(amount.replace(',', '.'));
    if (isNaN(numVal) || numVal <= 0) { showError('Valor invalido'); return; }
    setSaving(true);
    try {
      await api.post('/financeiro/transactions', {
        type,
        category,
        description: desc.trim(),
        amount: numVal,
        date: new Date(date + 'T12:00:00Z').toISOString(),
        due_date: dueDate ? new Date(dueDate + 'T12:00:00Z').toISOString() : new Date(date + 'T12:00:00Z').toISOString(),
        payment_method: paymentMethod || undefined,
        status: isPaid ? 'PAGO' : 'PENDENTE',
        paid_at: isPaid ? new Date().toISOString() : undefined,
        visible_to_dentist: type === 'DESPESA' ? visibleToDentist : true,
        is_recurring: isRecurring,
        recurrence_pattern: isRecurring ? recurrencePattern : undefined,
        recurrence_day: isRecurring && recurrenceDay ? parseInt(recurrenceDay) : undefined,
        recurrence_end_date: isRecurring && recurrenceEndDate ? recurrenceEndDate : undefined,
      });
      showSuccess(`${type === 'RECEITA' ? 'Receita' : 'Despesa'} criada`);
      reset();
      setOpen(false);
      onCreated();
    } catch {
      showError('Erro ao criar transacao');
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-semibold hover:opacity-90 transition-opacity"
      >
        <Plus size={14} /> Nova {type === 'RECEITA' ? 'Receita' : 'Despesa'}
      </button>
    );
  }

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-foreground">
          Nova {type === 'RECEITA' ? 'Receita' : 'Despesa'}
        </h3>
        <button onClick={() => { setOpen(false); reset(); }} className="text-muted-foreground hover:text-foreground">
          <X size={16} />
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <input
          placeholder="Descricao"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          className="bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <input
          placeholder="Valor (R$)"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <select
          value={paymentMethod}
          onChange={(e) => setPaymentMethod(e.target.value)}
          className="bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          <option value="">Forma de pagamento</option>
          <option value="PIX">PIX</option>
          <option value="CARTAO_CREDITO">Cartão de Crédito</option>
          <option value="CARTAO_DEBITO">Cartão de Débito</option>
          <option value="BOLETO">Boleto</option>
          <option value="DINHEIRO">Dinheiro</option>
          <option value="TRANSFERENCIA">Transferência</option>
        </select>
        <div>
          <label className="text-[10px] text-muted-foreground block mb-1">Data da compra</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground block mb-1">Vencimento</label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            placeholder="Vencimento"
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>
      </div>
      {/* Status de pagamento */}
      <div className="flex items-center gap-4 flex-wrap">
        <button
          type="button"
          onClick={() => setIsPaid(!isPaid)}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border transition-colors ${
            isPaid
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
              : 'border-border bg-background text-muted-foreground hover:bg-accent/30'
          }`}
        >
          <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${isPaid ? 'border-emerald-400 bg-emerald-400' : 'border-muted-foreground/40'}`}>
            {isPaid && <Check size={10} className="text-white" />}
          </div>
          <span className="text-xs font-semibold">{isPaid ? 'Já pago' : 'Pendente'}</span>
        </button>

        {/* Visibilidade para o dentista (só despesas) */}
        {type === 'DESPESA' && (
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={!visibleToDentist} onChange={e => setVisibleToDentist(!e.target.checked)}
              className="w-3.5 h-3.5 rounded border-border accent-primary" />
            <span className="text-xs text-muted-foreground">Ocultar do dentista</span>
          </label>
        )}
      </div>

      {/* Recorrência */}
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => setIsRecurring(!isRecurring)}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border transition-colors ${
            isRecurring
              ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-400'
              : 'border-border bg-background text-muted-foreground hover:bg-accent/30'
          }`}
        >
          <span className="text-sm">{isRecurring ? '🔄' : '↩️'}</span>
          <span className="text-xs font-semibold">{isRecurring ? 'Despesa recorrente' : 'Avulsa (única)'}</span>
        </button>

        {isRecurring && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3 border border-cyan-500/20 rounded-lg bg-cyan-500/5">
            <div>
              <label className="text-[10px] text-muted-foreground block mb-1">Frequência</label>
              <select value={recurrencePattern} onChange={e => setRecurrencePattern(e.target.value)}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none">
                <option value="MENSAL">Mensal</option>
                <option value="TRIMESTRAL">Trimestral</option>
                <option value="SEMESTRAL">Semestral</option>
                <option value="ANUAL">Anual</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground block mb-1">Dia do vencimento</label>
              <input type="number" min="1" max="31" value={recurrenceDay} onChange={e => setRecurrenceDay(e.target.value)}
                placeholder="Ex: 10"
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none" />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground block mb-1">Até quando (opcional)</label>
              <input type="date" value={recurrenceEndDate} onChange={e => setRecurrenceEndDate(e.target.value)}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none" />
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <button
          onClick={() => setShowCatManager(!showCatManager)}
          className="text-[10px] text-muted-foreground hover:text-primary transition-colors flex items-center gap-1"
        >
          <Pencil size={10} /> Gerenciar categorias
        </button>
        <button
          onClick={handleSubmit}
          disabled={saving}
          className="flex items-center gap-1.5 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          Salvar
        </button>
      </div>

      {/* Gerenciar categorias */}
      {showCatManager && (
        <div className="border border-border rounded-xl p-4 space-y-3 bg-accent/5">
          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
            Categorias de {type === 'DESPESA' ? 'Despesas' : 'Receitas'}
          </p>
          <div className="space-y-1.5">
            {typeCats.map(c => (
              <div key={c.id} className="flex items-center justify-between px-3 py-2 bg-background border border-border rounded-lg">
                <span className="text-xs text-foreground">{c.name}</span>
                <button onClick={() => handleDeleteCategory(c.id)} disabled={deletingCatId === c.id}
                  className="text-red-400 hover:bg-red-500/10 p-1 rounded transition-colors disabled:opacity-50">
                  {deletingCatId === c.id ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />}
                </button>
              </div>
            ))}
            {typeCats.length === 0 && (
              <p className="text-[10px] text-muted-foreground italic px-3 py-2">Nenhuma categoria cadastrada no banco</p>
            )}
          </div>
          <div className="flex gap-2">
            <input value={newCatName} onChange={e => setNewCatName(e.target.value)} placeholder="Nova categoria..."
              onKeyDown={e => e.key === 'Enter' && handleAddCategory()}
              className="flex-1 px-3 py-2 text-xs bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/40" />
            <button onClick={handleAddCategory} disabled={savingCat || !newCatName.trim()}
              className="px-3 py-2 text-xs bg-primary text-primary-foreground rounded-lg font-semibold hover:opacity-90 disabled:opacity-50 flex items-center gap-1">
              {savingCat ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />} Adicionar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Transaction Table
────────────────────────────────────────────────────────────── */
function TransactionTable({ rows, onRefresh, currentUserId, canManageAll }: { rows: Transaction[]; onRefresh: () => void; currentUserId?: string; canManageAll?: boolean }) {
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDesc, setEditDesc] = useState('');
  const [editAmount, setEditAmount] = useState('');
  const [editDueDate, setEditDueDate] = useState('');
  const [editMethod, setEditMethod] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const startEdit = (t: Transaction) => {
    setEditingId(t.id);
    setEditDesc(t.description);
    setEditAmount(String(t.amount));
    setEditDueDate(t.due_date?.slice(0, 10) || '');
    setEditMethod(t.payment_method || '');
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    setSavingEdit(true);
    try {
      await api.patch(`/financeiro/transactions/${editingId}`, {
        description: editDesc.trim(),
        amount: parseFloat(editAmount.replace(',', '.')),
        due_date: editDueDate ? new Date(editDueDate + 'T12:00:00Z').toISOString() : null,
        payment_method: editMethod || null,
      });
      showSuccess('Transação atualizada');
      setEditingId(null);
      onRefresh();
    } catch { showError('Erro ao salvar'); }
    finally { setSavingEdit(false); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Excluir esta transacao?')) return;
    setDeleting(id);
    try {
      await api.delete(`/financeiro/transactions/${id}`);
      showSuccess('Transacao removida');
      onRefresh();
    } catch {
      showError('Erro ao remover');
    } finally {
      setDeleting(null);
    }
  };

  const handleTogglePago = async (t: Transaction) => {
    const newStatus = t.status === 'PAGO' ? 'PENDENTE' : 'PAGO';
    try {
      await api.patch(`/financeiro/transactions/${t.id}`, {
        status: newStatus,
        paid_at: newStatus === 'PAGO' ? new Date().toISOString() : null,
      });
      showSuccess(newStatus === 'PAGO' ? 'Marcado como pago' : 'Revertido para pendente');
      onRefresh();
    } catch {
      showError('Erro ao atualizar status');
    }
  };

  if (rows.length === 0) {
    return (
      <div className="bg-card border border-border rounded-xl p-8 text-center">
        <Receipt size={32} className="mx-auto text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground">Nenhuma transacao encontrada</p>
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Data</th>
              <th className="px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Descricao</th>
              <th className="px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Categoria</th>
              <th className="px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide text-right">Valor</th>
              <th className="px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Vencimento</th>
              <th className="px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Forma Pgto</th>
              <th className="px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide text-center">Status</th>
              <th className="px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide text-center">Acoes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              editingId === t.id ? (
              /* ── Modo edição inline ── */
              <tr key={t.id} className="border-b border-border/50 bg-primary/5">
                <td className="px-4 py-2 text-foreground tabular-nums whitespace-nowrap">{fmtDate(t.date)}</td>
                <td className="px-4 py-2">
                  <input value={editDesc} onChange={e => setEditDesc(e.target.value)}
                    className="w-full px-2 py-1.5 text-xs bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/40" />
                </td>
                <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">{t.category}</td>
                <td className="px-4 py-2">
                  <input value={editAmount} onChange={e => setEditAmount(e.target.value)}
                    className="w-20 px-2 py-1.5 text-xs bg-background border border-border rounded-lg focus:outline-none text-right" />
                </td>
                <td className="px-4 py-2">
                  <input type="date" value={editDueDate} onChange={e => setEditDueDate(e.target.value)}
                    className="px-2 py-1.5 text-xs bg-background border border-border rounded-lg focus:outline-none" />
                </td>
                <td className="px-4 py-2">
                  <select value={editMethod} onChange={e => setEditMethod(e.target.value)}
                    className="px-2 py-1.5 text-xs bg-background border border-border rounded-lg focus:outline-none">
                    <option value="">-</option><option value="PIX">PIX</option><option value="CARTAO_CREDITO">Cartão Créd.</option>
                    <option value="CARTAO_DEBITO">Cartão Déb.</option><option value="BOLETO">Boleto</option>
                    <option value="DINHEIRO">Dinheiro</option><option value="TRANSFERENCIA">Transf.</option>
                  </select>
                </td>
                <td className="px-4 py-2 text-center"><StatusBadge status={t.status} /></td>
                <td className="px-4 py-2 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <button onClick={handleSaveEdit} disabled={savingEdit}
                      className="p-1.5 rounded-lg hover:bg-emerald-500/15 text-emerald-400 transition-colors disabled:opacity-50" title="Salvar">
                      {savingEdit ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                    </button>
                    <button onClick={() => setEditingId(null)} className="p-1.5 rounded-lg hover:bg-accent/30 text-muted-foreground" title="Cancelar">
                      <X size={14} />
                    </button>
                  </div>
                </td>
              </tr>
              ) : (
              /* ── Modo visualização ── */
              <tr key={t.id} className="border-b border-border/50 hover:bg-accent/10 transition-colors">
                <td className="px-4 py-3 text-foreground tabular-nums whitespace-nowrap">{fmtDate(t.date)}</td>
                <td className="px-4 py-3 text-foreground max-w-[200px]">
                  <span className="truncate block">{t.description}</span>
                  {t.is_recurring && <span className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-400 border border-cyan-500/20 mt-0.5 inline-block">🔄 Recorrente</span>}
                  {t.parent_transaction_id && <span className="text-[9px] text-muted-foreground/50 ml-1">(auto)</span>}
                </td>
                <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{t.category}</td>
                <td className={`px-4 py-3 text-right font-bold tabular-nums whitespace-nowrap ${t.type === 'RECEITA' ? 'text-emerald-400' : 'text-red-400'}`}>
                  {fmt(t.amount)}
                </td>
                <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{t.due_date ? fmtDate(t.due_date) : '--'}</td>
                <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{methodLabel(t.payment_method)}</td>
                <td className="px-4 py-3 text-center"><StatusBadge status={t.status} /></td>
                <td className="px-4 py-3 text-center">
                  {(() => {
                    const canEdit = canManageAll || t.dentist_id === currentUserId;
                    return (
                      <div className="flex items-center justify-center gap-1">
                        {canEdit && (
                          <button onClick={() => startEdit(t)}
                            className="p-1.5 rounded-lg hover:bg-accent/30 transition-colors text-muted-foreground hover:text-primary" title="Editar">
                            <Pencil size={14} />
                          </button>
                        )}
                        {canEdit && (
                          <button
                            onClick={() => handleTogglePago(t)}
                            className={`px-2 py-1 text-[10px] font-semibold rounded-md inline-flex items-center gap-1 transition-colors ${
                              t.status === 'PAGO'
                                ? 'text-amber-400 border border-amber-400/20 hover:bg-amber-400/10'
                                : 'text-emerald-400 border border-emerald-400/20 hover:bg-emerald-400/10'
                            }`}
                            title={t.status === 'PAGO' ? 'Reverter para pendente' : 'Marcar como pago'}
                          >
                            {t.status === 'PAGO' ? 'Reverter' : 'Pagar'}
                          </button>
                        )}
                        {canEdit && (
                          <button
                            onClick={() => handleDelete(t.id)}
                            disabled={deleting === t.id}
                            className="p-1.5 rounded-lg hover:bg-accent/30 transition-colors text-muted-foreground hover:text-red-400"
                            title="Excluir"
                          >
                            {deleting === t.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                          </button>
                        )}
                      </div>
                    );
                  })()}
                </td>
              </tr>
              )
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Monthly Chart (CSS only)
────────────────────────────────────────────────────────────── */
/**
 * Tendência dos últimos 6 meses. Fonte: GET /financeiro/cash-flow (groupBy=month),
 * que agrega FinancialTransaction não-cancelada — entries (RECEITA) e exits (DESPESA)
 * pelo MESMO critério (simétrico). A chave é YYYY-MM, então não mistura o mesmo mês de
 * anos diferentes (bug antigo do getUTCMonth). É independente do filtro de período da
 * tela: sempre mostra os 6 meses corridos.
 */
function MonthlyChart({ periods }: { periods: { period: string; entries: number; exits: number }[] }) {
  const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const now = new Date();
  const byKey = new Map(periods.map((p) => [p.period, p]));

  const monthlyData = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5 + i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const found = byKey.get(key);
    return { label: months[d.getUTCMonth()], receita: found?.entries || 0, despesa: found?.exits || 0 };
  });

  const hasData = monthlyData.some((d) => d.receita > 0 || d.despesa > 0);
  const maxVal = Math.max(...monthlyData.map((d) => Math.max(d.receita, d.despesa)), 1);

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <h3 className="text-sm font-bold text-foreground mb-1 flex items-center gap-2">
        <BarChart3 size={15} className="text-primary" />
        Receitas vs Despesas (6 meses)
      </h3>
      <p className="text-[10px] text-muted-foreground mb-3">Últimos 6 meses · não depende do filtro de período acima</p>
      {!hasData ? (
        <div className="flex flex-col items-center justify-center h-36 text-center">
          <BarChart3 size={24} className="text-muted-foreground/30 mb-2" />
          <p className="text-xs text-muted-foreground">Sem movimentações nos últimos 6 meses</p>
        </div>
      ) : (
        <>
          <div className="flex items-end gap-3 h-36">
            {monthlyData.map((d, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1">
                <div className="w-full flex items-end justify-center gap-1 h-28">
                  <div
                    className="w-3 bg-emerald-500/70 rounded-t-sm transition-all duration-300"
                    style={{ height: `${Math.max(2, (d.receita / maxVal) * 100)}%` }}
                    title={`Receita: ${fmt(d.receita)}`}
                  />
                  <div
                    className="w-3 bg-red-500/70 rounded-t-sm transition-all duration-300"
                    style={{ height: `${Math.max(2, (d.despesa / maxVal) * 100)}%` }}
                    title={`Despesa: ${fmt(d.despesa)}`}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground font-semibold">{d.label}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-center gap-4 mt-3">
            <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="w-2 h-2 rounded-full bg-emerald-500" /> Receitas
            </span>
            <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="w-2 h-2 rounded-full bg-red-500" /> Despesas
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   MAIN PAGE
══════════════════════════════════════════════════════════════ */
export default function FinanceiroPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('Resumo');
  const [period, setPeriod] = useState('mes');
  const [asaasBalance, setAsaasBalance] = useState<number | null>(null);

  const [summary, setSummary] = useState<FinancialSummary | null>(null);
  // Onda 16 — dashboard odontologico (charges + transactions)
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [receitas, setReceitas] = useState<Transaction[]>([]);
  const [despesas, setDespesas] = useState<Transaction[]>([]);
  const [overdue, setOverdue] = useState<Transaction[]>([]);
  // Onda 16 — tendência 6 meses (cash-flow), independente do filtro de período.
  const [cashFlow, setCashFlow] = useState<{ period: string; entries: number; exits: number }[]>([]);
  const [dentists, setDentists] = useState<{ id: string; name: string }[]>([]);
  const [filterDentistId, setFilterDentistId] = useState('');
  const [dbCategories, setDbCategories] = useState<{ id: string; type: string; name: string; icon: string | null }[]>([]);
  const { isAdmin, isFinanceiro, userId } = useRole();
  // Fase 5 — só quem tem manage_financial vê a aba "Diárias".
  const { hasPermission } = useUserPermissions();
  const canManageFinancial = hasPermission('manage_financial');
  // Diárias e Validar (libera tratamento) só pra quem tem manage_financial.
  const visibleTabs = TABS.filter((t) => (t !== 'Diárias' && t !== 'Validar') || canManageFinancial);

  /* ─── Auth guard + saldo Asaas + dentistas ─── */
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) { router.push('/atendimento/login'); return; }
    api.get('/payment-gateway/balance').then(r => setAsaasBalance(r.data?.balance ?? r.data?.value ?? null)).catch(() => {});
    api.get('/financeiro/categories').then(r => setDbCategories(r.data || [])).catch(() => {});
    if (isAdmin || isFinanceiro) {
      api.get('/users/lawyers').then(r => setDentists(r.data || [])).catch(() => {});
    }
  }, [router, isAdmin, isFinanceiro]);

  /* ─── Fetch data ─── */
  // Dentista não-admin vê apenas seus dados
  const effectiveDentistId = (isAdmin || isFinanceiro) ? filterDentistId : (userId || '');

  // Categorias dinâmicas do banco (com fallback para hardcoded)
  const despesaCats = dbCategories.filter(c => c.type === 'DESPESA').map(c => c.name);
  const receitaCats = dbCategories.filter(c => c.type === 'RECEITA').map(c => c.name);
  const activeDespesaCats = despesaCats.length > 0 ? despesaCats : DESPESA_CATEGORIES;
  const activeReceitaCats = receitaCats.length > 0 ? receitaCats : RECEITA_CATEGORIES;

  const refreshCategories = () => {
    api.get('/financeiro/categories').then(r => setDbCategories(r.data || [])).catch(() => {});
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    const { startDate, endDate } = getPeriodRange(period);
    const dentistParam = effectiveDentistId || undefined;
    // Gráfico de 6 meses: janela fixa de 6 meses corridos, NÃO usa o período selecionado.
    const sixMoStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 5, 1)).toISOString();
    try {
      // Defensivo: dashboard novo pode falhar enquanto deploy nao subiu;
      // resto da pagina nao deve quebrar. Promise.allSettled + fallback.
      const [sumRes, recRes, despRes, dashRes, cfRes] = await Promise.allSettled([
        api.get('/financeiro/summary', { params: { startDate, endDate, dentistId: dentistParam } }),
        api.get('/financeiro/transactions', { params: { type: 'RECEITA', startDate, endDate, limit: 100, dentistId: dentistParam } }),
        api.get('/financeiro/transactions', { params: { type: 'DESPESA', startDate, endDate, limit: 100, dentistId: dentistParam } }),
        api.get('/financeiro/dashboard', { params: { startDate, endDate, dentistId: dentistParam } }),
        api.get('/financeiro/cash-flow', { params: { groupBy: 'month', startDate: sixMoStart, dentistId: dentistParam } }),
      ]);

      if (sumRes.status === 'fulfilled') setSummary(sumRes.value.data);

      const recRows =
        recRes.status === 'fulfilled'
          ? Array.isArray(recRes.value.data) ? recRes.value.data : recRes.value.data.data || []
          : [];
      const despRows =
        despRes.status === 'fulfilled'
          ? Array.isArray(despRes.value.data) ? despRes.value.data : despRes.value.data.data || []
          : [];
      setReceitas(recRows);
      setDespesas(despRows);

      if (dashRes.status === 'fulfilled') {
        setDashboard(dashRes.value.data);
      } else {
        setDashboard(null);
      }

      if (cfRes.status === 'fulfilled') setCashFlow(cfRes.value.data?.periods || []);

      // Overdue: receitas pendentes com due_date no passado
      const now = new Date();
      const overdueItems = recRows.filter(
        (t: Transaction) => t.status === 'PENDENTE' && t.due_date && new Date(t.due_date) < now,
      );
      setOverdue(overdueItems);
    } catch {
      showError('Erro ao carregar dados financeiros');
    } finally {
      setLoading(false);
    }
  }, [period, effectiveDentistId]);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) fetchData();
  }, [fetchData]);

  /* ─── Tab icons ─── */
  const tabIcons: Record<Tab, any> = {
    Resumo: BarChart3,
    Validar: CheckCircle2,
    Receitas: TrendingUp,
    Despesas: TrendingDown,
    Boletos: CreditCard,
    Pacientes: Users,
    Diárias: CalendarClock,
    Log: FileText,
  };

  /* ─── Loading skeleton ─── */
  if (loading && !summary) {
    return (
      <div className="h-full overflow-y-auto bg-background p-4 md:p-6">
        <div className="w-full space-y-6">
          <div className="animate-pulse space-y-2">
            <div className="h-8 w-48 bg-muted rounded-lg" />
            <div className="h-4 w-32 bg-muted rounded" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="bg-card border border-border rounded-xl p-4 animate-pulse">
                <div className="w-8 h-8 rounded-lg bg-muted mb-2" />
                <div className="h-6 w-24 bg-muted rounded mb-1" />
                <div className="h-3 w-16 bg-muted rounded" />
              </div>
            ))}
          </div>
          <div className="bg-card border border-border rounded-xl p-4 animate-pulse h-48" />
        </div>
      </div>
    );
  }

  /* ─── Quick stats ─── */
  const totalTransacoes = receitas.length + despesas.length;
  const categoryCounts: Record<string, number> = {};
  [...receitas, ...despesas].forEach((t) => {
    categoryCounts[t.category] = (categoryCounts[t.category] || 0) + 1;
  });
  const topCategories = Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="w-full p-4 md:p-6 space-y-5 pb-28 md:pb-6">

        {/* ─── Header ─── */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/15 flex items-center justify-center">
              <DollarSign size={20} className="text-emerald-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Financeiro</h1>
              <p className="text-xs text-muted-foreground">Boletos, receitas e despesas da clinica</p>
            </div>
          </div>

          {/* Filtro por dentista (admin/financeiro) */}
          {(isAdmin || isFinanceiro) && dentists.length > 0 && (
            <select
              value={filterDentistId}
              onChange={e => setFilterDentistId(e.target.value)}
              className="px-3 py-2 text-xs bg-card border border-border rounded-xl focus:outline-none"
            >
              <option value="">Todos os dentistas</option>
              {dentists.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}

          {/* Saldo Asaas */}
          {asaasBalance !== null && (
            <div className="flex items-center gap-2 px-4 py-2 bg-card border border-border rounded-xl">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Saldo Asaas</span>
              <span className={`text-base font-bold ${asaasBalance >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(asaasBalance)}
              </span>
            </div>
          )}

          {/* Caixa do dia — entradas que efetivamente caíram HOJE (recebido na clínica
              + pagamentos Asaas online do dia). Independe do período selecionado. */}
          <div
            className="flex items-center gap-2 px-4 py-2 bg-card border border-border rounded-xl"
            title="Total que entrou no caixa hoje (recebimentos na clínica + Asaas)"
          >
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Caixa dia</span>
            <span className="text-base font-bold text-emerald-400">
              {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(dashboard?.entrada_do_dia?.value ?? 0)}
            </span>
          </div>

          {/* Period Selector */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 bg-card border border-border rounded-xl p-1">
              {PERIODS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => setPeriod(p.value)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    period === p.value
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent/30'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <select
              value={period.startsWith('mes-') ? period : ''}
              onChange={e => { if (e.target.value) setPeriod(e.target.value); }}
              className="px-3 py-2 text-xs bg-card border border-border rounded-xl text-foreground focus:outline-none"
            >
              <option value="">Mês...</option>
              {MONTH_NAMES.map((name, idx) => (
                <option key={idx} value={`mes-${idx}`}>{name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* ─── Tab Navigation ULTRA-COMPACTA (Fase 25 5b v3) ─── */}
        <div className="flex items-center gap-0.5 bg-card border border-border rounded-xl p-1 overflow-x-auto">
          {visibleTabs.map((t) => {
            const Icon = tabIcons[t];
            return (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold transition-colors whitespace-nowrap ${
                  tab === t
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent/30'
                }`}
              >
                <Icon className="w-3 h-3 shrink-0 hidden md:inline-block" />
                {t}
              </button>
            );
          })}
        </div>

        {/* ─── TAB: Resumo ─── */}
        {/* Banner de vencidos */}
        {(despesas.filter(d => d.status === 'PENDENTE' && d.due_date && new Date(d.due_date) < new Date()).length > 0) && (
          <div className="flex items-center gap-3 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-xl">
            <AlertTriangle size={16} className="text-red-400 shrink-0" />
            <div className="flex-1">
              <span className="text-xs font-bold text-red-400">
                {despesas.filter(d => d.status === 'PENDENTE' && d.due_date && new Date(d.due_date) < new Date()).length} despesa(s) vencida(s)
              </span>
              <span className="text-xs text-muted-foreground ml-2">
                Total: {fmt(despesas.filter(d => d.status === 'PENDENTE' && d.due_date && new Date(d.due_date) < new Date()).reduce((s, d) => s + parseFloat(String(d.amount)), 0))}
              </span>
            </div>
            <button onClick={() => setTab('Despesas')} className="text-[10px] font-bold text-red-400 hover:underline">Ver despesas</button>
          </div>
        )}

        {tab === 'Resumo' && summary && (
          <div className="space-y-5">
            {/* KPI Grid — Onda 16: 4 KPIs do funil financeiro odontologico.
                Fonte: GET /financeiro/dashboard (agrega charges + transactions).
                Fallback pro summary legado quando dashboard nao subiu ainda. */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
              <KpiCard
                icon={DollarSign}
                label={dashboard ? `Entrada do dia (${dashboard.entrada_do_dia?.count ?? 0})` : 'Entrada do dia'}
                value={fmt(dashboard?.entrada_do_dia?.value ?? 0)}
                color="text-emerald-400"
                bgColor="bg-emerald-500/15"
                hint="Resumo do caixa: total que ENTROU hoje (recebimento). Clique para abrir o Caixa."
                onClick={() => router.push('/atendimento/caixa')}
              />
              <KpiCard
                icon={Handshake}
                label={dashboard ? `Vendas do dia (${dashboard.vendas_do_dia?.count ?? 0})` : 'Vendas do dia'}
                value={fmt(dashboard?.vendas_do_dia?.value ?? 0)}
                color="text-violet-400"
                bgColor="bg-violet-500/15"
                hint="Produção: orçamentos FECHADOS (aceitos) hoje. É o valor vendido, mesmo que o dinheiro entre parcelado depois."
              />
              <KpiCard
                icon={Clock}
                label={dashboard ? `A receber (${dashboard.a_receber_total.count})` : 'A Receber'}
                value={fmt(dashboard?.a_receber_total.value ?? summary.totalReceivable)}
                color="text-blue-400"
                bgColor="bg-blue-500/15"
                hint="Cobranças de pacientes em aberto — posição de hoje (não muda com o período)"
              />
              <KpiCard
                icon={AlertTriangle}
                label={
                  dashboard
                    ? `Atrasado (${dashboard.atrasado.count}${dashboard.atrasado.dias_medio > 0 ? ` · ${dashboard.atrasado.dias_medio}d` : ''})`
                    : 'Atrasado'
                }
                value={fmt(dashboard?.atrasado.value ?? summary.totalOverdue)}
                color="text-red-400"
                bgColor="bg-red-500/15"
                hint="Cobranças vencidas e não pagas — posição de hoje (não muda com o período)"
              />
              <KpiCard
                icon={TrendingUp}
                label={dashboard ? `Vencem 7d (${dashboard.a_vencer_7d.count})` : 'A vencer 7d'}
                value={fmt(dashboard?.a_vencer_7d.value ?? 0)}
                color="text-amber-400"
                bgColor="bg-amber-500/15"
                hint="Cobranças que vencem nos próximos 7 dias — posição de hoje"
              />
            </div>
            <p className="text-[11px] text-muted-foreground -mt-2 px-0.5">
              <span className="font-semibold text-emerald-400/90">Entrada do dia</span> = dinheiro que entrou (recebimento);{' '}
              <span className="font-semibold text-violet-400/90">Vendas do dia</span> = orçamentos fechados hoje (produção).{' '}
              <span className="font-semibold">A receber</span>, <span className="font-semibold">Atrasado</span> e{' '}
              <span className="font-semibold">Vencem 7d</span> mostram a posição de hoje.
            </p>

            {/* Onda 18.x — removidos "Taxa de realização", "Inadimplência por faixa"
                e "Projeção de recebimento" a pedido do dono (tela mais limpa). */}

            {/* Widgets Top atrasos + Entrada do dia (lado a lado).
                Próximos vencimentos foi pra baixo em widget próprio. */}
            {dashboard && (dashboard.top_atrasos.length > 0 || (dashboard.entrada_do_dia?.count ?? 0) > 0) && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {/* Entrada do dia — Onda 16.2 (à ESQUERDA agora) */}
                {(dashboard.entrada_do_dia?.count ?? 0) > 0 ? (
                  <div className="bg-card border border-emerald-500/20 rounded-xl p-4">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-bold text-emerald-400 flex items-center gap-2">
                        <DollarSign size={14} />
                        Entrada do dia ({(dashboard.entrada_do_dia?.count ?? 0)})
                      </h3>
                      <span className="text-sm font-bold text-emerald-400 tabular-nums">
                        {fmt((dashboard.entrada_do_dia?.value ?? 0))}
                      </span>
                    </div>
                    <div className="space-y-2">
                      {(dashboard.entrada_do_dia?.items ?? []).slice(0, 5).map((c) => {
                        const hora = new Date(c.paid_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                        return (
                          <button
                            key={c.id}
                            onClick={() => c.patient?.id && router.push(`/atendimento/pacientes/${c.patient.id}`)}
                            className="w-full flex items-center justify-between text-sm hover:bg-accent/10 -mx-2 px-2 py-1 rounded transition-colors text-left"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-[10px] font-bold text-emerald-400 shrink-0 tabular-nums w-10">{hora}</span>
                              <span className="text-foreground truncate">{c.patient?.name || 'Sem nome'}</span>
                              <span className="text-[10px] text-muted-foreground shrink-0">
                                {c.received_in_cash ? 'Espécie' : c.billing_type}
                              </span>
                            </div>
                            <span className="text-xs font-bold text-emerald-400 tabular-nums shrink-0">{fmt(c.amount)}</span>
                          </button>
                        );
                      })}
                    </div>
                    <button onClick={() => setTab('Boletos')} className="text-[10px] font-bold text-emerald-400 hover:underline mt-3">
                      Ver todas as cobranças →
                    </button>
                  </div>
                ) : dashboard.top_atrasos.length > 0 ? (
                  // Placeholder quando tem atrasos mas nao tem entrada hoje —
                  // mantem grid 2 colunas pra simetria.
                  <div className="bg-card border border-border rounded-xl p-4 flex flex-col items-center justify-center text-center min-h-[140px]">
                    <DollarSign size={20} className="text-muted-foreground/40 mb-2" />
                    <p className="text-xs text-muted-foreground font-semibold">Entrada do dia</p>
                    <p className="text-[11px] text-muted-foreground/60 mt-1">Nenhuma cobrança paga hoje ainda</p>
                  </div>
                ) : null}

                {/* Top atrasos (à DIREITA agora) */}
                {dashboard.top_atrasos.length > 0 && (
                  <div className="bg-card border border-red-500/20 rounded-xl p-4">
                    <h3 className="text-sm font-bold text-red-400 mb-3 flex items-center gap-2">
                      <AlertTriangle size={14} />
                      Top atrasos ({dashboard.top_atrasos.length})
                    </h3>
                    <div className="space-y-2">
                      {dashboard.top_atrasos.slice(0, 5).map((c) => (
                        <button
                          key={c.id}
                          onClick={() => c.patient?.id && router.push(`/atendimento/pacientes/${c.patient.id}`)}
                          className="w-full flex items-center justify-between text-sm hover:bg-accent/10 -mx-2 px-2 py-1 rounded transition-colors text-left"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-xs font-bold text-red-400 shrink-0">{c.days_overdue}d</span>
                            <span className="text-foreground truncate">{c.patient?.name || 'Sem nome'}</span>
                          </div>
                          <span className="text-xs font-bold text-red-400 tabular-nums shrink-0">{fmt(c.amount)}</span>
                        </button>
                      ))}
                    </div>
                    <button onClick={() => setTab('Boletos')} className="text-[10px] font-bold text-red-400 hover:underline mt-3">
                      Ver todos →
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Proximos vencimentos (7d) — vira widget separado abaixo */}
            {dashboard && dashboard.proximos_vencimentos.length > 0 && (
              <div className="bg-card border border-amber-500/20 rounded-xl p-4">
                <h3 className="text-sm font-bold text-amber-400 mb-3 flex items-center gap-2">
                  <Clock size={14} />
                  Próximos 10 vencimentos
                </h3>
                <div className="relative grid grid-cols-2 gap-x-6 gap-y-2">
                  {/* Divisória vertical no meio — separa a coluna da esquerda da direita. */}
                  <div aria-hidden className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-amber-500/25" />
                  {dashboard.proximos_vencimentos.slice(0, 10).map((c) => {
                    const dt = new Date(c.due_date);
                    const days = Math.ceil((dt.getTime() - Date.now()) / 86400000);
                    return (
                      <button
                        key={c.id}
                        onClick={() => c.patient?.id && router.push(`/atendimento/pacientes/${c.patient.id}`)}
                        className="w-full flex items-center justify-between text-sm hover:bg-accent/10 -mx-2 px-2 py-1 rounded transition-colors text-left"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`text-xs font-bold shrink-0 ${days <= 3 ? 'text-red-400' : 'text-amber-400'}`}>{days}d</span>
                          <span className="text-foreground truncate">{c.patient?.name || 'Sem nome'}</span>
                        </div>
                        <span className="text-xs font-bold text-amber-400 tabular-nums shrink-0">{fmt(c.amount)}</span>
                      </button>
                    );
                  })}
                </div>
                <button onClick={() => setTab('Boletos')} className="text-[10px] font-bold text-amber-400 hover:underline mt-3">
                  Ver todos →
                </button>
              </div>
            )}

            {/* Onda 16 — KPIs de despesa removidos do Resumo. Despesas tem
                aba dedicada com agrupamento por vencimento (Vencidas/Hoje/
                A vencer/Pagas), evita duplicar info. Saldo + projeção
                seguem disponíveis no widget "Resumo do Periodo" abaixo. */}

            {/* Indicador de filtro por dentista (os numeros ja estao no Resumo do Periodo) */}
            {effectiveDentistId && (
              <div className="bg-card border border-primary/20 rounded-xl p-3 flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-primary/15 flex items-center justify-center text-primary text-base font-bold">
                  {dentists.find(d => d.id === effectiveDentistId)?.name?.[0] || userId?.[0]?.toUpperCase() || '?'}
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Visão filtrada por dentista</p>
                  <p className="text-sm font-bold text-foreground">
                    {dentists.find(d => d.id === effectiveDentistId)?.name || 'Meus dados'}
                  </p>
                </div>
              </div>
            )}

            {/* (Removido) Widget "Proximos Vencimentos 30d" baseado em FinancialTransaction —
                era redundante com "Proximos 10 vencimentos" (cobranças de paciente, a fonte
                real do a-receber). Receitas manuais pendentes seguem na aba Receitas. */}

            {/* Chart */}
            <MonthlyChart periods={cashFlow} />

            {/* Quick Stats */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="bg-card border border-border rounded-xl p-4">
                <h3 className="text-sm font-bold text-foreground mb-3">Resumo do Periodo</h3>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Total de Transacoes</span>
                    <span className="text-foreground font-bold tabular-nums">{totalTransacoes}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Receitas</span>
                    <span className="text-emerald-400 font-bold tabular-nums">{receitas.length}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Despesas</span>
                    <span className="text-red-400 font-bold tabular-nums">{despesas.length}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Receitas em atraso</span>
                    <span className="text-red-400 font-bold tabular-nums">{overdue.length}</span>
                  </div>
                  <div className="h-px bg-border my-1" />
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Saldo</span>
                    <span className={`font-bold tabular-nums ${summary.balance >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {fmt(summary.balance)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="bg-card border border-border rounded-xl p-4">
                <h3 className="text-sm font-bold text-foreground mb-3">Categorias Mais Comuns</h3>
                {topCategories.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Sem dados no periodo</p>
                ) : (
                  <div className="space-y-2">
                    {topCategories.map(([cat, count], i) => {
                      const pct = Math.max(5, (count / totalTransacoes) * 100);
                      return (
                        <div key={cat} className="space-y-1">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-foreground font-semibold">{cat}</span>
                            <span className="text-muted-foreground tabular-nums">{count}</span>
                          </div>
                          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full bg-primary/60 transition-all duration-500"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ─── TAB: Receitas ─── */}
        {tab === 'Receitas' && <ReceitasTab receitas={receitas} onRefresh={fetchData} lawyerId={effectiveDentistId} />}

        {/* ─── TAB: Despesas ─── */}
        {tab === 'Despesas' && (() => {
          const now = new Date();
          const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          const tomorrowStart = new Date(todayStart); tomorrowStart.setDate(tomorrowStart.getDate() + 1);

          const vencidas = despesas.filter(d => d.status === 'PENDENTE' && d.due_date && new Date(d.due_date) < todayStart);
          const venceHoje = despesas.filter(d => d.status === 'PENDENTE' && d.due_date && new Date(d.due_date) >= todayStart && new Date(d.due_date) < tomorrowStart);
          const aVencer = despesas.filter(d => d.status === 'PENDENTE' && (!d.due_date || new Date(d.due_date) >= tomorrowStart));
          const pagas = despesas.filter(d => d.status === 'PAGO');

          const sumOf = (items: Transaction[]) => items.reduce((s, t) => s + Number(t.amount || 0), 0);

          return (
            <div className="space-y-4">
              <QuickAddForm type="DESPESA" categories={activeDespesaCats} onCreated={fetchData} onManageCategories={refreshCategories} allDbCategories={dbCategories} />

              <DespesaSection
                icon={AlertTriangle} label="Vencidas" count={vencidas.length} total={sumOf(vencidas)}
                color="text-red-400" bgColor="bg-red-500/10" borderColor="border-red-500/20"
                defaultOpen={vencidas.length > 0}
                rows={vencidas} onRefresh={fetchData} currentUserId={userId || undefined} canManageAll={isAdmin || isFinanceiro}
              />
              <DespesaSection
                icon={Clock} label="Vencem Hoje" count={venceHoje.length} total={sumOf(venceHoje)}
                color="text-amber-400" bgColor="bg-amber-500/10" borderColor="border-amber-500/20"
                defaultOpen={venceHoje.length > 0}
                rows={venceHoje} onRefresh={fetchData} currentUserId={userId || undefined} canManageAll={isAdmin || isFinanceiro}
              />
              <DespesaSection
                icon={TrendingUp} label="A Vencer" count={aVencer.length} total={sumOf(aVencer)}
                color="text-emerald-400" bgColor="bg-emerald-500/10" borderColor="border-emerald-500/20"
                defaultOpen={aVencer.length > 0}
                rows={aVencer} onRefresh={fetchData} currentUserId={userId || undefined} canManageAll={isAdmin || isFinanceiro}
              />
              <DespesaSection
                icon={Check} label="Pagas" count={pagas.length} total={sumOf(pagas)}
                color="text-muted-foreground" bgColor="bg-muted/30" borderColor="border-border"
                defaultOpen={false}
                rows={pagas} onRefresh={fetchData} currentUserId={userId || undefined} canManageAll={isAdmin || isFinanceiro}
              />
            </div>
          );
        })()}

        {/* ─── TAB: Boletos (Onda 16) — todos os PaymentGatewayCharge ─── */}
        {tab === 'Boletos' && <BoletosTab dentistId={effectiveDentistId || undefined} />}

        {/* ─── TAB: Pacientes (Onda 16) — visao "conta corrente" agregada ─── */}
        {tab === 'Pacientes' && <PacientesSummaryTab dentistId={effectiveDentistId || undefined} />}

        {/* ─── TAB: Validar — fila de tratamentos aguardando liberação pro dentista ─── */}
        {tab === 'Validar' && canManageFinancial && <ValidarTab />}

        {/* ─── TAB: Diárias (Fase 5) — lança diária como DESPESA no caixa ─── */}
        {tab === 'Diárias' && canManageFinancial && <DailyRateTab />}

        {/* ─── TAB: Inadimplencia (legado, oculta na Onda 16 — mantido pra rollback rapido) ─── */}
        {(tab as any) === 'Inadimplencia' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-foreground flex items-center gap-2">
                <AlertTriangle size={15} className="text-red-400" />
                Pagamentos em Atraso ({overdue.length})
              </h2>
            </div>

            {overdue.length === 0 ? (
              <div className="bg-card border border-border rounded-xl p-8 text-center">
                <Check size={32} className="mx-auto text-emerald-400 mb-2" />
                <p className="text-sm text-muted-foreground">Nenhum pagamento em atraso</p>
              </div>
            ) : (
              <div className="space-y-2">
                {overdue.map((t) => {
                  const days = t.due_date ? daysOverdue(t.due_date) : 0;
                  const clientName = t.lead?.name || 'Cliente desconhecido';
                  const clientPhone = t.lead?.phone || '';
                  const reminderMsg = `Ola ${clientName}, verificamos que existe um pagamento pendente no valor de ${fmt(t.amount)}${t.description ? ` referente a ${t.description}` : ''}. Por gentileza, entre em contato para regularizacao.`;

                  return (
                    <div key={t.id} className="bg-card border border-border rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-bold text-foreground truncate">{clientName}</span>
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            days > 30 ? 'bg-red-500/15 text-red-400' : days > 7 ? 'bg-amber-500/15 text-amber-400' : 'bg-yellow-500/15 text-yellow-400'
                          }`}>
                            {days} dias
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <span className="truncate">{t.description || t.category || '--'}</span>
                          <span className="text-red-400 font-bold">{fmt(t.amount)}</span>
                          {t.due_date && <span>Venc.: {fmtDate(t.due_date)}</span>}
                        </div>
                        {clientPhone && (
                          <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                            <Phone size={10} /> {clientPhone}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {clientPhone && (
                          <a
                            href={whatsappLink(clientPhone, reminderMsg)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-semibold hover:bg-emerald-700 transition-colors"
                          >
                            <MessageSquare size={13} />
                            WhatsApp
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ─── TAB: Log de Movimentações ─── */}
        {tab === 'Log' && <AuditLogTab dentistId={effectiveDentistId} />}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   Componente: Log de Movimentações Financeiras
══════════════════════════════════════════════════════════════ */

const ACTION_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
  HONORARIO_CRIADO: { label: 'Honorário cadastrado', color: 'text-blue-400 bg-blue-500/10 border-blue-500/20', icon: '📋' },
  PAGAMENTO_RECEBIDO: { label: 'Pagamento recebido', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20', icon: '✅' },
  PAGAMENTO_PARCIAL: { label: 'Pagamento parcial', color: 'text-amber-400 bg-amber-500/10 border-amber-500/20', icon: '💰' },
  PARCELA_EDITADA: { label: 'Parcela editada', color: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20', icon: '✏️' },
  PARCELA_EXCLUIDA: { label: 'Parcela excluída', color: 'text-red-400 bg-red-500/10 border-red-500/20', icon: '🗑️' },
  COBRANCA_GERADA: { label: 'Cobrança gerada', color: 'text-blue-400 bg-blue-500/10 border-blue-500/20', icon: '📄' },
  COBRANCA_PAGA_ASAAS: { label: 'Cobrança paga (Asaas)', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20', icon: '🏦' },
  RECEITA_CRIADA: { label: 'Receita criada', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20', icon: '📥' },
  RECEITA_EDITADA: { label: 'Receita editada', color: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20', icon: '✏️' },
  RECEITA_EXCLUIDA: { label: 'Receita excluída', color: 'text-red-400 bg-red-500/10 border-red-500/20', icon: '🗑️' },
  DESPESA_CRIADA: { label: 'Despesa criada', color: 'text-orange-400 bg-orange-500/10 border-orange-500/20', icon: '📤' },
  DESPESA_EDITADA: { label: 'Despesa editada', color: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20', icon: '✏️' },
  DESPESA_EXCLUIDA: { label: 'Despesa excluída', color: 'text-red-400 bg-red-500/10 border-red-500/20', icon: '🗑️' },
  DESPESA_PAGA: { label: 'Despesa paga', color: 'text-orange-400 bg-orange-500/10 border-orange-500/20', icon: '💸' },
};

function AuditLogTab({ dentistId }: { dentistId?: string }) {
  const [logs, setLogs] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const limit = 30;

  const fmtDateTime = (d: string) => {
    const dt = new Date(d);
    return dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
      ' ' + dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  };

  const fmtCurrency = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params: any = { limit: String(limit), offset: String(page * limit) };
      if (dentistId) params.dentistId = dentistId;
      const res = await api.get('/financeiro/audit-log', { params });
      setLogs(res.data?.data || []);
      setTotal(res.data?.total || 0);
    } catch { setLogs([]); }
    finally { setLoading(false); }
  }, [dentistId, page]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-foreground flex items-center gap-2">
          <FileText size={16} className="text-primary" />
          Log de Movimentações
          <span className="text-xs text-muted-foreground font-normal">({total} registros)</span>
        </h2>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-primary" /></div>
      ) : logs.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <FileText size={40} className="mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground font-medium">Nenhuma movimentação registrada</p>
          <p className="text-xs text-muted-foreground mt-1">As operações financeiras serão registradas aqui automaticamente</p>
        </div>
      ) : (
        <>
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="divide-y divide-border/40">
              {logs.map((log: any) => {
                const config = ACTION_CONFIG[log.action] || { label: log.action, color: 'text-muted-foreground bg-accent/30 border-border', icon: '📌' };
                const meta = log.meta_json || {};
                return (
                  <div key={log.id} className="px-5 py-3.5 hover:bg-accent/10 transition-colors flex items-start gap-4">
                    {/* Ícone */}
                    <div className="text-lg shrink-0 mt-0.5">{config.icon}</div>

                    {/* Conteúdo */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-lg border ${config.color}`}>
                          {config.label}
                        </span>
                        {meta.processo && (
                          <span className="text-[10px] font-mono text-primary">{meta.processo}</span>
                        )}
                        {meta.tipo_honorario && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400">{meta.tipo_honorario}</span>
                        )}
                        {meta.tipo && !meta.tipo_honorario && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/40 text-muted-foreground">{meta.tipo}</span>
                        )}
                      </div>

                      {/* Detalhes */}
                      <div className="text-xs text-muted-foreground space-x-3">
                        {meta.valor !== undefined && <span className="font-semibold text-foreground">{fmtCurrency(meta.valor)}</span>}
                        {meta.valor_recebido !== undefined && <span className="text-emerald-400">Recebido: {fmtCurrency(meta.valor_recebido)}</span>}
                        {meta.saldo_restante !== undefined && <span className="text-amber-400">Saldo: {fmtCurrency(meta.saldo_restante)}</span>}
                        {meta.metodo && <span>via {meta.metodo}</span>}
                        {meta.descricao && <span className="truncate max-w-[200px] inline-block align-bottom">{meta.descricao}</span>}
                        {meta.cliente && <span>| {meta.cliente}</span>}
                        {meta.categoria && <span>| {meta.categoria}</span>}
                      </div>
                    </div>

                    {/* Ator + Hora */}
                    <div className="text-right shrink-0">
                      <p className="text-[11px] font-medium text-foreground">{log.actor?.name || 'Sistema'}</p>
                      <p className="text-[10px] text-muted-foreground">{fmtDateTime(log.created_at)}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Paginação */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                className="px-3 py-1.5 text-xs border border-border rounded-lg text-muted-foreground hover:bg-accent/30 disabled:opacity-30">Anterior</button>
              <span className="text-xs text-muted-foreground">Página {page + 1} de {totalPages}</span>
              <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                className="px-3 py-1.5 text-xs border border-border rounded-lg text-muted-foreground hover:bg-accent/30 disabled:opacity-30">Próxima</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   Componente: Cobranças — Layout estilo Asaas
══════════════════════════════════════════════════════════════ */

const CHARGE_STATUS_MAP: Record<string, { label: string; color: string; dot: string }> = {
  PENDING: { label: 'Aguardando pagamento', color: 'text-amber-400 bg-amber-400/10 border-amber-400/20', dot: 'bg-amber-400' },
  RECEIVED: { label: 'Recebida', color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20', dot: 'bg-emerald-400' },
  CONFIRMED: { label: 'Confirmada', color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20', dot: 'bg-emerald-400' },
  RECEIVED_IN_CASH: { label: 'Recebida em dinheiro', color: 'text-teal-400 bg-teal-400/10 border-teal-400/20', dot: 'bg-teal-400' },
  OVERDUE: { label: 'Vencida', color: 'text-red-400 bg-red-400/10 border-red-400/20', dot: 'bg-red-400' },
  REFUNDED: { label: 'Estornada', color: 'text-purple-400 bg-purple-400/10 border-purple-400/20', dot: 'bg-purple-400' },
  DELETED: { label: 'Removida', color: 'text-gray-400 bg-gray-400/10 border-gray-400/20', dot: 'bg-gray-500' },
  CANCELLED: { label: 'Cancelada', color: 'text-gray-400 bg-gray-400/10 border-gray-400/20', dot: 'bg-gray-500' },
};

const BILLING_ICONS: Record<string, { icon: string; label: string }> = {
  PIX: { icon: '⚡', label: 'Pix' },
  BOLETO: { icon: '📄', label: 'Boleto Bancario' },
  CREDIT_CARD: { icon: '💳', label: 'Cartao de Credito' },
  UNDEFINED: { icon: '❓', label: 'Indefinido' },
};

/* ══════════════════════════════════════════════════════════════
   Componente: Clientes CRM ↔ Asaas
══════════════════════════════════════════════════════════════ */

function ClientesSyncTab() {
  const [linked, setLinked] = useState<any[]>([]);
  const [asaasCustomers, setAsaasCustomers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);
  const [view, setView] = useState<'linked' | 'asaas' | 'unlinked'>('linked');
  const [searchQuery, setSearchQuery] = useState('');
  const [linking, setLinking] = useState<string | null>(null); // asaas customer ID being linked
  const [leadSearch, setLeadSearch] = useState('');
  const [leadResults, setLeadResults] = useState<any[]>([]);

  const fetchLinked = useCallback(async () => {
    try {
      const res = await api.get('/payment-gateway/customers/linked');
      setLinked(res.data || []);
    } catch { setLinked([]); }
  }, []);

  const fetchAsaas = useCallback(async () => {
    try {
      const res = await api.get('/payment-gateway/customers/asaas', { params: { limit: '100' } });
      setAsaasCustomers(res.data?.data || []);
    } catch { setAsaasCustomers([]); }
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchLinked(), fetchAsaas()]).finally(() => setLoading(false));
  }, [fetchLinked, fetchAsaas]);

  const handleImport = async () => {
    setImporting(true);
    setImportResult(null);
    try {
      const res = await api.post('/payment-gateway/customers/import');
      setImportResult(res.data);
      await Promise.all([fetchLinked(), fetchAsaas()]);
      showSuccess(`${res.data.linked} cliente(s) vinculado(s) automaticamente!`);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao importar');
    } finally {
      setImporting(false);
    }
  };

  const handleLink = async (asaasId: string, leadId: string) => {
    try {
      await api.post('/payment-gateway/customers/link', { asaasCustomerId: asaasId, leadId });
      showSuccess('Cliente vinculado!');
      setLinking(null);
      setLeadSearch('');
      setLeadResults([]);
      await fetchLinked();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao vincular');
    }
  };

  const handleUnlink = async (id: string) => {
    if (!confirm('Desvincular este cliente?')) return;
    try {
      await api.delete(`/payment-gateway/customers/${id}`);
      showSuccess('Desvinculado');
      await fetchLinked();
    } catch { showError('Erro ao desvincular'); }
  };

  const searchLeads = async (q: string) => {
    setLeadSearch(q);
    if (q.length < 2) { setLeadResults([]); return; }
    try {
      const res = await api.get('/leads', { params: { search: q, limit: 5 } });
      setLeadResults(res.data?.data || res.data || []);
    } catch { setLeadResults([]); }
  };

  const linkedIds = new Set(linked.map(l => l.external_id));
  const unlinkedAsaas = asaasCustomers.filter(c => !linkedIds.has(c.id) && !c.deleted);

  const q = searchQuery.toLowerCase();
  const filteredLinked = q ? linked.filter(l => (l.lead?.name || '').toLowerCase().includes(q) || (l.cpf_cnpj || '').includes(q)) : linked;
  const filteredAsaas = q ? asaasCustomers.filter(c => (c.name || '').toLowerCase().includes(q) || (c.cpfCnpj || '').includes(q)) : asaasCustomers;

  const displayList = view === 'linked' ? filteredLinked : view === 'asaas' ? filteredAsaas : unlinkedAsaas;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-sm font-bold text-foreground flex items-center gap-2">
          <Users size={15} className="text-primary" />
          Clientes CRC x Asaas
          <span className="text-xs text-muted-foreground font-normal">({linked.length} vinculados)</span>
        </h2>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              placeholder="Buscar por nome ou CPF..."
              className="pl-9 pr-3 py-1.5 text-xs bg-background border border-border rounded-lg focus:outline-none w-48" />
          </div>
          <div className="flex rounded-lg border border-border overflow-hidden">
            {(['linked', 'asaas', 'unlinked'] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent/30'}`}>
                {v === 'linked' ? `Vinculados (${linked.length})` : v === 'asaas' ? `Asaas (${asaasCustomers.length})` : `Sem vinculo (${unlinkedAsaas.length})`}
              </button>
            ))}
          </div>
          <button onClick={handleImport} disabled={importing}
            className="px-4 py-1.5 text-xs font-semibold bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5">
            {importing ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />}
            Importar e Vincular
          </button>
        </div>
      </div>

      {/* Import result */}
      {importResult && (
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-3 text-xs">
          <p className="font-semibold text-emerald-400">Importacao concluida: {importResult.total} clientes no Asaas</p>
          <p className="text-muted-foreground mt-1">{importResult.linked} vinculados automaticamente | {importResult.alreadyLinked} ja vinculados | {importResult.unlinked?.length || 0} sem match</p>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="text-center py-16"><Loader2 size={24} className="animate-spin text-muted-foreground mx-auto" /></div>
      ) : displayList.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <Users size={40} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">Nenhum cliente {view === 'linked' ? 'vinculado' : view === 'asaas' ? 'no Asaas' : 'sem vinculo'}</p>
        </div>
      ) : (
        <div className="border border-border rounded-xl overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-card/80 border-b border-border">
                <th className="px-4 py-3 text-left font-semibold text-muted-foreground">Nome</th>
                <th className="px-4 py-3 text-left font-semibold text-muted-foreground">CPF/CNPJ</th>
                <th className="px-4 py-3 text-left font-semibold text-muted-foreground">Email</th>
                <th className="px-4 py-3 text-left font-semibold text-muted-foreground">Telefone</th>
                <th className="px-4 py-3 text-left font-semibold text-muted-foreground">ID Asaas</th>
                <th className="px-4 py-3 text-left font-semibold text-muted-foreground">Acao</th>
              </tr>
            </thead>
            <tbody>
              {displayList.map((item: any, i: number) => {
                const isLinkedView = view === 'linked';
                const name = isLinkedView ? item.lead?.name : item.name;
                const cpf = isLinkedView ? item.cpf_cnpj : item.cpfCnpj?.replace(/\D/g, '');
                const email = isLinkedView ? item.lead?.email : item.email;
                const phone = isLinkedView ? item.lead?.phone : (item.phone || item.mobilePhone);
                const asaasId = isLinkedView ? item.external_id : item.id;
                const isAlreadyLinked = linkedIds.has(item.id);

                return (
                  <tr key={asaasId || i} className="border-b border-border/40 hover:bg-accent/10 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-primary/15 flex items-center justify-center text-primary text-[10px] font-bold shrink-0">
                          {(name || '?')[0]?.toUpperCase()}
                        </div>
                        <span className="font-medium text-foreground truncate max-w-[160px]">{name || '--'}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-muted-foreground">{cpf || '--'}</td>
                    <td className="px-4 py-3 text-muted-foreground truncate max-w-[150px]">{email || '--'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{phone || '--'}</td>
                    <td className="px-4 py-3 font-mono text-[10px] text-muted-foreground">{asaasId?.slice(-10)}</td>
                    <td className="px-4 py-3">
                      {isLinkedView ? (
                        <button onClick={() => handleUnlink(item.id)}
                          className="px-2 py-1 text-[10px] font-semibold text-red-400 border border-red-400/20 rounded-md hover:bg-red-400/10 flex items-center gap-1">
                          <Unlink size={10} /> Desvincular
                        </button>
                      ) : isAlreadyLinked ? (
                        <span className="px-2 py-1 text-[10px] font-semibold text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 rounded-md">Vinculado</span>
                      ) : linking === item.id ? (
                        <div className="space-y-1">
                          <input type="text" value={leadSearch} onChange={e => searchLeads(e.target.value)}
                            placeholder="Buscar lead por nome..."
                            className="w-full px-2 py-1 text-[10px] bg-background border border-border rounded-md focus:outline-none" autoFocus />
                          {leadResults.map(l => (
                            <button key={l.id} onClick={() => handleLink(item.id, l.id)}
                              className="w-full text-left px-2 py-1 text-[10px] hover:bg-accent/30 rounded-md flex items-center gap-1">
                              <Check size={10} className="text-emerald-400" /> {l.name || l.phone}
                            </button>
                          ))}
                          <button onClick={() => { setLinking(null); setLeadSearch(''); setLeadResults([]); }}
                            className="text-[10px] text-muted-foreground hover:text-foreground">Cancelar</button>
                        </div>
                      ) : (
                        <button onClick={() => setLinking(item.id)}
                          className="px-2 py-1 text-[10px] font-semibold text-primary border border-primary/20 rounded-md hover:bg-primary/10 flex items-center gap-1">
                          <Link2 size={10} /> Vincular
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   Componente: Receitas aprimorada com cadastro + cobrança Asaas
══════════════════════════════════════════════════════════════ */

const RECEITA_CAT_ICONS: Record<string, string> = {
  HONORARIO: '⚖️', CONSULTA: '📞', ACORDO: '🤝', OUTRO: '📋',
};

function ReceitasTab({ receitas, onRefresh, lawyerId }: { receitas: Transaction[]; onRefresh: () => void; lawyerId?: string }) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [viewMode, setViewMode] = useState<'recebidas' | 'a_receber'>('a_receber');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedReceita, setSelectedReceita] = useState<Transaction | null>(null);
  const [selectedPending, setSelectedPending] = useState<any>(null);
  const [pendingPayments, setPendingPayments] = useState<any[]>([]);
  const [loadingPending, setLoadingPending] = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [chargingGroup, setChargingGroup] = useState<string | null>(null);
  const [chargeGroupResult, setChargeGroupResult] = useState<{ key: string; data: any } | null>(null);

  const fetchPending = useCallback(async () => {
    setLoadingPending(true);
    try {
      const params: any = {};
      if (lawyerId) params.lawyerId = lawyerId;
      // So leads com honorario negociado — o endpoint juridico de "cases"
      // (/honorarios/pending-payments) foi removido na transicao odonto e
      // dava 404, derrubando TODA a lista (o Promise.all rejeitava).
      const leadRes = await api.get('/leads/honorarios-negociados/pending-payments', { params });
      const leadPays = (leadRes.data || []).map((p: any) => ({ ...p, _source: 'lead' }));
      setPendingPayments(leadPays.sort((a: any, b: any) => {
        const da = a.due_date ? new Date(a.due_date).getTime() : Infinity;
        const db = b.due_date ? new Date(b.due_date).getTime() : Infinity;
        return da - db;
      }));
    } catch { setPendingPayments([]); }
    finally { setLoadingPending(false); }
  }, [lawyerId]);

  useEffect(() => { fetchPending(); }, [fetchPending]);

  // Form fields
  const [desc, setDesc] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('Procedimento');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [status, setStatus] = useState('PENDENTE');
  const [clientSearch, setClientSearch] = useState('');
  const [clientResults, setClientResults] = useState<any[]>([]);
  const [selectedClient, setSelectedClient] = useState<any>(null);
  const [generateCharge, setGenerateCharge] = useState(false);
  const [chargeType, setChargeType] = useState('BOLETO');
  const [notes, setNotes] = useState('');

  const fmt = (v: number | string) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.round((typeof v === 'string' ? parseFloat(v) : v) * 100) / 100);
  const fmtDate = (d: string) => { if (!d) return '--'; const dt = new Date(d); return `${String(dt.getUTCDate()).padStart(2,'0')}/${String(dt.getUTCMonth()+1).padStart(2,'0')}/${dt.getUTCFullYear()}`; };

  const resetForm = () => {
    setDesc(''); setAmount(''); setCategory('Procedimento'); setDate(new Date().toISOString().slice(0,10));
    setDueDate(''); setPaymentMethod(''); setStatus('PENDENTE'); setClientSearch('');
    setClientResults([]); setSelectedClient(null); setGenerateCharge(false); setNotes('');
  };

  const searchClients = async (q: string) => {
    setClientSearch(q);
    if (q.length < 2) { setClientResults([]); return; }
    try {
      const res = await api.get('/leads', { params: { search: q, limit: 5 } });
      setClientResults(res.data?.data || res.data || []);
    } catch { setClientResults([]); }
  };

  const handleSubmit = async () => {
    if (!desc.trim() || !amount) { showError('Preencha descricao e valor'); return; }
    const numVal = parseFloat(amount.replace(',', '.'));
    if (isNaN(numVal) || numVal <= 0) { showError('Valor invalido'); return; }
    setSaving(true);
    try {
      await api.post('/financeiro/transactions', {
        type: 'RECEITA', category, description: desc.trim(), amount: numVal,
        date: new Date(date + 'T12:00:00Z').toISOString(),
        due_date: dueDate ? new Date(dueDate + 'T12:00:00Z').toISOString() : undefined,
        payment_method: paymentMethod || undefined, status,
        lead_id: selectedClient?.id || undefined,
        notes: notes.trim() || undefined,
      });

      if (generateCharge && selectedClient?.id) {
        try {
          await api.post('/payment-gateway/customers/sync/' + selectedClient.id);
          showSuccess('Receita criada! Cobranca Asaas sera gerada via honorarios.');
        } catch { showSuccess('Receita criada (cobranca Asaas nao gerada — vincule o cliente primeiro)'); }
      } else { showSuccess('Receita cadastrada!'); }

      resetForm(); setShowForm(false); onRefresh();
    } catch { showError('Erro ao criar receita'); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Excluir esta receita?')) return;
    setDeletingId(id);
    try { await api.delete(`/financeiro/transactions/${id}`); showSuccess('Removida'); onRefresh(); if (selectedReceita?.id === id) setSelectedReceita(null); }
    catch { showError('Erro'); }
    finally { setDeletingId(null); }
  };

  const filtered = receitas.filter(r => {
    if (searchQ) {
      const q = searchQ.toLowerCase();
      return (r.description || '').toLowerCase().includes(q) || (r.lead?.name || '').toLowerCase().includes(q)
        || (r.category || '').toLowerCase().includes(q);
    }
    return true;
  });

  const filteredPending = pendingPayments.filter((p: any) => {
    if (!searchQ) return true;
    const q = searchQ.toLowerCase();
    if (p._source === 'lead') {
      return (p.lead_honorario?.lead?.name || '').toLowerCase().includes(q)
        || (p.lead_honorario?.type || '').toLowerCase().includes(q) || 'lead'.includes(q);
    }
    const lc = p.honorario?.legal_case;
    return (lc?.case_number || '').toLowerCase().includes(q) || (lc?.lead?.name || '').toLowerCase().includes(q)
      || (p.honorario?.type || '').toLowerCase().includes(q);
  });

  const totalFiltered = filtered.reduce((s, r) => s + parseFloat(String(r.amount)), 0);

  return (
    <div className="flex gap-4">
      {/* Left: Table */}
      <div className={`space-y-4 transition-all ${selectedReceita || selectedPending ? 'flex-1 min-w-0' : 'w-full'}`}>
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            {/* Toggle A Receber / Recebidas */}
            <div className="flex bg-background border border-border rounded-lg overflow-hidden">
              <button onClick={() => setViewMode('a_receber')}
                className={`px-4 py-2 text-xs font-semibold transition-colors ${viewMode === 'a_receber' ? 'bg-amber-500/15 text-amber-500' : 'text-muted-foreground hover:bg-accent/30'}`}>
                A Receber ({pendingPayments.length})
              </button>
              <button onClick={() => setViewMode('recebidas')}
                className={`px-4 py-2 text-xs font-semibold transition-colors ${viewMode === 'recebidas' ? 'bg-emerald-500/15 text-emerald-500' : 'text-muted-foreground hover:bg-accent/30'}`}>
                Recebidas ({receitas.length})
              </button>
            </div>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input type="text" value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder="Buscar..."
                className="pl-9 pr-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none w-44" />
            </div>
          </div>
          <button onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-1.5 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:opacity-90">
            <Plus size={14} /> Nova Receita
          </button>
        </div>

        {/* Form */}
        {showForm && (
          <div className="bg-card border border-border rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-foreground">Cadastrar Receita</h3>
              <button onClick={() => { setShowForm(false); resetForm(); }} className="text-muted-foreground hover:text-foreground"><X size={16} /></button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="md:col-span-2">
                <label className="text-xs font-medium text-muted-foreground block mb-1">Descricao *</label>
                <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="Ex: Restauração 2 faces - João Silva"
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/40" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Valor (R$) *</label>
                <input value={amount} onChange={e => setAmount(e.target.value)} placeholder="1000.00"
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/40" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Categoria</label>
                <select value={category} onChange={e => setCategory(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none">
                  {RECEITA_CATEGORIES.map(c => <option key={c} value={c}>{RECEITA_CAT_ICONS[c] || ''} {c}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Data</label>
                <input type="date" value={date} onChange={e => setDate(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Vencimento</label>
                <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Forma de pagamento</label>
                <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none">
                  <option value="">Nao informado</option><option value="PIX">PIX</option><option value="BOLETO">Boleto</option>
                  <option value="CARTAO">Cartao</option><option value="DINHEIRO">Dinheiro</option><option value="TRANSFERENCIA">Transferencia</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Status</label>
                <select value={status} onChange={e => setStatus(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none">
                  <option value="PENDENTE">Pendente</option><option value="PAGO">Recebido</option>
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="text-xs font-medium text-muted-foreground block mb-1">Cliente (opcional)</label>
                {selectedClient ? (
                  <div className="flex items-center gap-2 px-3 py-2 bg-background border border-border rounded-lg">
                    <div className="w-6 h-6 rounded-full bg-primary/15 flex items-center justify-center text-primary text-[9px] font-bold">{selectedClient.name?.[0]?.toUpperCase() || '?'}</div>
                    <span className="text-sm font-medium text-foreground flex-1">{selectedClient.name || selectedClient.phone}</span>
                    <button onClick={() => setSelectedClient(null)} className="text-muted-foreground hover:text-foreground"><X size={14} /></button>
                  </div>
                ) : (
                  <div className="relative">
                    <input value={clientSearch} onChange={e => searchClients(e.target.value)} placeholder="Buscar cliente por nome..."
                      className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none" />
                    {clientResults.length > 0 && (
                      <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-xl z-10 max-h-40 overflow-y-auto">
                        {clientResults.map(l => (
                          <button key={l.id} onClick={() => { setSelectedClient(l); setClientSearch(''); setClientResults([]); }}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-accent/30 flex items-center gap-2">
                            <span className="font-medium">{l.name || l.phone}</span>
                            <span className="text-xs text-muted-foreground">{l.phone}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="md:col-span-2">
                <label className="text-xs font-medium text-muted-foreground block mb-1">Observacoes</label>
                <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notas internas..."
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none" />
              </div>
              {selectedClient && status === 'PENDENTE' && (
                <div className="md:col-span-2">
                  <button onClick={() => setGenerateCharge(!generateCharge)}
                    className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border w-full transition-colors ${generateCharge ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent/30'}`}>
                    <CreditCard size={14} />
                    <div className="text-left flex-1">
                      <p className="text-sm font-medium">Gerar cobranca no Asaas</p>
                      <p className="text-[10px] text-muted-foreground">Sincroniza cliente e gera cobranca automaticamente</p>
                    </div>
                  </button>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => { setShowForm(false); resetForm(); }}
                className="px-4 py-2 text-sm text-muted-foreground border border-border rounded-lg hover:bg-accent/30">Cancelar</button>
              <button onClick={handleSubmit} disabled={saving}
                className="px-6 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Salvar Receita
              </button>
            </div>
          </div>
        )}

        {/* ── A RECEBER (parcelas agrupadas por honorário) ── */}
        {viewMode === 'a_receber' && (
          loadingPending ? (
            <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-primary" /></div>
          ) : filteredPending.length === 0 ? (
            <div className="bg-card border border-border rounded-xl p-12 text-center">
              <Clock size={40} className="mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground font-medium">Nenhum valor a receber</p>
              <p className="text-xs text-muted-foreground mt-1">Os valores a receber de planos de tratamento aparecem na aba Boletos</p>
            </div>
          ) : (() => {
            // Agrupar parcelas por honorário
            const typeLabels: Record<string, string> = { CONTRATUAL: 'Contratuais', SUCUMBENCIA: 'Sucumbência', ENTRADA: 'Entrada', ACORDO: 'Acordo', FIXO: 'Fixo', EXITO: 'Êxito', MISTO: 'Misto' };
            const groups = new Map<string, { key: string; isLead: boolean; label: string; clientName: string; honType: string; payments: any[] }>();
            filteredPending.forEach((p: any) => {
              const isLead = p._source === 'lead';
              const groupKey = isLead ? `lead_${p.lead_honorario_id}` : `case_${p.honorario_id}`;
              if (!groups.has(groupKey)) {
                const lc = isLead ? null : p.honorario?.legal_case;
                const leadData = isLead ? p.lead_honorario?.lead : lc?.lead;
                const honType = isLead ? p.lead_honorario?.type : p.honorario?.type;
                const label = isLead ? 'LEAD' : `${lc?.case_number || ''} ${lc?.specialty ? `(${lc.specialty})` : ''}`.trim();
                groups.set(groupKey, { key: groupKey, isLead, label, clientName: leadData?.name || '--', honType: honType || '', payments: [] });
              }
              groups.get(groupKey)!.payments.push(p);
            });
            const groupList = Array.from(groups.values());
            const toggleGroup = (key: string) => setExpandedGroups(prev => { const s = new Set(prev); s.has(key) ? s.delete(key) : s.add(key); return s; });

            return (
              <>
                <div className="space-y-2">
                  {groupList.map(g => {
                    const total = g.payments.reduce((s: number, p: any) => s + parseFloat(String(p.amount)), 0);
                    const isOpen = expandedGroups.has(g.key);
                    return (
                      <div key={g.key} className="bg-card border border-border rounded-xl overflow-hidden">
                        {/* Header do grupo */}
                        <div className="px-4 py-3 flex items-center justify-between hover:bg-accent/10 transition-colors">
                          <button onClick={() => toggleGroup(g.key)} className="flex items-center gap-2.5 min-w-0 flex-1">
                            {isOpen ? <ChevronDown size={14} className="text-muted-foreground shrink-0" /> : <ChevronRight size={14} className="text-muted-foreground shrink-0" />}
                            {g.isLead ? (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20 font-semibold shrink-0">LEAD</span>
                            ) : (
                              <span className="text-[10px] font-mono text-primary shrink-0">{g.label}</span>
                            )}
                            <span className="text-xs text-foreground font-medium truncate">{g.clientName}</span>
                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400 border border-violet-500/20 shrink-0">
                              {typeLabels[g.honType] || g.honType}
                            </span>
                          </button>
                          <div className="flex items-center gap-3 shrink-0">
                            {(() => {
                              const hasCharge = chargeGroupResult?.key === g.key;
                              const hasExistingCharge = g.payments.some((p: any) => p.gateway_charge || p.lead_honorario?.gateway_charge);
                              if (hasCharge || hasExistingCharge) {
                                return (
                                  <span className="text-[10px] px-2.5 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 font-semibold flex items-center gap-1">
                                    <Check size={10} /> Cobrança Gerada
                                  </span>
                                );
                              }
                              // Botão para leads (parcelamento Asaas) e processos (batch)
                              if (g.isLead && g.payments.length > 0) {
                                return (
                                  <button
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      const honId = g.payments[0]?.lead_honorario_id;
                                      if (!honId) return;
                                      setChargingGroup(g.key);
                                      try {
                                        const res = await api.post('/payment-gateway/charges/installment', { leadHonorarioId: honId, billingType: 'BOLETO' });
                                        setChargeGroupResult({ key: g.key, data: res.data });
                                        showSuccess(`Cobrança gerada! ${g.payments.length}x ${fmt(Number(g.payments[0].amount))}`);
                                        setExpandedGroups(prev => { const s = new Set(prev); s.add(g.key); return s; });
                                      } catch (err: any) { showError(err?.response?.data?.message || 'Erro ao gerar cobrança'); }
                                      finally { setChargingGroup(null); }
                                    }}
                                    disabled={chargingGroup === g.key}
                                    className="text-[10px] px-2.5 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 font-semibold disabled:opacity-50 flex items-center gap-1"
                                  >
                                    {chargingGroup === g.key ? <Loader2 size={10} className="animate-spin" /> : <CreditCard size={10} />}
                                    Gerar Cobrança {g.payments.length > 1 ? `${g.payments.length}x` : ''}
                                  </button>
                                );
                              }
                              if (!g.isLead && g.payments.length > 0) {
                                const honId = g.payments[0]?.honorario_id;
                                return (
                                  <button
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      if (!honId) return;
                                      setChargingGroup(g.key);
                                      try {
                                        const res = await api.post('/payment-gateway/charges/batch', { honorarioId: honId, billingType: 'BOLETO' });
                                        setChargeGroupResult({ key: g.key, data: res.data });
                                        showSuccess(`Cobrança(s) gerada(s)!`);
                                        setExpandedGroups(prev => { const s = new Set(prev); s.add(g.key); return s; });
                                      } catch (err: any) { showError(err?.response?.data?.message || 'Erro ao gerar cobrança'); }
                                      finally { setChargingGroup(null); }
                                    }}
                                    disabled={chargingGroup === g.key}
                                    className="text-[10px] px-2.5 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 font-semibold disabled:opacity-50 flex items-center gap-1"
                                  >
                                    {chargingGroup === g.key ? <Loader2 size={10} className="animate-spin" /> : <CreditCard size={10} />}
                                    Gerar Cobrança {g.payments.length > 1 ? `${g.payments.length}x` : ''}
                                  </button>
                                );
                              }
                              return null;
                            })()}
                            <span className="text-[10px] text-muted-foreground">{g.payments.length} parcela(s)</span>
                            <span className="text-sm font-bold text-amber-400">{fmt(total)}</span>
                          </div>
                        </div>
                        {/* Parcelas expandidas */}
                        {isOpen && (
                          <div className="border-t border-border">
                            <table className="w-full text-xs">
                              <tbody>
                                {g.payments.map((p: any, idx: number) => (
                                  <tr key={p.id}
                                    className={`border-b border-border/30 hover:bg-accent/10 transition-colors cursor-pointer ${selectedPending?.id === p.id ? 'bg-primary/5' : ''}`}
                                    onClick={() => setSelectedPending(p)}>
                                    <td className="pl-10 pr-2 py-2.5 text-muted-foreground w-8">{idx + 1}.</td>
                                    <td className="px-2 py-2.5 text-right font-semibold text-foreground">{fmt(p.amount)}</td>
                                    <td className="px-2 py-2.5 text-muted-foreground">{p.due_date ? fmtDate(p.due_date) : <span className="italic text-muted-foreground/50">Alvará</span>}</td>
                                    <td className="px-2 py-2.5"><StatusBadge status={p.status} /></td>
                                    <td className="px-4 py-2.5 text-right">
                                      <button onClick={(e) => { e.stopPropagation(); setSelectedPending(p); }} className="text-[10px] text-primary hover:underline">Detalhes</button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {/* Resultado da cobrança parcelada */}
                            {chargeGroupResult?.key === g.key && chargeGroupResult.data && (
                              <div className="px-4 py-3 bg-emerald-500/5 border-t border-emerald-500/20">
                                <p className="text-[10px] font-bold text-emerald-400 uppercase mb-2">Cobrança Parcelada Gerada</p>
                                {chargeGroupResult.data.boleto?.url && (
                                  <a href={chargeGroupResult.data.boleto.url} target="_blank" rel="noopener noreferrer"
                                    className="text-xs text-primary hover:underline flex items-center gap-1 mb-1">
                                    <ExternalLink size={11} /> Abrir Boleto
                                  </a>
                                )}
                                {chargeGroupResult.data.pix?.copyPaste && (
                                  <button onClick={() => { navigator.clipboard.writeText(chargeGroupResult.data.pix.copyPaste); showSuccess('PIX copiado!'); }}
                                    className="text-xs text-primary hover:underline flex items-center gap-1">
                                    <CreditCard size={11} /> Copiar PIX
                                  </button>
                                )}
                                {chargeGroupResult.data.invoice_url && (
                                  <a href={chargeGroupResult.data.invoice_url} target="_blank" rel="noopener noreferrer"
                                    className="text-xs text-primary hover:underline flex items-center gap-1 mt-1">
                                    <ExternalLink size={11} /> Ver Fatura Asaas
                                  </a>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
                  <span>{groupList.length} honorário(s) | {filteredPending.length} parcela(s)</span>
                  <span className="font-semibold text-amber-400">Total a receber: {fmt(filteredPending.reduce((s: number, p: any) => s + parseFloat(String(p.amount)), 0))}</span>
                </div>
              </>
            );
          })()
        )}

        {/* ── RECEBIDAS (transações financeiras PAGO) ── */}
        {viewMode === 'recebidas' && (
          filtered.length === 0 ? (
            <div className="bg-card border border-border rounded-xl p-12 text-center">
              <TrendingUp size={40} className="mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground font-medium">Nenhuma receita recebida</p>
            </div>
          ) : (
            <>
              <div className="bg-card border border-border rounded-xl overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-card/80">
                      <th className="px-4 py-3 text-left font-semibold text-muted-foreground">Data</th>
                      <th className="px-4 py-3 text-left font-semibold text-muted-foreground">Processo / Descricao</th>
                      <th className="px-4 py-3 text-left font-semibold text-muted-foreground">Cliente</th>
                      <th className="px-4 py-3 text-right font-semibold text-muted-foreground">Valor</th>
                      <th className="px-4 py-3 text-left font-semibold text-muted-foreground">Pago em</th>
                      <th className="px-4 py-3 text-right font-semibold text-muted-foreground">Acoes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(r => (
                      <tr key={r.id}
                        onClick={() => setSelectedReceita(r)}
                        className={`border-b border-border/40 hover:bg-accent/10 transition-colors cursor-pointer ${selectedReceita?.id === r.id ? 'bg-primary/5 border-l-2 border-l-primary' : ''}`}>
                        <td className="px-4 py-3 text-muted-foreground">{fmtDate(r.date)}</td>
                        <td className="px-4 py-3 max-w-[280px]">
                          <span className="font-medium text-foreground truncate block">{r.description}</span>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground truncate max-w-[120px]">{r.lead?.name || '--'}</td>
                        <td className="px-4 py-3 text-right font-bold text-emerald-400">{fmt(r.amount)}</td>
                        <td className="px-4 py-3 text-muted-foreground">{r.paid_at ? fmtDate(r.paid_at) : fmtDate(r.date)}</td>
                        <td className="px-4 py-3 text-right" onClick={e => e.stopPropagation()}>
                          <button onClick={() => handleDelete(r.id)} disabled={deletingId === r.id}
                            className="px-2 py-1 text-[10px] font-semibold text-red-400 border border-red-400/20 rounded-md hover:bg-red-400/10 disabled:opacity-50 inline-flex items-center gap-1">
                            {deletingId === r.id ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
                <span>{filtered.length} receita(s) recebida(s)</span>
                <span className="font-semibold text-emerald-400">Total recebido: {fmt(totalFiltered)}</span>
              </div>
            </>
          )
        )}
      </div>

      {/* Right: Detail Panel — Receita recebida */}
      {selectedReceita && (
        <ReceitaDetailPanel
          receita={selectedReceita}
          onClose={() => setSelectedReceita(null)}
          onRefresh={() => { onRefresh(); setSelectedReceita(null); }}
          fmt={fmt}
          fmtDate={fmtDate}
        />
      )}

      {/* Right: Detail Panel — Parcela pendente */}
      {selectedPending && (
        <PendingPaymentPanel
          payment={selectedPending}
          onClose={() => setSelectedPending(null)}
          onRefresh={() => { fetchPending(); onRefresh(); setSelectedPending(null); }}
          fmt={fmt}
          fmtDate={fmtDate}
        />
      )}
    </div>
  );
}

/* ── Painel lateral de Parcela Pendente (A Receber) ────────── */

function PendingPaymentPanel({
  payment: p,
  onClose,
  onRefresh,
  fmt,
  fmtDate,
}: {
  payment: any;
  onClose: () => void;
  onRefresh: () => void;
  fmt: (v: number | string) => string;
  fmtDate: (d: string) => string;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editDueDate, setEditDueDate] = useState(p.due_date?.slice(0, 10) || '');
  const [noDueDate, setNoDueDate] = useState(!p.due_date);
  const [editAmount, setEditAmount] = useState(String(p.amount));
  const [editMethod, setEditMethod] = useState(p.payment_method || '');
  const [showPartial, setShowPartial] = useState(false);
  const [partialAmount, setPartialAmount] = useState('');
  const [partialMethod, setPartialMethod] = useState('');
  const [showChargeMenu, setShowChargeMenu] = useState(false);
  const [chargingType, setChargingType] = useState<string | null>(null);
  const [chargeResult, setChargeResult] = useState<any>(null);
  const chargeMenuRef = useRef<HTMLDivElement>(null);

  const isLead = p._source === 'lead';
  const lc = isLead ? null : p.honorario?.legal_case;
  const leadData = isLead ? p.lead_honorario?.lead : null;
  const honType = isLead ? p.lead_honorario?.type : p.honorario?.type;
  const typeLabels: Record<string, string> = { CONTRATUAL: 'Contratuais', SUCUMBENCIA: 'Sucumbência', ENTRADA: 'Entrada', ACORDO: 'Acordo', FIXO: 'Fixo', EXITO: 'Êxito', MISTO: 'Misto' };

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (chargeMenuRef.current && !chargeMenuRef.current.contains(e.target as Node)) setShowChargeMenu(false);
    }
    if (showChargeMenu) { document.addEventListener('mousedown', handleClick); return () => document.removeEventListener('mousedown', handleClick); }
  }, [showChargeMenu]);

  const handleMarkPaid = async () => {
    setSaving(true);
    try {
      const endpoint = isLead
        ? `/leads/honorarios-negociados/payments/${p.id}/mark-paid`
        : `/honorarios/payments/${p.id}/mark-paid`;
      await api.patch(endpoint, { payment_method: editMethod || undefined });
      showSuccess('Pagamento registrado como recebido');
      onRefresh();
    } catch { showError('Erro ao marcar como pago'); }
    finally { setSaving(false); }
  };

  const handleSaveEdit = async () => {
    setSaving(true);
    try {
      // Atualizar parcela (não existe endpoint de update individual — deletar e recriar)
      // Usar o PATCH direto no honorarioPayment via endpoint existente
      // Como não existe endpoint PATCH para parcela individual, atualizo via workaround:
      // Deletar a parcela e criar nova com os valores editados
      await api.delete(`/honorarios/payments/${p.id}`);
      await api.post(`/honorarios/${p.honorario_id}/payments`, {
        amount: parseFloat(editAmount.replace(',', '.')),
        due_date: noDueDate ? undefined : (editDueDate || undefined),
        payment_method: editMethod || undefined,
      });
      showSuccess('Parcela atualizada');
      setEditing(false);
      onRefresh();
    } catch { showError('Erro ao atualizar parcela'); }
    finally { setSaving(false); }
  };

  const handlePartialPayment = async () => {
    const val = parseFloat(partialAmount.replace(',', '.'));
    if (!val || val <= 0 || val > parseFloat(String(p.amount))) {
      showError('Valor inválido');
      return;
    }
    setSaving(true);
    try {
      // Marcar como pago parcialmente: criar pagamento PAGO + ajustar parcela
      // 1. Marcar parcela atual como paga com valor parcial
      await api.patch(`/honorarios/payments/${p.id}/mark-paid`, { payment_method: partialMethod || undefined });
      // 2. Criar nova parcela com o saldo restante
      const remaining = parseFloat(String(p.amount)) - val;
      if (remaining > 0) {
        // Atualizar o valor da transação que acabou de ser criada
        // E criar nova parcela para o restante
        await api.post(`/honorarios/${p.honorario_id}/payments`, {
          amount: remaining,
          due_date: p.due_date || undefined,
          payment_method: undefined,
        });
      }
      showSuccess(`Recebimento parcial de ${fmt(val)} registrado`);
      setShowPartial(false);
      onRefresh();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao registrar pagamento parcial');
    } finally { setSaving(false); }
  };

  const handleCreateCharge = async (billingType: string) => {
    setShowChargeMenu(false);
    setChargingType(billingType);
    try {
      const res = await api.post('/payment-gateway/charges', { honorarioPaymentId: p.id, billingType });
      setChargeResult({ type: billingType, ...res.data });
      showSuccess(`Cobrança ${billingType} gerada!`);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao gerar cobrança');
    } finally { setChargingType(null); }
  };

  return (
    <div className="w-[380px] shrink-0 bg-card border border-border rounded-xl overflow-hidden flex flex-col max-h-[calc(100vh-250px)] sticky top-4">
      <div className="px-5 py-4 border-b border-border bg-amber-500/5 flex items-center justify-between">
        <h3 className="text-sm font-bold text-foreground">Parcela A Receber</h3>
        <button onClick={onClose} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/30"><X size={16} /></button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        {/* Valor + Status */}
        <div className="flex items-center justify-between">
          <StatusBadge status={p.status} />
          <p className="text-lg font-bold text-amber-400">{fmt(p.amount)}</p>
        </div>

        {/* Dados */}
        {!editing ? (
          <div className="space-y-2.5">
            <InfoRow label="Tipo" value={typeLabels[p.honorario?.type] || p.honorario?.type || '--'} />
            <InfoRow label="Vencimento" value={p.due_date ? fmtDate(p.due_date) : 'Alvará judicial'} />
            <InfoRow label="Método" value={p.payment_method || 'Não informado'} />
            {p.honorario?.notes && <InfoRow label="Observações" value={p.honorario.notes} />}
            {p.honorario?.sentence_value && (
              <InfoRow label="Condenação" value={fmt(p.honorario.sentence_value)} />
            )}
            {p.honorario?.success_percentage && (
              <InfoRow label="Porcentagem" value={`${parseFloat(p.honorario.success_percentage)}%`} />
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="text-[10px] font-bold text-muted-foreground uppercase block mb-1">Valor</label>
              <input value={editAmount} onChange={e => setEditAmount(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/40" />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[10px] font-bold text-muted-foreground uppercase">Vencimento</label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={noDueDate} onChange={e => { setNoDueDate(e.target.checked); if (e.target.checked) setEditDueDate(''); }}
                    className="w-3 h-3 rounded border-border accent-primary" />
                  <span className="text-[10px] text-muted-foreground">Sem vencimento</span>
                </label>
              </div>
              {noDueDate ? (
                <div className="px-3 py-2 text-xs text-muted-foreground/50 italic bg-accent/20 border border-border rounded-lg">Alvará judicial / sem data definida</div>
              ) : (
                <input type="date" value={editDueDate} onChange={e => setEditDueDate(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-background border border-border rounded-lg focus:outline-none" />
              )}
            </div>
            <div>
              <label className="text-[10px] font-bold text-muted-foreground uppercase block mb-1">Método</label>
              <select value={editMethod} onChange={e => setEditMethod(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-background border border-border rounded-lg focus:outline-none">
                <option value="">Não informado</option><option value="PIX">PIX</option><option value="BOLETO">Boleto</option>
                <option value="CARTAO">Cartão</option><option value="DINHEIRO">Dinheiro</option><option value="TRANSFERENCIA">Transferência</option>
              </select>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setEditing(false)} className="flex-1 px-3 py-2 text-xs border border-border rounded-lg text-muted-foreground hover:bg-accent/30">Cancelar</button>
              <button onClick={handleSaveEdit} disabled={saving}
                className="flex-1 px-3 py-2 text-xs bg-primary text-primary-foreground rounded-lg font-semibold hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1">
                {saving && <Loader2 size={10} className="animate-spin" />} Salvar
              </button>
            </div>
          </div>
        )}

        {/* Processo */}
        {lc && (
          <div className="border border-border rounded-xl p-3.5 space-y-2">
            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Processo</p>
            <p className="text-xs font-mono text-primary">{lc.case_number}</p>
            {lc.specialty && <span className="text-[10px] px-2 py-0.5 rounded bg-accent/40 text-muted-foreground">{lc.specialty}</span>}
            {lc.lawyer?.name && <p className="text-[10px] text-muted-foreground mt-1">Adv. {lc.lawyer.name}</p>}
            <button onClick={() => router.push(`/atendimento/processos?openCase=${lc.id}`)}
              className="flex items-center gap-1 text-[10px] font-bold text-primary hover:underline mt-1">
              <ExternalLink size={10} /> Abrir processo
            </button>
          </div>
        )}

        {/* Cliente */}
        {lc?.lead && (
          <div className="border border-border rounded-xl p-3.5 space-y-2">
            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Cliente</p>
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-primary/15 flex items-center justify-center text-primary text-[10px] font-bold">
                {lc.lead.name?.[0]?.toUpperCase() || '?'}
              </div>
              <div>
                <p className="text-xs font-medium text-foreground">{lc.lead.name}</p>
                <p className="text-[10px] text-muted-foreground">{lc.lead.phone}</p>
              </div>
            </div>
          </div>
        )}

        {/* Recebimento parcial */}
        {showPartial && (
          <div className="border border-amber-500/30 rounded-xl p-3.5 space-y-3 bg-amber-500/5">
            <p className="text-[10px] font-bold text-amber-400 uppercase tracking-wider">Recebimento Parcial</p>
            <input type="text" value={partialAmount} onChange={e => setPartialAmount(e.target.value)}
              placeholder={`Valor recebido (máx ${fmt(p.amount)})`}
              className="w-full px-3 py-2 text-xs bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400/40" autoFocus />
            <select value={partialMethod} onChange={e => setPartialMethod(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-background border border-border rounded-lg focus:outline-none">
              <option value="">Forma de pagamento</option><option value="PIX">PIX</option><option value="BOLETO">Boleto</option>
              <option value="CARTAO">Cartão</option><option value="DINHEIRO">Dinheiro</option><option value="TRANSFERENCIA">Transferência</option>
            </select>
            <div className="flex gap-2">
              <button onClick={() => setShowPartial(false)} className="flex-1 px-3 py-2 text-xs border border-border rounded-lg text-muted-foreground">Cancelar</button>
              <button onClick={handlePartialPayment} disabled={saving}
                className="flex-1 px-3 py-2 text-xs bg-amber-500 text-white rounded-lg font-semibold hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1">
                {saving && <Loader2 size={10} className="animate-spin" />} Registrar
              </button>
            </div>
          </div>
        )}

        {/* Resultado cobrança */}
        {chargeResult && (
          <div className="border border-primary/30 rounded-xl p-3.5 bg-primary/5 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold text-foreground">Cobrança {chargeResult.type} Gerada</p>
              <button onClick={() => setChargeResult(null)} className="text-muted-foreground hover:text-foreground text-xs">&#10005;</button>
            </div>
            {chargeResult.pix_copy_paste && (
              <div className="space-y-1.5">
                <p className="text-[10px] text-muted-foreground">Código PIX:</p>
                <div className="flex gap-1.5">
                  <input readOnly value={chargeResult.pix_copy_paste} className="flex-1 px-2 py-1.5 text-[10px] font-mono bg-accent/30 border border-border rounded-lg" />
                  <button onClick={() => { navigator.clipboard.writeText(chargeResult.pix_copy_paste); showSuccess('Copiado!'); }}
                    className="px-2 py-1.5 bg-primary text-primary-foreground text-[10px] font-bold rounded-lg">Copiar</button>
                </div>
              </div>
            )}
            {chargeResult.boleto_url && (
              <a href={chargeResult.boleto_url} target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-center gap-1 w-full px-3 py-2 bg-primary text-primary-foreground text-[10px] font-bold rounded-lg hover:opacity-90">
                <ExternalLink size={10} /> Abrir Boleto
              </a>
            )}
          </div>
        )}
      </div>

      {/* Ações */}
      {!editing && (
        <div className="border-t border-border px-5 py-3 space-y-2">
          <div className="flex gap-2">
            <button onClick={() => setEditing(true)}
              className="flex-1 px-3 py-2 text-[10px] font-semibold border border-border rounded-lg text-muted-foreground hover:bg-accent/30 flex items-center justify-center gap-1">
              <Pencil size={10} /> Editar
            </button>
            <button onClick={() => setShowPartial(!showPartial)}
              className="flex-1 px-3 py-2 text-[10px] font-semibold border border-amber-400/30 rounded-lg text-amber-400 hover:bg-amber-400/10 flex items-center justify-center gap-1">
              <DollarSign size={10} /> Parcial
            </button>
          </div>
          <div className="flex gap-2">
            <div className="relative flex-1" ref={chargeMenuRef}>
              <button onClick={() => setShowChargeMenu(!showChargeMenu)}
                className="w-full px-3 py-2 text-[10px] font-semibold border border-blue-400/30 rounded-lg text-blue-400 hover:bg-blue-400/10 flex items-center justify-center gap-1">
                {chargingType ? <Loader2 size={10} className="animate-spin" /> : <CreditCard size={10} />} Cobrança
              </button>
              {showChargeMenu && (
                <div className="absolute bottom-full left-0 right-0 mb-1 bg-card border border-border rounded-lg shadow-xl z-50 py-1">
                  <button onClick={() => handleCreateCharge('PIX')} className="w-full text-left px-3 py-2 text-[10px] text-foreground hover:bg-accent/30">PIX</button>
                  <button onClick={() => handleCreateCharge('BOLETO')} className="w-full text-left px-3 py-2 text-[10px] text-foreground hover:bg-accent/30">Boleto</button>
                  <button onClick={() => handleCreateCharge('CREDIT_CARD')} className="w-full text-left px-3 py-2 text-[10px] text-foreground hover:bg-accent/30">Cartão</button>
                </div>
              )}
            </div>
            <button onClick={handleMarkPaid} disabled={saving}
              className="flex-1 px-3 py-2 text-[10px] font-semibold bg-emerald-500 text-white rounded-lg hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1">
              {saving ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} />} Recebido Total
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Painel lateral de detalhes da Receita ──────────────────── */

function ReceitaDetailPanel({
  receita: r,
  onClose,
  onRefresh,
  fmt,
  fmtDate,
}: {
  receita: Transaction;
  onClose: () => void;
  onRefresh: () => void;
  fmt: (v: number | string) => string;
  fmtDate: (d: string) => string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showPartial, setShowPartial] = useState(false);
  const [partialAmount, setPartialAmount] = useState('');
  const [partialMethod, setPartialMethod] = useState('');
  const [chargingType, setChargingType] = useState<string | null>(null);
  const [chargeResult, setChargeResult] = useState<any>(null);
  const chargeMenuRef = useRef<HTMLDivElement>(null);
  const [showChargeMenu, setShowChargeMenu] = useState(false);

  // Edit fields
  const [editDesc, setEditDesc] = useState(r.description);
  const [editAmount, setEditAmount] = useState(String(r.amount));
  const [editDueDate, setEditDueDate] = useState(r.due_date?.slice(0, 10) || '');
  const [noDueDate, setNoDueDate] = useState(!r.due_date);
  const [editMethod, setEditMethod] = useState(r.payment_method || '');
  const [editNotes, setEditNotes] = useState(r.notes || '');

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (chargeMenuRef.current && !chargeMenuRef.current.contains(e.target as Node)) setShowChargeMenu(false);
    }
    if (showChargeMenu) { document.addEventListener('mousedown', handleClick); return () => document.removeEventListener('mousedown', handleClick); }
  }, [showChargeMenu]);

  const handleSaveEdit = async () => {
    setSaving(true);
    try {
      await api.patch(`/financeiro/transactions/${r.id}`, {
        description: editDesc.trim(),
        amount: parseFloat(editAmount.replace(',', '.')),
        due_date: noDueDate ? null : (editDueDate ? new Date(editDueDate + 'T12:00:00Z').toISOString() : null),
        payment_method: editMethod || null,
        notes: editNotes.trim() || null,
      });
      showSuccess('Receita atualizada');
      setEditing(false);
      onRefresh();
    } catch { showError('Erro ao salvar'); }
    finally { setSaving(false); }
  };

  const handleMarkPaid = async () => {
    try {
      await api.patch(`/financeiro/transactions/${r.id}`, { status: 'PAGO', paid_at: new Date().toISOString() });
      showSuccess('Marcado como recebido');
      onRefresh();
    } catch { showError('Erro'); }
  };

  const handlePartialPayment = async () => {
    const val = parseFloat(partialAmount.replace(',', '.'));
    if (!val || val <= 0) { showError('Informe o valor recebido'); return; }
    setSaving(true);
    try {
      await api.post(`/financeiro/transactions/${r.id}/partial-payment`, {
        amount: val,
        payment_method: partialMethod || undefined,
      });
      showSuccess(`Recebimento parcial de ${fmt(val)} registrado`);
      setShowPartial(false);
      setPartialAmount('');
      onRefresh();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao registrar pagamento parcial');
    } finally { setSaving(false); }
  };

  const handleCreateCharge = async (billingType: string) => {
    setShowChargeMenu(false);
    setChargingType(billingType);
    try {
      let res;
      if (r.honorario_payment_id) {
        res = await api.post('/payment-gateway/charges', { honorarioPaymentId: r.honorario_payment_id, billingType });
      } else {
        // Para receita avulsa, sincronizar cliente e criar via honorário
        if (r.lead?.id) {
          await api.post('/payment-gateway/customers/sync/' + r.lead.id);
        }
        res = await api.post('/payment-gateway/charges', { honorarioPaymentId: r.honorario_payment_id, billingType });
      }
      setChargeResult({ type: billingType, ...res.data });
      showSuccess(`Cobranca ${billingType} gerada!`);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Erro ao gerar cobranca');
    } finally { setChargingType(null); }
  };

  const isPending = r.status === 'PENDENTE' || r.status !== 'PAGO';

  return (
    <div className="w-[380px] shrink-0 bg-card border border-border rounded-xl overflow-hidden flex flex-col max-h-[calc(100vh-250px)] sticky top-4">
      {/* Header */}
      <div className="px-5 py-4 border-b border-border bg-accent/10 flex items-center justify-between">
        <h3 className="text-sm font-bold text-foreground">Detalhes da Receita</h3>
        <button onClick={onClose} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/30"><X size={16} /></button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        {/* Status + Valor */}
        <div className="flex items-center justify-between">
          <StatusBadge status={r.status} />
          <div className="text-right">
            <p className="text-lg font-bold text-emerald-400">{fmt(r.amount)}</p>
            {r.interest_amount && r.interest_amount > 0 && (
              <p className="text-[10px] text-red-400">+ {fmt(r.interest_amount)} juros ({fmt(r.total_with_interest || 0)} total)</p>
            )}
          </div>
        </div>

        {/* Dados da transação */}
        {!editing ? (
          <div className="space-y-2.5">
            <InfoRow label="Descricao" value={r.description} />
            {r.honorario_payment?.honorario?.type && (
              <InfoRow label="Tipo honorario" value={{
                CONTRATUAL: 'Contratuais', SUCUMBENCIA: 'Sucumbência', ENTRADA: 'Entrada', ACORDO: 'Acordo',
                FIXO: 'Fixo', EXITO: 'Êxito', MISTO: 'Misto',
              }[r.honorario_payment.honorario.type] || r.honorario_payment.honorario.type} />
            )}
            <InfoRow label="Categoria" value={`${RECEITA_CAT_ICONS[r.category] || ''} ${r.category}`} />
            <InfoRow label="Data" value={fmtDate(r.date)} />
            <InfoRow label="Vencimento" value={r.due_date ? fmtDate(r.due_date) : 'Sem vencimento'} />
            <InfoRow label="Forma pagamento" value={r.payment_method || 'Nao informado'} />
            {r.paid_at && <InfoRow label="Pago em" value={fmtDate(r.paid_at)} />}
            {(r.notes || r.honorario_payment?.honorario?.notes) && (
              <InfoRow label="Observacoes" value={r.notes || r.honorario_payment?.honorario?.notes || ''} />
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="text-[10px] font-bold text-muted-foreground uppercase block mb-1">Descricao</label>
              <input value={editDesc} onChange={e => setEditDesc(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/40" />
            </div>
            <div>
              <label className="text-[10px] font-bold text-muted-foreground uppercase block mb-1">Valor</label>
              <input value={editAmount} onChange={e => setEditAmount(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/40" />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[10px] font-bold text-muted-foreground uppercase">Vencimento</label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={noDueDate} onChange={e => { setNoDueDate(e.target.checked); if (e.target.checked) setEditDueDate(''); }}
                    className="w-3 h-3 rounded border-border accent-primary" />
                  <span className="text-[10px] text-muted-foreground">Sem vencimento</span>
                </label>
              </div>
              {noDueDate ? (
                <div className="px-3 py-2 text-xs text-muted-foreground/50 italic bg-accent/20 border border-border rounded-lg">Sem data definida</div>
              ) : (
                <input type="date" value={editDueDate} onChange={e => setEditDueDate(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-background border border-border rounded-lg focus:outline-none" />
              )}
            </div>
            <div>
              <label className="text-[10px] font-bold text-muted-foreground uppercase block mb-1">Forma pagamento</label>
              <select value={editMethod} onChange={e => setEditMethod(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-background border border-border rounded-lg focus:outline-none">
                <option value="">Nao informado</option><option value="PIX">PIX</option><option value="BOLETO">Boleto</option>
                <option value="CARTAO">Cartao</option><option value="DINHEIRO">Dinheiro</option><option value="TRANSFERENCIA">Transferencia</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] font-bold text-muted-foreground uppercase block mb-1">Observacoes</label>
              <input value={editNotes} onChange={e => setEditNotes(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-background border border-border rounded-lg focus:outline-none" />
            </div>
            <div className="flex gap-2">
              <button onClick={() => setEditing(false)} className="flex-1 px-3 py-2 text-xs border border-border rounded-lg text-muted-foreground hover:bg-accent/30">Cancelar</button>
              <button onClick={handleSaveEdit} disabled={saving}
                className="flex-1 px-3 py-2 text-xs bg-primary text-primary-foreground rounded-lg font-semibold hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1">
                {saving && <Loader2 size={10} className="animate-spin" />} Salvar
              </button>
            </div>
          </div>
        )}


        {/* Cliente */}
        {r.lead && (
          <div className="border border-border rounded-xl p-3.5 space-y-2">
            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Cliente</p>
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-primary/15 flex items-center justify-center text-primary text-[10px] font-bold">
                {r.lead.name?.[0]?.toUpperCase() || '?'}
              </div>
              <div>
                <p className="text-xs font-medium text-foreground">{r.lead.name}</p>
                <p className="text-[10px] text-muted-foreground">{r.lead.phone}</p>
              </div>
            </div>
          </div>
        )}

        {/* Recebimento parcial */}
        {showPartial && isPending && (
          <div className="border border-amber-500/30 rounded-xl p-3.5 space-y-3 bg-amber-500/5">
            <p className="text-[10px] font-bold text-amber-400 uppercase tracking-wider">Recebimento Parcial</p>
            <div className="space-y-2">
              <input type="text" value={partialAmount} onChange={e => setPartialAmount(e.target.value)} placeholder="Valor recebido (ex: 1000.00)"
                className="w-full px-3 py-2 text-xs bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400/40" autoFocus />
              <select value={partialMethod} onChange={e => setPartialMethod(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-background border border-border rounded-lg focus:outline-none">
                <option value="">Forma de pagamento</option><option value="PIX">PIX</option><option value="BOLETO">Boleto</option>
                <option value="CARTAO">Cartao</option><option value="DINHEIRO">Dinheiro</option><option value="TRANSFERENCIA">Transferencia</option>
              </select>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setShowPartial(false)} className="flex-1 px-3 py-2 text-xs border border-border rounded-lg text-muted-foreground">Cancelar</button>
              <button onClick={handlePartialPayment} disabled={saving}
                className="flex-1 px-3 py-2 text-xs bg-amber-500 text-white rounded-lg font-semibold hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1">
                {saving && <Loader2 size={10} className="animate-spin" />} Registrar
              </button>
            </div>
          </div>
        )}

        {/* Charge result */}
        {chargeResult && (
          <div className="border border-primary/30 rounded-xl p-3.5 bg-primary/5 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold text-foreground">Cobranca {chargeResult.type} Gerada</p>
              <button onClick={() => setChargeResult(null)} className="text-muted-foreground hover:text-foreground text-xs">&#10005;</button>
            </div>
            {chargeResult.pix_copy_paste && (
              <div className="space-y-1.5">
                <p className="text-[10px] text-muted-foreground">Codigo PIX:</p>
                <div className="flex gap-1.5">
                  <input readOnly value={chargeResult.pix_copy_paste} className="flex-1 px-2 py-1.5 text-[10px] font-mono bg-accent/30 border border-border rounded-lg" />
                  <button onClick={() => { navigator.clipboard.writeText(chargeResult.pix_copy_paste); showSuccess('Copiado!'); }}
                    className="px-2 py-1.5 bg-primary text-primary-foreground text-[10px] font-bold rounded-lg">Copiar</button>
                </div>
              </div>
            )}
            {chargeResult.boleto_url && (
              <a href={chargeResult.boleto_url} target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-center gap-1 w-full px-3 py-2 bg-primary text-primary-foreground text-[10px] font-bold rounded-lg hover:opacity-90">
                <ExternalLink size={10} /> Abrir Boleto
              </a>
            )}
            {chargeResult.invoice_url && (
              <a href={chargeResult.invoice_url} target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-center gap-1 w-full px-3 py-2 border border-border text-[10px] font-bold text-muted-foreground rounded-lg hover:bg-accent/30">
                <ExternalLink size={10} /> Ver Fatura
              </a>
            )}
          </div>
        )}
      </div>

      {/* Actions footer */}
      {isPending && !editing && (
        <div className="border-t border-border px-5 py-3 space-y-2">
          <div className="flex gap-2">
            <button onClick={() => setEditing(true)}
              className="flex-1 px-3 py-2 text-[10px] font-semibold border border-border rounded-lg text-muted-foreground hover:bg-accent/30 flex items-center justify-center gap-1">
              <Pencil size={10} /> Editar
            </button>
            <button onClick={() => setShowPartial(!showPartial)}
              className="flex-1 px-3 py-2 text-[10px] font-semibold border border-amber-400/30 rounded-lg text-amber-400 hover:bg-amber-400/10 flex items-center justify-center gap-1">
              <DollarSign size={10} /> Parcial
            </button>
          </div>
          <div className="flex gap-2">
            {r.honorario_payment_id && (
              <div className="relative flex-1" ref={chargeMenuRef}>
                <button onClick={() => setShowChargeMenu(!showChargeMenu)}
                  className="w-full px-3 py-2 text-[10px] font-semibold border border-blue-400/30 rounded-lg text-blue-400 hover:bg-blue-400/10 flex items-center justify-center gap-1">
                  {chargingType ? <Loader2 size={10} className="animate-spin" /> : <CreditCard size={10} />} Cobranca
                </button>
                {showChargeMenu && (
                  <div className="absolute bottom-full left-0 right-0 mb-1 bg-card border border-border rounded-lg shadow-xl z-50 py-1">
                    <button onClick={() => handleCreateCharge('PIX')} className="w-full text-left px-3 py-2 text-[10px] text-foreground hover:bg-accent/30">PIX</button>
                    <button onClick={() => handleCreateCharge('BOLETO')} className="w-full text-left px-3 py-2 text-[10px] text-foreground hover:bg-accent/30">Boleto</button>
                    <button onClick={() => handleCreateCharge('CREDIT_CARD')} className="w-full text-left px-3 py-2 text-[10px] text-foreground hover:bg-accent/30">Cartao</button>
                  </div>
                )}
              </div>
            )}
            <button onClick={handleMarkPaid}
              className="flex-1 px-3 py-2 text-[10px] font-semibold bg-emerald-500 text-white rounded-lg hover:opacity-90 flex items-center justify-center gap-1">
              <Check size={10} /> Recebido Total
            </button>
          </div>
        </div>
      )}

      {r.status === 'PAGO' && !editing && (
        <div className="border-t border-border px-5 py-3">
          <button onClick={() => setEditing(true)}
            className="w-full px-3 py-2 text-[10px] font-semibold border border-border rounded-lg text-muted-foreground hover:bg-accent/30 flex items-center justify-center gap-1">
            <Pencil size={10} /> Editar
          </button>
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider shrink-0">{label}</span>
      <span className="text-xs text-foreground text-right">{value}</span>
    </div>
  );
}
