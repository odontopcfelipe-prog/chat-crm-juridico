'use client';

/**
 * Contas a Pagar — acesso só ADM/gerente (permissão manage_payables).
 * 2 abas: "Contas Fixas" (parceladas + recorrentes variáveis) e "Gastos do dia".
 * Tudo é DESPESA (FinancialTransaction) via endpoints /payables/* (gate próprio).
 */

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Plus, X, Loader2, Shield, Home, Check, Trash2, Pencil,
  CalendarClock, Repeat, Layers, Receipt, AlertTriangle, ArrowLeft,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useUserPermissions } from '@/lib/useUserPermissions';

// ─── Helpers ──────────────────────────────────────────────────
const fmt = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v || 0);

/** "hoje" no fuso de Maceió (UTC-3) como YYYY-MM-DD. */
const maceioTodayStr = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
/** Preferências da tela (aba/empresa/mês) — persistem no refresh. localStorage é
 *  best-effort (private/bloqueado pode lançar), então tudo em try/catch. */
const readLS = (k: string): string => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const writeLS = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignora */ } };
/** Aceita número no formato BR (vírgula decimal, ponto milhar) OU com ponto decimal.
 *  Ex.: "5.437,96"→5437.96 · "5437,96"→5437.96 · "5437.96"→5437.96 · "1.000"→1000. */
