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
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface ReminderRow {
  id: string;
  minutes_before: number;
  channel: string;
  sent_at: string | null;
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

export function RemindersTab() {
  const router = useRouter();
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
      const res = await api.get('/users?limit=100');
      const data: any[] = res.data?.data || res.data?.users || res.data || [];
      // Filtra so dentistas/admins (mesmo criterio do filtro da agenda)
      const list = data
        .filter((u: any) =>
          u.roles?.includes('DENTIST') || u.roles?.includes('ADVOGADO') || u.roles?.includes('ADMIN') ||
          u.role === 'DENTIST' || u.role === 'ADVOGADO' || u.role === 'ADMIN',
        )
        .map((u: any) => ({ id: u.id, name: u.name }));
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
      // Filtro por search (nome do paciente, telefone, titulo do evento)
      if (search.trim()) {
        const q = search.toLowerCase();
        const haystack = [
          r.event?.lead?.name,
          r.event?.lead?.phone,
          r.event?.title,
          r.event?.assigned_user?.name,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [reminders, search, dentistFilter]);

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
                  const hasLead = !!r.event?.lead?.name;
                  return (
                    <tr key={r.id} className="border-t border-border/40 hover:bg-accent/30 transition-colors">
                      <td className="px-4 py-2.5">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${statusStyle}`}>
                          {r.derived_status === 'enviado' && <CheckCircle2 size={10} />}
                          {r.derived_status === 'pendente' && <Clock size={10} />}
                          {r.derived_status === 'falhou' && <XCircle size={10} />}
                          {r.derived_status}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        {hasLead ? (
                          <>
                            <div className="font-semibold text-foreground">{r.event?.lead?.name}</div>
                            {r.event?.lead?.phone && (
                              <div className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5">
                                <Phone size={9} /> {r.event.lead.phone}
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
          </span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Atualiza automaticamente a cada {AUTO_REFRESH_MS / 1000}s
          </span>
        </div>
      </div>
    </div>
  );
}
