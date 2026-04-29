'use client';

/**
 * TimelineTab — histórico cronológico unificado do paciente.
 *
 * Agrega num único stream vertical: consultas, procedimentos executados,
 * pagamentos (incluindo atrasos), retornos programados/contatados e
 * anamneses preenchidas/assinadas.
 *
 * UI: linha vertical com pontinho colorido por tipo de evento, agrupado
 * por mês/ano pra facilitar leitura. Filtros toggleáveis por tipo (recepção
 * pode esconder pagamentos pra focar só em clínico, por exemplo).
 *
 * Backend: GET /patients/:id/timeline?limit=N — retorna {items, total}
 * já ordenado desc por data.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Loader2, Calendar, Activity, DollarSign, Bell, FileText,
  Clock, CheckCircle2, XCircle, AlertTriangle,
} from 'lucide-react';
import api from '@/lib/api';
import { showError } from '@/lib/toast';

interface TimelineItem {
  id: string;
  type: 'appointment' | 'procedure' | 'payment' | 'return' | 'anamnesis';
  date: string;
  title: string;
  subtitle?: string | null;
  status?: string | null;
  professional?: string | null;
  amount?: number | null;
  link?: string | null;
}

interface TimelineResponse {
  items: TimelineItem[];
  total: number;
}

const TYPE_CFG: Record<TimelineItem['type'], {
  label: string;
  icon: React.ElementType;
  color: string; // tailwind class for dot bg
  textColor: string;
  bgColor: string;
}> = {
  appointment: {
    label: 'Consultas',
    icon: Calendar,
    color: 'bg-blue-500',
    textColor: 'text-blue-600',
    bgColor: 'bg-blue-500/10 border-blue-500/20',
  },
  procedure: {
    label: 'Procedimentos',
    icon: Activity,
    color: 'bg-emerald-500',
    textColor: 'text-emerald-600',
    bgColor: 'bg-emerald-500/10 border-emerald-500/20',
  },
  payment: {
    label: 'Pagamentos',
    icon: DollarSign,
    color: 'bg-amber-500',
    textColor: 'text-amber-600',
    bgColor: 'bg-amber-500/10 border-amber-500/20',
  },
  return: {
    label: 'Retornos',
    icon: Bell,
    color: 'bg-purple-500',
    textColor: 'text-purple-600',
    bgColor: 'bg-purple-500/10 border-purple-500/20',
  },
  anamnesis: {
    label: 'Anamneses',
    icon: FileText,
    color: 'bg-slate-500',
    textColor: 'text-slate-600',
    bgColor: 'bg-slate-500/10 border-slate-500/20',
  },
};

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  // Consultas
  AGENDADO:    { label: 'Agendado',    cls: 'bg-blue-500/10 text-blue-600 border-blue-500/20' },
  CONFIRMADO:  { label: 'Confirmado',  cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' },
  CONCLUIDO:   { label: 'Concluído',   cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' },
  CANCELADO:   { label: 'Cancelado',   cls: 'bg-red-500/10 text-red-600 border-red-500/20' },
  ADIADO:      { label: 'Adiado',      cls: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
  // Procedimentos
  PENDING:     { label: 'Pendente',    cls: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
  SCHEDULED:   { label: 'Agendado',    cls: 'bg-blue-500/10 text-blue-600 border-blue-500/20' },
  IN_PROGRESS: { label: 'Em andamento', cls: 'bg-blue-500/10 text-blue-600 border-blue-500/20' },
  DONE:        { label: 'Executado',   cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' },
  CANCELLED:   { label: 'Cancelado',   cls: 'bg-red-500/10 text-red-600 border-red-500/20' },
  // Pagamentos
  ABERTA:      { label: 'Aberta',      cls: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
  PAGA:        { label: 'Paga',        cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' },
  PARCIAL:     { label: 'Parcial',     cls: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
  ATRASADA:    { label: 'Atrasada',    cls: 'bg-red-500/10 text-red-600 border-red-500/20' },
  CANCELADA:   { label: 'Cancelada',   cls: 'bg-muted text-muted-foreground border-border' },
  RENEGOCIADA: { label: 'Renegociada', cls: 'bg-purple-500/10 text-purple-600 border-purple-500/20' },
  // Retornos
  PENDENTE:    { label: 'Pendente',    cls: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
  CONTATADO:   { label: 'Contatado',   cls: 'bg-blue-500/10 text-blue-600 border-blue-500/20' },
  REJEITADO:   { label: 'Rejeitado',   cls: 'bg-red-500/10 text-red-600 border-red-500/20' },
  EXPIRADO:    { label: 'Expirado',    cls: 'bg-muted text-muted-foreground border-border' },
  // Anamnese
  RASCUNHO:           { label: 'Rascunho',  cls: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
  AGUARDANDO_PACIENTE:{ label: 'Aguarda paciente', cls: 'bg-blue-500/10 text-blue-600 border-blue-500/20' },
  PREENCHIDA:         { label: 'Preenchida', cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' },
  ASSINADA:           { label: 'Assinada',   cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' },
};

const MONTH_LABEL = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

function formatBRL(value: number) {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDateTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    timeZone: 'UTC',
  });
}

function monthYearKey(iso: string) {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()).padStart(2, '0')}`;
}

function formatMonthYear(key: string) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTH_LABEL[m]} de ${y}`;
}

export default function TimelineTab({
  patientId,
  initialActiveTypes,
}: {
  patientId: string;
  /**
   * Conjunto inicial de tipos a exibir. Permite drill-down a partir de
   * outros lugares (ex: click em "Consultas: N" no Resumo Clínico abre
   * essa aba já filtrada por 'appointment'). Se não passado, mostra tudo.
   */
  initialActiveTypes?: Set<TimelineItem['type']>;
}) {
  const [data, setData] = useState<TimelineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTypes, setActiveTypes] = useState<Set<TimelineItem['type']>>(
    initialActiveTypes ||
      new Set(['appointment', 'procedure', 'payment', 'return', 'anamnesis'])
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get<TimelineResponse>(`/patients/${patientId}/timeline?limit=200`)
      .then((r) => {
        if (!cancelled) setData(r.data);
      })
      .catch((err) => {
        showError(err?.response?.data?.message || 'Erro ao carregar histórico');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [patientId]);

  const toggleType = (t: TimelineItem['type']) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  // Filtra + agrupa por mês
  const grouped = useMemo(() => {
    if (!data?.items) return [];
    const filtered = data.items.filter((it) => activeTypes.has(it.type));
    const map = new Map<string, TimelineItem[]>();
    for (const it of filtered) {
      const k = monthYearKey(it.date);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(it);
    }
    // Map mantém ordem de inserção, e items já vêm desc por data → ok
    return Array.from(map.entries());
  }, [data, activeTypes]);

  // Contadores por tipo (pra mostrar no toggle)
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const it of data?.items || []) c[it.type] = (c[it.type] || 0) + 1;
    return c;
  }, [data]);

  if (loading) {
    return (
      <div className="p-12 flex items-center justify-center text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" /> Carregando histórico...
      </div>
    );
  }

  const totalShown = grouped.reduce((sum, [, items]) => sum + items.length, 0);

  return (
    <div>
      {/* Toolbar de filtros por tipo */}
      <div className="bg-card border border-border rounded-xl p-3 mb-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-muted-foreground">Mostrar:</span>
          {(Object.keys(TYPE_CFG) as Array<TimelineItem['type']>).map((t) => {
            const cfg = TYPE_CFG[t];
            const Icon = cfg.icon;
            const active = activeTypes.has(t);
            const count = counts[t] || 0;
            return (
              <button
                key={t}
                onClick={() => toggleType(t)}
                disabled={count === 0}
                className={`text-xs inline-flex items-center gap-1 px-2.5 py-1 rounded-full border transition-colors ${
                  active
                    ? `${cfg.bgColor} ${cfg.textColor}`
                    : 'border-border text-muted-foreground hover:bg-accent'
                } ${count === 0 ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                <Icon size={11} /> {cfg.label}
                <span className="ml-0.5 text-[10px] opacity-80">({count})</span>
              </button>
            );
          })}
          <span className="ml-auto text-xs text-muted-foreground">
            {totalShown} de {data?.total ?? 0} eventos
          </span>
        </div>
      </div>

      {/* Empty state */}
      {grouped.length === 0 && (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <Clock size={28} className="mx-auto mb-2 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            {data && data.total > 0
              ? 'Nenhum evento corresponde aos filtros selecionados.'
              : 'Sem histórico registrado ainda. Quando esse paciente tiver consultas, procedimentos ou pagamentos, eles aparecerão aqui.'}
          </p>
        </div>
      )}

      {/* Timeline agrupada por mês */}
      <div className="space-y-6">
        {grouped.map(([monthKey, items]) => (
          <div key={monthKey}>
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
              <span>{formatMonthYear(monthKey)}</span>
              <span className="text-[10px] font-normal opacity-70">{items.length} evento(s)</span>
              <span className="flex-1 h-px bg-border" />
            </h3>

            {/* Lista de eventos do mês com linha vertical conectora */}
            <ol className="relative border-l-2 border-border ml-3 space-y-3 pb-1">
              {items.map((item) => {
                const cfg = TYPE_CFG[item.type];
                const Icon = cfg.icon;
                const statusBadge = item.status ? STATUS_BADGE[item.status] : null;
                const isCancelled = item.status === 'CANCELADO' || item.status === 'CANCELLED' || item.status === 'CANCELADA';

                return (
                  <li key={item.id} className="ml-5 relative">
                    {/* Pontinho */}
                    <span
                      className={`absolute -left-[34px] top-1 w-5 h-5 rounded-full ${cfg.color} border-4 border-background flex items-center justify-center`}
                    >
                      <Icon size={10} className="text-white" />
                    </span>

                    {/* Card */}
                    <div className={`bg-card border border-border rounded-lg p-3 hover:border-primary/40 transition-colors ${isCancelled ? 'opacity-60' : ''}`}>
                      <div className="flex items-start justify-between gap-2 flex-wrap">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            {item.link ? (
                              <a
                                href={item.link}
                                className="text-sm font-medium text-foreground hover:text-primary truncate"
                              >
                                {item.title}
                              </a>
                            ) : (
                              <span className="text-sm font-medium text-foreground">{item.title}</span>
                            )}
                            {statusBadge && (
                              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${statusBadge.cls}`}>
                                {statusBadge.label}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5 flex-wrap">
                            <span>{formatDateTime(item.date)}</span>
                            {item.professional && <span>Dr(a). {item.professional}</span>}
                            {item.subtitle && <span className="italic truncate">{item.subtitle}</span>}
                          </div>
                        </div>
                        {item.amount != null && (
                          <span className={`text-sm font-semibold whitespace-nowrap ${
                            item.status === 'PAGA' || item.status === 'PARCIAL'
                              ? 'text-emerald-600'
                              : item.status === 'ATRASADA'
                                ? 'text-red-600'
                                : 'text-foreground'
                          }`}>
                            {formatBRL(item.amount)}
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
      </div>
    </div>
  );
}
