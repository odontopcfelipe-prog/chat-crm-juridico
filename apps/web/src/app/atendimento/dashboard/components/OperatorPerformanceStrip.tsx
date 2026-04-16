'use client';

import { TrendingUp, TrendingDown, Clock, UserX, ArrowUpRight } from 'lucide-react';
import type { LeadFunnelData, ResponseTimeData, TaskCompletionData } from '../types';

interface Props {
  funnel?: LeadFunnelData | null;
  responseTime?: ResponseTimeData | null;
  tasks?: TaskCompletionData | null;
}

interface MiniKPI {
  icon: any;
  label: string;
  value: string;
  trend: 'up' | 'down' | 'neutral';
  color: string;
}

export function OperatorPerformanceStrip({ funnel, responseTime, tasks }: Props) {
  const rate = funnel?.overallConversionRate ?? 0;
  const avgResp = responseTime?.avgMinutes ?? 0;
  const completionRate = tasks?.completionRate ?? 0;
  const overdue = tasks?.overdue ?? 0;

  // Calcular leads perdidos (stages onde count diminui)
  const totalLeads = funnel?.totalLeads ?? 0;
  const totalClients = funnel?.totalClients ?? 0;
  const leadsLost = totalLeads > 0 ? totalLeads - totalClients - (funnel?.stages?.reduce((s, st) => {
    if (st.stage === 'FINALIZADO') return s;
    return s;
  }, 0) ?? 0) : 0;

  // Stages avancados (soma de leads que passaram por stages)
  const stagesAdvanced = funnel?.stages
    ? funnel.stages.reduce((s, st) => s + st.count, 0) - (funnel.stages[0]?.count ?? 0)
    : 0;

  const kpis: MiniKPI[] = [
    {
      icon: rate >= 15 ? TrendingUp : TrendingDown,
      label: 'Conversao',
      value: `${rate.toFixed(1)}%`,
      trend: rate >= 15 ? 'up' : rate > 0 ? 'down' : 'neutral',
      color: rate >= 15 ? 'text-emerald-400' : rate >= 5 ? 'text-amber-400' : 'text-red-400',
    },
    {
      icon: Clock,
      label: 'Tempo Medio Resposta',
      value: avgResp < 60 ? `${Math.round(avgResp)} min` : `${(avgResp / 60).toFixed(1)}h`,
      trend: avgResp <= 15 ? 'up' : 'down',
      color: avgResp <= 15 ? 'text-emerald-400' : avgResp <= 30 ? 'text-amber-400' : 'text-red-400',
    },
    {
      icon: ArrowUpRight,
      label: 'Taxa Conclusao Tarefas',
      value: `${completionRate.toFixed(0)}%`,
      trend: completionRate >= 80 ? 'up' : 'down',
      color: completionRate >= 80 ? 'text-emerald-400' : completionRate >= 50 ? 'text-amber-400' : 'text-red-400',
    },
    {
      icon: UserX,
      label: 'Tarefas Atrasadas',
      value: `${overdue}`,
      trend: overdue === 0 ? 'up' : 'down',
      color: overdue === 0 ? 'text-emerald-400' : 'text-red-400',
    },
  ];

  return (
    <div className="bg-card/50 border border-border rounded-xl px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          Performance Comercial
        </h3>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {kpis.map((kpi) => {
          const Icon = kpi.icon;
          return (
            <div key={kpi.label} className="flex items-center gap-2.5">
              <div className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${
                kpi.trend === 'up'
                  ? 'bg-emerald-500/10'
                  : kpi.trend === 'down'
                  ? 'bg-red-500/10'
                  : 'bg-muted'
              }`}>
                <Icon size={14} className={kpi.color} />
              </div>
              <div className="min-w-0">
                <p className={`text-sm font-black leading-none ${kpi.color}`}>
                  {kpi.value}
                </p>
                <p className="text-[9px] text-muted-foreground mt-0.5 truncate">{kpi.label}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
