'use client';

/**
 * Cards de metricas de agendamento — Fase 25 (Onda 5e v18, Fase C.2).
 *
 * Mostra no dashboard:
 *  - % de confirmacao (CONFIRMADO + COMPARECEU + CONCLUIDO / total nao-cancelado)
 *  - % de no-show (NO_SHOW / total nao-cancelado)
 *  - Aguardando confirmacao (AGENDADO sem confirmacao do paciente)
 *  - Total de consultas no periodo
 *
 * Periodo default: ultimos 30 dias (configuravel via props).
 *
 * Endpoint: GET /calendar/metrics?from=...&to=...
 */

import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Clock, Calendar, AlertTriangle, Loader2 } from 'lucide-react';
import api from '@/lib/api';

interface Metrics {
  period: { from: string; to: string };
  total: number;
  counts: {
    AGENDADO: number;
    CONFIRMADO: number;
    COMPARECEU: number;
    CONCLUIDO: number;
    CANCELADO: number;
    NO_SHOW: number;
    ADIADO: number;
  };
  rates: {
    confirmacao_pct: number;
    no_show_pct: number;
    cancelamento_pct: number;
    comparecimento_pct: number;
    aguardando_confirmacao: number;
  };
}

export function AgendaMetricsCards({ daysBack = 30 }: { daysBack?: number }) {
  const [data, setData] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const to = new Date();
        const from = new Date();
        from.setDate(from.getDate() - daysBack);
        const res = await api.get('/calendar/metrics', {
          params: { from: from.toISOString(), to: to.toISOString() },
        });
        setData(res.data);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [daysBack]);

  if (loading) {
    return (
      <div className="bg-card rounded-2xl border border-border p-6 flex items-center justify-center min-h-[140px]">
        <Loader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-card rounded-2xl border border-border p-6">
        <p className="text-sm text-muted-foreground italic text-center">
          Não foi possível carregar as métricas de agendamento.
        </p>
      </div>
    );
  }

  if (data.total === 0) {
    return (
      <div className="bg-card rounded-2xl border border-border p-6">
        <h3 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
          <Calendar size={16} className="text-primary" />
          Métricas de Agendamento (últimos {daysBack} dias)
        </h3>
        <p className="text-sm text-muted-foreground italic text-center py-6">
          Nenhuma consulta agendada no período.
        </p>
      </div>
    );
  }

  const cards: Array<{
    title: string;
    value: string;
    sub: string;
    color: string;
    icon: any;
  }> = [
    {
      title: 'Confirmação',
      value: `${data.rates.confirmacao_pct}%`,
      sub: `${data.counts.CONFIRMADO + data.counts.COMPARECEU + data.counts.CONCLUIDO} de ${data.total - data.counts.CANCELADO}`,
      color: 'emerald',
      icon: CheckCircle2,
    },
    {
      title: 'No-show',
      value: `${data.rates.no_show_pct}%`,
      sub: `${data.counts.NO_SHOW} faltas`,
      color: 'red',
      icon: XCircle,
    },
    {
      title: 'Aguardando confirmação',
      value: String(data.rates.aguardando_confirmacao),
      sub: 'Pacientes sem responder ao lembrete',
      color: 'amber',
      icon: Clock,
    },
    {
      title: 'Total de consultas',
      value: String(data.total),
      sub: `Últimos ${daysBack} dias`,
      color: 'sky',
      icon: Calendar,
    },
  ];

  // Tailwind nao gera classes dinamicas — mapeamento explicito por cor
  const colorMap: Record<string, { bg: string; text: string; iconBg: string }> = {
    emerald: { bg: 'bg-emerald-500/10', text: 'text-emerald-700 dark:text-emerald-400', iconBg: 'bg-emerald-500/20' },
    red:     { bg: 'bg-red-500/10',     text: 'text-red-700 dark:text-red-400',         iconBg: 'bg-red-500/20' },
    amber:   { bg: 'bg-amber-500/10',   text: 'text-amber-700 dark:text-amber-400',     iconBg: 'bg-amber-500/20' },
    sky:     { bg: 'bg-sky-500/10',     text: 'text-sky-700 dark:text-sky-400',         iconBg: 'bg-sky-500/20' },
  };

  return (
    <div className="bg-card rounded-2xl border border-border p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
          <Calendar size={16} className="text-primary" />
          Métricas de Agendamento
        </h3>
        <span className="text-[11px] text-muted-foreground">Últimos {daysBack} dias</span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map((card) => {
          const Icon = card.icon;
          const styles = colorMap[card.color];
          return (
            <div key={card.title} className={`${styles.bg} rounded-xl p-3`}>
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

      {/* Linha extra: alerta se no-show estiver alto */}
      {data.rates.no_show_pct >= 15 && (
        <div className="mt-3 flex items-center gap-2 p-2.5 rounded-lg bg-red-500/5 border border-red-500/20">
          <AlertTriangle size={14} className="text-red-600 dark:text-red-400 shrink-0" />
          <p className="text-[11px] text-foreground">
            <strong>Atenção:</strong> taxa de no-show acima de 15%. Considere reforçar lembretes ou ligações de confirmação.
          </p>
        </div>
      )}
    </div>
  );
}
