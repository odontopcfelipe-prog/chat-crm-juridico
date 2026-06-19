'use client';

/**
 * Aba "Lembretes" dentro de Follow-up IA — Onda 5e v23 (Fase 25).
 *
 * Acompanhamento dos disparos de lembrete de agendamento (EventReminder):
 *   - Cards de resumo CLICAVEIS (filtram a tabela ao clicar)
 *   - Filtros avancados: status, busca, data, dentista
 *   - Auto-refresh a cada 30s
 *   - Tabela com acoes contextuais por status
 *
 * Endpoints:
 *   GET  /calendar/reminders/summary
 *   GET  /calendar/reminders?status=&channel=&from=&to=&limit=
 *   POST /calendar/reminders/:id/resend
 *   POST /calendar/reminders/:id/cancel
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Bell, Send, CheckCircle2, XCircle, Clock, Loader2, RefreshCw,
  Phone, Calendar as CalendarIcon, Trash2, Play, Search, ExternalLink, Filter, X,
  Eye, AlertTriangle, Layers, ChevronRight, ChevronDown, Download, BarChart3, Settings,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { ReminderPreviewModal } from './ReminderPreviewModal';
import { useRole } from '@/lib/useRole';

interface ReminderRow {
  id: string;
  minutes_before: number;
  channel: string;
  sent_at: string | null;
  last_error: string | null;
  // v25 (Onda C): delivery tracking via webhook Evolution
  delivered_at: string | null;
  read_at: string | null;
  delivery_status: 'enviado' | 'entregue' | 'lido' | null;
  derived_status: 'enviado' | 'pendente' | 'falhou';
  event: {
    id: string;
    title: string;
    type: string;
    status: string;
    start_at: string;
    location: string | null;
    assigned_user: { id: string; name: string } | null;
    lead: { id: string; name: string; phone: string } | null;
    // v31: patient como fallback quando evento foi criado direto da ficha
    patient: { id: string; name: string; phone: string } | null;
  } | null;
}

interface Summary {
  enviados_24h: number;
  pendentes_proximas_24h: number;
  falhas_24h: number;
  eventos_futuros: number;
}

interface DentistOption {
  id: string;
  name: string;
}

// v25 (Onda C): saude dos lembretes
interface HealthData {
  period: { days: number; since: string };
  totals: {
    total: number;
    enviados: number;
    entregues: number;
    lidos: number;
    falhas: number;
  };
  rates: {
    entrega_pct: number;
    leitura_pct: number;
    leitura_geral_pct: number;
  };
  by_minutes_before: Array<{
    minutes_before: number;
    total: number;
    entregues: number;
    lidos: number;
    entrega_pct: number;
    leitura_pct: number;
  }>;
  by_day: Array<{ day: string; count: number }>;
}

const STATUS_FILTERS = [
  { id: 'todos', label: 'Todos', icon: Bell },
  { id: 'pendente', label: 'Pendentes', icon: Clock },
  { id: 'enviado', label: 'Enviados', icon: CheckCircle2 },
  { id: 'falhou', label: 'Falharam', icon: XCircle },
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]['id'];

const formatMinutes = (m: number): string => {
  if (m < 60) return `${m}min`;
  if (m === 60) return '1h';
  if (m < 1440) return `${Math.round(m / 60)}h`;
  if (m === 1440) return '1d';
  return `${Math.round(m / 1440)}d`;
};

const formatDateTime = (iso: string): string => {
  const d = new Date(iso);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(d.getUTCFullYear()).slice(-2);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yy} ${hh}:${mi}`;
};

const channelLabel = (c: string): { label: string; color: string } => {
  if (c === 'WHATSAPP') return { label: 'WhatsApp', color: 'text-emerald-600 bg-emerald-500/10' };
  if (c === 'EMAIL') return { label: 'Email', color: 'text-sky-600 bg-sky-500/10' };
  if (c === 'PUSH') return { label: 'Push', color: 'text-violet-600 bg-violet-500/10' };
  return { label: c, color: 'text-muted-foreground bg-muted/30' };
};

// Auto-refresh interval em ms (30s — equilibra atualizacao vs carga no backend)
const AUTO_REFRESH_MS = 30_000;

/**
 * v25 (Onda C): renderiza checks de delivery estilo WhatsApp.
 *   ⏰ → enviado (sem ack)
 *   ✓  → entregue (1 check cinza)
 *   ✓✓ → lido (2 checks azul)
 */