const parseBRLNumber = (s: string): number => {
  let cleaned = (s || '').trim().replace(/[^\d.,]/g, '');
  if (cleaned.includes(',')) {
    // Formato BR: vírgula = decimal, pontos = milhar.
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (cleaned.includes('.')) {
    // Sem vírgula: um único ponto com ≤2 casas é decimal (5437.96); qualquer
    // outra combinação de pontos é separador de milhar (1.000 / 1.000.000).
    const single = cleaned.indexOf('.') === cleaned.lastIndexOf('.');
    const decimals = cleaned.length - cleaned.lastIndexOf('.') - 1;
    if (!(single && decimals <= 2)) cleaned = cleaned.replace(/\./g, '');
  }
  return parseFloat(cleaned);
};
/** due_date/date vêm como ISO (gravado ao meio-dia UTC) → fatiar dá o dia certo. */
const dayOf = (iso?: string | null) => (iso ? iso.slice(0, 10) : '');
const brDate = (iso?: string | null) => {
  const s = dayOf(iso);
  if (!s) return '--';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y.slice(2)}`;
};

interface Tx {
  id: string;
  description: string;
  category: string;
  amount: number | string;
  date: string;
  due_date: string | null;
  paid_at: string | null;
  payment_method: string | null;
  status: string;
  is_recurring: boolean;
  recurrence_pattern: string | null;
  recurrence_day: number | null;
  installment_sequence: number | null;
  installment_total: number | null;
  parent_transaction_id: string | null;
}
interface Category { id: string; name: string; type: string; }
interface CashAccount { id: string; name: string; kind: string; active: boolean; }
interface Company { id: string; name: string; }

const PAYMENT_METHODS = ['PIX', 'BOLETO', 'CARTAO', 'DINHEIRO', 'TRANSFERENCIA'];
// Formas aceitas pelo caixa (o gasto/pagamento que passa pela gaveta).
const CAIXA_METHODS = ['DINHEIRO', 'CARTAO', 'PIX', 'TRANSFERENCIA'];
// Forma sugerida por tipo de conta.
const METHOD_BY_KIND: Record<string, string> = { CAIXA: 'DINHEIRO', BANCO: 'PIX', CARTAO: 'CARTAO' };

export default function ContasAPagarPage() {
  const router = useRouter();
  const { hasPermission, ready } = useUserPermissions();
  const allowed = hasPermission('manage_payables');

  // Estado da tela persistido no refresh (aba/empresa/mês).
  const [tab, setTab] = useState<'fixas' | 'dia'>(() => (readLS('payables_tab') === 'dia' ? 'dia' : 'fixas'));
  const [txs, setTxs] = useState<Tx[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string>(() => readLS('payables_company')); // '' = clínica
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState(() => readLS('payables_month') || maceioTodayStr().slice(0, 7)); // YYYY-MM
  const [modal, setModal] = useState<null | 'parcelada' | 'recorrente' | 'dia'>(null);
  const [payTarget, setPayTarget] = useState<Tx | null>(null);
  const [editTarget, setEditTarget] = useState<Tx | null>(null);
  const isClinic = !selectedCompany;

  const monthRange = useCallback(() => {
    const [y, m] = month.split('-').map(Number);
    // Bordas do mês no fuso de Maceió (UTC-3), casando com a janela do caixa:
    // dia 1 00:00 Maceió = 03:00Z; fim = dia 1 do mês seguinte 02:59:59.999Z
    // (= último dia 23:59:59.999 Maceió). Assim o gasto lançado à noite não pula.
    const start = new Date(Date.UTC(y, m - 1, 1, 3, 0, 0, 0)).toISOString();
    const end = new Date(Date.UTC(y, m, 1, 2, 59, 59, 999)).toISOString();
    return { start, end };
  }, [month]);

  const load = useCallback(async () => {
    if (!allowed) return;
    setLoading(true);
    try {
      const { start, end } = monthRange();
      const companyQ = selectedCompany ? `&companyId=${selectedCompany}` : '';
      const [txRes, catRes, accRes] = await Promise.all([
        api.get(`/payables/transactions?startDate=${start}&endDate=${end}&limit=500${companyQ}`),
        api.get('/payables/categories'),
        api.get('/payables/accounts'),
      ]);
      const data = (txRes.data?.data ?? txRes.data ?? []) as Tx[];
      setTxs(data.map((t) => ({ ...t, amount: Number(t.amount) })));
      setCats((catRes.data ?? []) as Category[]);
      setAccounts((accRes.data ?? []) as CashAccount[]);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao carregar contas a pagar');
    } finally {
      setLoading(false);
    }
  }, [allowed, monthRange, selectedCompany]);

  const loadCompanies = useCallback(async () => {
    if (!allowed) return;
    try {
      const { data } = await api.get('/payables/companies');
      const list = (data ?? []) as Company[];
      setCompanies(list);
      // Se a empresa persistida foi apagada/desativada, volta pra clínica (evita erro no filtro).
      setSelectedCompany((cur) => (cur && !list.some((c) => c.id === cur) ? '' : cur));
    } catch { /* silencioso */ }
  }, [allowed]);

  useEffect(() => { if (ready && allowed) load(); }, [ready, allowed, load]);
  useEffect(() => { if (ready && allowed) loadCompanies(); }, [ready, allowed, loadCompanies]);
  // Persiste a preferência da tela pra o refresh continuar na mesma.
  useEffect(() => { writeLS('payables_tab', tab); }, [tab]);
  useEffect(() => { writeLS('payables_company', selectedCompany); }, [selectedCompany]);
  useEffect(() => { writeLS('payables_month', month); }, [month]);

  // Criar / renomear empresa (prompt simples — ferramenta de admin).
  const newCompany = async () => {
    const name = window.prompt('Nome da nova empresa:')?.trim();
    if (!name) return;
    try {
      const { data } = await api.post('/payables/companies', { name });
      showSuccess('Empresa criada');
      await loadCompanies();
      if (data?.id) setSelectedCompany(data.id);
    } catch (e: any) { showError(e?.response?.data?.message || 'Falha ao criar empresa'); }
  };
  const renameCompany = async () => {
    if (!selectedCompany) return;
    const cur = companies.find((c) => c.id === selectedCompany);
    const name = window.prompt('Novo nome da empresa:', cur?.name || '')?.trim();
    if (!name) return;
    try {
      await api.patch(`/payables/companies/${selectedCompany}`, { name });
      showSuccess('Empresa renomeada');
      loadCompanies();
    } catch (e: any) { showError(e?.response?.data?.message || 'Falha ao renomear'); }
  };

  // ─── Gate ───────────────────────────────────────────────────
  if (!ready) {
    return <div className="h-full flex items-center justify-center p-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  }
  if (!allowed) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 text-center p-8">
        <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center"><Shield className="w-8 h-8 text-destructive/60" /></div>
        <div>
          <h3 className="text-base font-bold text-foreground">Sem autorização</h3>
          <p className="text-[13px] text-muted-foreground mt-1 max-w-sm">Contas a Pagar é restrito ao administrador e ao gerente. Solicite o desbloqueio com o administrador.</p>
        </div>
        <button onClick={() => router.push('/atendimento/dashboard')} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-bold rounded-lg border border-border hover:bg-accent transition-colors"><Home size={14} /> Voltar ao Início</button>
      </div>
    );
  }

  // ─── Derivados ──────────────────────────────────────────────
  const today = maceioTodayStr();
  const num = (t: Tx) => Number(t.amount);
  const isFixed = (t: Tx) => t.is_recurring || !!t.installment_total || !!t.parent_transaction_id;
  const pend = txs.filter((t) => t.status === 'PENDENTE');
  const vencidas = pend.filter((t) => t.due_date && dayOf(t.due_date) < today);
  const aVencer = pend.filter((t) => !t.due_date || dayOf(t.due_date) >= today);
  const pagasMes = txs.filter((t) => t.status === 'PAGO');
  const kpiVencidas = vencidas.reduce((s, t) => s + num(t), 0);
  const kpiAVencer = aVencer.reduce((s, t) => s + num(t), 0);
  const kpiPago = pagasMes.reduce((s, t) => s + num(t), 0);

  const listForTab = txs.filter((t) => (tab === 'fixas' ? isFixed(t) : !isFixed(t)));

  // ─── Ações ──────────────────────────────────────────────────
  const pay = async (t: Tx) => {
    try {
      await api.patch(`/payables/transactions/${t.id}`, { status: 'PAGO', paid_at: new Date().toISOString() });
      showSuccess('Conta marcada como paga');
      load();
    } catch (e: any) { showError(e?.response?.data?.message || 'Falha ao pagar'); }
  };
  const del = async (t: Tx) => {
    if (!confirm(`Excluir "${t.description}"?`)) return;
    try {
      await api.delete(`/payables/transactions/${t.id}`);
      showSuccess('Conta removida');
      load();
    } catch (e: any) { showError(e?.response?.data?.message || 'Falha ao excluir'); }
  };

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-5">
        {/* Voltar pra tela anterior (Financeiro / Início) */}
        <button onClick={() => router.back()} className="inline-flex items-center gap-1 text-sm font-semibold text-muted-foreground hover:text-foreground -mb-1">
          <ArrowLeft size={16} /> Voltar
        </button>
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-foreground flex items-center gap-2"><Receipt className="w-5 h-5 text-rose-500" /> Contas a Pagar</h1>
            <p className="text-[13px] text-muted-foreground">
              {isClinic ? 'Contas fixas, parceladas e gastos do dia — só adm/gerente.' : 'Empresa separada — não entra no caixa/relatórios da clínica.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Empresa: '' = clínica; opção especial cria nova */}
            <select
              value={selectedCompany}
              onChange={(e) => { if (e.target.value === '__new__') { e.target.value = selectedCompany; newCompany(); } else setSelectedCompany(e.target.value); }}
              className="px-3 py-1.5 text-sm rounded-lg border border-border bg-background font-semibold"
              title="Empresa"
            >
              <option value="">🏥 Clínica</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value="__new__">➕ Nova empresa…</option>
            </select>
            {!isClinic && (
              <button onClick={renameCompany} title="Renomear empresa" className="p-1.5 rounded-lg border border-border hover:bg-accent"><Pencil size={14} /></button>
            )}
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="px-3 py-1.5 text-sm rounded-lg border border-border bg-background" />
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-3 gap-3">
          <Kpi label="Vencidas" value={fmt(kpiVencidas)} tone="rose" count={vencidas.length} />
          <Kpi label="A vencer no mês" value={fmt(kpiAVencer)} tone="amber" count={aVencer.length} />
          <Kpi label="Pago no mês" value={fmt(kpiPago)} tone="emerald" count={pagasMes.length} />
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-border">
          <TabBtn active={tab === 'fixas'} onClick={() => setTab('fixas')} icon={<Layers size={15} />} label="Contas Fixas" />
          <TabBtn active={tab === 'dia'} onClick={() => setTab('dia')} icon={<CalendarClock size={15} />} label="Gastos do dia" />
        </div>

        {/* Ações da aba */}
        <div className="flex flex-wrap gap-2">
          {tab === 'fixas' ? (
            <>
              <button onClick={() => setModal('parcelada')} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-bold rounded-lg bg-rose-500 text-white hover:bg-rose-600"><Layers size={15} /> Conta parcelada</button>
              <button onClick={() => setModal('recorrente')} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-bold rounded-lg border border-border hover:bg-accent"><Repeat size={15} /> Conta recorrente</button>
            </>
          ) : (
            <button onClick={() => setModal('dia')} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-bold rounded-lg bg-rose-500 text-white hover:bg-rose-600"><Plus size={15} /> Lançar gasto do dia</button>
          )}
        </div>

        {/* Lista */}
        {loading ? (
          <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <TxList
            items={listForTab}
            today={today}
            onPay={(t) => setPayTarget(t)}
            onEdit={(t) => setEditTarget(t)}
            onDelete={del}
            emptyLabel={tab === 'fixas' ? 'Nenhuma conta fixa neste mês.' : 'Nenhum gasto lançado neste mês.'}
          />
        )}
      </div>

      {modal === 'parcelada' && <ParceladaModal cats={cats} companyId={selectedCompany} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
      {modal === 'recorrente' && <RecorrenteModal cats={cats} companyId={selectedCompany} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
      {modal === 'dia' && <GastoDoDiaModal cats={cats} accounts={accounts} companyId={selectedCompany} isClinic={isClinic} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
      {payTarget && <PayModal tx={payTarget} accounts={accounts} isClinic={isClinic} onClose={() => setPayTarget(null)} onSaved={() => { setPayTarget(null); load(); }} onQuickPay={async () => { await pay(payTarget); setPayTarget(null); }} />}
      {editTarget && <EditModal tx={editTarget} cats={cats} onClose={() => setEditTarget(null)} onSaved={() => { setEditTarget(null); load(); }} />}
    </div>
  );
}

// ─── Componentes ──────────────────────────────────────────────
function Kpi({ label, value, tone, count }: { label: string; value: string; tone: 'rose' | 'amber' | 'emerald'; count: number }) {
  const toneCls = tone === 'rose' ? 'text-rose-500' : tone === 'amber' ? 'text-amber-500' : 'text-emerald-500';
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-lg font-bold ${toneCls}`}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{count} conta(s)</div>
    </div>
  );
}

function TabBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick} className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-bold border-b-2 -mb-px transition-colors ${active ? 'border-rose-500 text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>{icon}{label}</button>
  );
}

function TxList({ items, today, onPay, onEdit, onDelete, emptyLabel }: {
  items: Tx[]; today: string;
  onPay: (t: Tx) => void; onEdit: (t: Tx) => void; onDelete: (t: Tx) => void; emptyLabel: string;
}) {
  if (items.length === 0) return <div className="text-center text-sm text-muted-foreground py-12">{emptyLabel}</div>;
  const order = (t: Tx) => (t.status === 'PAGO' ? 2 : t.due_date && dayOf(t.due_date) < today ? 0 : 1);
  const sorted = [...items].sort((a, b) => order(a) - order(b) || (dayOf(a.due_date) < dayOf(b.due_date) ? -1 : 1));
  return (
    <div className="space-y-2">
      {sorted.map((t) => <TxRow key={t.id} t={t} today={today} onPay={onPay} onEdit={onEdit} onDelete={onDelete} />)}
    </div>
  );
}

function TxRow({ t, today, onPay, onEdit, onDelete }: { t: Tx; today: string; onPay: (t: Tx) => void; onEdit: (t: Tx) => void; onDelete: (t: Tx) => void }) {
  const paid = t.status === 'PAGO';
  const overdue = !paid && t.due_date && dayOf(t.due_date) < today;

  const badge = t.installment_total
    ? <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-500">{t.installment_sequence}/{t.installment_total}</span>
    : t.is_recurring
      ? <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-500 inline-flex items-center gap-0.5"><Repeat size={9} /> fixa</span>
      : t.parent_transaction_id
        ? <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-500 inline-flex items-center gap-0.5"><Repeat size={9} /> mês</span>
        : null;

  return (
    <div className={`rounded-xl border p-3 flex items-center gap-3 ${paid ? 'border-emerald-500/40 bg-emerald-500/5' : overdue ? 'border-rose-500/40 bg-rose-500/5' : 'border-border bg-card'}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-sm font-bold truncate ${paid ? 'text-emerald-700 dark:text-emerald-400' : 'text-foreground'}`}>{t.description}</span>
          {badge}
          {paid && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-600 inline-flex items-center gap-0.5"><Check size={9} /> pago{t.paid_at ? ` ${brDate(t.paid_at)}` : ''}</span>}
          {overdue && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-500 inline-flex items-center gap-0.5"><AlertTriangle size={9} /> vencida</span>}
        </div>
        <div className="text-[12px] text-muted-foreground">{t.category} · venc. {brDate(t.due_date)}{t.payment_method ? ` · ${t.payment_method}` : ''}</div>
      </div>
      <div className={`text-sm font-bold tabular-nums ${paid ? 'text-emerald-600' : 'text-foreground'}`}>{fmt(Number(t.amount))}</div>
      <div className="flex items-center gap-1">
        {!paid && <button title="Editar (valor e vencimento)" onClick={() => onEdit(t)} className="p-1.5 rounded border border-border hover:bg-accent"><Pencil size={13} /></button>}
        {!paid && <button title="Pagar" onClick={() => onPay(t)} className="p-1.5 rounded bg-emerald-500 text-white hover:bg-emerald-600"><Check size={14} /></button>}
        <button title="Excluir" onClick={() => onDelete(t)} className="p-1.5 rounded border border-border hover:bg-accent text-rose-500"><Trash2 size={13} /></button>
      </div>
    </div>
  );
}

// ─── Modais ───────────────────────────────────────────────────
function ModalShell({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-card border border-border p-5 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold text-foreground">{title}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[12px] font-bold text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
const inputCls = 'w-full px-3 py-2 text-sm rounded-lg border border-border bg-background';

/** Formata dígitos como moeda BR preenchendo da direita (centavos): "458936" → "4.589,36". */
const formatMoneyDigits = (raw: string): string => {
  const cents = parseInt((raw || '').replace(/\D/g, ''), 10);
  if (!Number.isFinite(cents)) return '';
  return (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** Campo de dinheiro com máscara BR automática (digite só números). */
function MoneyInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      inputMode="numeric"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '') ? formatMoneyDigits(e.target.value) : '')}
      placeholder={placeholder || '0,00'}
      className={inputCls}
    />
  );
}

function CategorySelect({ cats, value, onChange }: { cats: Category[]; value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
      <option value="">Selecione…</option>
      {cats.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
    </select>
  );
}

function EditModal({ tx, cats, onClose, onSaved }: { tx: Tx; cats: Category[]; onClose: () => void; onSaved: () => void }) {
  const [description, setDescription] = useState(tx.description);
  const [category, setCategory] = useState(tx.category);
  const [amount, setAmount] = useState(formatMoneyDigits(String(Math.round(Number(tx.amount) * 100))));
  const [dueDate, setDueDate] = useState(dayOf(tx.due_date));
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const amt = parseBRLNumber(amount);
    if (!description.trim() || !category || !(amt > 0)) { showError('Preencha descrição, categoria e valor'); return; }
    setSaving(true);
    try {
      await api.patch(`/payables/transactions/${tx.id}`, {
        description: description.trim(), category, amount: amt,
        due_date: dueDate ? `${dueDate}T12:00:00.000Z` : undefined,
      });
      showSuccess('Conta atualizada');
      onSaved();
    } catch (e: any) { showError(e?.response?.data?.message || 'Falha ao salvar'); }
    finally { setSaving(false); }
  };

  return (
    <ModalShell title="Editar conta" onClose={onClose}>
      <Field label="Descrição"><input value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} /></Field>
      <Field label="Categoria"><CategorySelect cats={cats} value={category} onChange={setCategory} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Valor (R$)"><MoneyInput value={amount} onChange={setAmount} /></Field>
        <Field label="Vencimento"><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputCls} /></Field>
      </div>
      {tx.is_recurring && <div className="text-[12px] text-muted-foreground bg-accent/50 rounded-lg p-2">🔄 Conta fixa: o vencimento muda só desta ocorrência. Os próximos meses o sistema gera sozinho (todo mês).</div>}
      <button disabled={saving} onClick={submit} className="w-full py-2.5 rounded-lg bg-rose-500 text-white font-bold hover:bg-rose-600 disabled:opacity-60 inline-flex items-center justify-center gap-2">{saving && <Loader2 size={15} className="animate-spin" />} Salvar</button>
    </ModalShell>
  );
}

