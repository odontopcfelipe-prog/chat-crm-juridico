import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ChatGateway } from '../gateway/chat.gateway';

/**
 * Cron na API para emitir socket events de tarefas/eventos em tempo real.
 * Verifica AMBOS os modelos:
 * - Task (tarefas standalone com due_at)
 * - CalendarEvent (eventos tipo TAREFA/PRAZO com start_at)
 */
@Injectable()
export class TaskAlertCronService {
  private readonly logger = new Logger(TaskAlertCronService.name);

  constructor(
    private prisma: PrismaService,
    private chatGateway: ChatGateway,
  ) {}

  /**
   * A cada 5 min: verifica tarefas/eventos vencendo nos próximos 15 min
   */
  @Cron('*/5 * * * *')
  async emitDueSoonAlerts() {
    try {
      const now = new Date();
      const fifteenMinFromNow = new Date(now.getTime() + 15 * 60 * 1000);

      // 1. Tasks com due_at prestes a vencer
      const tasksDueSoon = await this.prisma.task.findMany({
        where: {
          status: { in: ['A_FAZER', 'EM_PROGRESSO'] },
          due_at: { gte: now, lte: fifteenMinFromNow },
          assigned_user_id: { not: null },
        },
        select: {
          id: true, title: true, due_at: true, assigned_user_id: true,
          lead: { select: { name: true } },
          legal_case: { select: { case_number: true } },
        },
      });

      // 2. CalendarEvents (TAREFA, PRAZO) com start_at prestes a vencer
      const eventsDueSoon = await this.prisma.calendarEvent.findMany({
        where: {
          type: { in: ['TAREFA', 'PRAZO'] },
          status: { in: ['AGENDADO', 'CONFIRMADO'] },
          start_at: { gte: now, lte: fifteenMinFromNow },
          assigned_user_id: { not: null },
        },
        select: {
          id: true, title: true, start_at: true, type: true, assigned_user_id: true,
          lead: { select: { name: true } },
          legal_case: { select: { case_number: true } },
        },
      });

      const total = tasksDueSoon.length + eventsDueSoon.length;
      if (total > 0) {
        this.logger.log(`[TASK-PUSH] ${total} alerta(s) due soon (${tasksDueSoon.length} tasks + ${eventsDueSoon.length} events)`);
      }

      // Emitir para Tasks
      for (const task of tasksDueSoon) {
        const mins = Math.round((new Date(task.due_at!).getTime() - now.getTime()) / 60000);
        this.emitAlert(task.assigned_user_id!, {
          taskId: task.id,
          title: task.title,
          level: mins <= 5 ? 'critical' : 'urgent',
          message: `Vence em ${mins} min`,
          client: task.lead?.name || null,
          caseNumber: task.legal_case?.case_number || null,
        });
      }

      // Emitir para CalendarEvents
      for (const evt of eventsDueSoon) {
        const mins = Math.round((new Date(evt.start_at).getTime() - now.getTime()) / 60000);
        const emoji = evt.type === 'PRAZO' ? '⏰' : '✅';
        this.emitAlert(evt.assigned_user_id!, {
          taskId: evt.id,
          title: `${emoji} ${evt.title}`,
          level: mins <= 5 ? 'critical' : 'urgent',
          message: `Vence em ${mins} min`,
          client: evt.lead?.name || null,
          caseNumber: evt.legal_case?.case_number || null,
        });
      }
    } catch (e: any) {
      this.logger.warn(`[TASK-PUSH] Erro due soon: ${e.message}`);
    }
  }

  /**
   * A cada 30 min: verifica tarefas/eventos JÁ vencidos
   */
  @Cron('*/30 * * * *')
  async emitOverdueAlerts() {
    try {
      const now = new Date();

      // 1. Tasks vencidas
      const overdueTasks = await this.prisma.task.findMany({
        where: {
          status: { in: ['A_FAZER', 'EM_PROGRESSO'] },
          due_at: { lt: now },
          assigned_user_id: { not: null },
        },
        select: { id: true, title: true, due_at: true, assigned_user_id: true },
        take: 30,
      });

      // 2. CalendarEvents vencidos
      const overdueEvents = await this.prisma.calendarEvent.findMany({
        where: {
          type: { in: ['TAREFA', 'PRAZO'] },
          status: { in: ['AGENDADO', 'CONFIRMADO'] },
          start_at: { lt: now },
          assigned_user_id: { not: null },
        },
        select: { id: true, title: true, start_at: true, type: true, assigned_user_id: true },
        take: 30,
      });

      const total = overdueTasks.length + overdueEvents.length;
      if (total > 0) {
        this.logger.log(`[TASK-PUSH] ${total} alerta(s) overdue (${overdueTasks.length} tasks + ${overdueEvents.length} events)`);
      }

      // Agrupar por usuário
      const byUser = new Map<string, Array<{ id: string; title: string; date: Date }>>();

      for (const t of overdueTasks) {
        if (!t.assigned_user_id) continue;
        if (!byUser.has(t.assigned_user_id)) byUser.set(t.assigned_user_id, []);
        byUser.get(t.assigned_user_id)!.push({ id: t.id, title: t.title, date: t.due_at! });
      }

      for (const e of overdueEvents) {
        if (!e.assigned_user_id) continue;
        const emoji = e.type === 'PRAZO' ? '⏰' : '✅';
        if (!byUser.has(e.assigned_user_id)) byUser.set(e.assigned_user_id, []);
        byUser.get(e.assigned_user_id)!.push({ id: e.id, title: `${emoji} ${e.title}`, date: e.start_at });
      }

      for (const [userId, items] of byUser.entries()) {
        // Emitir um ÚNICO batch com todas as tarefas vencidas (não individual)
        const topItems = items.slice(0, 5).map(item => {
          const hoursAgo = Math.round((now.getTime() - item.date.getTime()) / 3600000);
          return {
            taskId: item.id,
            title: item.title,
            level: hoursAgo >= 24 ? 'critical' as const : 'urgent' as const,
            message: hoursAgo >= 24 ? `${Math.round(hoursAgo / 24)}d de atraso` : `${hoursAgo}h de atraso`,
          };
        });

        // Emitir batch único ao invés de múltiplos eventos
        this.chatGateway.server
          .to(`user:${userId}`)
          .emit('task_overdue_batch', { items: topItems, total: items.length });
      }
    } catch (e: any) {
      this.logger.warn(`[TASK-PUSH] Erro overdue: ${e.message}`);
    }
  }

  private emitAlert(userId: string, data: any) {
    try {
      this.chatGateway.server
        .to(`user:${userId}`)
        .emit('task_overdue_alert', data);
    } catch {}
  }
}
