import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import axios from 'axios';

/**
 * Worker cron para alertas de tarefas:
 * 1. A cada 10 min: verifica tarefas vencendo nos próximos 30 min → WhatsApp + Socket
 * 2. 8h e 14h Seg-Sex: verifica tarefas vencidas → WhatsApp de alerta
 */
@Injectable()
export class TaskAlertsCronService {
  private readonly logger = new Logger(TaskAlertsCronService.name);

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
  ) {}

  // ─── A cada 10 min: tarefas prestes a vencer (próximos 30 min) ────────

  @Cron('*/10 * * * *', { timeZone: 'America/Maceio' })
  async checkDueSoon() {
    try {
      const now = new Date();
      const thirtyMinFromNow = new Date(now.getTime() + 30 * 60 * 1000);

      // 1. Tasks com due_at
      const tasksDueSoon = await this.prisma.task.findMany({
        where: {
          status: { in: ['A_FAZER', 'EM_PROGRESSO'] },
          due_at: { gte: now, lte: thirtyMinFromNow },
        },
        include: {
          assigned_user: { select: { id: true, name: true, phone: true } },
          lead: { select: { name: true } },
        },
      });

      // 2. CalendarEvents (TAREFA/PRAZO) com start_at
      const eventsDueSoon = await this.prisma.calendarEvent.findMany({
        where: {
          type: { in: ['TAREFA', 'PRAZO'] },
          status: { in: ['AGENDADO', 'CONFIRMADO'] },
          start_at: { gte: now, lte: thirtyMinFromNow },
        },
        include: {
          assigned_user: { select: { id: true, name: true, phone: true } },
          lead: { select: { name: true } },
        },
      });

      // Unificar em lista comum (tenant_id vem nos escalares — include, não select)
      const dueSoon: Array<{ id: string; title: string; dueAt: Date; user: any; lead: any; legalCase: any; tenantId: string | null }> = [
        ...tasksDueSoon.map(t => ({ id: t.id, title: t.title, dueAt: t.due_at!, user: t.assigned_user, lead: t.lead, legalCase: null, tenantId: (t as any).tenant_id ?? null })),
        ...eventsDueSoon.map(e => ({ id: e.id, title: e.title, dueAt: e.start_at, user: e.assigned_user, lead: e.lead, legalCase: null, tenantId: (e as any).tenant_id ?? null })),
      ];

      if (dueSoon.length === 0) return;

      this.logger.log(`[TASK-ALERTS] ${dueSoon.length} tarefa(s)/evento(s) vencendo em 30 min`);

      const enabledCache = new Map<string, boolean>();
      for (const task of dueSoon) {
        if (!task.user?.phone) continue;

        // Toggle da Central (card "Alertas de tarefa" · Equipe). Default LIGADO.
        const tid = task.tenantId || '';
        if (!enabledCache.has(tid)) enabledCache.set(tid, await this.isEnabled(tid));
        if (!enabledCache.get(tid)) continue;

        const alreadySent = await this.wasAlertSentRecently(task.id, 'TASK_DUE_SOON', 2);
        if (alreadySent) continue;

        const dueTime = task.dueAt.toLocaleTimeString('pt-BR', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' });
        const firstName = task.user.name.split(' ')[0];

        const msg =
          `⏰ *Tarefa vencendo em breve!*\n\n` +
          `Olá, ${firstName}!\n\n` +
          `📋 *${task.title}*\n` +
          `⏰ Vence às *${dueTime}*\n` +
          (task.lead?.name ? `👤 Cliente: ${task.lead.name}\n` : '') +
          (task.legalCase?.case_number ? `📁 Processo: ${task.legalCase.case_number}\n` : '') +
          `\nAcesse o sistema para atualizar o status.\n\n` +
          `_Alerta automático do CRM_`;

        await this.sendWhatsApp(task.user.phone, msg);
        await this.logAlert(task.id, 'TASK_DUE_SOON', task.user.id, task.tenantId, task.user.name, task.user.phone);
        this.logger.log(`[TASK-ALERTS] Lembrete enviado para ${task.user.name} — tarefa: ${task.title}`);
      }
    } catch (e: any) {
      this.logger.error(`[TASK-ALERTS] Erro no check due soon: ${e.message}`);
    }
  }

  // ─── 8h e 14h Seg-Sex: tarefas vencidas ─────────────────────────────

  @Cron('0 8,14 * * 1-6', { timeZone: 'America/Maceio' })
  async checkOverdue() {
    try {
      const now = new Date();

      // 1. Tasks vencidas
      const overdueTasks = await this.prisma.task.findMany({
        where: {
          status: { in: ['A_FAZER', 'EM_PROGRESSO'] },
          due_at: { lt: now },
        },
        include: {
          assigned_user: { select: { id: true, name: true, phone: true } },
          lead: { select: { name: true } },
        },
        orderBy: { due_at: 'asc' },
        take: 30,
      });

      // 2. CalendarEvents vencidos
      const overdueEvents = await this.prisma.calendarEvent.findMany({
        where: {
          type: { in: ['TAREFA', 'PRAZO'] },
          status: { in: ['AGENDADO', 'CONFIRMADO'] },
          start_at: { lt: now },
        },
        include: {
          assigned_user: { select: { id: true, name: true, phone: true } },
          lead: { select: { name: true } },
        },
        orderBy: { start_at: 'asc' },
        take: 30,
      });

      // Unificar (tenant_id vem nos escalares — include, não select)
      const overdue: Array<{ id: string; title: string; dueAt: Date; user: any; tenantId: string | null }> = [
        ...overdueTasks.map(t => ({ id: t.id, title: t.title, dueAt: t.due_at!, user: t.assigned_user, tenantId: (t as any).tenant_id ?? null })),
        ...overdueEvents.map(e => ({ id: e.id, title: e.title, dueAt: e.start_at, user: e.assigned_user, tenantId: (e as any).tenant_id ?? null })),
      ];

      if (overdue.length === 0) return;

      this.logger.log(`[TASK-ALERTS] ${overdue.length} tarefa(s)/evento(s) vencida(s)`);

      // Agrupar por usuário
      const byUser = new Map<string, { user: any; tenantId: string | null; items: typeof overdue }>();
      for (const item of overdue) {
        const userId = item.user?.id;
        if (!userId || !item.user?.phone) continue;
        if (!byUser.has(userId)) byUser.set(userId, { user: item.user, tenantId: item.tenantId, items: [] });
        byUser.get(userId)!.items.push(item);
      }

      const enabledCache = new Map<string, boolean>();
      for (const [userId, group] of byUser.entries()) {
        // Toggle da Central (card "Alertas de tarefa" · Equipe). Default LIGADO.
        const tid = group.tenantId || '';
        if (!enabledCache.has(tid)) enabledCache.set(tid, await this.isEnabled(tid));
        if (!enabledCache.get(tid)) continue;

        const alreadySent = await this.wasAlertSentRecently(userId, 'TASK_OVERDUE_BATCH', 6);
        if (alreadySent) continue;

        const { user, items } = group;
        const firstName = user.name.split(' ')[0];
        const count = items.length;

        const taskList = items.slice(0, 5).map((t, i) => {
          const hoursAgo = Math.round((now.getTime() - t.dueAt.getTime()) / 3600000);
          return `${i + 1}. *${t.title}* (${hoursAgo > 24 ? `${Math.round(hoursAgo / 24)}d` : `${hoursAgo}h`} atraso)`;
        }).join('\n');

        const msg =
          `🚨 *${count} Tarefa(s) Vencida(s)!*\n\n` +
          `Olá, ${firstName}!\n\n` +
          `Você tem tarefas pendentes que já passaram do prazo:\n\n` +
          `${taskList}` +
          (count > 5 ? `\n... e mais ${count - 5} tarefa(s)` : '') +
          `\n\nAcesse o sistema para atualizar.\n\n` +
          `_Alerta automático do CRM_`;

        await this.sendWhatsApp(user.phone, msg);
        await this.logAlert(userId, 'TASK_OVERDUE_BATCH', userId, group.tenantId, user.name, user.phone);
        this.logger.log(`[TASK-ALERTS] Alerta overdue enviado para ${user.name} (${count} tarefas)`);
      }
    } catch (e: any) {
      this.logger.error(`[TASK-ALERTS] Erro no check overdue: ${e.message}`);
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private async sendWhatsApp(phone: string, text: string): Promise<void> {
    try {
      const { apiUrl, apiKey } = await this.settings.getEvolutionConfig();
      if (!apiUrl) return;
      const instance = process.env.EVOLUTION_INSTANCE_NAME || 'whatsapp';
      const cleanPhone = phone.replace(/\D/g, '');
      await axios.post(
        `${apiUrl}/message/sendText/${instance}`,
        { number: cleanPhone, text },
        { headers: { apikey: apiKey }, timeout: 15000 },
      );
    } catch (e: any) {
      this.logger.warn(`[TASK-ALERTS] Falha WhatsApp para ${phone}: ${e.message}`);
    }
  }

  private async wasAlertSentRecently(referenceId: string, type: string, hoursAgo: number): Promise<boolean> {
    const cutoff = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
    const existing = await this.prisma.auditLog.findFirst({
      where: { entity: 'TASK_ALERT', entity_id: referenceId, action: type, created_at: { gte: cutoff } },
    });
    return !!existing;
  }

  /** Toggle da Central: TASK_ALERTS_ENABLED_<tenant>. Default LIGADO (o motor
   *  sempre rodou; é aviso interno à equipe) — só 'false' desliga. */
  private async isEnabled(tenantId: string): Promise<boolean> {
    if (!tenantId) return true;
    try {
      const row = await this.prisma.globalSetting.findUnique({
        where: { key: `TASK_ALERTS_ENABLED_${tenantId}` },
      });
      return (row?.value ?? 'true') !== 'false';
    } catch {
      return true;
    }
  }

  private async logAlert(
    referenceId: string,
    type: string,
    userId: string,
    tenantId?: string | null,
    recipientName?: string | null,
    recipientPhone?: string | null,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: { entity: 'TASK_ALERT', entity_id: referenceId, action: type, meta_json: { user_id: userId, sent_at: new Date().toISOString() } },
      });
    } catch {}
    // Central 2.0 — registro unificado (métrica + resumo do card "Alertas de tarefa").
    try {
      await this.prisma.dispatchLog.create({
        data: {
          tenant_id: tenantId || '',
          type: 'task_alert',
          channel: 'WHATSAPP',
          recipient_name: recipientName || null,
          recipient_phone: recipientPhone || null,
          status: 'SENT',
          ref_user_id: userId,
          sent_at: new Date(),
        },
      });
    } catch (e: any) {
      this.logger.warn(`[DISPATCH-LOG] task_alert não registrou: ${e?.message}`);
    }
  }
}
