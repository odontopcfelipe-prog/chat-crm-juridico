'use client';

import { Activity, Target, CheckCircle2 } from 'lucide-react';
import { WidgetCard } from './WidgetCard';

interface Props {
  closedToday: number;
  closedThisWeek: number;
  closedThisMonth: number;
  isOperador?: boolean;
}

const DAILY_GOAL = 15;
const WEEKLY_GOAL = DAILY_GOAL * 5;
const MONTHLY_GOAL = DAILY_GOAL * 22;

function ProgressBar({ current, goal, color }: { current: number; goal: number; color: string }) {
  const pct = Math.min((current / goal) * 100, 100);
  const hitGoal = current >= goal;

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[9px] text-muted-foreground font-semibold">
          Meta: {goal}
        </span>
        <span className={`text-[9px] font-bold ${hitGoal ? 'text-emerald-400' : 'text-muted-foreground'}`}>
          {pct.toFixed(0)}%
        </span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${
            hitGoal ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.4)]' : color
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function InboxStats({ closedToday, closedThisWeek, closedThisMonth, isOperador }: Props) {
  const todayHit = closedToday >= DAILY_GOAL;
  const weekHit = closedThisWeek >= WEEKLY_GOAL;
  const monthHit = closedThisMonth >= MONTHLY_GOAL;

  return (
    <WidgetCard
      title="Atendimentos Encerrados"
      icon={<Activity size={15} className="text-primary" />}
      linkLabel="Ver inbox"
      linkHref="/atendimento"
      badge={isOperador ? `Meta: ${DAILY_GOAL}/dia` : undefined}
    >
      <div className="grid grid-cols-3 gap-3">
        {/* Hoje */}
        <div className={`text-center p-3 rounded-xl border transition-all ${
          todayHit
            ? 'bg-emerald-500/10 border-emerald-500/30 shadow-[0_0_12px_rgba(52,211,153,0.1)]'
            : 'bg-emerald-500/5 border-emerald-500/20'
        }`}>
          <div className="flex items-center justify-center gap-1">
            <p className="text-2xl font-black text-emerald-400">{closedToday}</p>
            {todayHit && <CheckCircle2 size={14} className="text-emerald-400" />}
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">Hoje</p>
          {isOperador && <ProgressBar current={closedToday} goal={DAILY_GOAL} color="bg-emerald-500" />}
        </div>

        {/* Semana */}
        <div className={`text-center p-3 rounded-xl border transition-all ${
          weekHit
            ? 'bg-blue-500/10 border-blue-500/30 shadow-[0_0_12px_rgba(59,130,246,0.1)]'
            : 'bg-blue-500/5 border-blue-500/20'
        }`}>
          <div className="flex items-center justify-center gap-1">
            <p className="text-2xl font-black text-blue-400">{closedThisWeek}</p>
            {weekHit && <CheckCircle2 size={14} className="text-blue-400" />}
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">Esta semana</p>
          {isOperador && <ProgressBar current={closedThisWeek} goal={WEEKLY_GOAL} color="bg-blue-500" />}
        </div>

        {/* Mes */}
        <div className={`text-center p-3 rounded-xl border transition-all ${
          monthHit
            ? 'bg-violet-500/10 border-violet-500/30 shadow-[0_0_12px_rgba(139,92,246,0.1)]'
            : 'bg-violet-500/5 border-violet-500/20'
        }`}>
          <div className="flex items-center justify-center gap-1">
            <p className="text-2xl font-black text-violet-400">{closedThisMonth}</p>
            {monthHit && <CheckCircle2 size={14} className="text-violet-400" />}
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">Este mes</p>
          {isOperador && <ProgressBar current={closedThisMonth} goal={MONTHLY_GOAL} color="bg-violet-500" />}
        </div>
      </div>
    </WidgetCard>
  );
}
