'use client';

/**
 * ArchivedQuotesTab — Onda 17.32.38
 *
 * Lista todos os orçamentos arquivados do tenant. Operador chega aqui via
 * tab "Orçamentos arquivados" no menu do Financeiro.
 *
 * Fluxo de entrada: quando uma proposta vai pra ACCEPTED (operador clicou
 * "Encaminhar ao financeiro"), o sistema pergunta quais outras versões
 * em aberto do paciente arquivar. As marcadas vêm parar aqui.
 *
 * Validade: 30 dias. UI marca como "EXPIRADO" depois disso (não some
 * automaticamente — operador decide se desarquiva ou ignora).
 *
 * Ações por linha:
 *  - Desarquivar (volta pra "Plano de tratamento" do paciente)
 *  - Ver paciente (link)
 *
 * Endpoint: GET /quotes/archived
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Archive, RotateCcw, ExternalLink, AlertTriangle, Layers, Clock } from 'lucide-react';
import Link from 'next/link';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface ArchivedQuote {
  id: string;
  status: string;
  title: string | null;
  quote_number?: number;
  total_value: string | number;
  priority?: string | null;
  archived_at: string | null;
  archived_by?: { id: string; name: string } | null;
  patient: { id: string; name: string; phone: string | null };
  _count?: { items: number };
}

const fmtBRL = (v: string | number) =>
  Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtDate = (iso: string | null) => {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  } catch {
    return iso;
  }
};

/** Onda 17.32.38 — Calcula dias desde archived_at. Usa pra mostrar "EXPIRADO"
 *  quando passou 30 dias. */
function daysSince(iso: string | null): number {
  if (!iso) return 0;
  try {
    return Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24));
  } catch {
    return 0;
  }
}

export default function ArchivedQuotesTab() {
  const [quotes, setQuotes] = useState<ArchivedQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [unarchiving, setUnarchiving] = useState<string | null>(null);
  const [filter, setFilter] = useState<'todos' | 'validos' | 'expirados'>('todos');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<ArchivedQuote[]>('/quotes/archived');
      setQuotes(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao carregar orçamentos arquivados');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    return quotes.filter((q) => {
      const days = daysSince(q.archived_at);
      const isExpired = days > 30;
      if (filter === 'validos') return !isExpired;
      if (filter === 'expirados') return isExpired;
      return true;
    });
  }, [quotes, filter]);

  const unarchive = async (id: string) => {
    if (!window.confirm('Desarquivar este orçamento? Ele volta pra aba "Plano de tratamento" do paciente.')) return;
    setUnarchiving(id);
    try {
      await api.post(`/quotes/${id}/unarchive`);
      showSuccess('Orçamento desarquivado');
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao desarquivar');
    } finally {
      setUnarchiving(null);
    }
  };

  if (loading) {
    return (
      <div className="py-12 flex items-center justify-center text-muted-foreground">
        <Loader2 size={18} className="animate-spin mr-2" /> Carregando arquivados...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-amber-500/15 flex items-center justify-center shrink-0">
            <Archive size={18} className="text-amber-700 dark:text-amber-400" />
          </div>
          <div>
            <h2 className="text-base font-bold text-foreground">Orçamentos arquivados</h2>
            <p className="text-xs text-muted-foreground">
              Propostas arquivadas pós-encaminhamento ao financeiro. Válidas por 30 dias — depois ficam marcadas como expiradas.
            </p>
          </div>
        </div>
        {/* Filtros */}
        <div className="flex items-center gap-1 bg-muted/30 p-1 rounded-md">
          {(['todos', 'validos', 'expirados'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`text-[11px] font-semibold px-3 py-1.5 rounded transition-colors ${
                filter === f
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {f === 'todos' ? 'Todos' : f === 'validos' ? 'Válidos' : 'Expirados'}
            </button>
          ))}
        </div>
      </div>

      {/* Empty state */}
      {filtered.length === 0 ? (
        <div className="bg-card border border-border border-dashed rounded-xl p-10 text-center">
          <Archive size={32} className="mx-auto text-muted-foreground/60 mb-3" />
          <p className="text-sm font-medium text-foreground mb-1">
            {quotes.length === 0
              ? 'Nenhum orçamento arquivado'
              : filter === 'expirados'
              ? 'Nenhum expirado'
              : 'Nenhum válido'}
          </p>
          <p className="text-xs text-muted-foreground max-w-md mx-auto">
            Quando você encaminha uma proposta ao financeiro, o sistema pergunta se quer arquivar as outras versões em aberto. Os arquivados aparecem aqui por 30 dias.
          </p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <p className="text-sm font-semibold text-foreground">
              {filtered.length} {filtered.length === 1 ? 'orçamento' : 'orçamentos'}
            </p>
          </div>
          <ul className="divide-y divide-border">
            {filtered.map((q) => {
              const days = daysSince(q.archived_at);
              const isExpired = days > 30;
              const daysLeft = Math.max(0, 30 - days);
              return (
                <li key={q.id} className={`px-4 py-3 flex items-center gap-3 flex-wrap ${isExpired ? 'opacity-60' : ''}`}>
                  <div className="flex-1 min-w-[240px]">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <Link
                        href={`/atendimento/pacientes/${q.patient.id}?tab=proposals`}
                        className="text-sm font-semibold text-foreground hover:text-primary truncate"
                      >
                        {q.patient.name}
                      </Link>
                      <span className="font-mono text-[10px] text-primary">
                        {q.quote_number ? `#${String(q.quote_number).padStart(3, '0')}` : ''}
                      </span>
                      {q.priority && (
                        <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-muted text-foreground">
                          {q.priority}
                        </span>
                      )}
                      {isExpired ? (
                        <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-red-500/15 text-red-700 dark:text-red-400 border border-red-500/30 inline-flex items-center gap-1">
                          <AlertTriangle size={9} />
                          Expirado há {days - 30}d
                        </span>
                      ) : (
                        <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/30">
                          {daysLeft}d restantes
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap">
                      <span className="inline-flex items-center gap-1">
                        <Layers size={10} />
                        {q.title || 'Sem título'} · {q._count?.items || 0} {q._count?.items === 1 ? 'item' : 'itens'}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Clock size={10} />
                        Arquivado em {fmtDate(q.archived_at)}
                      </span>
                      {q.archived_by?.name && (
                        <span className="text-muted-foreground">por {q.archived_by.name}</span>
                      )}
                    </p>
                  </div>
                  <div className="text-right min-w-[120px]">
                    <p className="text-sm font-bold text-foreground tabular-nums">R$ {fmtBRL(q.total_value)}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => unarchive(q.id)}
                      disabled={unarchiving === q.id}
                      className="text-xs font-semibold inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-50 transition-colors"
                      title="Volta o orçamento pra aba Plano de tratamento do paciente"
                    >
                      {unarchiving === q.id ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
                      Desarquivar
                    </button>
                    <Link
                      href={`/atendimento/pacientes/${q.patient.id}?tab=proposals`}
                      className="p-1.5 rounded text-muted-foreground hover:text-primary hover:bg-primary/10"
                      title="Abrir ficha do paciente"
                    >
                      <ExternalLink size={12} />
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
