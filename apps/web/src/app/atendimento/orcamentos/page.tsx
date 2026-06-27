'use client';

/**
 * Dashboard de Orçamentos (Fase 24 — Onda 1).
 *
 * Visão gerencial pra recepção/dentista monitorar funil de vendas:
 *  - Cards de stats (DRAFT/SENT/ACCEPTED/REJECTED/EXPIRED + conversão + expirando)
 *  - Lista filtrada por status, dentista criador, range de datas, busca
 *  - Cada item linkavel pra ficha do paciente
 *  - Botão "Enviar via WhatsApp" inline em SENT/DRAFT pra reagir rápido
 *
 * Métrica de sucesso: clínica aumentar a conversão Quote→TreatmentPlan.
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  DollarSign, Loader2, Search, Send, Check, X, MessageCircle,
  AlertTriangle, TrendingUp, Users, List, LayoutGrid,
  ChevronDown, ChevronUp, User, ShieldCheck,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Quote {
  id: string;
  status: 'DRAFT' | 'SENT' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
  total_value: string | number;
  created_at: string;
  valid_until: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  patient: { id: string; name: string | null; phone: string | null };
  created_by: { id: string; name: string } | null;
  _count?: { items: number };
  /** Onda 14.33 — Marca que o operador apertou "Salvar proposta",
   *  formalizando como a escolhida. Usado pra distinguir "aprovadas" de
   *  "apenas aceitas" no funil. */
  is_chosen_proposal?: boolean;
}

interface DashboardStats {
  byStatus: Record<string, { count: number; total: number }>;
  total_count: number;
  pipeline_value: number;
  revenue_accepted: number;
  conversion_rate: number | null;
  expiring_soon: number;
}

const STATUS_BADGE: Record<Quote['status'], string> = {
  DRAFT: 'bg-muted text-muted-foreground border-border',
  SENT: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
  ACCEPTED: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  REJECTED: 'bg-destructive/10 text-destructive border-destructive/20',
  EXPIRED: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
};

const STATUS_LABEL: Record<Quote['status'], string> = {
  DRAFT: 'Rascunho',
  SENT: 'Enviado',
  ACCEPTED: 'Aceito',
  REJECTED: 'Rejeitado',
  EXPIRED: 'Expirado',
};