function ParceladaModal({ cats, companyId, onClose, onSaved }: { cats: Category[]; companyId: string; onClose: () => void; onSaved: () => void }) {
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [total, setTotal] = useState('');
  const [installments, setInstallments] = useState('10');
  const [firstDue, setFirstDue] = useState(maceioTodayStr());
  const [method, setMethod] = useState('');
  const [saving, setSaving] = useState(false);

  const n = parseInt(installments || '0', 10);
  const totalNum = parseBRLNumber(total || '0');
  const perParcela = n > 0 && totalNum > 0 ? totalNum / n : 0;

  const submit = async () => {
    if (!description.trim() || !category || !(totalNum > 0) || !(n >= 1)) { showError('Preencha descrição, categoria, valor e parcelas'); return; }
    setSaving(true);
    try {
      await api.post('/payables/installment-plan', {
        description: description.trim(), category, total_amount: totalNum, installments: n,
        first_due_date: firstDue, payment_method: method || undefined,
        company_id: companyId || undefined,
      });
      showSuccess(`${n} parcela(s) criada(s)`);
      onSaved();
    } catch (e: any) { showError(e?.response?.data?.message || 'Falha ao criar parcelamento'); }
    finally { setSaving(false); }
  };

  return (
    <ModalShell title="Nova conta parcelada" onClose={onClose}>
      <Field label="Descrição"><input value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} placeholder="Ex: Compra de cadeira odontológica" /></Field>
      <Field label="Categoria"><CategorySelect cats={cats} value={category} onChange={setCategory} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Valor total (R$)"><MoneyInput value={total} onChange={setTotal} /></Field>
        <Field label="Parcelas"><input type="number" min="1" max="60" value={installments} onChange={(e) => setInstallments(e.target.value)} className={inputCls} /></Field>
      </div>
      <Field label="1º vencimento"><input type="date" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} className={inputCls} /></Field>
      <Field label="Forma (opcional)">
        <select value={method} onChange={(e) => setMethod(e.target.value)} className={inputCls}>
          <option value="">--</option>
          {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </Field>
      {perParcela > 0 && <div className="text-[12px] text-muted-foreground bg-accent/50 rounded-lg p-2">{n}x de <strong>{fmt(perParcela)}</strong> (a última ajusta os centavos) · 1 conta por mês a partir de {brDate(firstDue)}</div>}
      <button disabled={saving} onClick={submit} className="w-full py-2.5 rounded-lg bg-rose-500 text-white font-bold hover:bg-rose-600 disabled:opacity-60 inline-flex items-center justify-center gap-2">{saving && <Loader2 size={15} className="animate-spin" />} Criar {n || ''} parcelas</button>
    </ModalShell>
  );
}