function DeliveryChecks({ status }: { status: 'enviado' | 'entregue' | 'lido' | null }) {
  if (!status) return null;
  if (status === 'lido') {
    return (
      <span className="inline-flex items-center gap-0 text-sky-500" title="Lido pelo paciente">
        <CheckCircle2 size={11} />
        <CheckCircle2 size={11} className="-ml-1.5" />
      </span>
    );
  }
  if (status === 'entregue') {
    return (
      <span className="inline-flex items-center gap-0 text-muted-foreground" title="Entregue ao paciente">
        <CheckCircle2 size={11} />
        <CheckCircle2 size={11} className="-ml-1.5" />
      </span>
    );
  }
  return (
    <span className="text-muted-foreground/60" title="Enviado (aguardando entrega)">
      <CheckCircle2 size={11} />
    </span>
  );
}

export function RemindersTab() {
  const router = useRouter();
  const { isAdmin } = useRole();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [reminders, setReminders] = useState<ReminderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<StatusFilter>('pendente');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // v23: filtros avancados
  const [search, setSearch] = useState('');
  const [dentistFilter, setDentistFilter] = useState<string>('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [dentists, setDentists] = useState<DentistOption[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  // v24 (Onda B): modal de preview da mensagem + toggle de agrupamento
  const [previewReminderId, setPreviewReminderId] = useState<string | null>(null);
  const [groupByEvent, setGroupByEvent] = useState(false);
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());
  // v25 (Onda C): seção de saúde colapsável + estado de export
  const [showHealth, setShowHealth] = useState(false);
  const [healthData, setHealthData] = useState<HealthData | null>(null);
  const [exporting, setExporting] = useState(false);

  const fetchSummary = useCallback(async () => {
    try {
      const res = await api.get('/calendar/reminders/summary');
      setSummary(res.data);
    } catch (e: any) {
      // silent — nao polui UI com erro de polling
      // eslint-disable-next-line no-console
      console.warn('[RemindersTab] summary fetch failed', e?.message);
    }
  }, []);

  const fetchReminders = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const params: any = { limit: 200 };
      if (filter !== 'todos') params.status = filter;
      if (dateFrom) params.from = new Date(dateFrom + 'T00:00:00').toISOString();
      if (dateTo) params.to = new Date(dateTo + 'T23:59:59').toISOString();
      const res = await api.get('/calendar/reminders', { params });
      setReminders(res.data || []);
    } catch (e: any) {
      if (!silent) showError(e?.response?.data?.message || 'Falha ao carregar lembretes');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [filter, dateFrom, dateTo]);

  // v23: lista de dentistas pra dropdown de filtro (carrega 1x)
  const fetchDentists = useCallback(async () => {
    try {
      // Onda 17.54 — /users/lawyers (não /users, que é ADMIN-only → 403 pra não-admin).
      // Acessível a qualquer logado, tenant-scoped, já filtra dentistas (+admin c/ especialidade).
      const res = await api.get('/users/lawyers');
      const data: any[] = Array.isArray(res.data) ? res.data : (res.data?.data || res.data?.users || []);
      const list = data.map((u: any) => ({ id: u.id, name: u.name }));
      setDentists(list);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    fetchSummary();
    fetchDentists();
  }, [fetchSummary, fetchDentists]);

  useEffect(() => {
    fetchReminders();
  }, [fetchReminders]);

  // v23: auto-refresh — re-fetch silencioso a cada 30s pra mostrar lembretes
  // novos sem o operador precisar clicar em refresh
  useEffect(() => {
    const tick = setInterval(() => {
      fetchReminders(true);
      fetchSummary();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(tick);
  }, [fetchReminders, fetchSummary]);

  const handleResend = async (id: string) => {
    if (!confirm('Reenviar este lembrete agora? Vai disparar em segundos.')) return;
    setActionLoading(id);
    try {
      await api.post(`/calendar/reminders/${id}/resend`);
      showSuccess('Lembrete reenfileirado');
      fetchReminders();
      fetchSummary();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao reenviar');
    } finally {
      setActionLoading(null);
    }
  };

  const handleCancel = async (id: string) => {
    if (!confirm('Cancelar este lembrete? Não será disparado e o paciente não receberá.')) return;
    setActionLoading(id);
    try {
      await api.post(`/calendar/reminders/${id}/cancel`);
      showSuccess('Lembrete cancelado');
      fetchReminders();
      fetchSummary();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao cancelar');
    } finally {
      setActionLoading(null);
    }
  };

  // v25: carrega metricas de saude (so quando seccao eh aberta, evita request inutil)
  const fetchHealth = useCallback(async () => {
    try {
      const res = await api.get('/calendar/reminders/health', { params: { days: 30 } });
      setHealthData(res.data);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao carregar métricas de saúde');
    }
  }, []);

  useEffect(() => {
    if (showHealth && !healthData) fetchHealth();
  }, [showHealth, healthData, fetchHealth]);

  // v25: download CSV via fetch direto (api lib ajusta Authorization automaticamente)
  const handleExport = async () => {
    setExporting(true);
    try {
      const params: any = {};
      if (filter !== 'todos') params.status = filter;
      if (dateFrom) params.from = new Date(dateFrom + 'T00:00:00').toISOString();
      if (dateTo) params.to = new Date(dateTo + 'T23:59:59').toISOString();
      const res = await api.get('/calendar/reminders/export.csv', {
        params,
        responseType: 'blob',
      });
      const blob = new Blob([res.data], { type: 'text/csv;charset=utf-8' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `lembretes-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      showSuccess('CSV exportado');
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao exportar CSV');
    } finally {
      setExporting(false);
    }
  };

  // v23: navega pra agenda com deep-link no evento
  const handleViewEvent = (eventId: string) => {
    // sessionStorage carrega o ID que a agenda detecta no useEffect do mount
    // (ja existe esse padrao em agenda/page.tsx pra abrir evento via alerta)
    try {
      sessionStorage.setItem('open_event_id', eventId);
    } catch { /* sem suporte */ }
    router.push('/atendimento/agenda');
  };

  // v23: filtragem CLIENT-side (rapida, sem ida ao backend)
  // search + dentistFilter aplicados em cima do que veio do GET
  const filteredReminders = useMemo(() => {
    return reminders.filter((r) => {
      // Filtro por dentista
      if (dentistFilter && r.event?.assigned_user?.id !== dentistFilter) return false;
      // Filtro por search (nome/telefone do paciente — lead OU patient — + titulo + dentista)
      if (search.trim()) {
        const q = search.toLowerCase();
        const haystack = [
          r.event?.lead?.name,
          r.event?.lead?.phone,
          r.event?.patient?.name,
          r.event?.patient?.phone,
          r.event?.title,
          r.event?.assigned_user?.name,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [reminders, search, dentistFilter]);

  // v24 (Onda B): agrupamento por evento.
  // Quando groupByEvent=true, agrupa reminders pelo event.id e renderiza
  // 1 linha por evento com sub-linhas dos lembretes (expansive).
  const groupedReminders = useMemo(() => {
    if (!groupByEvent) return null;
    const groups = new Map<string, { event: ReminderRow['event']; reminders: ReminderRow[] }>();
    for (const r of filteredReminders) {
      const key = r.event?.id || `_no_event_${r.id}`;
      if (!groups.has(key)) {
        groups.set(key, { event: r.event, reminders: [] });
      }
      groups.get(key)!.reminders.push(r);
    }
    // Ordena cada grupo por minutes_before DESC (1d → 1h → 30min)
    for (const g of groups.values()) {
      g.reminders.sort((a, b) => b.minutes_before - a.minutes_before);
    }
    // Ordena grupos por start_at do evento ASC (mais proximo primeiro)
    return Array.from(groups.entries()).sort(([, a], [, b]) => {
      const aDate = a.event?.start_at ? new Date(a.event.start_at).getTime() : 0;
      const bDate = b.event?.start_at ? new Date(b.event.start_at).getTime() : 0;
      return aDate - bDate;
    });
  }, [filteredReminders, groupByEvent]);

  const toggleEventExpand = (eventId: string) => {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  };

  const cards: Array<{
    title: string;
    value: number;
    sub: string;
    color: string;
    icon: any;
    filterTo: StatusFilter;
  }> = [
    {
      title: 'Enviados (24h)',
      value: summary?.enviados_24h ?? 0,
      sub: 'Lembretes disparados nas últimas 24h',
      color: 'emerald',
      icon: CheckCircle2,
      filterTo: 'enviado',
    },
    {
      title: 'Pendentes (24h)',
      value: summary?.pendentes_proximas_24h ?? 0,
      sub: 'A disparar nas próximas 24h',
      color: 'amber',
      icon: Clock,
      filterTo: 'pendente',
    },
    {
      title: 'Falhas (24h)',
      value: summary?.falhas_24h ?? 0,
      sub: 'Não enviados (evento já passou)',
      color: 'red',
      icon: XCircle,
      filterTo: 'falhou',
    },
    {
      title: 'Agendamentos futuros',
      value: summary?.eventos_futuros ?? 0,
      sub: 'Total de consultas marcadas',
      color: 'sky',
      icon: CalendarIcon,
      filterTo: 'todos',
    },
  ];

  const colorMap: Record<string, { bg: string; text: string; iconBg: string; ring: string }> = {
    emerald: { bg: 'bg-emerald-500/10', text: 'text-emerald-700 dark:text-emerald-400', iconBg: 'bg-emerald-500/20', ring: 'ring-emerald-500/40' },
    red:     { bg: 'bg-red-500/10',     text: 'text-red-700 dark:text-red-400',         iconBg: 'bg-red-500/20',     ring: 'ring-red-500/40' },
    amber:   { bg: 'bg-amber-500/10',   text: 'text-amber-700 dark:text-amber-400',     iconBg: 'bg-amber-500/20',   ring: 'ring-amber-500/40' },
    sky:     { bg: 'bg-sky-500/10',     text: 'text-sky-700 dark:text-sky-400',         iconBg: 'bg-sky-500/20',     ring: 'ring-sky-500/40' },
  };

  const hasAnyFilter = !!search || !!dentistFilter || !!dateFrom || !!dateTo;
  const clearFilters = () => {
    setSearch('');
    setDentistFilter('');
    setDateFrom('');
    setDateTo('');
  };

  return (
    <div className="space-y-4">
      {/* Cards de resumo (clicaveis — Onda 5e v23) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map((card) => {
          const Icon = card.icon;
          const styles = colorMap[card.color];
          const active = filter === card.filterTo;
          return (
            <button
              key={card.title}
              onClick={() => setFilter(card.filterTo)}
              className={`${styles.bg} rounded-xl p-4 text-left transition-all hover:scale-[1.02] hover:shadow-md ${
                active ? `ring-2 ${styles.ring}` : ''
              }`}
              title={`Filtrar por: ${card.title}`}
            >
              <div className="flex items-center gap-2 mb-2">
                <div className={`${styles.iconBg} rounded-lg p-1.5`}>
                  <Icon size={14} className={styles.text} />
                </div>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {card.title}
                </span>
              </div>
              <p className={`text-2xl font-bold ${styles.text} leading-tight`}>{card.value}</p>
              <p className="text-[10px] text-muted-foreground mt-1">{card.sub}</p>
            </button>
          );
        })}
      </div>

      {/* v25 (Onda C #11): seção colapsavel de saude dos lembretes */}
      {showHealth && (
        <div className="bg-card rounded-2xl border border-border p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
              <BarChart3 size={16} className="text-primary" />
              Saúde dos lembretes
            </h3>
            {healthData && (
              <span className="text-[10px] text-muted-foreground">
                Últimos {healthData.period.days} dias
              </span>
            )}
          </div>

          {!healthData ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={16} className="animate-spin text-muted-foreground" />
            </div>
          ) : healthData.totals.enviados === 0 ? (
            <p className="text-sm text-muted-foreground italic text-center py-4">
              Nenhum lembrete enviado nos últimos {healthData.period.days} dias.
            </p>
          ) : (
            <div className="space-y-4">
              {/* Taxas principais */}
              <div className="grid grid-cols-3 gap-3">
                <div className="text-center p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/20">
                  <div className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">
                    {healthData.rates.entrega_pct}%
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-1">
                    Taxa de entrega
                  </div>
                  <div className="text-[10px] text-muted-foreground/70">
                    {healthData.totals.entregues}/{healthData.totals.enviados} enviados
                  </div>
                </div>
                <div className="text-center p-3 rounded-xl bg-sky-500/5 border border-sky-500/20">
                  <div className="text-2xl font-bold text-sky-700 dark:text-sky-400">
                    {healthData.rates.leitura_geral_pct}%
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-1">
                    Taxa de leitura
                  </div>
                  <div className="text-[10px] text-muted-foreground/70">
                    {healthData.totals.lidos}/{healthData.totals.enviados} enviados
                  </div>
                </div>
                <div className="text-center p-3 rounded-xl bg-red-500/5 border border-red-500/20">
                  <div className="text-2xl font-bold text-red-700 dark:text-red-400">
                    {healthData.totals.falhas}
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-1">
                    Falhas no envio
                  </div>
                </div>
              </div>

              {/* Por antecedência */}
              {healthData.by_minutes_before.length > 0 && (
                <div>
                  <h4 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
                    Efetividade por antecedência
                  </h4>
                  <div className="space-y-1.5">
                    {healthData.by_minutes_before.map((row) => (
                      <div key={row.minutes_before} className="flex items-center gap-2 text-xs">
                        <span className="font-semibold text-foreground min-w-[50px]">
                          {formatMinutes(row.minutes_before)}
                        </span>
                        <div className="flex-1 h-5 bg-muted/30 rounded overflow-hidden relative">
                          {/* Barra de leitura (sky) sobreposta a entrega (emerald) */}
                          <div
                            className="absolute inset-y-0 left-0 bg-emerald-500/40"
                            style={{ width: `${row.entrega_pct}%` }}
                          />
                          <div
                            className="absolute inset-y-0 left-0 bg-sky-500/60"
                            style={{ width: `${row.leitura_pct}%` }}
                          />
                          <div className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-foreground">
                            {row.lidos}/{row.entregues}/{row.total}
                          </div>
                        </div>
                        <span className="text-muted-foreground min-w-[60px] text-right">
                          {row.leitura_pct}% lido
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-3 mt-2 text-[9px] text-muted-foreground">
                    <span className="flex items-center gap-1"><span className="w-2 h-2 bg-sky-500/60 rounded" /> Lidos</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 bg-emerald-500/40 rounded" /> Entregues</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 bg-muted/40 rounded" /> Total enviados</span>
                  </div>
                </div>
              )}

              {/* Insight automatico */}
              {healthData.by_minutes_before.length > 1 && (() => {
                const sorted = [...healthData.by_minutes_before].sort((a, b) => b.leitura_pct - a.leitura_pct);
                const best = sorted[0];
                if (best.total < 5) return null; // sem dados suficientes
                return (
                  <div className="text-[11px] text-foreground/80 p-2.5 rounded-lg bg-primary/5 border border-primary/20">
                    💡 <strong>Lembrete mais efetivo:</strong> {formatMinutes(best.minutes_before)} antes
                    ({best.leitura_pct}% leem). Considere reforçar essa antecedência ou ajustar as outras.
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {/* Toolbar: filtros + status + refresh */}
      <div className="bg-card rounded-2xl border border-border overflow-hidden">
        <div className="px-4 py-3 border-b border-border space-y-3">
          {/* Linha 1: status pills + botao filtros + refresh */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1 flex-wrap">
              {STATUS_FILTERS.map((f) => {
                const Icon = f.icon;
                const active = filter === f.id;
                return (
                  <button
                    key={f.id}
                    onClick={() => setFilter(f.id)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      active
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    <Icon size={12} /> {f.label}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-1">
              {/* v25 (Onda C #11): toggle saude */}
              <button
                onClick={() => setShowHealth((v) => !v)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  showHealth ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent'
                }`}
                title="Métricas de saúde dos lembretes"
              >
                <BarChart3 size={12} /> Saúde
              </button>
              {/* v25 (Onda C #12): export CSV */}
              <button
                onClick={handleExport}
                disabled={exporting}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-muted-foreground hover:bg-accent transition-colors disabled:opacity-50"
                title="Exportar lista filtrada como CSV (abre no Excel)"
              >
                {exporting ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                Exportar
              </button>
              {/* v24: toggle agrupar por evento */}
              <button
                onClick={() => setGroupByEvent((v) => !v)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  groupByEvent ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent'
                }`}
                title={groupByEvent
                  ? 'Voltar pra lista linear (1 linha por lembrete)'
                  : 'Agrupar por evento (1 linha por evento + lembretes embaixo)'}
              >
                <Layers size={12} /> {groupByEvent ? 'Lista' : 'Agrupar'}
              </button>
              <button
                onClick={() => setShowFilters((v) => !v)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  showFilters || hasAnyFilter
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent'
                }`}
                title="Filtros avançados"
              >
                <Filter size={12} /> Filtros
                {hasAnyFilter && (
                  <span className="ml-0.5 min-w-[16px] h-[16px] px-1 inline-flex items-center justify-center text-[9px] font-bold bg-primary text-primary-foreground rounded-full">
                    !
                  </span>
                )}
              </button>
              <button
                onClick={() => { fetchReminders(); fetchSummary(); }}
                className="p-1.5 rounded-lg text-muted-foreground hover:bg-accent transition-colors"
                title={`Atualizar (auto-refresh a cada ${AUTO_REFRESH_MS / 1000}s)`}
              >
                <RefreshCw size={14} />
              </button>
            </div>
          </div>

          {/* Linha 2: filtros avancados (toggle) */}
          {showFilters && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-2 pt-2 border-t border-border/50">
              {/* Busca */}
              <div className="relative md:col-span-2">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar por paciente, telefone, evento…"
                  className="w-full pl-8 pr-7 py-1.5 text-xs bg-background border border-border rounded-lg placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/40"
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
              {/* Dentista */}
              <select
                value={dentistFilter}
                onChange={(e) => setDentistFilter(e.target.value)}
                className="px-2 py-1.5 text-xs bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40"
              >
                <option value="">Todos os dentistas</option>
                {dentists.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
              {/* Datas */}
              <div className="flex items-center gap-1">
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="flex-1 px-1.5 py-1.5 text-xs bg-background border border-border rounded-lg"
                  title="Data inicial"
                />
                <span className="text-[10px] text-muted-foreground">→</span>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="flex-1 px-1.5 py-1.5 text-xs bg-background border border-border rounded-lg"
                  title="Data final"
                />
              </div>
              {hasAnyFilter && (
                <div className="md:col-span-4 flex justify-end">
                  <button
                    onClick={clearFilters}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    <X size={10} /> Limpar filtros
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Tabela */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={20} className="animate-spin text-muted-foreground" />
          </div>
        ) : filteredReminders.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Bell size={32} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">
              {hasAnyFilter ? 'Nenhum lembrete bate com os filtros aplicados.' : 'Nenhum lembrete encontrado neste filtro.'}
            </p>
            {hasAnyFilter && (
              <button
                onClick={clearFilters}
                className="text-xs text-primary hover:underline mt-2"
              >
                Limpar filtros
              </button>
            )}
          </div>
        ) : groupByEvent && groupedReminders ? (
          // v24: modo agrupado por evento
          <div className="divide-y divide-border/40">
            {groupedReminders.map(([key, group]) => {
              const isExpanded = expandedEvents.has(key);
              const counts = {
                enviado: group.reminders.filter((r) => r.derived_status === 'enviado').length,
                pendente: group.reminders.filter((r) => r.derived_status === 'pendente').length,
                falhou: group.reminders.filter((r) => r.derived_status === 'falhou').length,
              };
              return (
                <div key={key}>
                  <button
                    onClick={() => toggleEventExpand(key)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-accent/30 transition-colors text-left"
                  >
                    {isExpanded ? <ChevronDown size={14} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={14} className="shrink-0 text-muted-foreground" />}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm text-foreground truncate">{group.event?.title || 'Evento sem título'}</span>
                        {(group.event?.lead?.name || group.event?.patient?.name) && (
                          <span className="text-[11px] text-muted-foreground">• {group.event?.lead?.name || group.event?.patient?.name}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground flex-wrap">
                        {group.event?.start_at && <span>📅 {formatDateTime(group.event.start_at)}</span>}
                        {group.event?.assigned_user?.name && <span>🦷 {group.event.assigned_user.name}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {counts.enviado > 0 && (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                          <CheckCircle2 size={9} /> {counts.enviado}
                        </span>
                      )}
                      {counts.pendente > 0 && (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500/15 text-amber-700 dark:text-amber-400">
                          <Clock size={9} /> {counts.pendente}
                        </span>
                      )}
                      {counts.falhou > 0 && (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-red-500/15 text-red-700 dark:text-red-400">
                          <XCircle size={9} /> {counts.falhou}
                        </span>
                      )}
                      <span className="text-[10px] text-muted-foreground">{group.reminders.length} lembrete{group.reminders.length !== 1 ? 's' : ''}</span>
                    </div>
                  </button>
                  {isExpanded && (
                    <div className="bg-muted/10 px-4 py-2 space-y-1.5 border-t border-border/30">
                      {group.reminders.map((r) => {
                        const ch = channelLabel(r.channel);
                        return (
                          <div key={r.id} className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-accent/40 group">
                            {r.derived_status === 'enviado' && <CheckCircle2 size={12} className="text-emerald-600 shrink-0" />}
                            {r.derived_status === 'pendente' && <Clock size={12} className="text-amber-600 shrink-0" />}
                            {r.derived_status === 'falhou' && <XCircle size={12} className="text-red-600 shrink-0" />}
                            <span className="text-xs font-semibold text-foreground min-w-[60px]">
                              {formatMinutes(r.minutes_before)} antes
                            </span>
                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold ${ch.color}`}>{ch.label}</span>
                            {r.sent_at && (
                              <span className="text-[10px] text-muted-foreground">{formatDateTime(r.sent_at)}</span>
                            )}
                            {r.last_error && (
                              <span className="text-[10px] text-red-600 dark:text-red-400 italic truncate flex items-center gap-1">
                                <AlertTriangle size={9} /> {r.last_error}
                              </span>
                            )}
                            <div className="flex-1" />
                            <button
                              onClick={() => setPreviewReminderId(r.id)}
                              className="p-1 rounded text-muted-foreground hover:bg-accent hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                              title="Ver mensagem enviada + respostas"
                            >
                              <Eye size={11} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/30 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-2.5">Status</th>
                  <th className="text-left px-3 py-2.5">Paciente</th>
                  <th className="text-left px-3 py-2.5">Dentista</th>
                  <th className="text-left px-3 py-2.5">Evento</th>
                  <th className="text-left px-3 py-2.5">Quando dispara</th>
                  <th className="text-left px-3 py-2.5">Canal</th>
                  <th className="text-right px-4 py-2.5">Ações</th>
                </tr>
              </thead>
              <tbody>
                {filteredReminders.map((r) => {
                  const statusStyle =
                    r.derived_status === 'enviado'
                      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                      : r.derived_status === 'falhou'
                        ? 'bg-red-500/15 text-red-700 dark:text-red-400'
                        : 'bg-amber-500/15 text-amber-700 dark:text-amber-400';
                  const ch = channelLabel(r.channel);
                  // v31: paciente pode vir via lead OU patient direto (criado pela ficha)
                  const contactName = r.event?.lead?.name || r.event?.patient?.name || null;
                  const contactPhone = r.event?.lead?.phone || r.event?.patient?.phone || null;
                  const hasLead = !!contactName;
                  return (
                    <tr key={r.id} className="border-t border-border/40 hover:bg-accent/30 transition-colors">
                      <td className="px-4 py-2.5">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${statusStyle}`}>
                          {r.derived_status === 'enviado' && <CheckCircle2 size={10} />}
                          {r.derived_status === 'pendente' && <Clock size={10} />}
                          {r.derived_status === 'falhou' && <XCircle size={10} />}
                          {r.derived_status}
                        </span>
                        {/* v25: checks de delivery (✓ entregue, ✓✓ lido) */}
                        {r.derived_status === 'enviado' && r.delivery_status && (
                          <div className="mt-1 ml-1">
                            <DeliveryChecks status={r.delivery_status} />
                          </div>
                        )}
                        {/* v24: motivo de erro inline em FALHOU */}
                        {r.derived_status === 'falhou' && r.last_error && (
                          <div
                            className="mt-1 text-[10px] text-red-600 dark:text-red-400 max-w-[180px] flex items-start gap-1 cursor-help"
                            title={r.last_error}
                          >
                            <AlertTriangle size={9} className="shrink-0 mt-0.5" />
                            <span className="truncate">{r.last_error}</span>
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {hasLead ? (
                          <>
                            <div className="font-semibold text-foreground">{contactName}</div>
                            {contactPhone && (
                              <div className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5">
                                <Phone size={9} /> {contactPhone}
                              </div>
                            )}
                          </>
                        ) : (
                          <span className="text-[11px] italic text-muted-foreground/70">sem paciente vinculado</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-foreground">{r.event?.assigned_user?.name || <span className="text-muted-foreground/60">—</span>}</td>
                      <td className="px-3 py-2.5">
                        <div className="font-medium text-foreground truncate max-w-[180px]">{r.event?.title || '—'}</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {r.event?.start_at ? formatDateTime(r.event.start_at) : '—'}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="text-foreground">
                          <strong>{formatMinutes(r.minutes_before)}</strong> antes
                        </div>
                        {r.sent_at && (
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            Enviado: {formatDateTime(r.sent_at)}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${ch.color}`}>
                          {ch.label}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {/* v24: ver mensagem enviada */}
                          <button
                            onClick={() => setPreviewReminderId(r.id)}
                            className="p-1.5 rounded text-muted-foreground hover:bg-accent hover:text-primary transition-colors"
                            title="Ver mensagem enviada + respostas do paciente"
                          >
                            <Eye size={12} />
                          </button>
                          {/* v23: ver evento na agenda */}
                          {r.event?.id && (
                            <button
                              onClick={() => handleViewEvent(r.event!.id)}
                              className="p-1.5 rounded text-muted-foreground hover:bg-accent hover:text-primary transition-colors"
                              title="Ver evento na agenda"
                            >
                              <ExternalLink size={12} />
                            </button>
                          )}
                          {(r.derived_status === 'falhou' || r.derived_status === 'enviado') && (
                            <button
                              onClick={() => handleResend(r.id)}
                              disabled={actionLoading === r.id}
                              className="p-1.5 rounded text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
                              title={r.derived_status === 'enviado'
                                ? 'Reenviar (útil pra teste ou se paciente não recebeu)'
                                : 'Reenviar (vai tentar disparar de novo)'}
                            >
                              {actionLoading === r.id ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                            </button>
                          )}
                          {r.derived_status === 'pendente' && (
                            <>
                              <button
                                onClick={() => handleResend(r.id)}
                                disabled={actionLoading === r.id}
                                className="p-1.5 rounded text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
                                title="Disparar agora (não esperar antecedência)"
                              >
                                {actionLoading === r.id ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                              </button>
                              <button
                                onClick={() => handleCancel(r.id)}
                                disabled={actionLoading === r.id}
                                className="p-1.5 rounded text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                                title="Cancelar lembrete"
                              >
                                <Trash2 size={12} />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Footer com contagem + indicador de auto-refresh */}
        <div className="px-4 py-2 border-t border-border/50 flex items-center justify-between text-[10px] text-muted-foreground">
          <span>
            {filteredReminders.length} lembrete{filteredReminders.length !== 1 ? 's' : ''}
            {filteredReminders.length !== reminders.length && ` (de ${reminders.length} carregados)`}
            {groupByEvent && groupedReminders && ` • ${groupedReminders.length} evento${groupedReminders.length !== 1 ? 's' : ''}`}
          </span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Atualiza automaticamente a cada {AUTO_REFRESH_MS / 1000}s
          </span>
        </div>
      </div>

      {/* v24: Modal de preview da mensagem */}
      {previewReminderId && (
        <ReminderPreviewModal
          reminderId={previewReminderId}
          onClose={() => setPreviewReminderId(null)}
        />
      )}

    </div>
  );
}
