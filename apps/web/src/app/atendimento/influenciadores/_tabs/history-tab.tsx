'use client';

/**
 * Aba "Histórico" — log de envios (auditoria).
 * Paginado, filtros por status (SENT/FAILED/SKIPPED).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Loader2, History, CheckCircle2, XCircle, AlertTriangle,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import api from '@/lib/api';
import { showError } from '@/lib/toast';

type LogStatus = 'SENT' | 'FAILED' | 'SKIPPED';

interface MessageLog {
  id: string;
  scheduled_for: string;
  status: LogStatus;
  sent_at: string | null;
  sent_text: string | null;
  error_message: string | null;
  schedule: { id: string; name: string };
  influencer: { id: string; name: string; phone: string | null; handle: string | null };
}

interface PageResp {
  items: MessageLog[];
  total: number;
  page: number;
  pageSize: number;
}

const STATUS_CFG: Record<LogStatus, { label: string; cls: string; icon: React.ElementType }> = {
  SENT:    { label: 'Enviado',  cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20', icon: CheckCircle2 },
  FAILED:  { label: 'Falhou',   cls: 'bg-red-500/10 text-red-600 border-red-500/20',             icon: XCircle },
  SKIPPED: { label: 'Pulado',   cls: 'bg-amber-500/10 text-amber-600 border-amber-500/20',       icon: AlertTriangle },
};

function formatDt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function HistoryTab() {
  const [data, setData] = useState<PageResp>({ items: [], total: 0, page: 1, pageSize: 50 });
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<LogStatus | ''>('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { page: String(page) };
      if (statusFilter) params.status = statusFilter;
      const { data } = await api.get<PageResp>('/influencers/messages', { params });
      setData(data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar histórico');
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <p className="text-xs text-muted-foreground">
          {data.total} envio{data.total === 1 ? '' : 's'} registrado{data.total === 1 ? '' : 's'}
        </p>
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value as LogStatus | ''); setPage(1); }}
          className="px-3 py-2 rounded-lg bg-card border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
        >
          <option value="">Todos os status</option>
          <option value="SENT">Enviados</option>
          <option value="FAILED">Falhas</option>
          <option value="SKIPPED">Pulados</option>
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : data.items.length === 0 ? (
        <div className="text-center py-16 bg-card border border-dashed border-border rounded-xl">
          <History size={36} className="mx-auto mb-3 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            {statusFilter ? `Nenhum envio com status ${statusFilter}.` : 'Nenhum envio registrado ainda.'}
          </p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="divide-y divide-border">
            {data.items.map(log => {
              const cfg = STATUS_CFG[log.status];
              const Icon = cfg.icon;
              const isExpanded = expanded === log.id;
              return (
                <div key={log.id}>
                  <button
                    onClick={() => setExpanded(isExpanded ? null : log.id)}
                    className="w-full px-4 py-3 hover:bg-accent/30 transition-colors text-left"
                  >
                    <div className="flex items-center gap-3">
                      <span className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-semibold ${cfg.cls}`}>
                        <Icon size={10} /> {cfg.label}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          {log.influencer.name}
                          {log.influencer.phone && (
                            <span className="ml-2 text-xs text-muted-foreground font-normal">
                              {log.influencer.phone}
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          via <span className="text-foreground">{log.schedule.name}</span> · {formatDt(log.sent_at || log.scheduled_for)}
                        </p>
                      </div>
                    </div>
                  </button>
                  {isExpanded && (
                    <div className="px-4 pb-4 bg-background/50">
                      {log.sent_text && (
                        <div className="mb-3">
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-1">Mensagem enviada</p>
                          <pre className="text-xs text-foreground whitespace-pre-wrap font-sans bg-background border border-border rounded-lg p-3">
                            {log.sent_text}
                          </pre>
                        </div>
                      )}
                      {log.error_message && (
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-red-600 font-bold mb-1">Erro</p>
                          <pre className="text-xs text-red-700 whitespace-pre-wrap font-sans bg-red-500/5 border border-red-500/20 rounded-lg p-3">
                            {log.error_message}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Paginação */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-4">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="p-1.5 rounded-lg border border-border bg-card text-foreground hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="text-xs text-muted-foreground">
            Página {data.page} de {totalPages}
          </span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="p-1.5 rounded-lg border border-border bg-card text-foreground hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
