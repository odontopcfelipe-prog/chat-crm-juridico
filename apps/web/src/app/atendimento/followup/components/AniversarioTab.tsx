'use client';

/**
 * Onda 17.60 — tela de Aniversariantes no modelo da tela de Lembretes (KPIs +
 * abas + tabela). Abas:
 *   - Próximos 30 dias — quem faz aniversário no próximo mês.
 *   - Do ano — TODOS os aniversariantes ativos, ordenados por quem está mais perto.
 *   - Enviados — histórico dos parabéns já disparados (DispatchLog).
 * Tudo filtrável por busca.
 *
 * Fontes:
 *   GET /calendar/birthday-greeting/upcoming?days=366  (aniversariantes do ano)
 *   GET /followup/disparos?type=aniversario&days=366   (enviados)
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import { Cake, Loader2, RefreshCw, Search, Inbox } from 'lucide-react';
import api from '@/lib/api';
import { showError } from '@/lib/toast';

interface UpcomingItem {
  id: string; name: string; phone: string | null;
  birth_day: number; birth_month: number; days_until: number; is_today: boolean;
}
interface HistoryItem {
  id: string; recipient_name: string | null; recipient_phone: string | null;
  status: string; sent_at: string | null; error: string | null;
}
type Tab = 'proximos' | 'ano' | 'enviados';

const STATUS_META: Record<string, { label: string; cls: string }> = {
  SENT:      { label: 'Enviado',  cls: 'bg-blue-500/10 text-blue-600 dark:text-blue-400' },
  DELIVERED: { label: 'Entregue', cls: 'bg-teal-500/10 text-teal-600 dark:text-teal-400' },
  READ:      { label: 'Lido',     cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  FAILED:    { label: 'Falhou',   cls: 'bg-red-500/10 text-red-600 dark:text-red-400' },
};

function diasLabel(d: number): string {
  if (d === 0) return '🎉 Hoje';
  if (d === 1) return 'Amanhã';
  if (d <= 30) return `Em ${d} dias`;
  if (d < 60) return 'Em ~1 mês';
  return `Em ${Math.round(d / 30)} meses`;
}
function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Maceio', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function maskPhone(p: string | null): string {
  if (!p) return '';
  const d = p.replace(/\D/g, '');
  return d.length >= 12 ? `+${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4)}` : d;
}

export function AniversarioTab() {
  const [upcoming, setUpcoming] = useState<UpcomingItem[]>([]);
  const [todayCount, setTodayCount] = useState(0);
  const [semData, setSemData] = useState(0);
  const [totalAtivos, setTotalAtivos] = useState(0);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Onda 17.60 — abre já na lista do ANO (ordenada pelos próximos aniversários),
  // pra ver de cara quem vem a seguir, mesmo que ninguém faça nos próximos 30 dias.
  const [tab, setTab] = useState<Tab>('ano');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [up, hist] = await Promise.all([
        api.get('/calendar/birthday-greeting/upcoming', { params: { days: 366 } }),
        api.get('/followup/disparos', { params: { type: 'aniversario', days: 366 } }),
      ]);
      setUpcoming(up.data?.items || []);
      setTodayCount(up.data?.today || 0);
      setSemData(up.data?.sem_data || 0);
      setTotalAtivos(up.data?.total_ativos || 0);
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

  const q = search.trim().toLowerCase();
  const proximos30 = useMemo(() => upcoming.filter((u) => u.days_until <= 30), [upcoming]);
  const enviadosCount = useMemo(() => history.filter((h) => ['SENT', 'DELIVERED', 'READ'].includes(h.status)).length, [history]);

  const upRows = useMemo(() => {
    const base = tab === 'proximos' ? proximos30 : upcoming;
    return q ? base.filter((u) => u.name.toLowerCase().includes(q) || (u.phone || '').includes(q)) : base;
  }, [tab, proximos30, upcoming, q]);
  const histRows = useMemo(() => (
    q ? history.filter((h) => (h.recipient_name || '').toLowerCase().includes(q) || (h.recipient_phone || '').includes(q)) : history
  ), [history, q]);

  if (loading) {
    return <div className="py-16 flex items-center justify-center text-muted-foreground"><Loader2 size={20} className="animate-spin" /></div>;
  }

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'proximos', label: 'Próximos 30 dias', count: proximos30.length },
    { id: 'ano', label: 'Do ano', count: upcoming.length },
    { id: 'enviados', label: 'Enviados', count: history.length },
  ];

  const kpi = (label: string, value: number, cls: string) => (
    <div className={`flex-1 min-w-[110px] p-3 rounded-xl border ${cls}`}>
      <div className="text-[10px] font-bold uppercase tracking-wider opacity-70">{label}</div>
      <div className="text-2xl font-extrabold mt-0.5">{value}</div>
    </div>
  );
  const empty = (msg: string) => (
    <div className="py-16 flex flex-col items-center justify-center text-muted-foreground gap-2">
      <Inbox size={28} className="opacity-40" /><p className="text-sm text-center px-4">{msg}</p>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h2 className="text-lg font-extrabold flex items-center gap-2"><Cake size={18} className="text-fuchsia-500" /> Aniversariantes</h2>
          <p className="text-[11px] text-muted-foreground">Quem faz aniversário (hoje, no mês, no ano) e os parabéns já enviados.</p>
        </div>
        <button onClick={load} disabled={refreshing} className="p-2 rounded-lg border border-border hover:bg-accent transition-colors disabled:opacity-50" title="Atualizar">
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* KPIs */}
      <div className="flex gap-2 flex-wrap">
        {kpi('Hoje', todayCount, 'border-fuchsia-500/20 bg-fuchsia-500/5 text-fuchsia-600 dark:text-fuchsia-400')}
        {kpi('Próximos 30 dias', proximos30.length, 'border-amber-500/20 bg-amber-500/5 text-amber-600 dark:text-amber-400')}
        {kpi('No ano', upcoming.length, 'border-border bg-card text-foreground')}
        {kpi('Parabéns enviados', enviadosCount, 'border-emerald-500/20 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400')}
      </div>

      {/* Aviso: pacientes sem data de nascimento não aparecem na lista */}
      {semData > 0 && (
        <div className="flex items-start gap-2 p-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-[12px] text-amber-800 dark:text-amber-300">
          <span className="text-base leading-none">⚠️</span>
          <span>
            <b>{semData}</b> de <b>{totalAtivos}</b> pacientes ativos estão <b>sem data de nascimento</b> — por isso não aparecem aqui. É só preencher o nascimento no cadastro deles que entram na lista. 🎂
          </span>
        </div>
      )}

      {/* Abas */}
      <div className="flex gap-1 border-b border-border overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-sm font-semibold -mb-px border-b-2 whitespace-nowrap transition-colors ${tab === t.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            {t.label} <span className="opacity-60">{t.count}</span>
          </button>
        ))}
      </div>

      {/* Busca */}
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por paciente ou telefone…"
          className="w-full pl-9 pr-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40"
        />
      </div>

      {/* Tabela */}
      {tab === 'enviados' ? (
        histRows.length === 0 ? empty('Nenhum parabéns enviado ainda — começa a registrar a partir do próximo aniversário disparado.') : (
          <div className="bg-card border border-border rounded-2xl overflow-hidden">
            <div className="hidden sm:grid grid-cols-[1fr_auto_auto] gap-3 px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border">
              <div>Paciente</div><div className="text-right">Status</div><div className="text-right">Enviado</div>
            </div>
            <div className="divide-y divide-border">
              {histRows.map((h) => {
                const sm = STATUS_META[h.status] || { label: h.status, cls: 'bg-muted text-muted-foreground' };
                return (
                  <div key={h.id} className="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_auto_auto] gap-3 px-4 py-2.5 items-center">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold truncate">{h.recipient_name || 'Sem nome'}</div>
                      <div className="text-[11px] text-muted-foreground truncate">{maskPhone(h.recipient_phone)}{h.error ? <span className="text-red-500"> · {h.error}</span> : ''}</div>
                    </div>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full justify-self-end ${sm.cls}`}>{sm.label}</span>
                    <div className="text-[11px] text-muted-foreground hidden sm:block text-right">{fmtDateTime(h.sent_at)}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )
      ) : (
        upRows.length === 0 ? empty(tab === 'proximos' ? 'Ninguém faz aniversário nos próximos 30 dias.' : 'Nenhum paciente ativo com data de nascimento cadastrada. Preencha o nascimento nos cadastros pra eles aparecerem aqui.') : (
          <div className="bg-card border border-border rounded-2xl overflow-hidden">
            <div className="hidden sm:grid grid-cols-[1fr_auto_auto] gap-3 px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border">
              <div>Paciente</div><div className="text-right">Aniversário</div><div className="text-right">Quando</div>
            </div>
            <div className="divide-y divide-border">
              {upRows.map((p) => (
                <div key={p.id} className={`grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_auto_auto] gap-3 px-4 py-2.5 items-center ${p.is_today ? 'bg-fuchsia-500/5' : ''}`}>
                  <div className="min-w-0 flex items-center gap-2.5">
                    <div className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${p.is_today ? 'bg-fuchsia-500/15 text-fuchsia-600' : 'bg-muted text-muted-foreground'}`}><Cake size={14} /></div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold truncate">{p.name}</div>
                      <div className="text-[11px] text-muted-foreground truncate">{maskPhone(p.phone) || 'sem telefone'}</div>
                    </div>
                  </div>
                  <div className="text-sm font-bold justify-self-end">{String(p.birth_day).padStart(2, '0')}/{String(p.birth_month).padStart(2, '0')}</div>
                  <div className={`text-[11px] font-semibold hidden sm:block text-right ${p.is_today ? 'text-fuchsia-600 dark:text-fuchsia-400' : 'text-muted-foreground'}`}>{diasLabel(p.days_until)}</div>
                </div>
              ))}
            </div>
          </div>
        )
      )}

      <div className="text-[10px] text-muted-foreground text-right flex items-center justify-end gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> {tab === 'enviados' ? histRows.length : upRows.length} registro(s) · atualiza a cada 30s
      </div>
    </div>
  );
}
