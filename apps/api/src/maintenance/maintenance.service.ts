import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { logCtx, fmtError } from '../common/logger/structured-logger';

/**
 * MaintenanceService — gestao de tasks de manutencao/recall (Fase 25 Onda 5).
 *
 * 3 origens de criacao:
 *   1. AUTO via EstheticApplication.expected_revisit_at (chamado pelo
 *      EstheticApplicationsService apos criar aplicacao)
 *   2. AUTO via TreatmentPlanItem ao virar DONE (chamado pelo TreatmentPlansService)
 *   3. MANUAL pelo operador via UI (POST /maintenance-tasks)
 *
 * Worker BullMQ (cron diario) processa tasks com due_date proxima e
 * envia WhatsApp lembrete pra paciente.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(private prisma: PrismaService) {}

  // ─── Criacao automatica ──────────────────────────────────────────

  /**
   * Cria task de manutencao a partir de EstheticApplication recem-criada.
   * Idempotente — se ja existe task pra essa application, retorna a existente.
   */
  async createFromEstheticApplication(params: {
    tenantId: string;
    patientId: string;
    estheticApplicationId: string;
    procedureId: string | null;
    procedureName?: string | null;
    expectedRevisitAt: Date;
    createdByUserId?: string;
  }) {
    // Idempotencia: evita duplicar se reprocessar
    const existing = await this.prisma.maintenanceTask.findFirst({
      where: { esthetic_application_id: params.estheticApplicationId },
    });
    if (existing) return existing;

    const title = `Revisão de ${params.procedureName || 'aplicação estética'}`;
    const task = await this.prisma.maintenanceTask.create({
      data: {
        tenant_id: params.tenantId,
        patient_id: params.patientId,
        procedure_id: params.procedureId,
        esthetic_application_id: params.estheticApplicationId,
        due_date: params.expectedRevisitAt,
        title,
        created_by_user_id: params.createdByUserId || null,
      },
    });
    await this.createReturnAlertForRecall({
      tenantId: params.tenantId,
      patientId: params.patientId,
      scheduledFor: params.expectedRevisitAt,
      reason: title,
      professionalUserId: params.createdByUserId,
    });
    return task;
  }

  /**
   * Cria task a partir de TreatmentPlanItem DONE.
   * Calcula due_date = executed_at + procedure.default_revisit_months.
   * No-op se procedure nao tem default_revisit_months.
   */
  async createFromTreatmentPlanItem(params: {
    tenantId: string;
    patientId: string;
    treatmentPlanItemId: string;
    procedureId: string;
    procedureName?: string;
    defaultRevisitMonths: number | null;
    executedAt: Date;
    createdByUserId?: string;
  }) {
    if (!params.defaultRevisitMonths || params.defaultRevisitMonths <= 0) {
      return null; // procedure sem revisita configurada — nada a fazer
    }

    const existing = await this.prisma.maintenanceTask.findFirst({
      where: { treatment_plan_item_id: params.treatmentPlanItemId },
    });
    if (existing) return existing;

    const dueDate = new Date(params.executedAt);
    dueDate.setMonth(dueDate.getMonth() + params.defaultRevisitMonths);

    const title = `Revisão de ${params.procedureName || 'procedimento'}`;
    const task = await this.prisma.maintenanceTask.create({
      data: {
        tenant_id: params.tenantId,
        patient_id: params.patientId,
        procedure_id: params.procedureId,
        treatment_plan_item_id: params.treatmentPlanItemId,
        due_date: dueDate,
        title,
        created_by_user_id: params.createdByUserId || null,
      },
    });
    // NÃO espelha ReturnAlert aqui: este recall é POR PROCEDIMENTO (ex.: fez uma
    // limpeza no meio do tratamento) — colocava paciente AINDA EM TRATAMENTO na
    // fila "Retornos pendentes" da recepção. A recepção só quer quem CONCLUIU o
    // tratamento (isso é o createFromPlanCompletion). A MaintenanceTask continua,
    // então o motor de recall (WhatsApp da revisão) segue funcionando.
    return task;
  }

  /**
   * Retorno PÓS-TRATAMENTO: quando o plano é concluído (último procedimento feito
   * OU botão "Concluir tratamento"), cria UM recall de N meses (default 6) — aparece
   * na tela "Retornos pendentes" da recepção (via ReturnAlert espelho) E entra no
   * motor de recall (WhatsApp perto da data). IDEMPOTENTE por plano: marca o plano no
   * `notes` (`[plan:{id}]`) e não duplica se o gatilho rodar 2x (item + botão).
   */
  async createFromPlanCompletion(params: {
    tenantId: string;
    patientId: string;
    treatmentPlanId: string;
    months?: number;
    completedAt?: Date;
    createdByUserId?: string;
  }) {
    const months = params.months && params.months > 0 ? params.months : 6;
    const marker = `[plan:${params.treatmentPlanId}]`;
    const existing = await this.prisma.maintenanceTask.findFirst({
      where: { tenant_id: params.tenantId, notes: { contains: marker } },
    });
    if (existing) return existing; // já há retorno pós-tratamento pra este plano

    const dueDate = new Date(params.completedAt || new Date());
    dueDate.setMonth(dueDate.getMonth() + months);

    // Título curto: aparece no "Motivo" da recepção E no {procedimento} da mensagem
    // de recall ("sua revisão de {título}"). A data (6 meses à frente) já é mostrada
    // nos dois lugares, então não repito "(6 meses)" no texto.
    const title = 'Retorno pós-tratamento';
    const task = await this.prisma.maintenanceTask.create({
      data: {
        tenant_id: params.tenantId,
        patient_id: params.patientId,
        due_date: dueDate,
        title,
        notes: marker,
        created_by_user_id: params.createdByUserId || null,
      },
    });
    await this.createReturnAlertForRecall({
      tenantId: params.tenantId,
      patientId: params.patientId,
      scheduledFor: dueDate,
      reason: title,
      professionalUserId: params.createdByUserId,
    });
    return task;
  }

  /**
   * Onda 18 — espelha um recall como ReturnAlert pra ele aparecer na tela
   * "Retornos pendentes" da recepcao (a lista que ja existe). scheduled_for =
   * data do recall: entra em "Agora" quando vence e fica em "Todos" desde ja.
   * Best-effort — nao derruba a criacao da task se falhar.
   */
  private async createReturnAlertForRecall(p: {
    tenantId: string;
    patientId: string;
    scheduledFor: Date;
    reason: string;
    professionalUserId?: string | null;
  }): Promise<void> {
    try {
      await this.prisma.returnAlert.create({
        data: {
          tenant_id: p.tenantId,
          patient_id: p.patientId,
          professional_user_id: p.professionalUserId || null,
          scheduled_for: p.scheduledFor,
          reason: p.reason,
        },
      });
    } catch (e: any) {
      this.logger.warn(`[RECALL->RETORNO] Falha ao criar ReturnAlert: ${e?.message}`);
    }
  }

  // ─── CRUD manual ─────────────────────────────────────────────────

  async createManual(
    tenantId: string,
    userId: string,
    dto: {
      patient_id: string;
      title: string;
      due_date: string;
      procedure_id?: string;
      notes?: string;
    },
  ) {
    const dueDate = new Date(dto.due_date);
    const task = await this.prisma.maintenanceTask.create({
      data: {
        tenant_id: tenantId,
        patient_id: dto.patient_id,
        procedure_id: dto.procedure_id || null,
        due_date: dueDate,
        title: dto.title,
        notes: dto.notes || null,
        created_by_user_id: userId,
      },
    });
    // Onda 18 — manutenção manual também espelha em "Retornos pendentes".
    await this.createReturnAlertForRecall({
      tenantId,
      patientId: dto.patient_id,
      scheduledFor: dueDate,
      reason: dto.title,
      professionalUserId: userId,
    });
    return task;
  }

  /**
   * Lista tasks do paciente (todas, mais recentes primeiro).
   * UI tab Manutencoes do paciente.
   */
  async listByPatient(patientId: string, tenantId: string) {
    return this.prisma.maintenanceTask.findMany({
      where: { patient_id: patientId, tenant_id: tenantId },
      orderBy: [{ status: 'asc' }, { due_date: 'asc' }],
      include: {
        procedure: { select: { id: true, name: true } },
        esthetic_application: {
          select: {
            id: true,
            applied_at: true,
            product_name_snapshot: true,
            application_point: true,
          },
        },
        treatment_plan_item: { select: { id: true } },
        scheduled_event: { select: { id: true, title: true, start_at: true } },
        completed_by: { select: { id: true, name: true } },
      },
    });
  }

  /**
   * Lista tasks atrasadas/proximas do tenant.
   * Pra dashboard widget "revisitas atrasadas".
   *
   * @param overdueOnly se true, so atrasadas (due_date < now); senao, atrasadas + proximas 30d
   */
  async listOverdueOrUpcoming(tenantId: string, overdueOnly = false) {
    const now = new Date();
    const in30days = new Date();
    in30days.setDate(in30days.getDate() + 30);

    return this.prisma.maintenanceTask.findMany({
      where: {
        tenant_id: tenantId,
        status: { in: ['PENDING', 'SCHEDULED'] },
        due_date: overdueOnly
          ? { lt: now }
          : { lte: in30days },
      },
      orderBy: { due_date: 'asc' },
      take: 50,
      include: {
        patient: { select: { id: true, name: true, phone: true, avatar_url: true } },
        procedure: { select: { id: true, name: true } },
      },
    });
  }

  async update(
    id: string,
    tenantId: string,
    userId: string,
    dto: {
      status?: string;
      due_date?: string;
      title?: string;
      notes?: string;
      scheduled_event_id?: string | null;
    },
  ) {
    const task = await this.prisma.maintenanceTask.findFirst({
      where: { id, tenant_id: tenantId },
    });
    if (!task) throw new NotFoundException('Task de manutencao nao encontrada');

    const data: any = { ...dto };
    if (dto.due_date) data.due_date = new Date(dto.due_date);

    // Se mudou status pra DONE, registra completed_at + completed_by
    if (dto.status === 'DONE' && task.status !== 'DONE') {
      data.completed_at = new Date();
      data.completed_by_user_id = userId;
    }
    // Se status saiu de DONE pra outro, limpa completed_*
    if (dto.status && dto.status !== 'DONE' && task.status === 'DONE') {
      data.completed_at = null;
      data.completed_by_user_id = null;
    }

    return this.prisma.maintenanceTask.update({ where: { id }, data });
  }

  async remove(id: string, tenantId: string) {
    const task = await this.prisma.maintenanceTask.findFirst({
      where: { id, tenant_id: tenantId },
    });
    if (!task) throw new NotFoundException('Task de manutencao nao encontrada');
    await this.prisma.maintenanceTask.delete({ where: { id } });
    return { ok: true };
  }
}