const formatBRL = (v: number | string) =>
  Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function expiryStatus(validUntil: string | null, status: string): { text: string; cls: string } | null {
  if (!validUntil || ['ACCEPTED', 'REJECTED'].includes(status)) return null;
  const expiry = new Date(validUntil);
  const daysLeft = Math.floor((expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  if (daysLeft < 0) return { text: `Expirou há ${Math.abs(daysLeft)}d`, cls: 'text-red-600' };
  if (daysLeft === 0) return { text: 'Expira hoje', cls: 'text-red-600' };
  if (daysLeft <= 7) return { text: `Expira em ${daysLeft}d`, cls: 'text-amber-600' };
  return { text: `${daysLeft}d`, cls: 'text-muted-foreground' };
}

export default function OrcamentosPage() {
  return (
    <Suspense fallback={
      <div className="p-6 flex items-center justify-center text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
      </div>
    }>
      <OrcamentosPageInner />
    </Suspense>
  );
}

function OrcamentosPageInner() {
  const router = useRouter();
  // Onda 17.32.41 — Le ?status= da URL pra pre-selecionar o filtro
  // (atalho "Propostas" no sidebar abre /atendimento/orcamentos?status=SENT).
  const searchParams = useSearchParams();
  const urlStatus = searchParams?.get('status') || '';
  const [list, setList] = useState<Quote[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>(urlStatus);
  // Mantem filtro em sincro com o URL (quando operador clica entre Orcamentos
  // e Propostas no sidebar, ou volta/avanca no historico do browser).
  useEffect(() => { setStatusFilter(urlStatus); }, [urlStatus]);
  const [search, setSearch] = useState('');
  // Onda 15 (etapa 19) — view por dentista + filtro por dentista especifico
  const [viewMode, setViewMode] = useState<'list' | 'by-dentist'>('list');
  const [dentistFilter, setDentistFilter] = useState<string>(''); // '' = todos
  const [collapsedDentists, setCollapsedDentists] = useState<Set<string>>(new Set());

  // Lista de dentistas unicos com KPIs — derivado de list (client-side).
  const dentists = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number; total: number; accepted: number; sent: number }>();
    for (const q of list) {
      const id = q.created_by?.id || 'SEM_DENTISTA';
      const name = q.created_by?.name || 'Sem dentista atribuído';
      const existing = map.get(id) || { id, name, count: 0, total: 0, accepted: 0, sent: 0 };
      existing.count += 1;
      existing.total += Number(q.total_value) || 0;
      if (q.status === 'ACCEPTED') existing.accepted += 1;
      if (q.status === 'SENT') existing.sent += 1;
      map.set(id, existing);
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [list]);

  // Lista filtrada (status + busca + dentista) — usada nas duas views.
  const filteredList = useMemo(() => {
    if (!dentistFilter) return list;
    return list.filter((q) => (q.created_by?.id || 'SEM_DENTISTA') === dentistFilter);
  }, [list, dentistFilter]);

  // Onda 15 (etapa 19.6) — Stats CALCULADAS NO CLIENTE a partir da lista
  // carregada. Antes dependia do endpoint /quotes/dashboard, que tinha
  // bug de roteamento (route order) e quando falhava deixava todos os
  // cards invisiveis. Computando aqui: cards sempre aparecem se houver
  // pelo menos 1 orcamento carregado, independente do backend.
  // OBS: respeita o filtro de dentista pra dar uma visao por profissional.
  //
  // Onda 15 (etapa 19.7) — Estendido pra incluir KPIs do funil completo:
  // - patients_evaluated: pacientes unicos com orcamento (proxy de
  //   avaliacoes realizadas — cada paciente que tem qualquer orcamento
  //   passou pela cadeira do dentista pelo menos uma vez).
  // - approved: count + R$ de quotes ACEITAS E marcadas como proposta
  //   escolhida (is_chosen_proposal=true) — ou seja, o operador apertou
  //   "Salvar proposta" / "Aprovar e cobrar". Distingue "paciente disse
  //   sim" de "venda fechada com plano de tratamento ativo".
  const computedStats = useMemo<(DashboardStats & {
    patients_evaluated: number;
    approved_count: number;
    approved_value: number;
  }) | null>(() => {
    if (list.length === 0) return null;
    const source = filteredList; // respeita filtro de dentista
    const byStatus: Record<string, { count: number; total: number }> = {
      DRAFT: { count: 0, total: 0 },
      SENT: { count: 0, total: 0 },
      ACCEPTED: { count: 0, total: 0 },
      REJECTED: { count: 0, total: 0 },
      EXPIRED: { count: 0, total: 0 },
    };
    let pipelineValue = 0;
    let revenueAccepted = 0;
    let expiringSoon = 0;
    let approvedCount = 0;
    let approvedValue = 0;
    const uniquePatients = new Set<string>();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const q of source) {
      const value = Number(q.total_value) || 0;
      if (byStatus[q.status]) {
        byStatus[q.status].count += 1;
        byStatus[q.status].total += value;
      }
      if (q.patient?.id) {
        uniquePatients.add(q.patient.id);
      }
      if (q.status === 'SENT') {
        pipelineValue += value;
        if (q.valid_until) {
          const expiry = new Date(q.valid_until).getTime();
          if (expiry - now > 0 && expiry - now <= sevenDaysMs) {
            expiringSoon += 1;
          }
        }
      }
      if (q.status === 'ACCEPTED') {
        revenueAccepted += value;
        // "Aprovada" = aceita + formalizada como proposta escolhida pelo
        // operador (is_chosen_proposal=true). Proxy pra "venda fechada
        // com plano ativo" enquanto nao integramos o status do plano.
        if (q.is_chosen_proposal) {
          approvedCount += 1;
          approvedValue += value;
        }
      }
    }
    const decided = byStatus.ACCEPTED.count + byStatus.REJECTED.count;
    const conversionRate = decided > 0 ? byStatus.ACCEPTED.count / decided : null;
    return {
      byStatus,
      total_count: source.length,
      pipeline_value: pipelineValue,
      revenue_accepted: revenueAccepted,
      conversion_rate: conversionRate,
      expiring_soon: expiringSoon,
      patients_evaluated: uniquePatients.size,
      approved_count: approvedCount,
      approved_value: approvedValue,
    };
  }, [list, filteredList]);

  // Stats finais: prioriza o backend (mais detalhado, ex: agregacao por
  // periodo de 30d) e cai pro calculado se backend nao respondeu.
  // Note: campos extras (patients_evaluated, approved_*) sempre vem do
  // computado (backend nao retorna ainda).
  const displayStats = stats
    ? { ...stats, patients_evaluated: computedStats?.patients_evaluated ?? 0, approved_count: computedStats?.approved_count ?? 0, approved_value: computedStats?.approved_value ?? 0 }
    : computedStats;

  // Quotes agrupados por dentista, ordenados por total. Respeita o filtro
  // de dentista (se nenhum: mostra todos os grupos; se filtrado: 1 grupo).
  const groupedByDentist = useMemo(() => {
    return dentists
      .filter((d) => !dentistFilter || d.id === dentistFilter)
      .map((d) => ({
        ...d,
        quotes: filteredList.filter((q) => (q.created_by?.id || 'SEM_DENTISTA') === d.id),
      }))
      .filter((g) => g.quotes.length > 0);
  }, [dentists, filteredList, dentistFilter]);

  const toggleDentistCollapse = (id: string) => {
    setCollapsedDentists((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter && statusFilter !== 'ARCHIVED') params.set('status', statusFilter);
      if (search.trim()) params.set('search', search.trim());
      params.set('limit', '200');
      // Onda 17.32.39 — Filtro especial "ARCHIVED" puxa do endpoint
      // /quotes/archived (que retorna por archived_at, nao por status).
      // Demais filtros continuam batendo no /quotes regular.
      const listEndpoint = statusFilter === 'ARCHIVED'
        ? '/quotes/archived'
        : `/quotes?${params}`;
      const [listRes, statsRes] = await Promise.allSettled([
        api.get<Quote[]>(listEndpoint),
        api.get<DashboardStats>('/quotes/dashboard'),
      ]);
      if (listRes.status === 'fulfilled') {
        setList(listRes.value.data);
      } else {
        const err: any = listRes.reason;
        showError(err?.response?.data?.message || 'Erro ao carregar lista de orçamentos');
      }
      if (statsRes.status === 'fulfilled') {
        setStats(statsRes.value.data);
      } else {
        // Falha de stats nao bloqueia a tela — esconde os cards no topo.
        setStats(null);
        const err: any = statsRes.reason;
        const msg = err?.response?.data?.message || 'Erro ao carregar estatísticas';
        // Nao spamma toast: so loga (lista ja sobe sozinha).
        console.warn('[orcamentos] stats falhou:', msg);
      }
    } catch (err: any) {
      // Catch defensivo para qualquer erro inesperado fora dos endpoints.
      showError(err?.response?.data?.message || 'Erro ao carregar orçamentos');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search]);

  useEffect(() => {
    const t = setTimeout(load, 250); // debounce na busca
    return () => clearTimeout(t);
  }, [load]);

  const sendWhatsApp = async (q: Quote) => {
    if (!confirm(`Enviar orçamento de ${formatBRL(q.total_value)} pra ${q.patient.name || 'paciente'} via WhatsApp?`)) return;
    try {
      const { data } = await api.post(`/quotes/${q.id}/send-whatsapp`);
      showSuccess(`Enviado pra ${data.sent_to}`);
      load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao enviar');
    }
  };

  return (
    // h-full + overflow-y-auto: o <main> do atendimento é overflow-hidden, então a
    // página precisa do próprio contêiner rolável (mesmo padrão da ficha do paciente).
    // Sem isso, a lista de orçamentos era cortada na viewport e não rolava pra baixo.
    <div className="h-full overflow-y-auto p-6 w-full">
      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <DollarSign size={26} className="text-primary" /> Orçamentos
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Funil comercial. Acompanhe rascunhos, envios, aceitações e taxa de conversão.
          </p>
        </div>
      </div>

      {/* Onda 15 (etapa 19.4) — Cards focados no FUNIL (em vez de
          contagem por status, que era informacao tecnica). Operador agora
          ve de relance: quanto dinheiro tem em jogo, quantos pacientes
          esperam decisao, o que e urgente, o que ja se perdeu, e o quao
          eficiente esta fechando.

          Breakdown completo por status segue disponivel via os chips de
          filtro abaixo. */}
      {displayStats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          {/* Funil enxuto — so 5 cards, sem repeticao nem ruido de zeros.
              Vencidos/expirando saem (so apareciam =0 a maior parte do tempo);
              "Aguardando resposta" colapsou pra sub-label do Pipeline (mesma
              info: SENT, R$ vs count). */}
          <FunnelCard
            icon={Users}
            label="Avaliações realizadas"
            value={displayStats.patients_evaluated}
            sub="pacientes únicos com orçamento"
            colorClass="blue"
          />
          <FunnelCard
            icon={DollarSign}
            label="Pipeline em fechamento"
            value={formatBRL(displayStats.byStatus.SENT?.total ?? 0)}
            sub={`${displayStats.byStatus.SENT?.count ?? 0} proposta(s) aguardando`}
            colorClass="emerald"
          />
          <FunnelCard
            icon={Check}
            label="Propostas aceitas"
            value={displayStats.byStatus.ACCEPTED?.count ?? 0}
            sub={formatBRL(displayStats.byStatus.ACCEPTED?.total ?? 0)}
            colorClass="emerald"
          />
          <FunnelCard
            icon={ShieldCheck}
            label="Aprovadas (fechadas)"
            value={displayStats.approved_count}
            sub={displayStats.approved_count > 0 ? formatBRL(displayStats.approved_value) : 'aceita + plano ativado'}
            colorClass="violet"
          />
          <FunnelCard
            icon={TrendingUp}
            label="Conversão"
            value={displayStats.conversion_rate !== null ? `${(displayStats.conversion_rate * 100).toFixed(0)}%` : '—'}
            colorClass="violet"
          />
        </div>
      )}

      {/* Aviso de expirando em breve */}
      {displayStats && displayStats.expiring_soon > 0 && (
        <div className="mb-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center gap-2 text-sm">
          <AlertTriangle size={16} className="text-amber-600 shrink-0" />
          <span className="text-amber-700">
            <strong>{displayStats.expiring_soon}</strong> orçamento(s) enviado(s) expiram nos próximos 7 dias.
            Considere reenviar pra cobrar resposta.
          </span>
          <button
            onClick={() => setStatusFilter('SENT')}
            className="ml-auto text-xs px-3 py-1 rounded border border-amber-500/40 hover:bg-amber-100/50 text-amber-700"
          >
            Ver enviados
          </button>
        </div>
      )}

      {/* Filtros */}
      <div className="flex flex-col gap-2 mb-4">
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="flex gap-1 bg-card border border-border rounded-lg p-1 flex-wrap">
            {(['', 'DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'ARCHIVED'] as const).map((s) => {
              // Onda 17.32.39 — filtro "Arquivado" puxa de /quotes/archived
              const label = s === 'ARCHIVED'
                ? 'Arquivado'
                : s
                ? STATUS_LABEL[s as Quote['status']]
                : 'Todos';
              const isArchived = s === 'ARCHIVED';
              return (
                <button
                  key={s || 'TODOS'}
                  onClick={() => setStatusFilter(s)}
                  className={`px-3 py-1.5 rounded text-xs font-medium ${
                    statusFilter === s
                      ? isArchived
                        ? 'bg-amber-600 text-white'
                        : 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div className="relative flex-1 max-w-md">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por paciente, telefone ou CPF..."
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-card border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>
        {/* Onda 15 (etapa 19) — Toggle de visualizacao + filtro por dentista */}
        <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
          <div className="flex gap-1 bg-card border border-border rounded-lg p-1">
            <button
              onClick={() => setViewMode('list')}
              className={`px-3 py-1.5 rounded text-xs font-medium inline-flex items-center gap-1.5 ${
                viewMode === 'list'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              title="Lista plana de orçamentos"
            >
              <List size={13} />
              Lista
            </button>
            <button
              onClick={() => setViewMode('by-dentist')}
              className={`px-3 py-1.5 rounded text-xs font-medium inline-flex items-center gap-1.5 ${
                viewMode === 'by-dentist'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              title="Agrupar por dentista"
            >
              <LayoutGrid size={13} />
              Por dentista
            </button>
          </div>
          {/* Onda 15 (etapa 19.3) — Seletor de dentista sempre visivel
              (antes so aparecia com 2+ dentistas, dificultando descoberta
              da feature). Quando ha pelo menos 1, vira interativo. */}
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <Users size={13} className="text-muted-foreground shrink-0" />
            <select
              value={dentistFilter}
              onChange={(e) => setDentistFilter(e.target.value)}
              disabled={dentists.length === 0}
              className="text-xs px-3 py-1.5 rounded-lg bg-card border border-border focus:outline-none focus:ring-2 focus:ring-primary/30 max-w-xs flex-1 sm:flex-initial disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="">
                {dentists.length === 0
                  ? 'Nenhum dentista (sem orçamentos)'
                  : `Todos os dentistas (${dentists.length})`}
              </option>
              {dentists.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} — {d.count} {d.count === 1 ? 'orçamento' : 'orçamentos'}
                </option>
              ))}
            </select>
            {dentistFilter && (
              <button
                onClick={() => setDentistFilter('')}
                className="text-xs px-2 py-1 rounded-md border border-border text-muted-foreground hover:bg-accent shrink-0"
                title="Limpar filtro de dentista"
              >
                Limpar
              </button>
            )}
          </div>
          {viewMode === 'by-dentist' && (
            <div className="text-xs text-muted-foreground sm:ml-auto shrink-0">
              {groupedByDentist.length} {groupedByDentist.length === 1 ? 'dentista' : 'dentistas'}
              {' · '}
              {filteredList.length} {filteredList.length === 1 ? 'orçamento' : 'orçamentos'}
            </div>
          )}
        </div>

        {/* Onda 15 (etapa 19.3) — Chips de dentistas (visiveis no modo
            "Por dentista" pra acesso rapido). Click toggla o filtro. */}
        {viewMode === 'by-dentist' && dentists.length > 0 && (
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => setDentistFilter('')}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                !dentistFilter
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card border-border text-muted-foreground hover:bg-accent'
              }`}
            >
              Todos
            </button>
            {dentists.map((d) => (
              <button
                key={d.id}
                onClick={() => setDentistFilter(dentistFilter === d.id ? '' : d.id)}
                className={`text-xs px-3 py-1.5 rounded-full border transition-colors inline-flex items-center gap-1.5 ${
                  dentistFilter === d.id
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-card border-border text-foreground hover:bg-accent'
                }`}
                title={`Filtrar pelos orçamentos de ${d.name}`}
              >
                <User size={11} />
                {d.name}
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                  dentistFilter === d.id
                    ? 'bg-primary-foreground/20 text-primary-foreground'
                    : 'bg-muted text-muted-foreground'
                }`}>
                  {d.count}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Lista */}
      {loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : filteredList.length === 0 ? (
        <div className="p-12 text-center bg-card border border-border rounded-xl">
          <DollarSign size={28} className="mx-auto mb-2 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            {statusFilter === 'ARCHIVED'
              ? 'Nenhum orçamento arquivado. Quando você encaminha uma proposta ao financeiro, o sistema pergunta se quer arquivar as outras versões em aberto.'
              : `Nenhum orçamento ${statusFilter ? STATUS_LABEL[statusFilter as Quote['status']].toLowerCase() : ''} encontrado.`}
          </p>
        </div>
      ) : viewMode === 'list' ? (
        /* MODO LISTA — Tabela plana com todos os orcamentos filtrados. */
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <QuoteTable
            quotes={filteredList}
            router={router}
            sendWhatsApp={sendWhatsApp}
          />
        </div>
      ) : (
        /* MODO POR DENTISTA — Sections expansiveis com KPIs do dentista. */
        <div className="space-y-3">
          {groupedByDentist.map((g) => {
            const isCollapsed = collapsedDentists.has(g.id);
            const decidedCount = g.accepted + g.quotes.filter((q) => q.status === 'REJECTED').length;
            const conversionRate = decidedCount > 0 ? (g.accepted / decidedCount) : null;
            return (
              <div key={g.id} className="bg-card border border-border rounded-xl overflow-hidden">
                <button
                  type="button"
                  onClick={() => toggleDentistCollapse(g.id)}
                  className="w-full px-4 py-3 flex items-center gap-3 hover:bg-muted/30 transition-colors"
                >
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary shrink-0">
                    <User size={18} />
                  </div>
                  <div className="text-left flex-1 min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate">{g.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {g.count} {g.count === 1 ? 'orçamento' : 'orçamentos'}
                      {g.sent > 0 && ` · ${g.sent} enviado(s)`}
                      {g.accepted > 0 && ` · ${g.accepted} aceito(s)`}
                    </p>
                  </div>
                  <div className="text-right shrink-0 hidden sm:block">
                    <p className="text-sm font-bold tabular-nums">{formatBRL(g.total)}</p>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide">total</p>
                  </div>
                  {conversionRate !== null && (
                    <div className="text-right shrink-0 hidden md:block px-3 border-l border-border">
                      <p className={`text-sm font-bold ${conversionRate >= 0.5 ? 'text-emerald-600' : conversionRate >= 0.25 ? 'text-amber-600' : 'text-red-600'}`}>
                        {(conversionRate * 100).toFixed(0)}%
                      </p>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">conversão</p>
                    </div>
                  )}
                  <div className="shrink-0 text-muted-foreground ml-1">
                    {isCollapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
                  </div>
                </button>
                {!isCollapsed && (
                  <div className="border-t border-border">
                    <QuoteTable
                      quotes={g.quotes}
                      router={router}
                      sendWhatsApp={sendWhatsApp}
                      hideDentistColumn
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Onda 15 (etapa 19) — Tabela reutilizavel pra os dois modos de view
 * (lista plana e por dentista). Quando hideDentistColumn=true, omite a
 * coluna "Criado por" (porque ja esta no header da section).
 */
function QuoteTable({
  quotes,
  router,
  sendWhatsApp,
  hideDentistColumn,
}: {
  quotes: Quote[];
  router: ReturnType<typeof useRouter>;
  sendWhatsApp: (q: Quote) => void;
  hideDentistColumn?: boolean;
}) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-muted/50 text-muted-foreground text-xs uppercase">
        <tr>
          <th className="text-left px-4 py-2 font-medium">Paciente</th>
          <th className="text-left px-4 py-2 font-medium">Status</th>
          <th className="text-right px-4 py-2 font-medium">Valor</th>
          <th className="text-left px-4 py-2 font-medium">Validade</th>
          <th className="text-left px-4 py-2 font-medium">
            {hideDentistColumn ? 'Criado' : 'Criado'}
          </th>
          <th className="text-right px-4 py-2 font-medium">Ações</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {quotes.map((q) => {
          const expiry = expiryStatus(q.valid_until, q.status);
          return (
            <tr key={q.id} className="hover:bg-muted/30">
              <td className="px-4 py-3">
                <button
                  onClick={() => router.push(`/atendimento/pacientes/${q.patient.id}`)}
                  className="text-left hover:text-primary"
                >
                  <div className="font-medium">{q.patient.name || 'Sem nome'}</div>
                  {q.patient.phone && (
                    <div className="text-xs text-muted-foreground">{q.patient.phone}</div>
                  )}
                </button>
              </td>
              <td className="px-4 py-3">
                <span className={`inline-flex text-xs px-2 py-0.5 rounded-full border ${STATUS_BADGE[q.status]}`}>
                  {STATUS_LABEL[q.status]}
                </span>
              </td>
              <td className="px-4 py-3 text-right font-semibold">
                {formatBRL(q.total_value)}
                {q._count && (
                  <div className="text-xs text-muted-foreground font-normal">
                    {q._count.items} item(ns)
                  </div>
                )}
              </td>
              <td className="px-4 py-3">
                {q.valid_until ? (
                  <div className="text-xs">
                    <div>{new Date(q.valid_until).toLocaleDateString('pt-BR')}</div>
                    {expiry && (
                      <div className={`font-medium ${expiry.cls}`}>{expiry.text}</div>
                    )}
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </td>
              <td className="px-4 py-3 text-xs text-muted-foreground">
                <div>{new Date(q.created_at).toLocaleDateString('pt-BR')}</div>
                {!hideDentistColumn && q.created_by && <div>por {q.created_by.name}</div>}
              </td>
              <td className="px-4 py-3 text-right">
                <div className="flex items-center justify-end gap-1">
                  {(q.status === 'DRAFT' || q.status === 'SENT') && q.patient.phone && (
                    <button
                      onClick={() => sendWhatsApp(q)}
                      className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white"
                      title={q.status === 'SENT' ? 'Reenviar WhatsApp' : 'Enviar WhatsApp'}
                    >
                      <MessageCircle size={11} />
                      {q.status === 'SENT' ? 'Reenviar' : 'Enviar'}
                    </button>
                  )}
                  <button
                    onClick={() => router.push(`/atendimento/pacientes/${q.patient.id}?tab=quotes`)}
                    className="text-xs px-2 py-1 rounded-lg border border-border text-muted-foreground hover:bg-accent"
                    title="Abrir ficha do paciente"
                  >
                    Detalhes
                  </button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function StatCard({
  icon: Icon, label, value, sub, cls,
}: {
  icon: React.ElementType;
  label: string;
  value: number | string;
  sub?: string;
  cls?: string;
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1">
        <Icon size={14} className={cls || 'text-muted-foreground'} />
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
      </div>
      <p className={`text-2xl font-bold ${cls || 'text-foreground'}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

/**
 * Onda 15 (etapa 19.5) — Card de funil estilo dashboard financeiro.
 * Layout: caixinha colorida com icone no topo → valor BEM grande
 * em cor tematica → label minusculo MAIUSCULO cinza abaixo. Limpo,
 * profissional, otimo pra leitura de relance.
 *
 * Cores: emerald (pipeline/positivo), blue (em andamento), amber
 * (urgente/alerta), red (perdido/negativo), violet (KPI especial),
 * gray (zerado / neutro).
 *
 * highlight = ring colorido pra chamar atencao quando valor > 0
 * em metricas de urgencia (ex: "Vencem em 7 dias").
 */
function FunnelCard({
  icon: Icon, label, value, sub, colorClass, highlight,
}: {
  icon: React.ElementType;
  label: string;
  value: number | string;
  sub?: string;
  colorClass: 'emerald' | 'blue' | 'amber' | 'red' | 'violet' | 'gray';
  highlight?: boolean;
}) {
  const palette: Record<typeof colorClass, { icon: string; iconBg: string; value: string; ring?: string }> = {
    emerald: { icon: 'text-emerald-600', iconBg: 'bg-emerald-500/10', value: 'text-emerald-600' },
    blue:    { icon: 'text-blue-600',    iconBg: 'bg-blue-500/10',    value: 'text-blue-600' },
    amber:   { icon: 'text-amber-600',   iconBg: 'bg-amber-500/10',   value: 'text-amber-600', ring: 'ring-1 ring-amber-500/30' },
    red:     { icon: 'text-red-600',     iconBg: 'bg-red-500/10',     value: 'text-red-600' },
    violet:  { icon: 'text-violet-600',  iconBg: 'bg-violet-500/10',  value: 'text-violet-600' },
    gray:    { icon: 'text-muted-foreground', iconBg: 'bg-muted/40',  value: 'text-foreground' },
  };
  const p = palette[colorClass];
  return (
    <div className={`bg-card rounded-xl p-4 border border-border hover:shadow-sm transition-shadow ${highlight ? p.ring || '' : ''}`}>
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center mb-3 ${p.iconBg}`}>
        <Icon size={16} className={p.icon} />
      </div>
      <p className={`text-2xl font-extrabold tabular-nums leading-tight ${p.value}`}>{value}</p>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mt-1">{label}</p>
      {sub && <p className="text-[10px] text-muted-foreground mt-0.5 italic">{sub}</p>}
    </div>
  );
}