function RecorrenteModal({ cats, companyId, onClose, onSaved }: { cats: Category[]; companyId: string; onClose: () => void; onSaved: () => void }) {
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [day, setDay] = useState('10');
  const [method, setMethod] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const amt = parseBRLNumber(amount || '0');
    const d = parseInt(day || '0', 10);
    if (!description.trim() || !category || !(amt > 0) || !(d >= 1 && d <= 31)) { showError('Preencha descrição, categoria, valor estimado e dia (1-31)'); return; }
    setSaving(true);
    try {
      // 1ª ocorrência: vencimento no dia deste mês (o cron gera os meses seguintes).
      // date=due_date ancorados ao meio-dia UTC pra a competência bater com o mês.
      const todayStr = maceioTodayStr();
      const [y, m] = todayStr.split('-');
      const maxDay = new Date(Date.UTC(Number(y), Number(m), 0, 12)).getUTCDate();
      const dueIso = `${y}-${m}-${String(Math.min(d, maxDay)).padStart(2, '0')}T12:00:00.000Z`;
      await api.post('/payables/transactions', {
        description: description.trim(), category, amount: amt,
        date: dueIso, due_date: dueIso, status: 'PENDENTE', payment_method: method || undefined,
        is_recurring: true, recurrence_pattern: 'MENSAL', recurrence_day: d,
        company_id: companyId || undefined,
      });
      showSuccess('Conta recorrente cadastrada');
      onSaved();
    } catch (e: any) { showError(e?.response?.data?.message || 'Falha ao cadastrar'); }
    finally { setSaving(false); }
  };

  return (
    <ModalShell title="Nova conta recorrente (mensal)" onClose={onClose}>
      <p className="text-[12px] text-muted-foreground">Água, energia, internet… Cadastra o valor estimado; o sistema gera 1 conta por mês e você <strong>ajusta o valor real</strong> antes de pagar.</p>
      <Field label="Descrição"><input value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} placeholder="Ex: Energia elétrica" /></Field>
      <Field label="Categoria"><CategorySelect cats={cats} value={category} onChange={setCategory} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Valor estimado (R$)"><MoneyInput value={amount} onChange={setAmount} /></Field>
        <Field label="Dia do vencimento"><input type="number" min="1" max="31" value={day} onChange={(e) => setDay(e.target.value)} className={inputCls} /></Field>
      </div>
      <Field label="Forma (opcional)">
        <select value={method} onChange={(e) => setMethod(e.target.value)} className={inputCls}>
          <option value="">--</option>
          {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </Field>
      <button disabled={saving} onClick={submit} className="w-full py-2.5 rounded-lg bg-rose-500 text-white font-bold hover:bg-rose-600 disabled:opacity-60 inline-flex items-center justify-center gap-2">{saving && <Loader2 size={15} className="animate-spin" />} Cadastrar conta fixa</button>
    </ModalShell>
  );
}

