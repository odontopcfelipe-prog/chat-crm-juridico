'use client';

/**
 * Onda 17.60 — Histórico unificado de disparos.
 *
 * Junta TODOS os disparos feitos pro paciente/dentista (lembrete, confirmação,
 * NPS, aniversário, resumo do dentista, consulta agendada/remarcada) numa lista
 * só — pra ver de relance o que saiu, pra quem, quando e com qual status.
 *
 * Fonte: GET /followup/disparos (followup.service.getDisparoHistory agrega
 * EventReminder + AppointmentConfirmation + PostCareSurvey + DispatchLog).
 * Auto-refresh a cada 30s.
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Bell, CheckCircle2, Heart, Cake, FileText, Calendar, CalendarClock,
  Loader2, RefreshCw, Search, Send, XCircle, Inbox,
} from 'lucide-react';
import api from '@/lib/api';
import { showError } from '@/lib/toast';

interface DisparoItem {
  id: string;
  type: string;
  type_label: string;
  recipient_name: string | null;
  recipient_phone: string | null;
  status: string;
  channel: string;
  sent_at: string | null;
  error: string | null;
  ref_title: string | null;
}
interface Summary {
  total: number;
  enviados: number;
  entregues: number;
  falhas: number;
  por_tipo: Record<string, number>;
}

const TYPE_META: Record<string, { label: string; Icon: any; cls: string }> = {
  lembrete:              { label: 'Lembrete',      Icon: Bell,         cls: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20' },
  confirmacao:           { label: 'Confirmação',   Icon: CheckCircle2, cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20' },
  nps:                   { label: 'NPS',           Icon: Heart,        cls: 'bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/20' },
  aniversario:           { label: 'Aniversário',   Icon: Cake,         cls: 'bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400 border-fuchsia-500/20' },
  resumo_dentista:       { label: 'Resumo',        Icon: FileText,     cls: 'bg-slate-500/10 text-slate-600 dark:text-slate-300 border-slate-500/20' },
  agendamento_criado:    { label: 'Agendada',      Icon: Calendar,     cls: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20' },
  agendamento_remarcado: { label: 'Remarcada',     Icon: CalendarClock,cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20' },
};

const STATUS_META: Record<string, { label: string; cls: string }> = {
  SENT:      { label: 'Enviado',   cls: 'bg-blue-500/10 text-blue-600 dark:text-blue-400' },
  DELIVERED: { label: 'Entregue',  cls: 'bg-teal-500/10 text-teal-600 dark:text-teal-400' },
  READ:      { label: 'Lido',      cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  RESPONDED: { label: 'Respondeu', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  PENDENTE:  { label: 'Pendente',  cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  FAILED:    { label: 'Falhou',    cls: 'bg-red-500/10 text-red-600 dark:text-red-400' },
};

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  // sent_at é timestamp REAL (UTC do container); mostra no fuso de Maceió.
  return new Date(iso).toLocaleString('pt-BR', {
    timeZone: 'America/Maceio', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function maskPhone(p: string | null): string {
  if (!p) return '';
  const d = p.replace(/\D/g, '');
  return d.length >= 12 ? `+${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4)}` : d;
}

export function DisparosHistoryTab() {
  const [items, setItems] = useState<DisparoItem[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [days, setDays] = useState(7);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await api.get('/followup/disparos', { params: { days, limit: 300 } });
      setItems(r.data?.items || []);
      setSummary(r.data?.summary || null);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao carregar o histórico de disparos');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [days]);

  useEffect(() => {
    load();
    const i = setInterval(load, 30_000);
    return () => clearInterval(i);
  }, [load]);

  const filtered = useMemo(() => {
    let r = items;
    if (typeFilter) r = r.filter((x) => x.type === typeFilter);
    if (statusFilter) {
      r = statusFilter === 'FAILED'
        ? r.filter((x) => x.status === 'FAILED')
        : r.filter((x) => ['SENT', 'DELIVERED', 'READ', 'RESPONDED'].includes(x.status));
    }
    const q = search.trim().toLowerCase();
    if (q) r = r.filter((x) =>
      (x.recipient_name || '').toLowerCase().includes(q) ||
      (x.recipient_phone || '').includes(q) ||
      (x.ref_title || '').toLowerCase().includes(q),
    );
    return r;
  }, [items, typeFilter, statusFilter, search]);

  const kpi = (label: string, value: number | string, cls: string, active: boolean, onClick: () => void) => (
    <button
      onClick={onClick}
      className={`flex-1 min-w-[120px] text-left p-3 rounded-xl border transition-colors ${active ? 'ring-2 ring-primary/40' : ''} ${cls}`}
    >
      <div className="text-[10px] font-bold uppercase tracking-wider opacity-70">{label}</div>
      <div className="text-2xl font-extrabold mt-0.5">{value}</div>
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h2 className="text-lg font-extrabold flex items-center gap-2">
            <Send size={18} className="text-primary" /> Histórico de Disparos
          </h2>
          <p className="text-[11px] text-muted-foreground">Tudo que saiu pro paciente/dentista, num lugar só.</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={(e) => setDays(parseInt(e.target.value, 10))}
            className="px-2.5 py-1.5 text-xs bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40"
          >
            <option value={1}>Hoje (24h)</option>
            <option value={7}>7 dias</option>
            <option value={30}>30 dias</option>
            <option value={90}>90 dias</option>
          </select>
          <button onClick={load} disabled={refreshing} className="p-2 rounded-lg border border-border hover:bg-accent transition-colors disabled:opacity-50" title="Atualizar">
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* KPIs clicáveis */}
      <div className="flex gap-2 flex-wrap">
        {kpi('Total', summary?.total ?? 0, 'bg-card border-border', !statusFilter, () => setStatusFilter(null))}
        {kpi('Enviados', summary?.enviados ?? 0, 'bg-blue-500/5 border-blue-500/20 text-blue-700 dark:text-blue-300', statusFilter === 'SENT', () => setStatusFilter('SENT'))}
        {kpi('Entregues', summary?.entregues ?? 0, 'bg-teal-500/5 border-teal-500/20 text-teal-700 dark:text-teal-300', false, () => setStatusFilter(null))}
        {kpi('Falhas', summary?.falhas ?? 0, 'bg-red-500/5 border-red-500/20 text-red-700 dark:text-red-300', statusFilter === 'FAILED', () => setStatusFilter('FAILED'))}
      </div>

      {/* Filtros por tipo */}
      <div className="flex gap-1.5 flex-wrap">
        <button
          onClick={() => setTypeFilter(null)}
          className={`px-2.5 py-1 text-[11px] font-semibold rounded-full border transition-colors ${!typeFilter ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-accent'}`}
        >
          Todos
        </button>
        {Object.entries(TYPE_META).map(([key, m]) => {
          const count = summary?.por_tipo?.[key] ?? 0;
          if (!count && typeFilter !== key) return null;
          const active = typeFilter === key;
          return (
            <button
              key={key}
              onClick={() => setTypeFilter(active ? null : key)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-full border transition-colors ${active ? 'bg-primary text-primary-foreground border-primary' : `${m.cls} hover:opacity-80`}`}
            >
              <m.Icon size={11} /> {m.label} <span className="opacity-70">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Busca */}
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por paciente, telefone ou título…"
          className="w-full pl-9 pr-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40"
        />
      </div>

      {/* Lista */}
      {loading ? (
        <div className="py-16 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-16 flex flex-col items-center justify-center text-muted-foreground gap-2">
          <Inbox size={28} className="opacity-40" />
          <p className="text-sm">Nenhum disparo neste filtro.</p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-2xl divide-y divide-border overflow-hidden">
          {filtered.map((it) => {
            const tm = TYPE_META[it.type] || { label: it.type, Icon: Send, cls: 'bg-muted text-muted-foreground border-border' };
            const sm = STATUS_META[it.status] || { label: it.status, cls: 'bg-muted text-muted-foreground' };
            return (
              <div key={it.id} className="flex items-center gap-3 px-4 py-3 hover:bg-accent/40 transition-colors">
                <div className={`shrink-0 w-9 h-9 rounded-xl border flex items-center justify-center ${tm.cls}`}>
                  <tm.Icon size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold truncate">{it.recipient_name || 'Sem nome'}</span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${tm.cls}`}>{tm.label}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {maskPhone(it.recipient_phone)}{it.ref_title ? ` · ${it.ref_title}` : ''}
                    {it.error ? <span className="text-red-500"> · {it.error}</span> : ''}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${sm.cls}`}>
                    {it.status === 'FAILED' ? <XCircle size={10} /> : <CheckCircle2 size={10} />} {sm.label}
                  </span>
                  <div className="text-[10px] text-muted-foreground mt-0.5">{fmtDateTime(it.sent_at)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="text-[10px] text-muted-foreground text-right flex items-center justify-end gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> {filtered.length} disparo(s) · atualiza a cada 30s
      </div>
    </div>
  );
}
