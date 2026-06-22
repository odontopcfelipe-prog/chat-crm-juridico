'use client';

/**
 * Onda 17.60 — tela do disparo de Aniversário.
 *
 * Antes o "Abrir" do card de Aniversário só jogava pra lista de pacientes. Agora
 * mostra o que importa pro disparo:
 *   - Próximos aniversariantes (HOJE + próximos dias) com a data.
 *   - Histórico de envios (enviados / falharam), vindo do DispatchLog.
 *
 * Fontes:
 *   GET /calendar/birthday-greeting/upcoming?days=
 *   GET /followup/disparos?type=aniversario&days=
 */

import { useEffect, useState, useCallback } from 'react';
import { Cake, Loader2, RefreshCw, CheckCircle2, XCircle, PartyPopper, Phone } from 'lucide-react';
import api from '@/lib/api';
import { showError } from '@/lib/toast';

interface UpcomingItem {
  id: string;
  name: string;
  phone: string | null;
  birth_day: number;
  birth_month: number;
  days_until: number;
  is_today: boolean;
}
interface HistoryItem {
  id: string;
  recipient_name: string | null;
  recipient_phone: string | null;
  status: string;
  sent_at: string | null;
  error: string | null;
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  SENT:      { label: 'Enviado',  cls: 'bg-blue-500/10 text-blue-600 dark:text-blue-400' },
  DELIVERED: { label: 'Entregue', cls: 'bg-teal-500/10 text-teal-600 dark:text-teal-400' },
  READ:      { label: 'Lido',     cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  FAILED:    { label: 'Falhou',   cls: 'bg-red-500/10 text-red-600 dark:text-red-400' },
};

function diasLabel(d: number): string {
  if (d === 0) return '🎉 Hoje';
  if (d === 1) return 'Amanhã';
  return `Em ${d} dias`;
}
function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', {
    timeZone: 'America/Maceio', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}
function maskPhone(p: string | null): string {
  if (!p) return '';
  const d = p.replace(/\D/g, '');
  return d.length >= 12 ? `+${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4)}` : d;
}

export function AniversarioTab() {
  const [upcoming, setUpcoming] = useState<UpcomingItem[]>([]);
  const [todayCount, setTodayCount] = useState(0);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [up, hist] = await Promise.all([
        api.get('/calendar/birthday-greeting/upcoming', { params: { days: 30 } }),
        api.get('/followup/disparos', { params: { type: 'aniversario', days: 60 } }),
      ]);
      setUpcoming(up.data?.items || []);
      setTodayCount(up.data?.today || 0);
      setHistory(hist.data?.items || []);
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao carregar os aniversariantes');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const i = setInterval(load, 60_000);
    return () => clearInterval(i);
  }, [load]);

  const enviados = history.filter((h) => ['SENT', 'DELIVERED', 'READ'].includes(h.status)).length;
  const falhas = history.filter((h) => h.status === 'FAILED').length;

  if (loading) {
    return (
      <div className="py-16 flex items-center justify-center text-muted-foreground">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h2 className="text-lg font-extrabold flex items-center gap-2">
            <Cake size={18} className="text-fuchsia-500" /> Aniversariantes
          </h2>
          <p className="text-[11px] text-muted-foreground">Quem faz aniversário (hoje e em breve) e o que já foi disparado.</p>
        </div>
        <button onClick={load} disabled={refreshing} className="p-2 rounded-lg border border-border hover:bg-accent transition-colors disabled:opacity-50" title="Atualizar">
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* KPIs */}
      <div className="flex gap-2 flex-wrap">
        <div className="flex-1 min-w-[120px] p-3 rounded-xl border border-fuchsia-500/20 bg-fuchsia-500/5">
          <div className="text-[10px] font-bold uppercase tracking-wider text-fuchsia-600/70">Hoje</div>
          <div className="text-2xl font-extrabold text-fuchsia-600 dark:text-fuchsia-400 mt-0.5">{todayCount}</div>
        </div>
        <div className="flex-1 min-w-[120px] p-3 rounded-xl border border-border bg-card">
          <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Próximos 30 dias</div>
          <div className="text-2xl font-extrabold mt-0.5">{upcoming.length}</div>
        </div>
        <div className="flex-1 min-w-[120px] p-3 rounded-xl border border-blue-500/20 bg-blue-500/5">
          <div className="text-[10px] font-bold uppercase tracking-wider text-blue-600/70">Enviados (60d)</div>
          <div className="text-2xl font-extrabold text-blue-600 dark:text-blue-400 mt-0.5">{enviados}</div>
        </div>
        <div className="flex-1 min-w-[120px] p-3 rounded-xl border border-red-500/20 bg-red-500/5">
          <div className="text-[10px] font-bold uppercase tracking-wider text-red-600/70">Falhas (60d)</div>
          <div className="text-2xl font-extrabold text-red-600 dark:text-red-400 mt-0.5">{falhas}</div>
        </div>
      </div>

      {/* Próximos aniversariantes */}
      <div>
        <h3 className="text-sm font-bold mb-2 flex items-center gap-1.5">
          <PartyPopper size={14} className="text-fuchsia-500" /> Próximos aniversariantes
        </h3>
        {upcoming.length === 0 ? (
          <p className="text-xs text-muted-foreground italic py-6 text-center">Ninguém faz aniversário nos próximos 30 dias.</p>
        ) : (
          <div className="bg-card border border-border rounded-2xl divide-y divide-border overflow-hidden">
            {upcoming.map((p) => (
              <div key={p.id} className={`flex items-center gap-3 px-4 py-2.5 ${p.is_today ? 'bg-fuchsia-500/5' : ''}`}>
                <div className={`shrink-0 w-9 h-9 rounded-xl flex items-center justify-center ${p.is_today ? 'bg-fuchsia-500/15 text-fuchsia-600' : 'bg-muted text-muted-foreground'}`}>
                  <Cake size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-bold truncate">{p.name}</div>
                  {p.phone && <div className="text-[11px] text-muted-foreground flex items-center gap-1"><Phone size={10} /> {maskPhone(p.phone)}</div>}
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-sm font-bold">{String(p.birth_day).padStart(2, '0')}/{String(p.birth_month).padStart(2, '0')}</div>
                  <div className={`text-[10px] font-semibold ${p.is_today ? 'text-fuchsia-600 dark:text-fuchsia-400' : 'text-muted-foreground'}`}>{diasLabel(p.days_until)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Histórico de envios */}
      <div>
        <h3 className="text-sm font-bold mb-2 flex items-center gap-1.5">
          <CheckCircle2 size={14} className="text-emerald-500" /> Histórico de envios (60 dias)
        </h3>
        {history.length === 0 ? (
          <p className="text-xs text-muted-foreground italic py-6 text-center">Nenhuma mensagem de aniversário disparada ainda.</p>
        ) : (
          <div className="bg-card border border-border rounded-2xl divide-y divide-border overflow-hidden">
            {history.map((h) => {
              const sm = STATUS_META[h.status] || { label: h.status, cls: 'bg-muted text-muted-foreground' };
              return (
                <div key={h.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold truncate">{h.recipient_name || 'Sem nome'}</div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {maskPhone(h.recipient_phone)}
                      {h.error ? <span className="text-red-500"> · {h.error}</span> : ''}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${sm.cls}`}>
                      {h.status === 'FAILED' ? <XCircle size={10} /> : <CheckCircle2 size={10} />} {sm.label}
                    </span>
                    <div className="text-[10px] text-muted-foreground mt-0.5">{fmtDateTime(h.sent_at)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