function GastoDoDiaModal({ cats, accounts, companyId, isClinic, onClose, onSaved }: { cats: Category[]; accounts: CashAccount[]; companyId: string; isClinic: boolean; onClose: () => void; onSaved: () => void }) {
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState(accounts[0]?.id || '');
  const [method, setMethod] = useState(METHOD_BY_KIND[accounts[0]?.kind] || 'DINHEIRO');
  const [paid, setPaid] = useState(true);
  const [saving, setSaving] = useState(false);

  const onAccountChange = (id: string) => {
    setAccountId(id);
    const acc = accounts.find((a) => a.id === id);
    if (acc) setMethod(METHOD_BY_KIND[acc.kind] || 'DINHEIRO');
  };

  const submit = async () => {
    const amt = parseBRLNumber(amount || '0');
    if (!description.trim() || !category || !(amt > 0)) { showError('Preencha descrição, categoria e valor'); return; }
    if (isClinic && paid && !accountId) { showError('Escolha a conta de onde saiu o dinheiro (pra bater no caixa)'); return; }
    setSaving(true);
    try {
      const body: any = { description: description.trim(), category, amount: amt, company_id: companyId || undefined };
      if (paid && isClinic) {
        // Clínica + pago → passa pelo CAIXA (debita a conta, entra no fechamento).
        body.status = 'PAGO'; body.account_id = accountId; body.payment_method = method;
      } else if (paid) {
        // Outra empresa + pago → só marca pago (não mexe no caixa da clínica).
        body.status = 'PAGO'; body.date = `${maceioTodayStr()}T12:00:00.000Z`; body.paid_at = new Date().toISOString();
      } else {
        body.status = 'PENDENTE'; body.date = `${maceioTodayStr()}T12:00:00.000Z`;
      }
      await api.post('/payables/transactions', body);
      showSuccess('Gasto lançado');
      onSaved();
    } catch (e: any) { showError(e?.response?.data?.message || 'Falha ao lançar'); }
    finally { setSaving(false); }
  };

  return (
    <ModalShell title="Lançar gasto do dia" onClose={onClose}>
      <Field label="Descrição"><input value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} placeholder="Ex: Material de limpeza" /></Field>
      <Field label="Categoria"><CategorySelect cats={cats} value={category} onChange={setCategory} /></Field>
      <Field label="Valor (R$)"><MoneyInput value={amount} onChange={setAmount} /></Field>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} /> Já pago{isClinic ? ' hoje (entra no caixa)' : ''}
      </label>
      {paid && isClinic && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Conta (de onde saiu)">
            <select value={accountId} onChange={(e) => onAccountChange(e.target.value)} className={inputCls}>
              <option value="">Selecione…</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Forma">
            <select value={method} onChange={(e) => setMethod(e.target.value)} className={inputCls}>
              {CAIXA_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
        </div>
      )}
      <button disabled={saving} onClick={submit} className="w-full py-2.5 rounded-lg bg-rose-500 text-white font-bold hover:bg-rose-600 disabled:opacity-60 inline-flex items-center justify-center gap-2">{saving && <Loader2 size={15} className="animate-spin" />} Lançar gasto</button>
    </ModalShell>
  );
}

