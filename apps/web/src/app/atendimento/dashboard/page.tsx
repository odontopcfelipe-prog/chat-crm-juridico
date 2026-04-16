'use client';

import { useRole } from '@/lib/useRole';
import { useDashboardData } from './hooks/useDashboardData';
import { usePeriodFilter } from './hooks/usePeriodFilter';
import { useTeamPerformance } from './hooks/useTeamPerformance';
import { MotionWidget } from './components/MotionWidget';
import {
  useRevenueTrend, useLeadFunnel, useTaskCompletion,
  useCaseDuration, useFinancialAging, useAiUsage,
  useLeadSources, useResponseTime, useConversionVelocity,
} from './hooks/useAnalyticsData';

import { DashboardHeader } from './components/DashboardHeader';
import { PeriodSelector } from './components/PeriodSelector';
import { StatsGrid } from './components/StatsGrid';
import { InboxStats } from './components/InboxStats';
import { FinancialStats } from './components/FinancialStats';
import { LeadPipeline } from './components/LeadPipeline';
import { LegalCasesPipeline } from './components/LegalCasesPipeline';
import { TeamMetrics } from './components/TeamMetrics';
import { TeamPerformanceBoard } from './components/TeamPerformanceBoard';
import { UpcomingEvents } from './components/UpcomingEvents';
import { DjenPublications } from './components/DjenPublications';
import { QuickActions } from './components/QuickActions';
import { TeamOnline } from './components/TeamOnline';
import { OperatorPerformanceStrip } from './components/OperatorPerformanceStrip';

import { RevenueTrendChart } from './components/charts/RevenueTrendChart';
import { LeadFunnelChart } from './components/charts/LeadFunnelChart';
import { TaskCompletionChart } from './components/charts/TaskCompletionChart';
import { CaseDurationChart } from './components/charts/CaseDurationChart';
import { FinancialAgingChart } from './components/charts/FinancialAgingChart';
import { AiUsageChart } from './components/charts/AiUsageChart';
import { LeadSourcesChart } from './components/charts/LeadSourcesChart';
import { ConversionVelocityWidget } from './components/charts/ConversionVelocityWidget';
import { ResponseTimeWidget } from './components/charts/ResponseTimeWidget';

/* ═══════════════════════════════════════════════════════════════
   Dashboard — Composicao principal
   ═══════════════════════════════════════════════════════════════ */
