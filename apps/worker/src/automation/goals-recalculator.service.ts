import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@crm/shared';

/**
 * Cron horario que recalcula current_value + projected_value de todas
 * as Goals ativas e em vigor. Implementa as 5 metricas suportadas
 * (mesma logica do GoalsService.recalculate no API).
 *
 * Roda a cada hora cheia. Para cada tenant com pelo menos 1 goal ativa,
 * itera e atualiza individualmente. Best-effort — se uma falhar, segue.
 */
@Injectable()
export class GoalsRecalculatorService {
  private readonly logger = new Logger(GoalsRecalculatorService.name);

  constructor(private prisma: PrismaService) {}

  @Cron('0 * * * *', { timeZone: 'America/Maceio' })
  async recalculateAllActive() {
    try {
      const now = new Date();
      const goals = await this.prisma.goal.findMany({
        where: {
          active: true,
          period_start: { lte: now },
          period_end: { gte: now },
        },
      });

      if (goals.length === 0) return;

      let ok = 0;
      let failed = 0;

      for (const g of goals) {
        try {
          await this.recalculateOne(g);
          ok++;
        } catch (e: any) {
          this.logger.warn(`Goal ${g.id} (${g.metric}) falhou: ${e.message}`);
          failed++;
        }
      }

      this.logger.log(`[GoalsRecalculator] ${ok}/${goals.length} recalculadas (${failed} falhas)`);
    } catch (e: any) {
      this.logger.error(`[GoalsRecalculator] Erro: ${e.message}`);
    }
  }

  private async recalculateOne(g: any) {
    const now = new Date();
    const start = new Date(g.period_start);
    const end = new Date(g.period_end);
    const isProfessional = g.scope === 'PROFESSIONAL' && g.professional_user_id;

    let current = 0;

    switch (g.metric) {
      case 'SALES_VALUE': {
        const quotes = await this.prisma.quote.findMany({
          where: {
            patient: { tenant_id: g.tenant_id },
            status: 'ACCEPTED',
            accepted_at: { gte: start, lte: end },
            ...(isProfessional ? { created_by_user_id: g.professional_user_id } : {}),
          },
          select: { total_value: true },
        });
        current = quotes.reduce((sum: number, q: any) => sum + Number(q.total_value), 0);
        break;
      }
      case 'FIRST_CONSULTATIONS':
        current = await this.prisma.patient.count({
          where: {
            tenant_id: g.tenant_id,
            first_visit_at: { gte: start, lte: end },
            ...(isProfessional ? { primary_dentist_id: g.professional_user_id } : {}),
          },
        });
        break;
      case 'NEW_PATIENTS':
        current = await this.prisma.patient.count({
          where: {
            tenant_id: g.tenant_id,
            created_at: { gte: start, lte: end },
            ...(isProfessional ? { primary_dentist_id: g.professional_user_id } : {}),
          },
        });
        break;
      case 'MISSES_PCT': {
        const total = await this.prisma.calendarEvent.count({
          where: {
            tenant_id: g.tenant_id,
            start_at: { gte: start, lte: end },
            type: 'CONSULTA',
            ...(isProfessional ? { assigned_user_id: g.professional_user_id } : {}),
          },
        });
        const cancelled = total === 0 ? 0 : await this.prisma.calendarEvent.count({
          where: {
            tenant_id: g.tenant_id,
            start_at: { gte: start, lte: end },
            type: 'CONSULTA',
            status: 'CANCELADO',
            ...(isProfessional ? { assigned_user_id: g.professional_user_id } : {}),
          },
        });
        current = total === 0 ? 0 : (cancelled / total) * 100;
        break;
      }
      case 'CONVERSIONS': {
        const sent = await this.prisma.quote.count({
          where: {
            patient: { tenant_id: g.tenant_id },
            sent_at: { gte: start, lte: end },
          },
        });
        const accepted = sent === 0 ? 0 : await this.prisma.quote.count({
          where: {
            patient: { tenant_id: g.tenant_id },
            sent_at: { gte: start, lte: end },
            status: 'ACCEPTED',
          },
        });
        current = sent === 0 ? 0 : (accepted / sent) * 100;
        break;
      }
      default:
        return;
    }

    const totalMs = end.getTime() - start.getTime();
    const elapsedMs = Math.max(1, Math.min(totalMs, now.getTime() - start.getTime()));
    const projected = current * (totalMs / elapsedMs);

    await this.prisma.goal.update({
      where: { id: g.id },
      data: {
        current_value: new Prisma.Decimal(current.toFixed(2)),
        projected_value: new Prisma.Decimal(projected.toFixed(2)),
        last_calculated_at: now,
      },
    });
  }
}