function PayModal({ tx, accounts, isClinic, onClose, onSaved, onQuickPay }: { tx: Tx; accounts: CashAccount[]; isClinic: boolean; onClose: () => void; onSaved: () => void; onQuickPay: () => Promise<void> }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id || '');
  const [method, setMethod] = useState(METHOD_BY_KIND[accounts[0]?.kind] || 'DINHEIRO');
  const [saving, setSaving] = useState(false);

  const onAccountChange = (id: string) => {
    setAccountId(id);
    const acc = accounts.find((a) => a.id === id);
    if (acc) setMethod(METHOD_BY_KIND[acc.kind] || 'DINHEIRO');
  };

  const payCaixa = async () => {
    if (!accountId) { showError('Escolha a conta'); return; }
    setSaving(true);
    try {
      await api.post(`/payables/transactions/${tx.id}/pay`, { account_id: accountId, payment_method: method });
      showSuccess('Pago e lançado no caixa');
      onSaved();
    } catch (e: any) { showError(e?.response?.data?.message || 'Falha ao pagar'); }
    finally { setSaving(false); }
  };

  const quick = async () => {
    setSaving(true);
    try { await onQuickPay(); } finally { setSaving(false); }
  };

  return (
    <ModalShell title={`Pagar: ${tx.description}`} onClose={onClose}>
      <div className="text-sm text-muted-foreground">Valor: <strong className="text-foreground">{fmt(Number(tx.amount))}</strong></div>
      {isClinic ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Conta (de onde saiu)">
              <select value={accountId} onChange={(e) => onAccountChange(e.target.value)} className={inputCls}>
                <option value="">Selecione…</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <Field label="Forma">
              <select value={method} onChange={(e) => setMethod(e.target.value)} className={inputCls}>
                {CAIXA_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </Field>
          </div>
          <button disabled={saving} onClick={payCaixa} className="w-full py-2.5 rounded-lg bg-emerald-500 text-white font-bold hover:bg-emerald-600 disabled:opacity-60 inline-flex items-center justify-center gap-2">{saving && <Loader2 size={15} className="animate-spin" />} Pagar e lançar no caixa</button>
          <button disabled={saving} onClick={quick} className="w-full py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent">Só marcar como pago (sem passar pelo caixa)</button>
        </>
      ) : (
        <>
          <p className="text-[12px] text-muted-foreground">Empresa separada — o pagamento só é registrado (não entra no caixa da clínica).</p>
          <button disabled={saving} onClick={quick} className="w-full py-2.5 rounded-lg bg-emerald-500 text-white font-bold hover:bg-emerald-600 disabled:opacity-60 inline-flex items-center justify-center gap-2">{saving && <Loader2 size={15} className="animate-spin" />} Marcar como pago</button>
        </>
      )}
    </ModalShell>
  );
}