export default function DashboardPage() {
  const roleInfo = useRole();
  const { isAdmin, isAdvogado, isOperador, isEstagiario, isFinanceiro } = roleInfo;

  const { period, setPeriod, setCustomRange } = usePeriodFilter('30d');
  const { data, loading } = useDashboardData(period);

  // Analytics hooks — cada widget carrega independentemente
  const revenue = useRevenueTrend(12);
  const funnel = useLeadFunnel(period);
  const tasks = useTaskCompletion(period);
  const caseDuration = useCaseDuration();
  const aging = useFinancialAging();
  const aiUsage = useAiUsage(6, isAdmin);
  const sources = useLeadSources(period);
  const responseTime = useResponseTime(period);
  const velocity = useConversionVelocity(period);
  const teamPerf = useTeamPerformance(period, isAdmin);

  // Dashboard agressivo para ADMIN e OPERADOR
  const aggressive = isAdmin || isOperador;

  // Visibility per role
  const showInbox = isAdmin || isOperador;
  const showFinancials = isAdmin || isAdvogado || isFinanceiro;
  const showRevenue = isAdmin || isAdvogado || isFinanceiro;
  const showFunnel = isAdmin || isOperador;
  const showTasks = isAdmin || isAdvogado || isOperador || isEstagiario;
  const showPipeline = isAdmin || isOperador;
  const showCases = isAdmin || isAdvogado || isEstagiario;
  const showCaseDuration = isAdmin || isAdvogado;
  const showAging = isAdmin || isAdvogado || isFinanceiro;
  const showVelocity = isAdmin || isOperador;
  const showResponse = isAdmin || isOperador;
  const showSources = isAdmin || isOperador;
  const showAi = isAdmin;
  const showTeam = isAdmin;
  const showEvents = isAdmin || isAdvogado || isOperador || isEstagiario;
  const showDjen = isAdmin || isAdvogado || isEstagiario;

  // Full-page loading
  if (loading && !data) {
    return (
      <div className="h-full overflow-y-auto bg-background p-4 md:p-6">
        <div className="max-w-7xl mx-auto space-y-6">
          <div className="animate-pulse space-y-2">
            <div className="h-8 w-60 bg-muted rounded-lg" />
            <div className="h-4 w-44 bg-muted rounded" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="bg-card border border-border rounded-xl p-3 animate-pulse">
                <div className="w-6 h-6 rounded-lg bg-muted mb-1.5" />
                <div className="h-5 w-12 bg-muted rounded mb-1" />
                <div className="h-2 w-16 bg-muted rounded" />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-card border border-border rounded-xl p-4 animate-pulse h-56" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="max-w-7xl mx-auto p-4 md:p-6 space-y-4 pb-28 md:pb-6">

        {/* Row 1: Header + Period Selector */}
        <MotionWidget>
          <div className="space-y-3">
            <DashboardHeader data={data} isAdmin={isAdmin} />
            <PeriodSelector active={period.key} onSelect={setPeriod} onCustomRange={setCustomRange} />
          </div>
        </MotionWidget>

        {/* Row 2: Stats Grid — agressivo (8 cards) para ADMIN/OPERADOR, padrao para demais */}
        <MotionWidget delay={0.05}>
          <StatsGrid
            data={data}
            aggressive={aggressive}
            funnel={aggressive ? funnel.data : undefined}
            responseTime={aggressive ? responseTime.data : undefined}
            velocity={aggressive ? velocity.data : undefined}
          />
        </MotionWidget>

        {/* Row 3: Performance Strip (ADMIN + OPERADOR) */}
        {aggressive && (
          <MotionWidget delay={0.08}>
            <OperatorPerformanceStrip
              funnel={funnel.data}
              responseTime={responseTime.data}
              tasks={tasks.data}
            />
          </MotionWidget>
        )}

        {/* Row 4: Inbox Stats (com metas) + Financial Stats */}
        <MotionWidget delay={0.12}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {showInbox && data.inboxStats && (
              <InboxStats
                closedToday={data.inboxStats.closedToday}
                closedThisWeek={data.inboxStats.closedThisWeek}
                closedThisMonth={data.inboxStats.closedThisMonth}
                isOperador={aggressive}
              />
            )}
            {showFinancials && (
              <div className={showInbox && data.inboxStats ? '' : 'md:col-span-2'}>
                <FinancialStats financials={data.financials} />
              </div>
            )}
          </div>
        </MotionWidget>

        {/* Row 5: Revenue Trend (full width) */}
        {showRevenue && (
          <MotionWidget delay={0.15}>
            <RevenueTrendChart data={revenue.data} loading={revenue.loading} />
          </MotionWidget>
        )}

        {/* Row 6: Lead Funnel + Lead Sources (2 col) */}
        <MotionWidget delay={0.18}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {showFunnel && <LeadFunnelChart data={funnel.data} loading={funnel.loading} />}
            {showSources ? <LeadSourcesChart data={sources.data} loading={sources.loading} /> : showTasks && <TaskCompletionChart data={tasks.data} loading={tasks.loading} />}
          </div>
        </MotionWidget>

        {/* Row 7: Response Time + Conversion Velocity (2 col) */}
        {(showResponse || showVelocity) && (
          <MotionWidget delay={0.22}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {showResponse && <ResponseTimeWidget data={responseTime.data} loading={responseTime.loading} />}
              {showVelocity && <ConversionVelocityWidget data={velocity.data} loading={velocity.loading} />}
            </div>
          </MotionWidget>
        )}

        {/* Row 8: Lead Pipeline (full width) */}
        {showPipeline && (
          <MotionWidget delay={0.25}>
            <LeadPipeline pipeline={data.leadPipeline} />
          </MotionWidget>
        )}

        {/* Row 9: Task Completion (se nao foi mostrado acima) */}
        {showTasks && showSources && (
          <MotionWidget delay={0.28}>
            <TaskCompletionChart data={tasks.data} loading={tasks.loading} />
          </MotionWidget>
        )}

        {/* Row 10: Legal Cases Pipeline (2 columns) */}
        {showCases && (
          <MotionWidget delay={0.3}>
            <LegalCasesPipeline legalCases={data.legalCases} trackingCases={data.trackingCases} />
          </MotionWidget>
        )}

        {/* Row 11: Case Duration + Financial Aging */}
        {(showCaseDuration || showAging) && (
          <MotionWidget delay={0.33}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {showCaseDuration && <CaseDurationChart data={caseDuration.data} loading={caseDuration.loading} />}
              {showAging && <FinancialAgingChart data={aging.data} loading={aging.loading} />}
            </div>
          </MotionWidget>
        )}

        {/* Row 12: AI Usage (admin) */}
        {showAi && (
          <MotionWidget delay={0.36}>
            <AiUsageChart data={aiUsage.data} loading={aiUsage.loading} />
          </MotionWidget>
        )}

        {/* Row 13: Team Performance (admin) — comparacoes agressivas */}
        {showTeam && (
          <MotionWidget delay={0.39}>
            <TeamPerformanceBoard data={teamPerf.data} loading={teamPerf.loading} />
          </MotionWidget>
        )}

        {/* Row 14: Events + DJEN (2 columns) */}
        <MotionWidget delay={0.42}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {showEvents && <UpcomingEvents events={data.upcomingEvents} />}
            {showDjen && <DjenPublications items={data.recentDjen} />}
          </div>
        </MotionWidget>

        {/* Row 15: Quick Actions */}
        <MotionWidget delay={0.45}>
          <QuickActions roleInfo={roleInfo} />
        </MotionWidget>

        {/* Row 16: Equipe Online (ADMIN only) */}
        {isAdmin && (
          <MotionWidget delay={0.5}>
            <TeamOnline />
          </MotionWidget>
        )}
      </div>
    </div>
  );
}
