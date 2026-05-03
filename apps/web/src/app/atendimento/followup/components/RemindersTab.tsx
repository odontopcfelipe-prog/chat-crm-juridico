'use client';

/**
 * Aba "Lembretes" dentro de Follow-up IA — Onda 5e v21 (Fase 25).
 *
 * Acompanhamento dos disparos de lembrete de agendamento (EventReminder):
 *   - Cards de resumo: enviados 24h, pendentes proximas 24h, falhas 24h
 *   - Tabela filtravel por status (pendente/enviado/falhou) e canal
 *   - Acoes: Reenviar (zerar sent_at + re-enfileirar) / Cancelar (remover do BullMQ)
 *
 * Endpoints:
 *   GET  /calendar/reminders/summary
 *   GET  /calendar/reminders?status=&channel=&from=&to=&limit=
 *   POST /calendar/reminders/:id/resend
 *   POST /calendar/reminders/:id/cancel
 */

import { useEffect, useState, useCallback } from 'react';
import {
  Bell, Send, CheckCircle2, XCircle, Clock, Loader2, RefreshCw,
  Phone, Calendar as CalendarIcon, Trash2, Play,
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

export function RemindersTab() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [reminders, setReminders] = useState<ReminderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<StatusFilter>('pendente');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchSummary = useCallback(async () => {
    try {
      const res = await api.get('/calendar/reminders/summary');
      setSummary(res.data);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao carregar resumo');
    }
  }, []);

  const fetchReminders = useCallback(async () => {
    setLoading(true);
    try {
      const params: any = { limit: 100 };
      if (filter !== 'todos') params.status = filter;
      const res = await api.get('/calendar/reminders', { params });
      setReminders(res.data || []);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao carregar lembretes');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  useEffect(() => {
    fetchReminders();
  }, [fetchReminders]);

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

  const cards: Array<{
    title: string;
    value: number;
    sub: string;
    color: string;
    icon: any;
  }> = [
    {
      title: 'Enviados (24h)',
      value: summary?.enviados_24h ?? 0,
      sub: 'Lembretes disparados nas últimas 24h',
      color: 'emerald',
      icon: CheckCircle2,
    },
    {
      title: 'Pendentes (24h)',
      value: summary?.pendentes_proximas_24h ?? 0,
      sub: 'A disparar nas próximas 24h',
      color: 'amber',
      icon: Clock,
    },
    {
      title: 'Falhas (24h)',
      value: summary?.falhas_24h ?? 0,
      sub: 'Não enviados (evento já passou)',
      color: 'red',
      icon: XCircle,
    },
    {
      title: 'Agendamentos futuros',
      value: summary?.eventos_futuros ?? 0,
      sub: 'Total de consultas marcadas',
      color: 'sky',
      icon: CalendarIcon,
    },
  ];

  const colorMap: Record<string, { bg: string; text: string; iconBg: string }> = {
    emerald: { bg: 'bg-emerald-500/10', text: 'text-emerald-700 dark:text-emerald-400', iconBg: 'bg-emerald-500/20' },
    red:     { bg: 'bg-red-500/10',     text: 'text-red-700 dark:text-red-400',         iconBg: 'bg-red-500/20' },
    amber:   { bg: 'bg-amber-500/10',   text: 'text-amber-700 dark:text-amber-400',     iconBg: 'bg-amber-500/20' },
    sky:     { bg: 'bg-sky-500/10',     text: 'text-sky-700 dark:text-sky-400',         iconBg: 'bg-sky-500/20' },
  };

  return (
    <div className="space-y-4">
      {/* Cards de resumo */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map((card) => {
          const Icon = card.icon;
          const styles = colorMap[card.color];
          return (
            <div key={card.title} className={`${styles.bg} rounded-xl p-4`}>
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
            </div>
          );
        })}
      </div>

      {/* Filtros + tabela */}
      <div className="bg-card rounded-2xl border border-border overflow-hidden">
        {/* Header com filtros + botao de refresh */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-1">
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
          <button
            onClick={() => { fetchReminders(); fetchSummary(); }}
            className="p-1.5 rounded-lg text-muted-foreground hover:bg-accent transition-colors"
            title="Atualizar"
          >
            <RefreshCw size={14} />
          </button>
        </div>

        {/* Tabela */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={20} className="animate-spin text-muted-foreground" />
          </div>
        ) : reminders.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Bell size={32} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">Nenhum lembrete encontrado neste filtro.</p>
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
                {reminders.map((r) => {
                  const statusStyle =
                    r.derived_status === 'enviado'
                      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                      : r.derived_status === 'falhou'
                        ? 'bg-red-500/15 text-red-700 dark:text-red-400'
                        : 'bg-amber-500/15 text-amber-700 dark:text-amber-400';
                  const ch = channelLabel(r.channel);
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
                        <div className="font-semibold text-foreground">{r.event?.lead?.name || '—'}</div>
                        {r.event?.lead?.phone && (
                          <div className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5">
                            <Phone size={9} /> {r.event.lead.phone}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-foreground">{r.event?.assigned_user?.name || '—'}</td>
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
                          {(r.derived_status === 'falhou' || r.derived_status === 'enviado') && (
                            <button
                              onClick={() => handleResend(r.id)}
                              disabled={actionLoading === r.id}
                              className="p-1.5 rounded text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
                              title="Reenviar agora"
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
      </div>
    </div>
  );
}
