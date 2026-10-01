'use client';

/**
 * Financeiro unificado. Abas: Contas a Pagar · Gastos do dia (manage_payables) +
 * Entradas · Pacientes · Log (view_financial). Em "Contas a Pagar", os tipos
 * Todas/Parceladas/Fixas/Variáveis são a navegação principal (partição sem
 * sobreposição). Saídas = DESPESA (FinancialTransaction) via /payables/* (gate próprio).
 */

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Plus, X, Loader2, Shield, Home, Check, Trash2, Pencil,
  CalendarClock, Repeat, Layers, AlertTriangle, ArrowLeft,
  Eye, EyeOff, Users, FileText, TrendingUp, DollarSign, ChevronDown,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useUserPermissions } from '@/lib/useUserPermissions';
import PacientesSummaryTab from '../components/PacientesSummaryTab';

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
  is_variable_amount?: boolean | null;
  lead?: { name?: string } | null;
}
interface Category { id: string; name: string; type: string; }
interface CashAccount { id: string; name: string; kind: string; active: boolean; }
interface Company { id: string; name: string; }
interface LogRow { id: string; action: string; created_at: string; actor?: { name?: string } | null; meta_json?: any }
interface ValCount { value: number; count: number }

const PAYMENT_METHODS = ['PIX', 'BOLETO', 'CARTAO', 'DINHEIRO', 'TRANSFERENCIA'];
// Formas aceitas pelo caixa (o gasto/pagamento que passa pela gaveta).
const CAIXA_METHODS = ['DINHEIRO', 'CARTAO', 'PIX', 'TRANSFERENCIA'];
// Forma sugerida por tipo de conta.
const METHOD_BY_KIND: Record<string, string> = { CAIXA: 'DINHEIRO', BANCO: 'PIX', CARTAO: 'CARTAO' };

export default function ContasAPagarPage() {
  const router = useRouter();
  const { hasPermission, ready } = useUserPermissions();
  // O painel virou O Financeiro. Acesso por OR: adm/gerente (manage_payables) OU setor
  // financeiro (view_financial). O que é SENSÍVEL (aluguel/folha/fornecedor + multi-empresa)
  // fica gateado POR ABA em manage_payables — o financeiro entra mas NÃO vê essas contas.
  const canManagePayables = hasPermission('manage_payables');
  const canViewFinancial = hasPermission('view_financial');
  const canManageFinancial = hasPermission('manage_financial'); // criar/editar receita
  const allowed = canManagePayables || canViewFinancial;

  // Estado da tela persistido no refresh (aba/empresa/mês).
  type PanelTab = 'fixas' | 'dia' | 'entradas' | 'pacientes' | 'log';
  const [tab, setTab] = useState<PanelTab>(() => {
    const t = readLS('payables_tab');
    return (['fixas', 'dia', 'entradas', 'pacientes', 'log'] as string[]).includes(t) ? (t as PanelTab) : 'fixas';
  });
  const [txs, setTxs] = useState<Tx[]>([]); // saídas (fixas ou gastos, conforme a aba)
  const [entradas, setEntradas] = useState<Tx[]>([]); // RECEITA (aba Entradas)
  const [logRows, setLogRows] = useState<LogRow[]>([]); // aba Log
  const [cats, setCats] = useState<Category[]>([]); // categorias de DESPESA (payables)
  const [receitaCats, setReceitaCats] = useState<Category[]>([]); // categorias de RECEITA (Nova Receita)
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string>(() => readLS('payables_company')); // '' = clínica
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState(() => readLS('payables_month') || maceioTodayStr().slice(0, 7)); // YYYY-MM
  const [modal, setModal] = useState<null | 'parcelada' | 'recorrente' | 'dia' | 'receita'>(null);
  const [payTarget, setPayTarget] = useState<Tx | null>(null);
  const [editTarget, setEditTarget] = useState<Tx | null>(null);
  // Resumo discreto de cobranças (Saldo Asaas / A Receber / Atrasado) + olho.
  const [asaasBalance, setAsaasBalance] = useState<number | null>(null);
  const [receber, setReceber] = useState<ValCount | null>(null);
  const [atrasado, setAtrasado] = useState<ValCount | null>(null);
  const [showValues, setShowValues] = useState<boolean>(() => readLS('payables_showvalues') === '1');
  // Filtro/navegação da aba Contas a Pagar (partição sem sobreposição):
  //  parcelada = compra em N vezes · recorrente = mensal fixo · variavel = mensal que muda.
  const [payKind, setPayKind] = useState<'all' | 'parcelada' | 'recorrente' | 'variavel'>('all');
  const [addMenu, setAddMenu] = useState(false); // menu "+ Adicionar" quando em "Todas"
  const [recVariavel, setRecVariavel] = useState(false); // default do modal recorrente (fixo × variável)
  // Empresa só é selecionável por quem tem manage_payables; o financeiro nunca sai da clínica.
  const effCompany = canManagePayables ? selectedCompany : '';
  const isClinic = !effCompany;
  // Abas de SAÍDA (aluguel/folha/fornecedor) — só adm/gerente (manage_payables).
  const SAIDA_TABS: PanelTab[] = ['fixas', 'dia'];
  // Abas do financeiro geral (não sensível) — view_financial; só na clínica.
  const FIN_TABS: PanelTab[] = ['entradas', 'pacientes', 'log'];
  const availableTabs: PanelTab[] = [
    ...(canManagePayables ? SAIDA_TABS : []),
    ...(canViewFinancial && isClinic ? FIN_TABS : []),
  ];
  const effTab: PanelTab = availableTabs.includes(tab) ? tab : (availableTabs[0] ?? 'fixas');

  const monthRange = useCallback(() => {
    const [y, m] = month.split('-').map(Number);
    // Bordas do mês no fuso de Maceió (UTC-3), casando com a janela do caixa:
    // dia 1 00:00 Maceió = 03:00Z; fim = dia 1 do mês seguinte 02:59:59.999Z
    // (= último dia 23:59:59.999 Maceió). Assim o gasto lançado à noite não pula.
    const start = new Date(Date.UTC(y, m - 1, 1, 3, 0, 0, 0)).toISOString();
    const end = new Date(Date.UTC(y, m, 1, 2, 59, 59, 999)).toISOString();
    return { start, end };
  }, [month]);

  // Dados da ABA ativa (saídas fixas/gastos, entradas ou log). Pacientes se vira sozinho.
  const load = useCallback(async () => {
    if (!allowed) return;
    setLoading(true);
    try {
      const { start, end } = monthRange();
      const companyQ = effCompany ? `&companyId=${effCompany}` : '';
      if (effTab === 'fixas') {
        if (!canManagePayables) { setTxs([]); return; } // saídas sensíveis: só adm/gerente
        const { data } = await api.get(`/payables/transactions?startDate=${start}&endDate=${end}&limit=500${companyQ}`);
        setTxs(((data?.data ?? data ?? []) as Tx[]).map((t) => ({ ...t, amount: Number(t.amount) })));
      } else if (effTab === 'dia') {
        if (!canManagePayables) { setTxs([]); return; }
        const { data } = await api.get(`/payables/gastos?startDate=${start}&endDate=${end}&limit=500${companyQ}`);
        setTxs(((data?.data ?? data ?? []) as Tx[]).map((t) => ({ ...t, amount: Number(t.amount) })));
      } else if (effTab === 'entradas') {
        if (!canViewFinancial) { setEntradas([]); return; }
        const { data } = await api.get(`/financeiro/transactions?type=RECEITA&startDate=${start}&endDate=${end}&limit=200`);
        setEntradas(((data?.data ?? data ?? []) as Tx[]).map((t) => ({ ...t, amount: Number(t.amount) })));
      } else if (effTab === 'log') {
        if (!canViewFinancial) { setLogRows([]); return; }
        const { data } = await api.get('/financeiro/audit-log?limit=60');
        setLogRows((data?.data ?? data ?? []) as LogRow[]);
      }
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao carregar');
    } finally {
      setLoading(false);
    }
  }, [allowed, monthRange, effCompany, effTab, canManagePayables, canViewFinancial]);

  // Refs de DESPESA (categorias/contas do payables) — só quem gerencia payables.
  const loadRefs = useCallback(async () => {
    if (!canManagePayables) return;
    try {
      const [catRes, accRes] = await Promise.all([api.get('/payables/categories'), api.get('/payables/accounts')]);
      setCats((catRes.data ?? []) as Category[]);
      setAccounts((accRes.data ?? []) as CashAccount[]);
    } catch { /* silencioso */ }
  }, [canManagePayables]);

  // Categorias de RECEITA (pro modal Nova Receita) — quem vê financeiro.
  const loadReceitaCats = useCallback(async () => {
    if (!canViewFinancial) return;
    try {
      const { data } = await api.get('/financeiro/categories');
      setReceitaCats(((data ?? []) as Category[]).filter((c) => c.type === 'RECEITA'));
    } catch { /* silencioso */ }
  }, [canViewFinancial]);

  // Resumo discreto de cobranças (só clínica + quem tem view_financial). O saldo Asaas
  // e o dashboard são o mundo A RECEBER (view_financial) — um gerente só-manage_payables
  // não vê (por isso o gate vem ANTES do fetch do balance).
  const loadSummary = useCallback(async () => {
    if (!allowed || !isClinic || !canViewFinancial) return;
    try { const b = await api.get('/payment-gateway/balance'); setAsaasBalance(b.data?.balance ?? b.data?.value ?? null); } catch { setAsaasBalance(null); }
    try {
      const { start, end } = monthRange();
      const { data } = await api.get(`/financeiro/dashboard?startDate=${start}&endDate=${end}`);
      setReceber(data?.a_receber_total ?? null);
      setAtrasado(data?.atrasado ?? null);
    } catch { setReceber(null); setAtrasado(null); }
  }, [allowed, isClinic, canViewFinancial, monthRange]);

  const loadCompanies = useCallback(async () => {
    if (!canManagePayables) return; // multi-empresa é dado sensível do dono
    try {
      const { data } = await api.get('/payables/companies');
      const list = (data ?? []) as Company[];
      setCompanies(list);
      // Se a empresa persistida foi apagada/desativada, volta pra clínica (evita erro no filtro).
      setSelectedCompany((cur) => (cur && !list.some((c) => c.id === cur) ? '' : cur));
    } catch { /* silencioso */ }
  }, [canManagePayables]);

  useEffect(() => { if (ready && allowed) load(); }, [ready, allowed, load]);
  useEffect(() => { if (ready && canManagePayables) loadRefs(); }, [ready, canManagePayables, loadRefs]);
  useEffect(() => { if (ready && canManagePayables) loadCompanies(); }, [ready, canManagePayables, loadCompanies]);
  useEffect(() => { if (ready && canViewFinancial) loadReceitaCats(); }, [ready, canViewFinancial, loadReceitaCats]);
  useEffect(() => { if (ready && allowed) loadSummary(); }, [ready, allowed, loadSummary]);
  // Se a aba persistida não está disponível pra este usuário/empresa, normaliza o
  // estado pro fallback (senão o localStorage grava uma aba que ele não pode usar).
  useEffect(() => { if (tab !== effTab) setTab(effTab); }, [tab, effTab]);
  // Persiste a preferência da tela pra o refresh continuar na mesma.
  useEffect(() => { writeLS('payables_tab', tab); }, [tab]);
  useEffect(() => { writeLS('payables_company', selectedCompany); }, [selectedCompany]);
  useEffect(() => { writeLS('payables_month', month); }, [month]);
  useEffect(() => { writeLS('payables_showvalues', showValues ? '1' : '0'); }, [showValues]);

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
  const isSaidasTab = effTab === 'fixas' || effTab === 'dia';
  // Partição do filtro (buckets exclusivos): parcelada · recorrente(fixo) · variável.
  const matchesKind = (t: Tx) => {
    if (payKind === 'all') return true;
    if (payKind === 'parcelada') return !!t.installment_total;
    if (payKind === 'variavel') return t.is_variable_amount === true;
    // recorrente = mensal de valor fixo (recorrente/ocorrência, NÃO parcela, NÃO variável)
    return (t.is_recurring || !!t.parent_transaction_id) && !t.installment_total && t.is_variable_amount !== true;
  };
  // fixas: filtra as fixas do que veio + o filtro do chip; dia: já vem só não-fixa.
  const listForTab = effTab === 'fixas' ? txs.filter(isFixed).filter(matchesKind) : txs;
  const pend = listForTab.filter((t) => t.status === 'PENDENTE');
  const vencidas = pend.filter((t) => t.due_date && dayOf(t.due_date) < today);
  const aVencer = pend.filter((t) => !t.due_date || dayOf(t.due_date) >= today);
  const pagasMes = listForTab.filter((t) => t.status === 'PAGO');
  const kpiVencidas = vencidas.reduce((s, t) => s + num(t), 0);
  const kpiAVencer = aVencer.reduce((s, t) => s + num(t), 0);
  const kpiPago = pagasMes.reduce((s, t) => s + num(t), 0);

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

  // Rótulo/ícone de cada aba (a barra é montada só com as abas permitidas).
  const TAB_META: Record<PanelTab, { label: string; icon: React.ReactNode }> = {
    fixas: { label: 'Contas a Pagar', icon: <Layers size={15} /> },
    dia: { label: 'Gastos do dia', icon: <CalendarClock size={15} /> },
    entradas: { label: 'Entradas', icon: <TrendingUp size={15} /> },
    pacientes: { label: 'Pacientes', icon: <Users size={15} /> },
    log: { label: 'Log', icon: <FileText size={15} /> },
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
            <h1 className="text-xl font-bold text-foreground flex items-center gap-2"><DollarSign className="w-5 h-5 text-emerald-500" /> Financeiro</h1>
            <p className="text-[13px] text-muted-foreground">
              {!isClinic
                ? 'Empresa separada — não entra no caixa/relatórios da clínica.'
                : canManagePayables
                  ? 'Contas, gastos, entradas e pacientes da clínica.'
                  : 'Entradas, pacientes e log da clínica.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Empresa (multi-empresa) — dado sensível do dono: só adm/gerente */}
            {canManagePayables && (
              <>
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
              </>
            )}
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="px-3 py-1.5 text-sm rounded-lg border border-border bg-background" />
          </div>
        </div>

        {/* Resumo discreto de cobranças (só clínica) — valores escondidos, olho revela */}
        {isClinic && (asaasBalance !== null || receber || atrasado) && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button onClick={() => setShowValues((v) => !v)} title={showValues ? 'Esconder valores' : 'Mostrar valores'} className="inline-flex items-center gap-1 px-2 py-1 text-[12px] font-semibold text-muted-foreground hover:text-foreground rounded-lg border border-border">
              {showValues ? <EyeOff size={13} /> : <Eye size={13} />} {showValues ? 'Esconder' : 'Ver valores'}
            </button>
            {asaasBalance !== null && <SummaryChip label="Saldo Asaas" value={fmt(asaasBalance)} show={showValues} tone={asaasBalance < 0 ? 'rose' : 'emerald'} />}
            {receber && <SummaryChip label="A receber" value={fmt(receber.value)} sub={`${receber.count}`} show={showValues} tone="sky" />}
            {atrasado && <SummaryChip label="Atrasado" value={fmt(atrasado.value)} sub={`${atrasado.count}`} show={showValues} tone="rose" />}
          </div>
        )}

        {/* KPIs — só nas abas de saída (Contas Fixas / Gastos do dia) */}
        {isSaidasTab && (
          <div className="grid grid-cols-3 gap-3">
            <Kpi label="Vencidas" value={fmt(kpiVencidas)} tone="rose" count={vencidas.length} />
            <Kpi label="A vencer no mês" value={fmt(kpiAVencer)} tone="amber" count={aVencer.length} />
            <Kpi label="Pago no mês" value={fmt(kpiPago)} tone="emerald" count={pagasMes.length} />
          </div>
        )}

        {/* Tabs — montadas só com as abas que o usuário pode ver */}
        <div className="flex items-center gap-1 border-b border-border overflow-x-auto">
          {availableTabs.map((t) => (
            <TabBtn key={t} active={effTab === t} onClick={() => setTab(t)} icon={TAB_META[t].icon} label={TAB_META[t].label} />
          ))}
        </div>

        {/* Aba Gastos do dia — botão único */}
        {effTab === 'dia' && (
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setModal('dia')} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-bold rounded-lg bg-rose-500 text-white hover:bg-rose-600"><Plus size={15} /> Lançar gasto do dia</button>
          </div>
        )}

        {/* Aba Contas a Pagar — TIPOS como navegação principal + adicionar contextual */}
        {effTab === 'fixas' && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Navegação principal por tipo */}
            <div className="inline-flex rounded-lg border border-border bg-card overflow-hidden text-[13px] font-bold">
              {([['all', 'Todas'], ['parcelada', 'Parceladas'], ['recorrente', 'Fixas'], ['variavel', 'Variáveis']] as const).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => { setPayKind(k); setAddMenu(false); }}
                  className={`px-3 py-1.5 transition-colors ${payKind === k ? 'bg-rose-500 text-white' : 'text-muted-foreground hover:bg-accent'}`}
                >{label}</button>
              ))}
            </div>
            {/* Adicionar: contextual no tipo selecionado; em "Todas" abre menu de escolha */}
            <div className="relative">
              {payKind === 'parcelada' ? (
                <button onClick={() => setModal('parcelada')} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-bold rounded-lg bg-rose-500 text-white hover:bg-rose-600"><Layers size={14} /> Nova parcelada</button>
              ) : payKind === 'recorrente' ? (
                <button onClick={() => { setRecVariavel(false); setModal('recorrente'); }} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-bold rounded-lg bg-rose-500 text-white hover:bg-rose-600"><Repeat size={14} /> Nova fixa</button>
              ) : payKind === 'variavel' ? (
                <button onClick={() => { setRecVariavel(true); setModal('recorrente'); }} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-bold rounded-lg bg-amber-500 text-white hover:bg-amber-600"><Repeat size={14} /> Nova variável</button>
              ) : (
                <>
                  <button onClick={() => setAddMenu((v) => !v)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-bold rounded-lg bg-rose-500 text-white hover:bg-rose-600"><Plus size={14} /> Adicionar <ChevronDown size={13} /></button>
                  {addMenu && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setAddMenu(false)} />
                      <div className="absolute right-0 mt-1 z-20 w-60 rounded-xl border border-border bg-card shadow-lg p-1">
                        <button onClick={() => { setAddMenu(false); setModal('parcelada'); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm font-semibold rounded-lg hover:bg-accent text-left"><Layers size={15} className="text-rose-500" /> Conta parcelada</button>
                        <button onClick={() => { setAddMenu(false); setRecVariavel(false); setModal('recorrente'); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm font-semibold rounded-lg hover:bg-accent text-left"><Repeat size={15} className="text-sky-500" /> Conta fixa (mesmo valor)</button>
                        <button onClick={() => { setAddMenu(false); setRecVariavel(true); setModal('recorrente'); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm font-semibold rounded-lg hover:bg-accent text-left"><Repeat size={15} className="text-amber-500" /> Conta variável (muda todo mês)</button>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}
        {effTab === 'entradas' && canManageFinancial && (
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setModal('receita')} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-bold rounded-lg bg-emerald-500 text-white hover:bg-emerald-600"><Plus size={15} /> Nova receita</button>
          </div>
        )}

        {/* Conteúdo da aba */}
        {effTab === 'pacientes' ? (
          <PacientesSummaryTab />
        ) : loading ? (
          <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : effTab === 'log' ? (
          <LogTab rows={logRows} />
        ) : effTab === 'entradas' ? (
          <EntradasTab items={entradas} />
        ) : (
          <TxList
            items={listForTab}
            today={today}
            onPay={(t) => setPayTarget(t)}
            onEdit={(t) => setEditTarget(t)}
            onDelete={del}
            emptyLabel={effTab === 'fixas' ? 'Nenhuma conta fixa neste mês.' : 'Nenhum gasto lançado neste mês.'}
          />
        )}
      </div>

      {modal === 'parcelada' && <ParceladaModal cats={cats} companyId={effCompany} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
      {modal === 'recorrente' && <RecorrenteModal cats={cats} companyId={effCompany} defaultVariavel={recVariavel} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
      {modal === 'dia' && <GastoDoDiaModal cats={cats} accounts={accounts} companyId={effCompany} isClinic={isClinic} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
      {modal === 'receita' && <NovaReceitaModal cats={receitaCats} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
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
    <div className="space-y-1.5">
      {sorted.map((t) => <TxRow key={t.id} t={t} today={today} onPay={onPay} onEdit={onEdit} onDelete={onDelete} />)}
    </div>
  );
}

function TxRow({ t, today, onPay, onEdit, onDelete }: { t: Tx; today: string; onPay: (t: Tx) => void; onEdit: (t: Tx) => void; onDelete: (t: Tx) => void }) {
  const paid = t.status === 'PAGO';
  const overdue = !paid && t.due_date && dayOf(t.due_date) < today;

  const variavel = t.is_variable_amount === true;
  const badge = t.installment_total
    ? <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-500">{t.installment_sequence}/{t.installment_total}</span>
    : (t.is_recurring || t.parent_transaction_id)
      ? (variavel
          ? <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 inline-flex items-center gap-0.5"><Repeat size={9} /> variável</span>
          : <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-500 inline-flex items-center gap-0.5"><Repeat size={9} /> fixa</span>)
      : null;

  return (
    <div className={`rounded-lg border px-3 py-2 flex items-center gap-2 ${paid ? 'border-emerald-500/40 bg-emerald-500/5' : overdue ? 'border-rose-500/40 bg-rose-500/5' : 'border-border bg-card'}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`text-[13px] font-bold truncate ${paid ? 'text-emerald-700 dark:text-emerald-400' : 'text-foreground'}`}>{t.description}</span>
          {badge}
          {paid && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-600 inline-flex items-center gap-0.5"><Check size={9} /> pago{t.paid_at ? ` ${brDate(t.paid_at)}` : ''}</span>}
          {overdue && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-500 inline-flex items-center gap-0.5"><AlertTriangle size={9} /> vencida</span>}
        </div>
        <div className="text-[11px] text-muted-foreground truncate">{t.category} · venc. {brDate(t.due_date)}{t.payment_method ? ` · ${t.payment_method}` : ''}</div>
      </div>
      <div className={`text-[13px] font-bold tabular-nums ${paid ? 'text-emerald-600' : 'text-foreground'}`}>{fmt(Number(t.amount))}</div>
      <div className="flex items-center gap-1">
        {!paid && <button title="Editar (valor e vencimento)" onClick={() => onEdit(t)} className="p-1 rounded border border-border hover:bg-accent"><Pencil size={12} /></button>}
        {!paid && <button title="Pagar" onClick={() => onPay(t)} className="p-1 rounded bg-emerald-500 text-white hover:bg-emerald-600"><Check size={13} /></button>}
        <button title="Excluir" onClick={() => onDelete(t)} className="p-1 rounded border border-border hover:bg-accent text-rose-500"><Trash2 size={12} /></button>
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
  const [variavel, setVariavel] = useState(tx.is_variable_amount === true);
  const [saving, setSaving] = useState(false);
  // Só recorrentes têm classificação fixo/variável (parcelas são sempre valor exato).
  const isRecorrente = tx.is_recurring || !!tx.parent_transaction_id;

  const submit = async () => {
    const amt = parseBRLNumber(amount);
    if (!description.trim() || !category || !(amt > 0)) { showError('Preencha descrição, categoria e valor'); return; }
    setSaving(true);
    try {
      await api.patch(`/payables/transactions/${tx.id}`, {
        description: description.trim(), category, amount: amt,
        due_date: dueDate ? `${dueDate}T12:00:00.000Z` : undefined,
        ...(isRecorrente ? { is_variable_amount: variavel } : {}),
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
      {isRecorrente && (
        <Field label="Tipo de valor">
          <div className="inline-flex w-full rounded-lg border border-border overflow-hidden text-sm font-bold">
            <button type="button" onClick={() => setVariavel(false)} className={`flex-1 px-3 py-2 transition-colors ${!variavel ? 'bg-rose-500 text-white' : 'text-muted-foreground hover:bg-accent'}`}>Fixo (mesmo valor)</button>
            <button type="button" onClick={() => setVariavel(true)} className={`flex-1 px-3 py-2 transition-colors ${variavel ? 'bg-amber-500 text-white' : 'text-muted-foreground hover:bg-accent'}`}>Variável (muda)</button>
          </div>
        </Field>
      )}
      {tx.is_recurring && <div className="text-[12px] text-muted-foreground bg-accent/50 rounded-lg p-2">🔄 Conta mensal: o vencimento/valor muda só desta ocorrência. Os próximos meses o sistema gera sozinho.</div>}
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

function RecorrenteModal({ cats, companyId, defaultVariavel = false, onClose, onSaved }: { cats: Category[]; companyId: string; defaultVariavel?: boolean; onClose: () => void; onSaved: () => void }) {
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [day, setDay] = useState('10');
  const [method, setMethod] = useState('');
  const [variavel, setVariavel] = useState(defaultVariavel); // vem do contexto (chip Recorrentes=fixo, Variáveis=variável)
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const amt = parseBRLNumber(amount || '0');
    const d = parseInt(day || '0', 10);
    if (!description.trim() || !category || !(amt > 0) || !(d >= 1 && d <= 31)) { showError('Preencha descrição, categoria, valor e dia (1-31)'); return; }
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
        is_variable_amount: variavel,
        company_id: companyId || undefined,
      });
      showSuccess(variavel ? 'Conta variável cadastrada' : 'Conta fixa cadastrada');
      onSaved();
    } catch (e: any) { showError(e?.response?.data?.message || 'Falha ao cadastrar'); }
    finally { setSaving(false); }
  };

  return (
    <ModalShell title={variavel ? 'Nova conta variável (mensal)' : 'Nova conta fixa (mensal)'} onClose={onClose}>
      <p className="text-[12px] text-muted-foreground">Conta que se repete todo mês. O sistema gera 1 por mês automaticamente.</p>
      <Field label="Descrição"><input value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} placeholder="Ex: Aluguel / Energia elétrica" /></Field>
      <Field label="Categoria"><CategorySelect cats={cats} value={category} onChange={setCategory} /></Field>
      {/* Fixo × Variável */}
      <Field label="Tipo de valor">
        <div className="inline-flex w-full rounded-lg border border-border overflow-hidden text-sm font-bold">
          <button type="button" onClick={() => setVariavel(false)} className={`flex-1 px-3 py-2 transition-colors ${!variavel ? 'bg-rose-500 text-white' : 'text-muted-foreground hover:bg-accent'}`}>Fixo (mesmo valor)</button>
          <button type="button" onClick={() => setVariavel(true)} className={`flex-1 px-3 py-2 transition-colors ${variavel ? 'bg-amber-500 text-white' : 'text-muted-foreground hover:bg-accent'}`}>Variável (muda)</button>
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={variavel ? 'Valor estimado (R$)' : 'Valor (R$)'}><MoneyInput value={amount} onChange={setAmount} /></Field>
        <Field label="Dia do vencimento"><input type="number" min="1" max="31" value={day} onChange={(e) => setDay(e.target.value)} className={inputCls} /></Field>
      </div>
      <Field label="Forma (opcional)">
        <select value={method} onChange={(e) => setMethod(e.target.value)} className={inputCls}>
          <option value="">--</option>
          {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </Field>
      <p className="text-[12px] text-muted-foreground bg-accent/50 rounded-lg p-2">
        {variavel
          ? '💡 Variável (energia/água/internet): cadastra o estimado e você ajusta o valor real antes de pagar cada mês.'
          : '💡 Fixo (aluguel/FGTS/folha): mesmo valor todo mês — já vem preenchido pra pagar.'}
      </p>
      <button disabled={saving} onClick={submit} className="w-full py-2.5 rounded-lg bg-rose-500 text-white font-bold hover:bg-rose-600 disabled:opacity-60 inline-flex items-center justify-center gap-2">{saving && <Loader2 size={15} className="animate-spin" />} Cadastrar conta</button>
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

// ─── Resumo discreto de cobranças (Saldo Asaas / A Receber / Atrasado) ────────
// Valor escondido por padrão; o olho no cabeçalho revela. Nunca aparece pra
// outras empresas (só clínica) — é dado sensível do gateway.
function SummaryChip({ label, value, sub, show, tone }: { label: string; value: string; sub?: string; show: boolean; tone: 'rose' | 'emerald' | 'sky' }) {
  const toneCls = tone === 'rose' ? 'text-rose-500' : tone === 'sky' ? 'text-sky-500' : 'text-emerald-500';
  return (
    <div className="rounded-lg border border-border bg-card px-2.5 py-1 text-right leading-tight">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}{sub ? ` · ${sub}` : ''}</div>
      <div className={`text-[13px] font-bold tabular-nums ${show ? toneCls : 'text-muted-foreground'}`}>{show ? value : '••••••'}</div>
    </div>
  );
}

// ─── Aba Entradas (RECEITA do mês, só leitura) ────────────────────────────────
// Espelho das entradas do Financeiro — o lançamento continua na tela de recepção;
// aqui é a visão consolidada pro adm/gerente (mesma fonte, nada é duplicado).
function EntradasTab({ items }: { items: Tx[] }) {
  if (items.length === 0) return <div className="text-center text-sm text-muted-foreground py-12">Nenhuma entrada neste mês.</div>;
  const total = items.reduce((s, t) => s + Number(t.amount), 0);
  const sorted = [...items].sort((a, b) => (dayOf(b.date) < dayOf(a.date) ? -1 : 1));
  return (
    <div className="space-y-2">
      <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-3 flex items-center justify-between">
        <span className="text-[12px] font-bold uppercase tracking-wide text-emerald-600">Total de entradas · {items.length}</span>
        <span className="text-lg font-bold tabular-nums text-emerald-600">{fmt(total)}</span>
      </div>
      {sorted.map((t) => (
        <div key={t.id} className="rounded-xl border border-border bg-card p-3 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-foreground truncate">{t.description}</div>
            <div className="text-[12px] text-muted-foreground">{t.category}{t.lead?.name ? ` · ${t.lead.name}` : ''} · {brDate(t.date)}{t.payment_method ? ` · ${t.payment_method}` : ''}</div>
          </div>
          <div className="text-sm font-bold tabular-nums text-emerald-600">{fmt(Number(t.amount))}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Aba Log (auditoria do financeiro) ────────────────────────────────────────
const LOG_LABELS: Record<string, { label: string; tone: string }> = {
  DESPESA_CRIADA: { label: 'Despesa criada', tone: 'text-rose-500' },
  RECEITA_CRIADA: { label: 'Receita criada', tone: 'text-emerald-500' },
  DESPESA_EDITADA: { label: 'Despesa editada', tone: 'text-amber-500' },
  RECEITA_EDITADA: { label: 'Receita editada', tone: 'text-amber-500' },
  DESPESA_PAGA: { label: 'Despesa paga', tone: 'text-emerald-500' },
  PAGAMENTO_RECEBIDO: { label: 'Pagamento recebido', tone: 'text-emerald-500' },
  PAGAMENTO_PARCIAL: { label: 'Pagamento parcial', tone: 'text-sky-500' },
  DIARIA_LANCADA: { label: 'Diária lançada', tone: 'text-violet-500' },
  DESPESA_EXCLUIDA: { label: 'Despesa excluída', tone: 'text-rose-500' },
  RECEITA_EXCLUIDA: { label: 'Receita excluída', tone: 'text-rose-500' },
};
function LogTab({ rows }: { rows: LogRow[] }) {
  if (rows.length === 0) return <div className="text-center text-sm text-muted-foreground py-12">Sem movimentações registradas.</div>;
  const dt = (iso: string) => { try { return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return iso; } };
  return (
    <div className="space-y-2">
      {rows.map((r) => {
        const meta = (r.meta_json || {}) as any;
        const info = LOG_LABELS[r.action] || { label: r.action.replace(/_/g, ' ').toLowerCase(), tone: 'text-foreground' };
        return (
          <div key={r.id} className="rounded-xl border border-border bg-card p-3 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-[11px] font-bold uppercase tracking-wide ${info.tone}`}>{info.label}</span>
                {meta.descricao && <span className="text-sm font-semibold text-foreground truncate">{meta.descricao}</span>}
              </div>
              <div className="text-[12px] text-muted-foreground">{r.actor?.name || 'Sistema'} · {dt(r.created_at)}{meta.categoria ? ` · ${meta.categoria}` : ''}</div>
            </div>
            {meta.valor != null && <div className="text-sm font-bold tabular-nums text-foreground">{fmt(Number(meta.valor))}</div>}
          </div>
        );
      })}
    </div>
  );
}

// ─── Modal Nova Receita (lançar entrada avulsa) ───────────────────────────────
// Gate no botão por manage_financial; grava RECEITA em FinancialTransaction (mesma
// fonte da recepção). Categoria = lista de RECEITA OU texto livre (category é string,
// não FK), então não precisa de CRUD de categoria separado.
function NovaReceitaModal({ cats, onClose, onSaved }: { cats: Category[]; onClose: () => void; onSaved: () => void }) {
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [customCat, setCustomCat] = useState('');
  const [useCustom, setUseCustom] = useState(cats.length === 0);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(maceioTodayStr());
  const [method, setMethod] = useState('');
  const [received, setReceived] = useState(true);
  const [saving, setSaving] = useState(false);
  // Se as categorias de RECEITA chegarem DEPOIS do modal montar (fetch lento), volta
  // pro select (o initializer só roda na montagem). Só dispara na transição 0→N.
  useEffect(() => { if (cats.length > 0) setUseCustom(false); }, [cats.length]);

  const submit = async () => {
    const amt = parseBRLNumber(amount || '0');
    const cat = (useCustom ? customCat : category).trim();
    if (!description.trim() || !cat || !(amt > 0)) { showError('Preencha descrição, categoria e valor'); return; }
    setSaving(true);
    try {
      const body: any = {
        type: 'RECEITA', description: description.trim(), category: cat, amount: amt,
        date: `${date}T12:00:00.000Z`, status: received ? 'PAGO' : 'PENDENTE',
        payment_method: method || undefined,
      };
      if (received) body.paid_at = new Date().toISOString();
      await api.post('/financeiro/transactions', body);
      showSuccess('Receita lançada');
      onSaved();
    } catch (e: any) { showError(e?.response?.data?.message || 'Falha ao lançar'); }
    finally { setSaving(false); }
  };

  return (
    <ModalShell title="Nova receita" onClose={onClose}>
      <Field label="Descrição"><input value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} placeholder="Ex: Recebimento avulso" /></Field>
      <Field label="Categoria">
        {useCustom ? (
          <div className="flex gap-2">
            <input value={customCat} onChange={(e) => setCustomCat(e.target.value)} className={inputCls} placeholder="Nova categoria" />
            {cats.length > 0 && <button type="button" onClick={() => setUseCustom(false)} className="px-2 rounded-lg border border-border text-[12px] font-semibold hover:bg-accent">Lista</button>}
          </div>
        ) : (
          <select value={category} onChange={(e) => { if (e.target.value === '__outra__') { setUseCustom(true); setCategory(''); } else setCategory(e.target.value); }} className={inputCls}>
            <option value="">Selecione…</option>
            {cats.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
            <option value="__outra__">➕ Outra…</option>
          </select>
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Valor (R$)"><MoneyInput value={amount} onChange={setAmount} /></Field>
        <Field label="Data"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} /></Field>
      </div>
      <Field label="Forma (opcional)">
        <select value={method} onChange={(e) => setMethod(e.target.value)} className={inputCls}>
          <option value="">--</option>
          {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </Field>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" checked={received} onChange={(e) => setReceived(e.target.checked)} /> Já recebido
      </label>
      <button disabled={saving} onClick={submit} className="w-full py-2.5 rounded-lg bg-emerald-500 text-white font-bold hover:bg-emerald-600 disabled:opacity-60 inline-flex items-center justify-center gap-2">{saving && <Loader2 size={15} className="animate-spin" />} Lançar receita</button>
    </ModalShell>
  );
}
