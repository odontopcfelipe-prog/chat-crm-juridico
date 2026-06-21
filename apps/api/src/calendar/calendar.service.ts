import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger, Inject, forwardRef } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { ChatGateway } from '../gateway/chat.gateway';
import { isAdmin, canViewAllAgenda } from '../common/utils/permissions.util';
import { WaitlistService } from '../waitlist/waitlist.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { EmailAutomationService } from '../email-automation/email-automation.service';
// Type-only import pra evitar circular runtime dep CalendarModule <-> LeadsModule.
// Resolvido via moduleRef.get em runtime.
import type { LeadsService } from '../leads/leads.service';

// Tipos de evento da clinica odontologica.
// AUDIENCIA/PERICIA/PRAZO mantidos por compat com dados antigos do CRM
// juridico (eventos legados ainda existem no banco e precisam editar/deletar).
const EVENT_TYPES = [
  'CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'BLOQUEIO', 'TAREFA', 'OUTRO',
  'AUDIENCIA', 'PERICIA', 'PRAZO',
] as const;
const EVENT_STATUSES = ['AGENDADO', 'CONFIRMADO', 'CONCLUIDO', 'CANCELADO', 'ADIADO'] as const;

@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);

  constructor(
    private prisma: PrismaService,
    private chatGateway: ChatGateway,
    @InjectQueue('calendar-reminders') private reminderQueue: Queue,
    @Inject(forwardRef(() => WaitlistService)) private waitlist: WaitlistService,
    @Inject(forwardRef(() => WhatsappService)) private whatsapp: WhatsappService,
    // Onda 17.32.181 — e-mails automaticos (modulo @Global)
    private emailAutomation: EmailAutomationService,
    private moduleRef: ModuleRef,
  ) {}

  /**
   * Auto-conversao Lead → Patient quando paciente "entra em tratamento"
   * (Onda 5e v32, Fase 25).
   *
   * Chamado quando um evento clinico e validado ou marcado como CONCLUIDO.
   * Se o lead vinculado ainda nao tem Patient cadastrado, cria automaticamente
   * via LeadsService.ensurePatient (idempotente — nao duplica).
   *
   * Best-effort: erros sao logados mas nao bloqueiam a validacao do evento.
   * Carrega LeadsService dinamicamente via ModuleRef pra evitar circular dep
   * entre CalendarModule e LeadsModule.
   */
  private async autoEnsurePatientFromEvent(eventId: string): Promise<void> {
    try {
      const event = await this.prisma.calendarEvent.findUnique({
        where: { id: eventId },
        select: {
          lead_id: true,
          patient_id: true,
          tenant_id: true,
          type: true,
        },
      });
      if (!event?.lead_id || event.patient_id) return; // ja tem patient ou nao tem lead
      if (!this.isClinicalEvent(event.type)) return;

      // Carrega LeadsService dinamicamente (sem injecao direta pra evitar
      // circular dependency CalendarModule <-> LeadsModule).
      // moduleRef.get com strict:false busca em todo o app, fora do escopo
      // do CalendarModule. Usa require pra runtime (type-only import nao
      // existe em runtime).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { LeadsService: LeadsServiceClass } = require('../leads/leads.service');
      const leadsService = this.moduleRef.get<LeadsService>(LeadsServiceClass, { strict: false });
      if (!leadsService || typeof leadsService.ensurePatient !== 'function') {
        this.logger.warn(`[AUTO_PATIENT] LeadsService indisponivel pra evento ${eventId}`);
        return;
      }

      await leadsService.ensurePatient(event.lead_id, event.tenant_id ?? undefined);
      this.logger.log(`[AUTO_PATIENT] Lead ${event.lead_id} virou Patient apos evento ${eventId} validado/concluido`);
    } catch (e: any) {
      // Swallow — patient creation falhou mas validacao do evento ja foi
      this.logger.warn(`[AUTO_PATIENT] Falhou pra evento ${eventId}: ${e?.message}`);
    }
  }

  // ─── CRUD Events ──────────────────────────────────────

  async findAll(query: {
    start?: string;
    end?: string;
    type?: string;
    userId?: string;
    leadId?: string;
    tenantId?: string;
    search?: string;
  }) {
    const where: any = {};

    if (query.tenantId) {
      where.OR = [{ tenant_id: query.tenantId }, { tenant_id: null }];
    }
    if (query.type) where.type = query.type;
    if (query.leadId) where.lead_id = query.leadId;

    // Filtrar por userId:
    // - Se o evento TEM um responsável (assigned_user_id preenchido), apenas ele vê.
    // - Se o evento NÃO TEM responsável, o criador (created_by_id) vê.
    // Isso garante que ao trocar o advogado, o antigo para de ver o evento.
    if (query.userId) {
      if (!where.AND) where.AND = [];
      where.AND.push({
        OR: [
          { assigned_user_id: query.userId },
          { assigned_user_id: null, created_by_id: query.userId },
        ],
      });
    }

    if (query.search) {
      if (!where.AND) where.AND = [];
      where.AND.push({
        OR: [
          { title: { contains: query.search, mode: 'insensitive' } },
          { description: { contains: query.search, mode: 'insensitive' } },
        ],
      });
    }

    if (query.start || query.end) {
      // Schedule-x pode enviar datas em vários formatos:
      // - "2026-03-09T07:00:00+00:00[UTC]" → remover sufixo IANA
      // - "2026-03-09 00:00" → converter espaço para T
      // - "2026-03-09" → date-only
      const parseDate = (s: string) => {
        const cleaned = s.replace(/\[.*?\]$/, '').trim();
        // Se é formato "YYYY-MM-DD HH:mm", converter para ISO
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(cleaned)) {
          return new Date(cleaned.replace(' ', 'T'));
        }
        return new Date(cleaned);
      };
      // Overlap query: inclui eventos que começam antes do range mas terminam dentro dele
      // Evento visível se: start_at < rangeEnd AND (end_at > rangeStart OR end_at IS NULL AND start_at >= rangeStart)
      if (query.start && query.end) {
        const rangeStart = parseDate(query.start);
        const rangeEnd = parseDate(query.end);
        // Defensive: skip filter if dates are invalid
        if (isNaN(rangeStart.getTime()) || isNaN(rangeEnd.getTime())) {
          this.logger.warn(`[findAll] Invalid date range: start=${query.start}, end=${query.end}`);
        } else {
          where.start_at = { lt: rangeEnd };
          if (!where.AND) where.AND = [];
          where.AND.push({
            OR: [
              { end_at: { gt: rangeStart } },
              { end_at: null, start_at: { gte: rangeStart } },
            ],
          });
        }
      } else {
        where.start_at = {};
        if (query.start) where.start_at.gte = parseDate(query.start);
        if (query.end) where.start_at.lte = parseDate(query.end);
      }
    }

    return this.prisma.calendarEvent.findMany({
      where,
      include: {
        assigned_user: { select: { id: true, name: true } },
        created_by: { select: { id: true, name: true } },
        lead: { select: { id: true, name: true, phone: true } },
        // Paciente vinculado: exibido no card da agenda + botao "Abrir ficha"
        // no modal de edicao. Necessario tanto no findAll quanto no findOne
        // pra evitar fetch extra ao clicar no evento.
        patient: { select: { id: true, name: true, phone: true, avatar_url: true } },
        appointment_type: true,
        reminders: true,
        _count: { select: { comments: true } },
      },
      orderBy: { start_at: 'asc' },
    });
  }

  async findOne(id: string) {
    const event = await this.prisma.calendarEvent.findUnique({
      where: { id },
      include: {
        assigned_user: { select: { id: true, name: true } },
        created_by: { select: { id: true, name: true } },
        lead: { select: { id: true, name: true, phone: true } },
        // v32: patient pra UI mostrar nome quando paciente foi vinculado direto
        patient: { select: { id: true, name: true, phone: true, avatar_url: true } },
        appointment_type: true,
        reminders: true,
        _count: { select: { comments: true } },
      },
    });
    if (!event) throw new NotFoundException('Evento nao encontrado');
    return event;
  }

  async create(data: {
    type: string;
    title: string;
    description?: string;
    start_at: string;
    end_at?: string;
    all_day?: boolean;
    status?: string;
    priority?: string;
    color?: string;
    location?: string;
    lead_id?: string;
    patient_id?: string;
    conversation_id?: string;
    assigned_user_id?: string;
    created_by_id: string;
    appointment_type_id?: string;
    tenant_id?: string;
    reminders?: { minutes_before: number; channel?: string }[];
    recurrence_rule?: string;
    recurrence_end?: string;
    recurrence_days?: number[];
  }) {
    if (!EVENT_TYPES.includes(data.type as any)) {
      throw new BadRequestException(`Tipo invalido: ${data.type}. Use: ${EVENT_TYPES.join(', ')}`);
    }

    // Dentista responsavel OBRIGATORIO em eventos clinicos (Fase 23).
    // Eventos como BLOQUEIO/TAREFA/OUTRO podem nao ter dentista — sao usos
    // operacionais, nao atendimentos.
    if (this.isClinicalEvent(data.type) && !data.assigned_user_id) {
      throw new BadRequestException(
        `Dentista responsavel e obrigatorio para eventos do tipo ${data.type}. ` +
        `Selecione o profissional na hora de criar o agendamento.`,
      );
    }

    // STUBBED: LegalCase removido Fase 0.2 — lead_id deve vir direto
    let resolvedLeadId = data.lead_id;

    // Auto-resolve patient_id quando lead_id está setado mas patient_id não:
    // se o lead já foi convertido em Patient, vincula a consulta ao paciente
    // automaticamente. Habilita Timeline + Resumo Clínico (consultas count,
    // first/last visit) a refletir a realidade.
    let resolvedPatientId = data.patient_id;
    if (!resolvedPatientId && resolvedLeadId) {
      const linkedPatient = await this.prisma.patient.findUnique({
        where: { lead_id: resolvedLeadId },
        select: { id: true },
      });
      if (linkedPatient) resolvedPatientId = linkedPatient.id;
    }

    // v31: caminho INVERSO — quando operador escolhe paciente direto pela UI
    // (ContactPicker), patient_id vem mas lead_id pode vir null. Buscamos o
    // lead vinculado ao paciente pra preencher event.lead_id, garantindo que:
    //   - Lembretes via WhatsApp funcionam (worker usa event.lead.phone)
    //   - Aba Lembretes mostra nome do paciente (event.lead.name)
    //   - IA tem contexto completo da conversa
    if (resolvedPatientId && !resolvedLeadId) {
      const patient = await this.prisma.patient.findUnique({
        where: { id: resolvedPatientId },
        select: { lead_id: true },
      });
      if (patient?.lead_id) {
        resolvedLeadId = patient.lead_id;
      }
    }

    const event = await this.prisma.calendarEvent.create({
      data: {
        type: data.type,
        title: data.title,
        description: data.description,
        start_at: new Date(data.start_at),
        end_at: data.end_at ? new Date(data.end_at) : null,
        all_day: data.all_day ?? false,
        status: data.status ?? 'AGENDADO',
        priority: data.priority ?? 'NORMAL',
        color: data.color,
        location: data.location,
        lead_id: resolvedLeadId,
        patient_id: resolvedPatientId,
        conversation_id: data.conversation_id,
        assigned_user_id: data.assigned_user_id,
        created_by_id: data.created_by_id,
        appointment_type_id: data.appointment_type_id,
        tenant_id: data.tenant_id,
        recurrence_rule: data.recurrence_rule,
        recurrence_end: data.recurrence_end ? new Date(data.recurrence_end) : null,
        recurrence_days: data.recurrence_days ?? [],
        reminders: data.reminders?.length
          ? {
              create: data.reminders.map((r) => ({
                minutes_before: r.minutes_before,
                channel: r.channel ?? 'PUSH',
              })),
            }
          : undefined,
      },
      include: {
        assigned_user: { select: { id: true, name: true } },
        lead: { select: { id: true, name: true, phone: true } },
        reminders: true,
      },
    });

    // Atualiza datas de visita se já foi criado como CONFIRMADO/CONCLUIDO
    // (operador pode marcar direto sem passar por updateStatus)
    if (
      resolvedPatientId &&
      ['CONFIRMADO', 'CONCLUIDO'].includes(event.status) &&
      this.isClinicalEvent(event.type)
    ) {
      await this.updatePatientVisitDates(resolvedPatientId, event.start_at).catch(() => {});
    }

    // Notificar advogado atribuido via socket
    if (event.assigned_user_id) {
      try {
        this.chatGateway.emitCalendarUpdate(event.assigned_user_id, {
          eventId: event.id,
          action: 'created',
          title: event.title,
          type: event.type,
          start_at: event.start_at.toISOString(),
        });
      } catch {}
    }

    // Onda 17.32.181 — e-mail automatico "consulta agendada" pro
    // paciente (best-effort; so eventos clinicos com paciente/lead)
    if (data.tenant_id && this.isClinicalEvent(event.type)) {
      void this.sendAppointmentCreatedEmail(event, resolvedPatientId, resolvedLeadId, data.tenant_id);
      // Onda 17.59 — notificação imediata por WhatsApp "consulta agendada"
      // (espelha o e-mail; o WhatsApp imediato antes só existia pra audiência/perícia).
      void this.sendAppointmentCreatedWhatsapp(event, resolvedPatientId, resolvedLeadId, data.tenant_id);
    }

    // Enqueue WhatsApp + Email reminders
    await this.enqueueReminders(event.id, event.start_at, event.reminders || []);

    // STUBBED: LegalCase removido Fase 0.2 — leadPhone vem direto do lead
    const leadPhone: string | undefined = event.lead?.phone || undefined;

    // Notificação imediata ao cliente (1 min de delay) quando audiência ou perícia é agendada
    if ((data.type === 'AUDIENCIA' || data.type === 'PERICIA') && leadPhone) {
      try {
        await this.reminderQueue.add(
          'notify-hearing-scheduled',
          { eventId: event.id },
          {
            delay: 60_000, // 1 minuto — dá tempo ao operador de corrigir antes do envio
            jobId: `hearing-notify-${event.id}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: true,
            removeOnFail: 50,
          },
        );
        this.logger.log(`[NOTIFY] Notificação ${data.type} agendada ao cliente em 1 min (evento ${event.id}, lead: ${event.lead?.phone})`);
      } catch (e: any) {
        this.logger.error(`[NOTIFY] Erro ao enfileirar notificação ${data.type}: ${e.message}`);
      }
    }

    // Expand recurrence if rule set
    if (data.recurrence_rule) {
      await this.expandRecurrence(event);
    }

    return event;
  }

  private async enqueueReminders(eventId: string, startAt: Date, reminders: { id: string; minutes_before: number; channel: string }[]) {
    for (const r of reminders) {
      if (r.channel !== 'WHATSAPP' && r.channel !== 'EMAIL') continue; // PUSH handled by cron
      const triggerAt = startAt.getTime() - r.minutes_before * 60 * 1000;
      const delay = Math.max(triggerAt - Date.now(), 1000); // min 1s
      const jobId = `reminder-${r.id}`;
      try {
        // Remove job anterior (se existir) antes de enfileirar — garante idempotência em re-agendamentos
        try { const old = await this.reminderQueue.getJob(jobId); if (old) await old.remove(); } catch {}
        await this.reminderQueue.add('send-reminder', {
          reminderId: r.id,
          eventId,
          channel: r.channel,
        }, {
          delay,
          jobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: 50,
        });
        this.logger.log(`Lembrete ${r.id} enfileirado: canal=${r.channel}, delay=${Math.round(delay / 60000)}min`);
      } catch (e: any) {
        this.logger.error(`Erro ao enfileirar lembrete ${r.id}: ${e.message}`);
      }
    }
  }

  /** Remove todos os jobs de lembrete de um evento da fila BullMQ */
  private async cancelReminderJobs(eventId: string) {
    try {
      const reminders = await this.prisma.eventReminder.findMany({
        where: { event_id: eventId },
        select: { id: true },
      });
      for (const r of reminders) {
        try {
          const job = await this.reminderQueue.getJob(`reminder-${r.id}`);
          if (job) await job.remove();
        } catch {}
      }
    } catch (e: any) {
      this.logger.warn(`Erro ao cancelar jobs de lembrete do evento ${eventId}: ${e.message}`);
    }
  }

  async update(
    id: string,
    data: {
      title?: string;
      description?: string;
      start_at?: string;
      end_at?: string;
      all_day?: boolean;
      status?: string;
      priority?: string;
      color?: string;
      location?: string;
      type?: string;
      lead_id?: string | null;
      patient_id?: string | null;
      conversation_id?: string | null;
      assigned_user_id?: string | null;
      appointment_type_id?: string | null;
      // Onda 5e v20: campos extra que o frontend envia mas que NAO sao
      // colunas escalares do CalendarEvent. Tratados separadamente
      // (reminders precisa deleteMany+create, recurrence_* sao escalares).
      // channel optional pra casar com ReminderDto (default WHATSAPP).
      reminders?: { minutes_before: number; channel?: string }[];
      recurrence_rule?: string;
      recurrence_end?: string;
      recurrence_days?: number[];
    },
  ) {
    if (data.type && !EVENT_TYPES.includes(data.type as any)) {
      throw new BadRequestException(`Tipo invalido: ${data.type}`);
    }
    if (data.status && !EVENT_STATUSES.includes(data.status as any)) {
      throw new BadRequestException(`Status invalido: ${data.status}`);
    }

    // v20 fix: separa campos relacionais (reminders) dos escalares ANTES
    // de passar pro Prisma. Sem isso, prisma.update({ data: { reminders: [...] } })
    // dava 500 "Erro interno do servidor" porque reminders eh relacao, nao
    // campo escalar — Prisma exige sintaxe { deleteMany, create } pra arrays.
    const { reminders: incomingReminders, recurrence_end, ...rest } = data;
    const updateData: any = { ...rest };
    if (data.start_at) updateData.start_at = new Date(data.start_at);
    if (data.end_at) updateData.end_at = new Date(data.end_at);
    if (data.end_at === null) updateData.end_at = null;
    if (recurrence_end) updateData.recurrence_end = new Date(recurrence_end);
    if (recurrence_end === null) updateData.recurrence_end = null;

    // STUBBED: LegalCase removido Fase 0.2 — não há auto-preenchimento de lead a partir de processo

    // Carrega estado anterior para detectar mudanças relevantes na audiência
    const before = await this.prisma.calendarEvent.findUnique({
      where: { id },
      select: {
        type: true, start_at: true, location: true, lead_id: true,
        status: true, assigned_user_id: true, tenant_id: true,
        validated_at: true, validated_by_user_id: true, // pra checar lock pos-validacao
      },
    });

    // Bloqueia troca de dentista APOS validacao clinica (Fase 23).
    // Operador pode trocar dentista ate o atendimento ser validado pelo
    // proprio dentista. Depois disso, so admin pode reverter validacao
    // primeiro (POST /calendar/events/:id/unvalidate) e entao trocar.
    if (before?.validated_at && data.assigned_user_id !== undefined) {
      const novoUserId = data.assigned_user_id || null;
      if (novoUserId !== before.assigned_user_id) {
        throw new ForbiddenException(
          'Atendimento ja foi validado pelo dentista. Pra trocar o responsavel, ' +
          'um administrador precisa reverter a validacao primeiro.',
        );
      }
    }

    // Dentista responsavel obrigatorio em eventos clinicos. Aplica tanto se
    // o tipo esta sendo alterado quanto se o assigned_user_id ta sendo zerado.
    const finalType = (data.type || before?.type) as string | undefined;
    const finalAssignedUserId =
      data.assigned_user_id !== undefined ? data.assigned_user_id : before?.assigned_user_id;
    if (finalType && this.isClinicalEvent(finalType) && !finalAssignedUserId) {
      throw new BadRequestException(
        `Dentista responsavel e obrigatorio para eventos do tipo ${finalType}.`,
      );
    }

    const event = await this.prisma.calendarEvent.update({
      where: { id },
      data: updateData,
      include: {
        assigned_user: { select: { id: true, name: true } },
        lead: { select: { id: true, name: true, phone: true } },
        reminders: true,
      },
    });

    // v20: trata reminders separadamente — se frontend enviou novo array,
    // substitui completamente (deleteMany + createMany). Mantem comportamento
    // antigo se nao enviar (reminders existentes ficam intactos).
    let finalReminders = event.reminders;
    if (incomingReminders !== undefined) {
      // Cancela jobs antigos no BullMQ ANTES de deletar do banco
      await this.cancelReminderJobs(event.id);
      // Substitui no banco
      await this.prisma.eventReminder.deleteMany({ where: { event_id: event.id } });
      if (incomingReminders.length > 0) {
        await this.prisma.eventReminder.createMany({
          data: incomingReminders.map((r) => ({
            event_id: event.id,
            minutes_before: r.minutes_before,
            channel: r.channel ?? 'WHATSAPP',
          })),
        });
      }
      // Recarrega pra ter os IDs novos pra enqueue
      finalReminders = await this.prisma.eventReminder.findMany({ where: { event_id: event.id } });
      this.logger.log(`[update] reminders substituidos pro evento ${event.id} (${incomingReminders.length} novos)`);
    }

    // Se start_at mudou OU reminders foram alterados, re-enfileirar
    const shouldReEnqueue = (data.start_at || incomingReminders !== undefined) && finalReminders?.length;
    if (shouldReEnqueue) {
      await this.enqueueReminders(event.id, event.start_at, finalReminders);
      this.logger.log(`Lembretes re-enfileirados para evento ${event.id}`);
    }

    // Se é AUDIÊNCIA ou PERÍCIA e data ou local mudaram → notificar cliente sobre a remarcação
    const isAudiencia = ['AUDIENCIA', 'PERICIA'].includes(before?.type ?? event.type);
    const dateChanged = data.start_at && new Date(data.start_at).getTime() !== before?.start_at?.getTime();
    const locationChanged = data.location !== undefined && data.location !== before?.location;
    if (isAudiencia && (dateChanged || locationChanged) && event.lead?.phone) {
      try {
        // Cancela notificação anterior pendente (se operador ainda não enviou)
        const oldJob = await this.reminderQueue.getJob(`hearing-notify-${event.id}`);
        if (oldJob) await oldJob.remove();
        // Enfileira nova notificação de remarcação com 1 minuto de delay
        await this.reminderQueue.add(
          'notify-hearing-rescheduled',
          { eventId: event.id },
          {
            delay: 60_000,
            jobId: `hearing-notify-${event.id}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: true,
            removeOnFail: 50,
          },
        );
        this.logger.log(`[AUDIENCIA] Notificação de remarcação enfileirada para evento ${event.id}`);
      } catch (e: any) {
        this.logger.error(`[AUDIENCIA] Erro ao enfileirar notificação de remarcação: ${e.message}`);
      }
    }

    // Lista de espera (Fase 19): se status virou CANCELADO/ADIADO numa CONSULTA,
    // dispara matching pra notificar candidatos. Não bloqueia.
    const newlyCancelled =
      data.status &&
      ['CANCELADO', 'ADIADO'].includes(data.status) &&
      !['CANCELADO', 'ADIADO'].includes(before?.status ?? '');
    if (
      newlyCancelled &&
      event.type === 'CONSULTA' &&
      event.assigned_user_id &&
      event.start_at
    ) {
      this.waitlist
        .notifySlotOpened({
          dentistId: event.assigned_user_id,
          slotStart: event.start_at,
          tenantId: event.tenant_id ?? undefined,
          dentistName: event.assigned_user?.name,
        })
        .then((res) => {
          if (res.notified > 0) {
            this.logger.log(
              `[WAITLIST] ${res.notified} candidato(s) notificado(s) pela vaga aberta no evento ${event.id} (via update)`,
            );
          }
        })
        .catch((e) => this.logger.warn(`[WAITLIST] hook falhou: ${e?.message}`));
    }

    if (event.assigned_user_id) {
      try {
        this.chatGateway.emitCalendarUpdate(event.assigned_user_id, {
          eventId: event.id,
          action: 'updated',
          title: event.title,
          type: event.type,
        });
      } catch {}
    }

    return event;
  }

  async updateStatus(id: string, status: string) {
    if (!EVENT_STATUSES.includes(status as any)) {
      throw new BadRequestException(`Status invalido: ${status}`);
    }

    const event = await this.prisma.calendarEvent.update({
      where: { id },
      data: { status },
      include: { assigned_user: { select: { id: true, name: true } } },
    });

    // Cancelar jobs de lembrete quando evento é cancelado/concluído
    if (['CANCELADO', 'CONCLUIDO'].includes(status)) {
      await this.cancelReminderJobs(id);
      this.logger.log(`Lembretes cancelados para evento ${id} (status → ${status})`);
    }

    // Atualiza datas de visita do paciente quando consulta vira CONCLUIDO
    // (Resumo Clínico vai mostrar "Primeira/Última visita" corretamente).
    if (
      status === 'CONCLUIDO' &&
      event.patient_id &&
      this.isClinicalEvent(event.type) &&
      event.start_at
    ) {
      await this.updatePatientVisitDates(event.patient_id, event.start_at).catch((e) =>
        this.logger.warn(`[VISIT_DATES] hook falhou: ${e?.message}`),
      );
    }

    // Onda 5e v32 (Fase 25) — auto-conversao Lead → Patient quando consulta
    // clinica vira CONCLUIDO. Se o lead ainda nao tem Patient cadastrado,
    // cria automaticamente. Idempotente.
    if (status === 'CONCLUIDO' && this.isClinicalEvent(event.type)) {
      await this.autoEnsurePatientFromEvent(id);
    }

    // Lista de espera (Fase 19): se cancelou/adiou uma CONSULTA com dentista atribuído,
    // dispara matching pra notificar candidatos da fila. Não bloqueia o cancelamento.
    if (
      ['CANCELADO', 'ADIADO'].includes(status) &&
      event.type === 'CONSULTA' &&
      event.assigned_user_id &&
      event.start_at
    ) {
      this.waitlist
        .notifySlotOpened({
          dentistId: event.assigned_user_id,
          slotStart: event.start_at,
          tenantId: event.tenant_id ?? undefined,
          dentistName: event.assigned_user?.name,
        })
        .then((res) => {
          if (res.notified > 0) {
            this.logger.log(
              `[WAITLIST] ${res.notified} candidato(s) notificado(s) pela vaga aberta no evento ${id}`,
            );
          }
        })
        .catch((e) => this.logger.warn(`[WAITLIST] hook falhou: ${e?.message}`));
    }

    // Notificar advogado
    if (event.assigned_user_id) {
      try {
        this.chatGateway.emitCalendarUpdate(event.assigned_user_id, {
          eventId: id,
          action: 'status_changed',
          title: event.title,
          type: event.type,
        });
      } catch {}
    }

    return event;
  }

  async remove(id: string) {
    const event = await this.prisma.calendarEvent.findUnique({ where: { id } });
    if (!event) throw new NotFoundException('Evento nao encontrado');

    // Cancelar jobs de lembrete pendentes na fila BullMQ antes de deletar
    await this.cancelReminderJobs(id);

    await this.prisma.calendarEvent.delete({ where: { id } });

    if (event.assigned_user_id) {
      try {
        this.chatGateway.emitCalendarUpdate(event.assigned_user_id, {
          eventId: id,
          action: 'deleted',
          title: event.title,
        });
      } catch {}
    }

    return { deleted: true };
  }

  // ─── Conflict Detection ─────────────────────────────────

  async checkConflicts(userId: string, startAt: string, endAt: string, excludeEventId?: string, tenantId?: string) {
    const start = new Date(startAt);
    const end = new Date(endAt);
    const where: any = {
      assigned_user_id: userId,
      status: { notIn: ['CANCELADO', 'CONCLUIDO'] },
      // Overlap: evento começa antes do fim do range E (termina após início do range OU sem end_at mas começa dentro do range)
      start_at: { lt: end },
      OR: [
        { end_at: { gt: start } },
        { end_at: null, start_at: { gte: start } },
      ],
    };
    // Isolamento de tenant: admin de um tenant não vê agenda de outro tenant
    if (tenantId) {
      where.AND = [
        ...(where.AND || []),
        { OR: [{ tenant_id: tenantId }, { tenant_id: null }] },
      ];
    }
    if (excludeEventId) where.id = { not: excludeEventId };
    return this.prisma.calendarEvent.findMany({
      where,
      select: { id: true, title: true, start_at: true, end_at: true },
    });
  }

  // ─── Availability ─────────────────────────────────────

  async getSchedule(userId: string) {
    // Onda 5e v10: ordena por day_of_week + sort_order + start_time pra
    // garantir ordem consistente quando ha multiplos turnos no mesmo dia.
    return this.prisma.userSchedule.findMany({
      where: { user_id: userId },
      orderBy: [{ day_of_week: 'asc' }, { sort_order: 'asc' }, { start_time: 'asc' }],
    });
  }

  async setSchedule(
    userId: string,
    slots: {
      day_of_week: number;
      start_time: string;
      end_time: string;
      lunch_start?: string | null;
      lunch_end?: string | null;
      label?: string | null;
      sort_order?: number;
    }[],
  ) {
    // Onda 5e v10: como agora pode haver MULTIPLOS registros pelo mesmo
    // (user_id, day_of_week), nao da pra usar upsert (chave nao eh mais
    // unica). Usamos transacao: deleta TUDO do usuario + cria os novos slots.
    // Idempotente — se rodar duas vezes com mesmo input, da o mesmo resultado.
    return this.prisma.$transaction(async (tx) => {
      await tx.userSchedule.deleteMany({ where: { user_id: userId } });
      if (slots.length === 0) return [];
      // Filtra slots invalidos (start >= end ou campos vazios) por seguranca
      const valid = slots.filter(
        (s) => s.start_time && s.end_time && s.start_time < s.end_time,
      );
      await tx.userSchedule.createMany({
        data: valid.map((s, idx) => ({
          user_id: userId,
          day_of_week: s.day_of_week,
          start_time: s.start_time,
          end_time: s.end_time,
          lunch_start: s.lunch_start ?? null,
          lunch_end: s.lunch_end ?? null,
          label: s.label ?? null,
          sort_order: s.sort_order ?? idx,
        })),
      });
      return tx.userSchedule.findMany({
        where: { user_id: userId },
        orderBy: [{ day_of_week: 'asc' }, { sort_order: 'asc' }, { start_time: 'asc' }],
      });
    });
  }

  async getAvailability(userId: string, dateStr: string, durationMinutes: number, tenantId?: string) {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      throw new BadRequestException('Data inválida');
    }
    // UTC naive: datas armazenadas como horário local em UTC — usar getUTCDay()
    const dayOfWeek = date.getUTCDay(); // 0=dom..6=sab

    // 0. Verificar se e feriado (com filtro de tenant)
    const isHoliday = await this.isHoliday(date, tenantId);
    if (isHoliday) return [];

    // 1. Onda 5e v10: busca TODOS os turnos do dia (pode ter manha + tarde + plantao)
    const shifts = await this.prisma.userSchedule.findMany({
      where: { user_id: userId, day_of_week: dayOfWeek },
      orderBy: [{ sort_order: 'asc' }, { start_time: 'asc' }],
    });
    if (shifts.length === 0) return [];

    // 2. Eventos existentes nesse dia (inclui eventos que começaram antes mas terminam durante o dia)
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    const events = await this.prisma.calendarEvent.findMany({
      where: {
        assigned_user_id: userId,
        // Overlap: evento começa antes do fim do dia E (termina após início do dia OU sem end_at mas começa no dia)
        start_at: { lte: dayEnd },
        OR: [
          { end_at: { gte: dayStart } },
          { end_at: null, start_at: { gte: dayStart } },
        ],
        status: { notIn: ['CANCELADO', 'CONCLUIDO'] },
      },
      select: { start_at: true, end_at: true },
      orderBy: { start_at: 'asc' },
    });

    // UTC naive: extrair hora/minuto direto em UTC (datas armazenadas como horário local)
    const toLocalMinutes = (d: Date): number => {
      return d.getUTCHours() * 60 + d.getUTCMinutes();
    };

    const fmt = (m: number): string =>
      `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

    // 3. Onda 5e v10: pra CADA turno, calcula slots livres separadamente.
    // Diferente da v anterior (1 turno por dia), agora um dia pode ter manha
    // 08-12 + tarde 14-18 + plantao 19-22. Cada turno gera sua janela de
    // slots independente, depois concatenamos tudo no resultado final.
    const allSlots: { start: string; end: string }[] = [];
    for (const shift of shifts) {
      const [startH, startM] = shift.start_time.split(':').map(Number);
      const [endH, endM] = shift.end_time.split(':').map(Number);
      const workStart = startH * 60 + startM;
      const workEnd = endH * 60 + endM;
      if (workEnd <= workStart) continue; // turno invalido

      // Eventos que se sobrepoem ao turno + lunch interno (compat) viram busy
      const busy: { start: number; end: number }[] = [];
      for (const e of events) {
        const s = Math.max(toLocalMinutes(e.start_at), workStart);
        const eEnd = e.end_at
          ? Math.min(toLocalMinutes(e.end_at), workEnd)
          : Math.min(s + durationMinutes, workEnd);
        if (eEnd > s) busy.push({ start: s, end: eEnd });
      }
      // Lunch DENTRO do turno (formato antigo, backward compat)
      if (shift.lunch_start && shift.lunch_end) {
        const [lsH, lsM] = shift.lunch_start.split(':').map(Number);
        const [leH, leM] = shift.lunch_end.split(':').map(Number);
        const ls = Math.max(lsH * 60 + lsM, workStart);
        const le = Math.min(leH * 60 + leM, workEnd);
        if (le > ls) busy.push({ start: ls, end: le });
      }
      busy.sort((a, b) => a.start - b.start);

      // Encaixa slots de duracao=durationMinutes em cada gap livre do turno
      let cursor = workStart;
      for (const b of busy) {
        while (cursor + durationMinutes <= b.start) {
          allSlots.push({ start: fmt(cursor), end: fmt(cursor + durationMinutes) });
          cursor += durationMinutes;
        }
        if (b.end > cursor) cursor = b.end;
      }
      while (cursor + durationMinutes <= workEnd) {
        allSlots.push({ start: fmt(cursor), end: fmt(cursor + durationMinutes) });
        cursor += durationMinutes;
      }
    }

    return allSlots;
  }

  // ─── Appointment Types ────────────────────────────────

  async findAppointmentTypes(tenantId?: string) {
    return this.prisma.appointmentType.findMany({
      where: tenantId ? { tenant_id: tenantId } : {},
      orderBy: { name: 'asc' },
    });
  }

  async createAppointmentType(data: {
    name: string;
    duration: number;
    color?: string;
    tenant_id?: string;
  }) {
    return this.prisma.appointmentType.create({ data });
  }

  async updateAppointmentType(id: string, data: { name?: string; duration?: number; color?: string; active?: boolean }) {
    return this.prisma.appointmentType.update({ where: { id }, data });
  }

  async deleteAppointmentType(id: string) {
    await this.prisma.appointmentType.delete({ where: { id } });
    return { deleted: true };
  }

  // ─── Listagem de Reminders pra Dashboard (Onda 5e v21, Fase 25) ─────
  // Lista EventReminder filtravel pra UI de acompanhamento de disparos
  // (aba Lembretes dentro de Follow-up IA). Retorna detalhes do evento +
  // paciente + dentista pra renderizar a tabela sem N+1 queries.

  async listReminders(opts: {
    status?: 'pendente' | 'enviado' | 'falhou' | 'todos';
    channel?: string;
    from?: string;
    to?: string;
    tenant_id?: string;
    limit?: number;
  }) {
    const limit = Math.min(opts.limit ?? 100, 500);
    const where: any = {};

    // Filtro de status (pendente = sent_at NULL e evento futuro,
    // enviado = sent_at preenchido, falhou = pendente + evento ja passou)
    const now = new Date();
    if (opts.status === 'pendente') {
      where.sent_at = null;
      where.event = { start_at: { gte: now } };
    } else if (opts.status === 'enviado') {
      where.sent_at = { not: null };
    } else if (opts.status === 'falhou') {
      where.sent_at = null;
      where.event = { start_at: { lt: now } };
    }

    if (opts.channel) where.channel = opts.channel;
    if (opts.from || opts.to) {
      const eventCondition = where.event || {};
      eventCondition.start_at = {};
      if (opts.from) eventCondition.start_at.gte = new Date(opts.from);
      if (opts.to) eventCondition.start_at.lte = new Date(opts.to);
      where.event = eventCondition;
    }

    // Filtro de tenant via evento (EventReminder nao tem tenant_id direto)
    if (opts.tenant_id) {
      const eventCondition = where.event || {};
      eventCondition.OR = [
        { tenant_id: opts.tenant_id },
        { tenant_id: null },
      ];
      where.event = eventCondition;
    }

    // EventReminder nao tem created_at no schema — ordena por sent_at + id
    // pra desempate consistente
    const reminders = await this.prisma.eventReminder.findMany({
      where,
      take: limit,
      orderBy: [{ sent_at: 'desc' }, { id: 'desc' }],
      include: {
        event: {
          select: {
            id: true, title: true, type: true, status: true, start_at: true,
            location: true,
            assigned_user: { select: { id: true, name: true } },
            lead: { select: { id: true, name: true, phone: true } },
            // v31: tambem traz patient pra fallback quando evento foi criado
            // direto via ficha do paciente (sem lead vinculado)
            patient: { select: { id: true, name: true, phone: true } },
          },
        },
      },
    });

    return reminders.map((r: any) => ({
      id: r.id,
      minutes_before: r.minutes_before,
      channel: r.channel,
      sent_at: r.sent_at,
      last_error: r.last_error, // v24: motivo de falha
      // v25 (Onda C): delivery tracking via webhook
      delivered_at: r.delivered_at,
      read_at: r.read_at,
      // Status derivado pra UI
      derived_status: r.sent_at
        ? 'enviado'
        : r.event && r.event.start_at < now
          ? 'falhou'
          : 'pendente',
      // v25: status detalhado de delivery (pra mostrar checks ✓ / ✓✓)
      delivery_status: r.read_at
        ? 'lido'
        : r.delivered_at
          ? 'entregue'
          : r.sent_at
            ? 'enviado'
            : null,
      event: r.event,
    }));
  }

  // ─── Preview do conteudo de um lembrete (Onda 5e v24, Onda B) ────────
  // Retorna texto enviado pro WhatsApp + respostas do paciente nas N horas
  // seguintes. Usado pelo modal "Ver mensagem" da aba Lembretes.
  async getReminderPreview(reminderId: string) {
    const reminder = await this.prisma.eventReminder.findUnique({
      where: { id: reminderId },
      include: {
        event: {
          select: {
            id: true, title: true, start_at: true, lead_id: true,
            lead: { select: { id: true, name: true, phone: true } },
            // v31: patient como fallback (eventos criados via ficha do paciente)
            patient: { select: { id: true, name: true, phone: true } },
            assigned_user: { select: { name: true } },
          },
        },
      },
    });
    if (!reminder) throw new BadRequestException('Lembrete não encontrado');

    // Busca a Message OUT salva no momento do envio do lembrete
    // (calendar-reminder.worker.ts salva com status='enviado' na conversa do lead)
    let sentMessage: any = null;
    let leadResponses: any[] = [];
    let conversationId: string | null = null;

    if (reminder.event?.lead_id && reminder.sent_at) {
      // Acha a conversa do lead
      const convo = await this.prisma.conversation.findFirst({
        where: { lead_id: reminder.event.lead_id },
        orderBy: { last_message_at: 'desc' },
        select: { id: true },
      });
      if (convo) {
        conversationId = convo.id;
        // Mensagem OUT enviada nos 60s ao redor do sent_at
        const sentAtMs = reminder.sent_at.getTime();
        const windowStart = new Date(sentAtMs - 60_000);
        const windowEnd = new Date(sentAtMs + 60_000);
        sentMessage = await this.prisma.message.findFirst({
          where: {
            conversation_id: convo.id,
            direction: 'out',
            created_at: { gte: windowStart, lte: windowEnd },
          },
          orderBy: { created_at: 'desc' },
          select: { id: true, text: true, created_at: true, status: true },
        });

        // Respostas do lead nas 48h apos o lembrete
        const responseWindowEnd = new Date(sentAtMs + 48 * 60 * 60 * 1000);
        leadResponses = await this.prisma.message.findMany({
          where: {
            conversation_id: convo.id,
            direction: 'in',
            created_at: { gt: reminder.sent_at, lte: responseWindowEnd },
          },
          orderBy: { created_at: 'asc' },
          take: 5,
          select: { id: true, text: true, type: true, created_at: true },
        });
      }
    }

    return {
      reminder: {
        id: reminder.id,
        minutes_before: reminder.minutes_before,
        channel: reminder.channel,
        sent_at: reminder.sent_at,
        last_error: reminder.last_error,
        // v25: delivery tracking
        delivered_at: (reminder as any).delivered_at,
        read_at: (reminder as any).read_at,
      },
      event: reminder.event,
      conversation_id: conversationId,
      sent_message: sentMessage,
      lead_responses: leadResponses,
    };
  }

  // ─── Metricas de saude dos lembretes (v25 #11) ──────────────────────
  // Agregados sobre EventReminder pra dashboard de saude:
  //   - Taxa de delivery (% entregue / enviados)
  //   - Taxa de leitura (% lido / entregues)
  //   - Antecedencias mais efetivas (qual antecedencia tem maior taxa de leitura)
  //   - Volume por dia (ultimos 30d)
  async getRemindersHealth(opts: { tenant_id?: string; days?: number }) {
    const days = opts.days ?? 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const tenantFilter = opts.tenant_id
      ? { event: { OR: [{ tenant_id: opts.tenant_id }, { tenant_id: null }] } }
      : {};

    // Agregados sobre lembretes ENVIADOS no periodo
    const reminders = await (this.prisma as any).eventReminder.findMany({
      where: {
        sent_at: { gte: since },
        ...tenantFilter,
      },
      select: {
        minutes_before: true,
        channel: true,
        sent_at: true,
        delivered_at: true,
        read_at: true,
        last_error: true,
      },
    });

    const total = reminders.length;
    const enviados = reminders.filter((r: any) => r.sent_at).length;
    const entregues = reminders.filter((r: any) => r.delivered_at).length;
    const lidos = reminders.filter((r: any) => r.read_at).length;
    const falhasNoPeriodo = await (this.prisma as any).eventReminder.count({
      where: {
        sent_at: null,
        last_error: { not: null },
        event: {
          start_at: { gte: since },
          ...(opts.tenant_id ? { OR: [{ tenant_id: opts.tenant_id }, { tenant_id: null }] } : {}),
        },
      },
    });

    // Taxa por antecedencia (1d, 1h, 30min)
    const byMinutes: Record<number, { total: number; entregues: number; lidos: number }> = {};
    for (const r of reminders) {
      const m = r.minutes_before;
      if (!byMinutes[m]) byMinutes[m] = { total: 0, entregues: 0, lidos: 0 };
      byMinutes[m].total++;
      if (r.delivered_at) byMinutes[m].entregues++;
      if (r.read_at) byMinutes[m].lidos++;
    }

    // Volume por dia (ultimos N dias)
    const byDay: Record<string, number> = {};
    for (const r of reminders) {
      if (!r.sent_at) continue;
      const day = r.sent_at.toISOString().slice(0, 10);
      byDay[day] = (byDay[day] || 0) + 1;
    }

    const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 100));

    return {
      period: { days, since: since.toISOString() },
      totals: {
        total,
        enviados,
        entregues,
        lidos,
        falhas: falhasNoPeriodo,
      },
      rates: {
        entrega_pct: pct(entregues, enviados),
        leitura_pct: pct(lidos, entregues),
        leitura_geral_pct: pct(lidos, enviados),
      },
      by_minutes_before: Object.entries(byMinutes)
        .map(([m, v]) => ({
          minutes_before: parseInt(m),
          total: v.total,
          entregues: v.entregues,
          lidos: v.lidos,
          entrega_pct: pct(v.entregues, v.total),
          leitura_pct: pct(v.lidos, v.total),
        }))
        .sort((a, b) => b.minutes_before - a.minutes_before),
      by_day: Object.entries(byDay)
        .map(([day, count]) => ({ day, count }))
        .sort((a, b) => a.day.localeCompare(b.day)),
    };
  }

  // ─── Export CSV de lembretes (v25 #12) ──────────────────────────────
  // Reusa listReminders, formata como CSV pra download (relatorio).
  async exportRemindersCSV(opts: {
    status?: 'pendente' | 'enviado' | 'falhou' | 'todos';
    from?: string;
    to?: string;
    tenant_id?: string;
  }) {
    const reminders = await this.listReminders({ ...opts, limit: 5000 });

    const escape = (val: any): string => {
      if (val === null || val === undefined) return '';
      const s = String(val).replace(/"/g, '""');
      return `"${s}"`;
    };
    const fmtDate = (d: Date | string | null) => {
      if (!d) return '';
      const dt = typeof d === 'string' ? new Date(d) : d;
      return dt.toISOString().slice(0, 19).replace('T', ' ');
    };

    const headers = [
      'Status', 'Status Detalhado', 'Paciente', 'Telefone', 'Dentista',
      'Evento', 'Tipo Evento', 'Data/Hora Evento',
      'Antecedencia (min)', 'Canal',
      'Enviado em', 'Entregue em', 'Lido em',
      'Motivo Falha',
    ];
    const lines = [headers.map(escape).join(',')];
    for (const r of reminders) {
      lines.push([
        r.derived_status,
        (r as any).delivery_status || '',
        r.event?.lead?.name || '',
        r.event?.lead?.phone || '',
        r.event?.assigned_user?.name || '',
        r.event?.title || '',
        r.event?.type || '',
        fmtDate(r.event?.start_at as any),
        r.minutes_before,
        r.channel,
        fmtDate(r.sent_at as any),
        fmtDate((r as any).delivered_at),
        fmtDate((r as any).read_at),
        r.last_error || '',
      ].map(escape).join(','));
    }
    return lines.join('\n');
  }

  /**
   * Resumo agregado de lembretes nas ultimas 24h + proximas 24h.
   * Renderizado nos cards do topo da aba Lembretes.
   */
  async getRemindersSummary(opts: { tenant_id?: string }) {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const dayAhead = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const tenantFilter = opts.tenant_id
      ? { OR: [{ tenant_id: opts.tenant_id }, { tenant_id: null }] }
      : {};

    const [enviados24h, pendentes24h, falhas24h, totalEventosFuturos] = await Promise.all([
      this.prisma.eventReminder.count({
        where: { sent_at: { gte: dayAgo, lte: now } },
      }),
      this.prisma.eventReminder.count({
        where: {
          sent_at: null,
          event: { ...tenantFilter, start_at: { gte: now, lte: dayAhead } },
        },
      }),
      this.prisma.eventReminder.count({
        where: {
          sent_at: null,
          event: { ...tenantFilter, start_at: { lt: now, gte: dayAgo } },
        },
      }),
      this.prisma.calendarEvent.count({
        where: {
          ...tenantFilter,
          start_at: { gte: now },
          type: { in: ['CONSULTA', 'PROCEDIMENTO', 'RETORNO'] },
          status: { notIn: ['CANCELADO', 'CONCLUIDO'] },
        },
      }),
    ]);

    return {
      enviados_24h: enviados24h,
      pendentes_proximas_24h: pendentes24h,
      falhas_24h: falhas24h,
      eventos_futuros: totalEventosFuturos,
    };
  }

  /**
   * Reenvia um lembrete: zera sent_at e re-enfileira no BullMQ pra disparar
   * imediatamente (delay de 1s). Util quando lembrete falhou e operador
   * quer tentar de novo manualmente.
   */
  async resendReminder(reminderId: string) {
    const reminder = await this.prisma.eventReminder.findUnique({
      where: { id: reminderId },
      include: { event: { select: { id: true, status: true, start_at: true } } },
    });
    if (!reminder) throw new BadRequestException('Lembrete não encontrado');
    if (!reminder.event) throw new BadRequestException('Evento não encontrado');
    if (['CANCELADO', 'CONCLUIDO'].includes(reminder.event.status)) {
      throw new BadRequestException('Não dá pra reenviar lembrete de evento cancelado/concluído');
    }

    // Zera sent_at pra worker re-processar
    await this.prisma.eventReminder.update({
      where: { id: reminderId },
      data: { sent_at: null },
    });

    // Re-enfileira no BullMQ com delay imediato (1s)
    const jobId = `reminder-${reminder.id}`;
    try {
      const old = await this.reminderQueue.getJob(jobId);
      if (old) await old.remove();
    } catch {}
    await this.reminderQueue.add(
      'send-reminder',
      { reminderId: reminder.id, eventId: reminder.event.id, channel: reminder.channel },
      {
        delay: 1000,
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );

    this.logger.log(`[RESEND] Lembrete ${reminderId} reenfileirado pra disparo imediato`);
    return { success: true, reminder_id: reminderId };
  }

  /**
   * Cancela lembrete pendente: remove do BullMQ + marca como sent_at agora
   * (impede reprocessamento). Nao deleta o registro pra ficar no historico.
   */
  async cancelReminder(reminderId: string) {
    const reminder = await this.prisma.eventReminder.findUnique({
      where: { id: reminderId },
    });
    if (!reminder) throw new BadRequestException('Lembrete não encontrado');
    if (reminder.sent_at) {
      throw new BadRequestException('Lembrete já foi processado (não pode cancelar)');
    }

    // Remove do BullMQ
    const jobId = `reminder-${reminder.id}`;
    try {
      const old = await this.reminderQueue.getJob(jobId);
      if (old) await old.remove();
    } catch {}

    // Marca sent_at pra impedir worker pegar (idempotencia)
    await this.prisma.eventReminder.update({
      where: { id: reminderId },
      data: { sent_at: new Date() }, // truque: sent_at sinaliza "nao processar mais"
    });

    this.logger.log(`[CANCEL] Lembrete ${reminderId} cancelado (removido da fila)`);
    return { success: true, reminder_id: reminderId };
  }

  // ─── Configuracao de Lembretes (Onda 5e v27, Fase 25) ────────────────
  // Persistido como JSON em GlobalSetting com key REMINDER_CONFIG_<tenant_id>.
  // Sem tenant_id: chave global REMINDER_CONFIG (fallback).
  // Defaults vem de packages/shared (DEFAULT_REMINDER_CONFIG) se nao customizado.

  async getReminderConfig(tenant_id?: string) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DEFAULT_REMINDER_CONFIG } = await import('@crm/shared');
    const key = tenant_id ? `REMINDER_CONFIG_${tenant_id}` : 'REMINDER_CONFIG';
    try {
      const setting = await this.prisma.globalSetting.findUnique({ where: { key } });
      if (!setting?.value) return DEFAULT_REMINDER_CONFIG;
      const parsed = JSON.parse(setting.value);
      // Merge com defaults pra garantir que campos novos venham preenchidos
      return {
        // Onda 17.49 — liga/desliga; default LIGADO (so 'false' explicito desliga).
        enabled: parsed.enabled !== false,
        default_antecedencias: Array.isArray(parsed.default_antecedencias)
          ? parsed.default_antecedencias
          : DEFAULT_REMINDER_CONFIG.default_antecedencias,
        templates: {
          ...DEFAULT_REMINDER_CONFIG.templates,
          ...(parsed.templates || {}),
        },
      };
    } catch (e) {
      this.logger.warn(`Falha ao parsear ${key}, usando defaults: ${(e as any)?.message}`);
      return DEFAULT_REMINDER_CONFIG;
    }
  }

  async setReminderConfig(
    tenant_id: string | undefined,
    config: { enabled?: boolean; default_antecedencias?: any[]; templates?: any },
  ) {
    const key = tenant_id ? `REMINDER_CONFIG_${tenant_id}` : 'REMINDER_CONFIG';
    // Valida shape minimo
    if (config.default_antecedencias) {
      if (!Array.isArray(config.default_antecedencias)) {
        throw new BadRequestException('default_antecedencias deve ser array');
      }
      for (const a of config.default_antecedencias) {
        if (typeof a.minutes_before !== 'number' || a.minutes_before < 1) {
          throw new BadRequestException('cada antecedencia precisa ter minutes_before >= 1');
        }
        if (!a.channel || typeof a.channel !== 'string') {
          throw new BadRequestException('cada antecedencia precisa ter channel string');
        }
      }
    }
    if (config.templates) {
      for (const k of ['consulta_24h', 'consulta_1h', 'consulta_15min']) {
        if (config.templates[k] !== undefined && typeof config.templates[k] !== 'string') {
          throw new BadRequestException(`template ${k} deve ser string`);
        }
        if (config.templates[k] && config.templates[k].length > 1500) {
          throw new BadRequestException(`template ${k} ultrapassa 1500 caracteres`);
        }
      }
    }
    // Onda 17.49 — preserva SO o `enabled` (o modal de antecedencias nunca o
    // envia, entao salvar templates/antecedencias nao pode apagar o liga/desliga).
    // default_antecedencias/templates AUSENTES continuam significando "resetar pros
    // defaults" — e o que o botao "Restaurar padroes" faz; por isso NAO ha fallback
    // pro atual aqui (so pro enabled).
    const current = await this.getReminderConfig(tenant_id);
    const value = JSON.stringify({
      enabled: config.enabled !== undefined ? config.enabled : current.enabled,
      default_antecedencias: config.default_antecedencias,
      templates: config.templates,
    });
    await this.prisma.globalSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
    this.logger.log(`[REMINDER_CONFIG] salvo pra ${key}`);
    return this.getReminderConfig(tenant_id);
  }

  // ─── Resumo Diario pra Dentistas (Onda 5e v30, Fase 25) ──────────────
  // Disparo unico no inicio do dia com lista dos atendimentos do dentista.
  // Diferente dos reminders por evento — sao consolidados num so disparo.

  async getDentistDailySummaryConfig(tenant_id?: string) {
    const { DEFAULT_DENTIST_DAILY_SUMMARY } = await import('@crm/shared');
    const key = tenant_id ? `DENTIST_DAILY_SUMMARY_${tenant_id}` : 'DENTIST_DAILY_SUMMARY';
    try {
      const setting = await this.prisma.globalSetting.findUnique({ where: { key } });
      if (!setting?.value) return DEFAULT_DENTIST_DAILY_SUMMARY;
      const parsed = JSON.parse(setting.value);
      return { ...DEFAULT_DENTIST_DAILY_SUMMARY, ...parsed };
    } catch (e) {
      this.logger.warn(`Falha ao parsear ${key}, usando defaults: ${(e as any)?.message}`);
      return DEFAULT_DENTIST_DAILY_SUMMARY;
    }
  }

  async setDentistDailySummaryConfig(
    tenant_id: string | undefined,
    config: { enabled?: boolean; send_at?: string; channel?: string; template?: string },
  ) {
    if (config.send_at !== undefined && !/^\d{2}:\d{2}$/.test(config.send_at)) {
      throw new BadRequestException('send_at deve estar no formato HH:MM');
    }
    if (config.channel !== undefined && !['WHATSAPP', 'PUSH'].includes(config.channel)) {
      throw new BadRequestException('channel deve ser WHATSAPP ou PUSH');
    }
    if (config.template !== undefined) {
      if (typeof config.template !== 'string') {
        throw new BadRequestException('template deve ser string');
      }
      if (config.template.length > 2000) {
        throw new BadRequestException('template ultrapassa 2000 caracteres');
      }
    }
    const key = tenant_id ? `DENTIST_DAILY_SUMMARY_${tenant_id}` : 'DENTIST_DAILY_SUMMARY';
    const current = await this.getDentistDailySummaryConfig(tenant_id);
    const merged = { ...current, ...config };
    await this.prisma.globalSetting.upsert({
      where: { key },
      create: { key, value: JSON.stringify(merged) },
      update: { value: JSON.stringify(merged) },
    });
    this.logger.log(`[DENTIST_DAILY_SUMMARY] salvo pra ${key}`);
    return merged;
  }

  /** Onda 17.56 — instância Evolution REAL do tenant: prefere a de uma conversa
   *  recente (a que o chat usa de verdade) e cai na tabela Instance como fallback.
   *  A tabela Instance às vezes tem um registro 'whatsapp' que a Evolution não tem. */
  private async resolveTenantWhatsappInstance(tenant_id?: string): Promise<string | null> {
    const convo = await this.prisma.conversation.findFirst({
      where: { instance_name: { not: null }, ...(tenant_id ? { tenant_id } : {}) },
      orderBy: { last_message_at: 'desc' },
      select: { instance_name: true },
    });
    if (convo?.instance_name) return convo.instance_name;
    const inst = await this.prisma.instance.findFirst({
      where: { type: 'whatsapp', ...(tenant_id ? { tenant_id } : {}) },
      orderBy: { created_at: 'asc' },
      select: { name: true },
    });
    return inst?.name ?? null;
  }

  // ─── Confirmação de agendamento (Onda 17.56) — mensagem editável ─────
  // O liga/desliga vive em APPOINTMENT_CONFIRMATION_ENABLED_<tenant> (painel
  // Operacional). Aqui guardamos só o TEXTO, em
  // APPOINTMENT_CONFIRMATION_TEMPLATE_<tenant>. O worker scheduler aplica.
  async getAppointmentConfirmationConfig(tenant_id?: string) {
    const DEFAULT =
      'Olá {nome}! Confirmando sua consulta com {dentista} amanhã ({data}) às {hora}.\n{local_line}\nResponda 1 para CONFIRMAR ou 2 para REMARCAR.';
    const key = tenant_id ? `APPOINTMENT_CONFIRMATION_TEMPLATE_${tenant_id}` : 'APPOINTMENT_CONFIRMATION_TEMPLATE';
    try {
      const setting = await this.prisma.globalSetting.findUnique({ where: { key } });
      if (!setting?.value) return { template: DEFAULT };
      const parsed = JSON.parse(setting.value);
      const tpl = typeof parsed.template === 'string' && parsed.template.trim() ? parsed.template : DEFAULT;
      return { template: tpl };
    } catch (e) {
      this.logger.warn(`Falha ao parsear ${key}, usando default: ${(e as any)?.message}`);
      return { template: DEFAULT };
    }
  }

  async setAppointmentConfirmationConfig(
    tenant_id: string | undefined,
    config: { template?: string },
  ) {
    if (config.template !== undefined) {
      if (typeof config.template !== 'string') {
        throw new BadRequestException('template deve ser string');
      }
      if (config.template.length > 1500) {
        throw new BadRequestException('template ultrapassa 1500 caracteres');
      }
    }
    const key = tenant_id ? `APPOINTMENT_CONFIRMATION_TEMPLATE_${tenant_id}` : 'APPOINTMENT_CONFIRMATION_TEMPLATE';
    const value = JSON.stringify({ template: config.template ?? '' });
    await this.prisma.globalSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
    this.logger.log(`[APPOINTMENT_CONFIRMATION_TEMPLATE] salvo pra ${key}`);
    return this.getAppointmentConfirmationConfig(tenant_id);
  }

  /** Onda 17.56 — teste GENÉRICO: envia a mensagem de QUALQUER disparo (com dados
   *  de exemplo) pra um número, pra ver na hora se o WhatsApp da clínica entrega. */
  async sendTestDisparo(tenant_id: string | undefined, disparo: string, phone: string) {
    let num = (phone || '').replace(/\D/g, '');
    if (num.length < 10) {
      throw new BadRequestException('Telefone inválido — use DDD + número (ex.: 82999998888)');
    }
    // Adiciona o código do Brasil (55) quando vem só DDD + número (10–11 dígitos).
    if (num.length === 10 || num.length === 11) num = `55${num}`;

    const instanceName = await this.resolveTenantWhatsappInstance(tenant_id);
    if (!instanceName) {
      throw new BadRequestException(
        'Nenhuma instância de WhatsApp conectada pra esta clínica. Conecte o WhatsApp primeiro.',
      );
    }

    // Onda 17.57 — endereço REAL da clínica (cadastrado em Identidade); cai pra
    // um exemplo só se o tenant ainda não preencheu o endereço.
    const { formatTenantAddress } = await import('@crm/shared');
    const tenantRow = tenant_id
      ? await this.prisma.tenant.findUnique({
          where: { id: tenant_id },
          select: {
            address: true, address_number: true, address_complement: true,
            neighborhood: true, city: true, state: true,
          },
        }).catch(() => null)
      : null;
    const tenantAddr = formatTenantAddress(tenantRow);

    // Onda 17.59 — dentista REAL do tenant logado (1º DENTIST, ou ADMIN com
    // especialidade). Antes era fixo "Dra. Suellen" — parecia de OUTRO tenant.
    const dentistRow = tenant_id
      ? await this.prisma.user.findFirst({
          where: {
            tenant_id,
            OR: [
              { roles: { has: 'DENTIST' } },
              { roles: { has: 'ADMIN' }, specialties: { isEmpty: false } },
            ],
          },
          select: { name: true },
          orderBy: { name: 'asc' },
        }).catch(() => null)
      : null;
    const dentistName = dentistRow?.name || 'a clínica';

    // Variáveis: paciente/data/hora de EXEMPLO; dentista e local REAIS do tenant.
    const V: Record<string, string> = {
      nome: 'Felipe (teste)', nome_completo: 'Felipe Passos (teste)',
      dentista: dentistName, dentista_completo: dentistName,
      data: '06/05', hora: '14:00',
      local: tenantAddr || '(endereço não cadastrado — preencha em Configurações › Identidade)',
      clinica: 'sua clínica', antecedencia: '1 dia', qtd: '1',
    };
    const apply = (t: string) =>
      (t || '')
        .replace(/\{local_line\}/g, V.local ? `📍 ${V.local}\n` : '')
        .replace(/\{agenda\}/g, '- 14:00  Felipe (teste) (Avaliacao)')
        .replace(/\{(\w+)\}/g, (_m, k) => V[k] ?? '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    let msg = '';
    switch (disparo) {
      case 'confirmacao':
        msg = apply((await this.getAppointmentConfirmationConfig(tenant_id)).template);
        break;
      case 'lembrete_1dia':
        msg = apply((await this.getReminderConfig(tenant_id)).templates.consulta_24h);
        break;
      case 'lembrete_1h':
        msg = apply((await this.getReminderConfig(tenant_id)).templates.consulta_1h);
        break;
      case 'lembrete_15min':
        msg = apply((await this.getReminderConfig(tenant_id)).templates.consulta_15min);
        break;
      case 'aniversario':
        msg = apply((await this.getBirthdayGreetingConfig(tenant_id)).template);
        break;
      case 'resumo_dentista':
        msg = apply((await this.getDentistDailySummaryConfig(tenant_id)).template);
        break;
      case 'nps':
        msg = `Oi Felipe! Como foi sua consulta hoje com ${dentistName}? De 0 a 10, o quanto você indicaria a gente? 😊 (mensagem de teste)`;
        break;
      default:
        throw new BadRequestException('Esse disparo ainda não tem teste disponível.');
    }
    if (!msg.trim()) {
      throw new BadRequestException('A mensagem desse disparo está vazia — configure o texto antes de testar.');
    }

    try {
      const r: any = await this.whatsapp.sendText(num, msg, instanceName, undefined, tenant_id);
      const raw = JSON.stringify(r ?? {});
      // Evolution responde exists:false quando o número não está no WhatsApp
      // (quase sempre número digitado errado — dígito a mais/menos).
      if (/"exists"\s*:\s*false/.test(raw)) {
        throw new BadRequestException(
          `O número ${num} não foi encontrado no WhatsApp. Confira o número (DDD + número) — parece ter dígitos a mais ou a menos.`,
        );
      }
      if (!r || r?.statusCode >= 400 || r?.error) {
        throw new Error(`Evolution ${r?.statusCode ?? ''} ${r?.error ?? ''}`.trim());
      }
      this.logger.log(`[DISPARO_TESTE] ${disparo} enviado pra ${num} via ${instanceName}`);
      return { sent: true, to: num, message: msg };
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(
        `Não enviou: ${e.message}. Verifique se o WhatsApp da clínica está conectado.`,
      );
    }
  }

  /** Atalho legado — a UI nova usa sendTestDisparo. */
  async sendTestConfirmation(tenant_id: string | undefined, phone: string) {
    return this.sendTestDisparo(tenant_id, 'confirmacao', phone);
  }

  /**
   * Monta a mensagem do resumo diario pra um dentista especifico,
   * substituindo as variaveis do template. Retorna a string final.
   * Se o dentista nao tem atendimentos no dia, retorna null.
   */
  private async buildDentistDailySummaryMessage(
    user: { id: string; name: string | null; phone: string | null },
    template: string,
    dayStart: Date,
    dayEnd: Date,
  ): Promise<string | null> {
    const events = await this.prisma.calendarEvent.findMany({
      where: {
        assigned_user_id: user.id,
        start_at: { gte: dayStart, lt: dayEnd },
        status: { in: ['AGENDADO', 'CONFIRMADO'] },
        type: { in: ['CONSULTA', 'PROCEDIMENTO', 'RETORNO'] },
      },
      include: {
        patient: { select: { name: true } },
        lead: { select: { name: true } },
      },
      orderBy: { start_at: 'asc' },
    });

    if (events.length === 0) return null;

    const TYPE_LABEL: Record<string, string> = {
      CONSULTA: 'Avaliacao',
      PROCEDIMENTO: 'Procedimento',
      RETORNO: 'Retorno',
    };

    const agendaLines = events.map((e) => {
      const d = new Date(e.start_at);
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      const who = e.patient?.name || e.lead?.name || 'Paciente';
      const tipo = TYPE_LABEL[e.type] || e.type;
      return `- ${hh}:${mm}  ${who} (${tipo})`;
    });

    const dataStr = dayStart.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });

    let msg = template;
    msg = msg.replace(/\{nome\}/g, user.name || 'Doutor(a)');
    msg = msg.replace(/\{data\}/g, dataStr);
    msg = msg.replace(/\{qtd\}/g, String(events.length));
    msg = msg.replace(/\{agenda\}/g, agendaLines.join('\n'));
    msg = msg.replace(/\n{3,}/g, '\n\n').trim();
    return msg;
  }

  /**
   * Envia o resumo diario pra TODOS os dentistas do tenant que tiverem
   * atendimentos hoje. Usado tanto pelo cron diario quanto pelo trigger
   * manual "Enviar agora" da UI.
   */
  async sendDentistDailySummaryNow(tenant_id?: string) {
    const config = await this.getDentistDailySummaryConfig(tenant_id);

    // Janela do dia em UTC (mesmo padrao que o resto da agenda usa)
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const dentists = await this.prisma.user.findMany({
      where: {
        ...(tenant_id ? { tenant_id } : {}),
        roles: { has: 'DENTIST' },
      },
      select: { id: true, name: true, phone: true },
    });

    // Onda 17.56 — instância Evolution real do tenant (mesmo motivo do teste de
    // confirmação: sem nome, sendText cairia no default 'whatsapp' inexistente).
    const summaryInstanceName =
      config.channel === 'WHATSAPP' ? await this.resolveTenantWhatsappInstance(tenant_id) : null;

    const results: { user_id: string; name: string | null; sent: boolean; reason?: string }[] = [];
    for (const u of dentists) {
      const msg = await this.buildDentistDailySummaryMessage(u, config.template, dayStart, dayEnd);
      if (!msg) {
        results.push({ user_id: u.id, name: u.name, sent: false, reason: 'sem atendimentos hoje' });
        continue;
      }

      if (config.channel === 'PUSH') {
        try {
          this.chatGateway.emitCalendarReminder(u.id, {
            eventId: 'daily-summary',
            title: 'Resumo do dia',
            type: 'DAILY_SUMMARY',
            start_at: now.toISOString(),
            minutesBefore: 0,
          });
          results.push({ user_id: u.id, name: u.name, sent: true });
        } catch (e: any) {
          results.push({ user_id: u.id, name: u.name, sent: false, reason: `push falhou: ${e.message}` });
        }
        continue;
      }

      // WHATSAPP
      if (!u.phone) {
        results.push({ user_id: u.id, name: u.name, sent: false, reason: 'sem telefone cadastrado' });
        continue;
      }
      const phone = u.phone.replace(/\D/g, '');
      try {
        await this.whatsapp.sendText(phone, msg, summaryInstanceName ?? undefined, undefined, tenant_id);
        results.push({ user_id: u.id, name: u.name, sent: true });
      } catch (e: any) {
        results.push({ user_id: u.id, name: u.name, sent: false, reason: `whatsapp falhou: ${e.message}` });
      }
    }

    this.logger.log(
      `[DENTIST_DAILY_SUMMARY] disparado: ${results.filter((r) => r.sent).length}/${dentists.length} dentistas`,
    );
    return { total: dentists.length, results };
  }

  // ─── Disparo de aniversário (Onda 17.49) ─────────────────────────────
  // Robô diário: manda WhatsApp de "feliz aniversário" pros aniversariantes
  // ATIVOS de hoje. Opt-in (default off). Espelha o resumo do dentista.

  async getBirthdayGreetingConfig(tenant_id?: string) {
    const { DEFAULT_BIRTHDAY_GREETING } = await import('@crm/shared');
    const key = tenant_id ? `BIRTHDAY_GREETING_${tenant_id}` : 'BIRTHDAY_GREETING';
    try {
      const setting = await this.prisma.globalSetting.findUnique({ where: { key } });
      if (!setting?.value) return DEFAULT_BIRTHDAY_GREETING;
      return { ...DEFAULT_BIRTHDAY_GREETING, ...JSON.parse(setting.value) };
    } catch (e) {
      this.logger.warn(`Falha ao parsear ${key}, usando defaults: ${(e as any)?.message}`);
      return DEFAULT_BIRTHDAY_GREETING;
    }
  }

  async setBirthdayGreetingConfig(
    tenant_id: string | undefined,
    config: { enabled?: boolean; send_at?: string; template?: string; last_run_date?: string },
  ) {
    if (config.send_at !== undefined && !/^\d{2}:\d{2}$/.test(config.send_at)) {
      throw new BadRequestException('send_at deve estar no formato HH:MM');
    }
    if (config.template !== undefined) {
      if (typeof config.template !== 'string') throw new BadRequestException('template deve ser string');
      if (config.template.length > 2000) throw new BadRequestException('template ultrapassa 2000 caracteres');
    }
    const key = tenant_id ? `BIRTHDAY_GREETING_${tenant_id}` : 'BIRTHDAY_GREETING';
    const current = await this.getBirthdayGreetingConfig(tenant_id);
    const merged = { ...current, ...config };
    await this.prisma.globalSetting.upsert({
      where: { key },
      create: { key, value: JSON.stringify(merged) },
      update: { value: JSON.stringify(merged) },
    });
    this.logger.log(`[BIRTHDAY_GREETING] salvo pra ${key}`);
    return merged;
  }

  /** Aniversariantes ATIVOS de hoje (mesma regra do /patients/birthdays). */
  private async birthdayPatientsToday(tenant_id: string) {
    // "Hoje" no fuso America/Maceio (UTC-3) calculado no Node — NAO usa
    // CURRENT_DATE do Postgres (que roda em UTC) pra nao pegar o dia errado
    // perto da meia-noite (ex: send_at noturno pegaria os aniversariantes de
    // amanha). Mesma base que o cron usa pra decidir a hora.
    const todayMaceio = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return this.prisma.$queryRawUnsafe<Array<{ id: string; name: string; phone: string | null }>>(
      `SELECT id, name, phone FROM patients
       WHERE tenant_id = $1 AND status = 'ACTIVE' AND birth_date IS NOT NULL
         AND EXTRACT(MONTH FROM birth_date) = EXTRACT(MONTH FROM $2::date)
         AND EXTRACT(DAY FROM birth_date) = EXTRACT(DAY FROM $2::date)
       LIMIT 200`,
      tenant_id, todayMaceio,
    );
  }

  /**
   * Manda o parabéns pra todos os aniversariantes de hoje do tenant.
   * Usado pelo cron diário e pelo "Enviar agora" manual.
   */
  async sendBirthdayGreetingsNow(tenant_id: string) {
    const config = await this.getBirthdayGreetingConfig(tenant_id);
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenant_id }, select: { name: true } });
    const clinica = tenant?.name || 'nossa clínica';

    const patients = await this.birthdayPatientsToday(tenant_id);
    const results: { patient_id: string; name: string; sent: boolean; reason?: string }[] = [];

    for (const p of patients) {
      if (!p.phone) {
        results.push({ patient_id: p.id, name: p.name, sent: false, reason: 'sem telefone' });
        continue;
      }
      const firstName = (p.name || '').split(' ')[0] || p.name;
      const msg = config.template
        .replace(/\{nome\}/g, firstName)
        .replace(/\{clinica\}/g, clinica)
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      const phone = p.phone.replace(/\D/g, '');
      try {
        // Passa tenant_id pra sair da instancia Evolution DA CLINICA (multi-tenant).
        await this.whatsapp.sendText(phone, msg, undefined, undefined, tenant_id);
        results.push({ patient_id: p.id, name: p.name, sent: true });
      } catch (e: any) {
        results.push({ patient_id: p.id, name: p.name, sent: false, reason: `whatsapp falhou: ${e.message}` });
      }
    }

    this.logger.log(
      `[BIRTHDAY_GREETING] disparado: ${results.filter((r) => r.sent).length}/${patients.length} aniversariantes (tenant ${tenant_id})`,
    );
    return { total: patients.length, results };
  }

  // ─── Backfill de Reminders (Onda 5e v19, Fase 25) ────────────────────
  // Cria EventReminders default (1d, 1h, 30min) pra eventos futuros que
  // NAO tem reminders + enfileira no BullMQ pra disparar WhatsApp.
  //
  // USO: chamado via POST /calendar/reminders/backfill (admin only) pra
  // recuperar agendamentos antigos que foram criados antes do sistema de
  // reminders existir (ou quando Redis foi resetado e perdeu jobs).
  //
  // Idempotente: se evento ja tem reminder com mesma antecedencia, pula.
  async backfillReminders(opts: { tenant_id?: string; dry_run?: boolean } = {}) {
    // v26: alinhado com defaults da UI/IA [1d, 1h, 15min antes]
    const defaults = [1440, 60, 15]; // minutes_before pra cada lembrete default

    // 1. Eventos futuros de CONSULTA/PROCEDIMENTO/RETORNO sem todos os reminders
    const where: any = {
      start_at: { gte: new Date() },
      type: { in: ['CONSULTA', 'PROCEDIMENTO', 'RETORNO'] },
      status: { notIn: ['CANCELADO', 'CONCLUIDO'] },
      lead_id: { not: null },
    };
    if (opts.tenant_id) {
      where.OR = [{ tenant_id: opts.tenant_id }, { tenant_id: null }];
    }

    const events = await this.prisma.calendarEvent.findMany({
      where,
      include: { reminders: { select: { minutes_before: true } } },
      orderBy: { start_at: 'asc' },
    });

    let createdCount = 0;
    let enqueuedCount = 0;
    const created: { event_id: string; reminder_id: string; minutes_before: number }[] = [];

    for (const ev of events) {
      const existing = new Set(ev.reminders.map((r) => r.minutes_before));
      const toCreate = defaults.filter((m) => !existing.has(m));
      if (toCreate.length === 0) continue;

      if (opts.dry_run) {
        createdCount += toCreate.length;
        continue;
      }

      // Cria reminders no banco
      for (const minutes of toCreate) {
        try {
          const reminder = await this.prisma.eventReminder.create({
            data: {
              event_id: ev.id,
              minutes_before: minutes,
              channel: 'WHATSAPP',
            },
          });
          created.push({ event_id: ev.id, reminder_id: reminder.id, minutes_before: minutes });
          createdCount++;
        } catch (e: any) {
          this.logger.warn(`[BACKFILL] Falha ao criar reminder ${minutes}min pro evento ${ev.id}: ${e.message}`);
        }
      }
    }

    // 2. Enfileira tudo no BullMQ (mesma logica do enqueueReminders)
    if (!opts.dry_run) {
      for (const c of created) {
        const ev = events.find((e) => e.id === c.event_id);
        if (!ev) continue;
        const triggerAt = ev.start_at.getTime() - c.minutes_before * 60 * 1000;
        const delay = Math.max(triggerAt - Date.now(), 1000);
        const jobId = `reminder-${c.reminder_id}`;
        try {
          // Remove job antigo se existir (idempotencia)
          try {
            const old = await this.reminderQueue.getJob(jobId);
            if (old) await old.remove();
          } catch {}
          await this.reminderQueue.add(
            'send-reminder',
            { reminderId: c.reminder_id, eventId: c.event_id, channel: 'WHATSAPP' },
            {
              delay,
              jobId,
              attempts: 3,
              backoff: { type: 'exponential', delay: 5000 },
              removeOnComplete: true,
              removeOnFail: 50,
            },
          );
          enqueuedCount++;
        } catch (e: any) {
          this.logger.warn(`[BACKFILL] Falha ao enfileirar reminder ${c.reminder_id}: ${e.message}`);
        }
      }
    }

    this.logger.log(
      `[BACKFILL] eventos=${events.length}, reminders_criados=${createdCount}, enfileirados=${enqueuedCount}, dry_run=${opts.dry_run ?? false}`,
    );

    return {
      events_scanned: events.length,
      reminders_created: createdCount,
      jobs_enqueued: enqueuedCount,
      dry_run: opts.dry_run ?? false,
    };
  }

  // ─── Metricas de Agendamento (Onda 5e v18, Fase C.2) ────────────────
  // Conta CONSULTAs por status no periodo especificado e calcula taxas
  // (% confirmacao, % no-show, etc). Usado pelo dashboard pra dar feedback
  // ao admin sobre saude operacional da agenda.

  async getAgendaMetrics(opts: { from?: string; to?: string; tenant_id?: string }) {
    const from = opts.from ? new Date(opts.from) : new Date(new Date().setDate(new Date().getDate() - 30));
    const to = opts.to ? new Date(opts.to) : new Date();

    const where: any = {
      type: 'CONSULTA',
      start_at: { gte: from, lte: to },
    };
    if (opts.tenant_id) {
      where.OR = [{ tenant_id: opts.tenant_id }, { tenant_id: null }];
    }

    // Agrupa por status (uma query so)
    const grouped = await this.prisma.calendarEvent.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    });

    const counts: Record<string, number> = {
      AGENDADO: 0,
      CONFIRMADO: 0,
      COMPARECEU: 0,
      CONCLUIDO: 0,
      CANCELADO: 0,
      NO_SHOW: 0,
      ADIADO: 0,
    };
    for (const g of grouped) {
      counts[g.status] = g._count._all;
    }

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const totalNaoCancelado = total - counts.CANCELADO;
    const concluidoOuCompareceu = counts.CONCLUIDO + counts.COMPARECEU;

    // Pra "% confirmacao" considera CONFIRMADO + COMPARECEU + CONCLUIDO
    // (todos os que de alguma forma confirmaram presenca)
    const confirmedTotal = counts.CONFIRMADO + counts.COMPARECEU + counts.CONCLUIDO;

    const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 100));

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      total,
      counts,
      rates: {
        confirmacao_pct: pct(confirmedTotal, totalNaoCancelado),
        no_show_pct: pct(counts.NO_SHOW, totalNaoCancelado),
        cancelamento_pct: pct(counts.CANCELADO, total),
        comparecimento_pct: pct(concluidoOuCompareceu, totalNaoCancelado),
        aguardando_confirmacao: counts.AGENDADO,
      },
    };
  }

  // ─── Holidays ─────────────────────────────────────────

  async findHolidays(tenantId?: string) {
    // Fase 25 (Onda 5e v8) — inclui feriados globais (tenant_id = NULL,
    // tipicamente feriados nacionais semeados via SQL) E os do tenant
    // especifico (ex: aniversario da clinica). Sem o OR, feriados globais
    // ficavam invisiveis pro frontend.
    return this.prisma.holiday.findMany({
      where: tenantId
        ? { OR: [{ tenant_id: tenantId }, { tenant_id: null }] }
        : {},
      orderBy: { date: 'asc' },
    });
  }

  async createHoliday(data: { date: string; name: string; recurring_yearly?: boolean; tenant_id?: string }) {
    return this.prisma.holiday.create({
      data: {
        date: new Date(data.date),
        name: data.name,
        recurring_yearly: data.recurring_yearly ?? false,
        tenant_id: data.tenant_id,
      },
    });
  }

  async updateHoliday(id: string, data: { date?: string; name?: string; recurring_yearly?: boolean }) {
    const updateData: any = {};
    if (data.date) updateData.date = new Date(data.date);
    if (data.name !== undefined) updateData.name = data.name;
    if (data.recurring_yearly !== undefined) updateData.recurring_yearly = data.recurring_yearly;
    return this.prisma.holiday.update({ where: { id }, data: updateData });
  }

  async deleteHoliday(id: string) {
    await this.prisma.holiday.delete({ where: { id } });
    return { deleted: true };
  }

  // ─── Schedule Blocks (Fase 25 — Onda 5e v9) ───────────
  // Bloqueio pontual de agenda do dentista (ferias, doenca, curso).
  // Diferente de UserSchedule (recorrente semanal), aqui sao janelas
  // com data inicio/fim. IA respeita em check_availability + book_appointment.

  async findScheduleBlocks(filters?: { user_id?: string; from?: string; to?: string; tenant_id?: string }) {
    const where: any = {};
    if (filters?.user_id) where.user_id = filters.user_id;
    if (filters?.tenant_id) where.tenant_id = filters.tenant_id;
    // Janela: bloqueios que SE SOBREPOEM ao intervalo from..to
    if (filters?.from || filters?.to) {
      const from = filters.from ? new Date(filters.from) : new Date('1970-01-01');
      const to = filters.to ? new Date(filters.to) : new Date('2099-12-31');
      where.AND = [{ start_at: { lte: to } }, { end_at: { gte: from } }];
    }
    return this.prisma.scheduleBlock.findMany({
      where,
      orderBy: { start_at: 'asc' },
      include: {
        user: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
      },
    });
  }

  async createScheduleBlock(data: {
    user_id: string;
    start_at: string;
    end_at: string;
    all_day?: boolean;
    reason: string;
    notes?: string;
    created_by?: string;
    tenant_id?: string;
  }) {
    return this.prisma.scheduleBlock.create({
      data: {
        user_id: data.user_id,
        start_at: new Date(data.start_at),
        end_at: new Date(data.end_at),
        all_day: data.all_day ?? false,
        reason: data.reason,
        notes: data.notes,
        created_by: data.created_by,
        tenant_id: data.tenant_id,
      },
      include: { user: { select: { id: true, name: true } } },
    });
  }

  async updateScheduleBlock(
    id: string,
    data: { start_at?: string; end_at?: string; all_day?: boolean; reason?: string; notes?: string },
  ) {
    const updateData: any = {};
    if (data.start_at) updateData.start_at = new Date(data.start_at);
    if (data.end_at) updateData.end_at = new Date(data.end_at);
    if (data.all_day !== undefined) updateData.all_day = data.all_day;
    if (data.reason !== undefined) updateData.reason = data.reason;
    if (data.notes !== undefined) updateData.notes = data.notes;
    return this.prisma.scheduleBlock.update({ where: { id }, data: updateData });
  }

  async deleteScheduleBlock(id: string) {
    await this.prisma.scheduleBlock.delete({ where: { id } });
    return { deleted: true };
  }

  private async isHoliday(date: Date, tenantId?: string): Promise<boolean> {
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    // Filtro de tenant: feriados globais (tenant_id NULL) + feriados do tenant
    const tenantFilter = tenantId
      ? { OR: [{ tenant_id: tenantId }, { tenant_id: null }] }
      : {};

    // Check exact date holidays
    const exactMatch = await this.prisma.holiday.findFirst({
      where: {
        date: { gte: dayStart, lte: dayEnd },
        recurring_yearly: false,
        ...tenantFilter,
      },
    });
    if (exactMatch) return true;

    // Check recurring yearly holidays (same month + day, any year)
    const month = date.getMonth() + 1;
    const day = date.getDate();
    if (tenantId) {
      const recurringMatch = await this.prisma.$queryRaw`
        SELECT id FROM "Holiday"
        WHERE recurring_yearly = true
          AND EXTRACT(MONTH FROM date) = ${month}
          AND EXTRACT(DAY FROM date) = ${day}
          AND (tenant_id = ${tenantId} OR tenant_id IS NULL)
        LIMIT 1
      ` as any[];
      return recurringMatch.length > 0;
    }
    const recurringMatch = await this.prisma.$queryRaw`
      SELECT id FROM "Holiday"
      WHERE recurring_yearly = true
        AND EXTRACT(MONTH FROM date) = ${month}
        AND EXTRACT(DAY FROM date) = ${day}
      LIMIT 1
    ` as any[];
    return recurringMatch.length > 0;
  }

  // ─── Recurrence ───────────────────────────────────────

  async expandRecurrence(parentEvent: any) {
    const rule = parentEvent.recurrence_rule;
    if (!rule) return [];

    const startAt = new Date(parentEvent.start_at);
    const endAt = parentEvent.end_at ? new Date(parentEvent.end_at) : null;

    // Calcular duração: prioridade → end_at, appointment_type.duration, fallback 30min
    let duration: number;
    if (endAt) {
      duration = endAt.getTime() - startAt.getTime();
    } else if (parentEvent.appointment_type_id) {
      const apptType = parentEvent.appointment_type?.duration
        ?? (await this.prisma.appointmentType.findUnique({
            where: { id: parentEvent.appointment_type_id },
            select: { duration: true },
          }))?.duration;
      duration = (apptType || 30) * 60 * 1000;
    } else {
      duration = 30 * 60 * 1000;
    }
    const recurrenceEnd = parentEvent.recurrence_end
      ? new Date(parentEvent.recurrence_end)
      : new Date(startAt.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 dias

    const dates: Date[] = [];
    let cursor = new Date(startAt);

    const advanceCursor = () => {
      switch (rule) {
        case 'DAILY':
          cursor.setDate(cursor.getDate() + 1);
          break;
        case 'WEEKLY':
          cursor.setDate(cursor.getDate() + 7);
          break;
        case 'BIWEEKLY':
          cursor.setDate(cursor.getDate() + 14);
          break;
        case 'MONTHLY':
          cursor.setMonth(cursor.getMonth() + 1);
          break;
        case 'CUSTOM':
          cursor.setDate(cursor.getDate() + 1);
          break;
      }
    };

    // Gerar datas (pular a primeira que ja e o pai)
    advanceCursor();
    while (cursor <= recurrenceEnd && dates.length < 365) {
      if (rule === 'CUSTOM') {
        const dow = cursor.getDay();
        if ((parentEvent.recurrence_days || []).includes(dow)) {
          dates.push(new Date(cursor));
        }
      } else {
        dates.push(new Date(cursor));
      }
      advanceCursor();
    }

    // Criar instancias filhas em batch
    if (dates.length === 0) return [];

    // Buscar lembretes do evento pai para replicar nos filhos
    const parentReminders = parentEvent.reminders?.length
      ? parentEvent.reminders
      : await this.prisma.eventReminder.findMany({
          where: { event_id: parentEvent.id },
          select: { minutes_before: true, channel: true },
        });

    // Processar em lotes de 20 para não sobrecarregar o pool de conexões do DB
    const BATCH_SIZE = 20;
    const children: any[] = [];
    const createChild = async (d: Date) => {
      const childStart = new Date(d);
      childStart.setHours(startAt.getHours(), startAt.getMinutes(), startAt.getSeconds());
      const childEnd = new Date(childStart.getTime() + duration);

      const child = await this.prisma.calendarEvent.create({
        data: {
          type: parentEvent.type,
          title: parentEvent.title,
          description: parentEvent.description,
          start_at: childStart,
          end_at: childEnd,
          all_day: parentEvent.all_day,
          status: parentEvent.status || 'AGENDADO',
          priority: parentEvent.priority || 'NORMAL',
          color: parentEvent.color,
          location: parentEvent.location,
          lead_id: parentEvent.lead_id,
          assigned_user_id: parentEvent.assigned_user_id,
          created_by_id: parentEvent.created_by_id,
          appointment_type_id: parentEvent.appointment_type_id,
          tenant_id: parentEvent.tenant_id,
          parent_event_id: parentEvent.id,
          // Replicar lembretes do pai nos filhos
          ...(parentReminders.length > 0
            ? {
                reminders: {
                  create: parentReminders.map((r: any) => ({
                    minutes_before: r.minutes_before,
                    channel: r.channel ?? 'PUSH',
                  })),
                },
              }
            : {}),
        },
        include: { reminders: true },
      });

      // Enfileirar lembretes WhatsApp/Email para o filho
      if (child.reminders?.length) {
        await this.enqueueReminders(child.id, child.start_at, child.reminders);
      }

      return child;
    };

    for (let i = 0; i < dates.length; i += BATCH_SIZE) {
      const batch = dates.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(createChild));
      children.push(...batchResults);
    }

    this.logger.log(`Criadas ${children.length} instancias recorrentes (com lembretes) para evento ${parentEvent.id}`);
    return children;
  }

  async updateRecurrenceAll(parentId: string, data: any) {
    // Atualizar pai
    const parent = await this.update(parentId, data);
    // Atualizar todos os filhos
    const updateData: any = {};
    if (data.title !== undefined) updateData.title = data.title;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.type !== undefined) updateData.type = data.type;
    if (data.priority !== undefined) updateData.priority = data.priority;
    if (data.location !== undefined) updateData.location = data.location;
    if (data.assigned_user_id !== undefined) updateData.assigned_user_id = data.assigned_user_id;

    if (Object.keys(updateData).length > 0) {
      await this.prisma.calendarEvent.updateMany({
        where: { parent_event_id: parentId },
        data: updateData,
      });
    }
    return parent;
  }

  async removeRecurrenceAll(parentId: string) {
    // Deletar filhos primeiro, depois o pai
    await this.prisma.calendarEvent.deleteMany({ where: { parent_event_id: parentId } });
    await this.prisma.calendarEvent.delete({ where: { id: parentId } });
    return { deleted: true };
  }

  // ─── Search ───────────────────────────────────────────

  async search(query: string, tenantId?: string) {
    return this.prisma.calendarEvent.findMany({
      where: {
        ...(tenantId ? { tenant_id: tenantId } : {}),
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } },
        ],
      },
      include: {
        assigned_user: { select: { id: true, name: true } },
        lead: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { start_at: 'desc' },
      take: 20,
    });
  }

  // ─── ICS Export ───────────────────────────────────────

  async exportICS(eventIds: string[]): Promise<string> {
    const events = await this.prisma.calendarEvent.findMany({
      where: { id: { in: eventIds } },
      include: {
        assigned_user: { select: { name: true } },
        lead: { select: { name: true } },
      },
    });

    // UTC naive: datas armazenadas como horário local em UTC — extrair componentes UTC
    // O TZID no ICS é America/Sao_Paulo, então os valores devem ser horário local (= UTC raw)
    const formatIcsLocalDate = (d: Date) => {
      const y = d.getUTCFullYear();
      const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
      const da = String(d.getUTCDate()).padStart(2, '0');
      const h = String(d.getUTCHours()).padStart(2, '0');
      const mi = String(d.getUTCMinutes()).padStart(2, '0');
      const s = String(d.getUTCSeconds()).padStart(2, '0');
      return `${y}${mo}${da}T${h}${mi}${s}`;
    };

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//LexCRM//Calendar//PT',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      // VTIMEZONE para America/Sao_Paulo
      'BEGIN:VTIMEZONE',
      'TZID:America/Sao_Paulo',
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:-0300',
      'TZOFFSETTO:-0300',
      'TZNAME:BRT',
      'END:STANDARD',
      'END:VTIMEZONE',
    ];

    for (const evt of events) {
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${evt.id}@lexcrm`);
      lines.push(`DTSTART;TZID=America/Sao_Paulo:${formatIcsLocalDate(evt.start_at)}`);
      if (evt.end_at) lines.push(`DTEND;TZID=America/Sao_Paulo:${formatIcsLocalDate(evt.end_at)}`);
      lines.push(`SUMMARY:${(evt.title || '').replace(/[,;\\]/g, ' ')}`);
      if (evt.description) lines.push(`DESCRIPTION:${evt.description.replace(/\n/g, '\\n').replace(/[,;\\]/g, ' ')}`);
      if (evt.location) lines.push(`LOCATION:${evt.location.replace(/[,;\\]/g, ' ')}`);
      lines.push(`STATUS:${evt.status === 'CONFIRMADO' ? 'CONFIRMED' : evt.status === 'CANCELADO' ? 'CANCELLED' : 'TENTATIVE'}`);
      lines.push(`CREATED:${formatIcsLocalDate(evt.created_at)}`);
      lines.push(`LAST-MODIFIED:${formatIcsLocalDate(evt.updated_at)}`);
      lines.push('END:VEVENT');
    }

    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  // ─── Ownership Check ──────────────────────────────────

  async checkOwnership(eventId: string, userId: string, userRoles: string | string[], tenantId?: string): Promise<boolean> {
    const event = await this.prisma.calendarEvent.findUnique({
      where: { id: eventId },
      select: { created_by_id: true, assigned_user_id: true, tenant_id: true },
    });
    if (!event) throw new NotFoundException('Evento nao encontrado');
    // Tenant isolation check
    if (tenantId && event.tenant_id && event.tenant_id !== tenantId) return false;
    // ADMIN/OPERADOR (secretaria)/ASSISTANT enxergam e mexem em qualquer
    // evento do tenant. DENTIST/FINANCEIRO so se for owner ou assigned.
    if (canViewAllAgenda(userRoles)) return true;
    return event.created_by_id === userId ||
      (event.assigned_user_id !== null && event.assigned_user_id === userId);
  }

  // ─── Comments ─────────────────────────────────────────

  async addComment(eventId: string, userId: string, text: string) {
    const comment = await (this.prisma as any).calendarEventComment.create({
      data: { event_id: eventId, user_id: userId, text },
      include: { user: { select: { id: true, name: true } } },
    });

    // Notificar assigned e creator (exceto quem comentou)
    const event = await this.prisma.calendarEvent.findUnique({
      where: { id: eventId },
      select: { assigned_user_id: true, created_by_id: true, title: true },
    });
    if (event) {
      const notifyIds = new Set<string>();
      if (event.assigned_user_id && event.assigned_user_id !== userId) notifyIds.add(event.assigned_user_id);
      if (event.created_by_id !== userId) notifyIds.add(event.created_by_id);
      for (const uid of notifyIds) {
        try {
          this.chatGateway.emitCalendarUpdate(uid, {
            eventId,
            action: 'comment_added',
            title: event.title ?? '',
          });
        } catch {}
      }
    }

    return comment;
  }

  async findComments(eventId: string) {
    return (this.prisma as any).calendarEventComment.findMany({
      where: { event_id: eventId },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { created_at: 'asc' },
    });
  }

  // ─── Migrate Tasks ────────────────────────────────────

  async migrateOrphanTasks() {
    const orphanTasks = await this.prisma.task.findMany({
      where: { calendar_event_id: null },
      include: { comments: true },
    });

    let migrated = 0;
    for (const task of orphanTasks) {
      const creatorId = task.assigned_user_id || (await this.prisma.user.findFirst({ where: { roles: { has: 'ADMIN' } }, select: { id: true } }))?.id;
      if (!creatorId) continue;

      const event = await this.prisma.calendarEvent.create({
        data: {
          type: 'TAREFA',
          title: task.title,
          description: task.description,
          start_at: task.due_at || task.created_at,
          end_at: task.due_at ? new Date(task.due_at.getTime() + 30 * 60000) : null,
          status: task.status === 'CONCLUIDO' || task.status === 'CONCLUIDA' ? 'CONCLUIDO'
                : task.status === 'CANCELADA' ? 'CANCELADO'
                : 'AGENDADO',
          assigned_user_id: task.assigned_user_id,
          created_by_id: creatorId,
          lead_id: task.lead_id,
          conversation_id: task.conversation_id,
          tenant_id: task.tenant_id,
        },
      });

      await this.prisma.task.update({
        where: { id: task.id },
        data: { calendar_event_id: event.id },
      });

      // Migrar comentários
      for (const c of task.comments) {
        await (this.prisma as any).calendarEventComment.create({
          data: { event_id: event.id, user_id: c.user_id, text: c.text, created_at: c.created_at },
        });
      }
      migrated++;
    }

    // Migrar comentários de tasks já vinculadas
    const linkedTasks = await this.prisma.task.findMany({
      where: { calendar_event_id: { not: null } },
      include: { comments: true },
    });
    let commentsMigrated = 0;
    for (const task of linkedTasks) {
      for (const c of task.comments) {
        const exists = await (this.prisma as any).calendarEventComment.findFirst({
          where: { event_id: task.calendar_event_id!, user_id: c.user_id, text: c.text },
        });
        if (!exists) {
          await (this.prisma as any).calendarEventComment.create({
            data: { event_id: task.calendar_event_id!, user_id: c.user_id, text: c.text, created_at: c.created_at },
          });
          commentsMigrated++;
        }
      }
    }

    return { orphanTasksMigrated: migrated, commentsMigrated };
  }

  // ─── Re-envio manual de notificação ──────────────────────────────────────────

  async notifyEvent(eventId: string): Promise<{ queued: boolean; message: string }> {
    const event = await this.prisma.calendarEvent.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        type: true,
        status: true,
        title: true,
        lead: { select: { phone: true } },
      },
    });

    if (!event) {
      throw new NotFoundException(`Evento ${eventId} não encontrado`);
    }

    if (!['AUDIENCIA', 'PERICIA'].includes(event.type)) {
      throw new BadRequestException(
        `Notificação manual disponível apenas para Audiência e Perícia (tipo atual: ${event.type})`,
      );
    }

    if (!event.lead?.phone) {
      throw new BadRequestException(
        'Cliente vinculado ao evento não possui telefone cadastrado',
      );
    }

    if (['CANCELADO', 'CONCLUIDO'].includes(event.status)) {
      throw new BadRequestException(
        `Evento está ${event.status} — notificação não enviada`,
      );
    }

    // Remove job pendente anterior para evitar duplicata
    try {
      const existing = await this.reminderQueue.getJob(`hearing-notify-${eventId}`);
      if (existing) await existing.remove();
    } catch {}

    // Enfileira sem delay (envio imediato)
    await this.reminderQueue.add(
      'notify-hearing-scheduled',
      { eventId },
      {
        jobId: `hearing-notify-manual-${eventId}-${Date.now()}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );

    this.logger.log(`[NOTIFY] Re-envio manual enfileirado para evento ${eventId} (${event.type}: "${event.title}")`);
    return { queued: true, message: `Notificação de ${event.type === 'PERICIA' ? 'perícia' : 'audiência'} enfileirada com sucesso` };
  }

  // ─── Atendimentos pendentes de validacao (Fase 23 PR2) ───────────
  //
  // Lista eventos clinicos passados (start_at < now) que ainda nao foram
  // validados. Filtros: meusOnly (so atendimentos do dentista logado) ou
  // todos (admin ve tudo). Util pro dashboard "limpeza fim de dia".
  async listPendingValidation(params: {
    tenantId: string;
    actorUserId: string;
    isAdmin: boolean;
    onlyMine?: boolean;
    daysBack?: number;
  }) {
    const daysBack = Math.min(90, Math.max(1, params.daysBack || 30));
    const cutoffStart = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const now = new Date();

    // Se nao for admin, sempre filtra so os dele (regra de seguranca)
    const filterByUser = !params.isAdmin || params.onlyMine;

    return this.prisma.calendarEvent.findMany({
      where: {
        tenant_id: params.tenantId,
        type: { in: ['CONSULTA', 'PROCEDIMENTO', 'RETORNO'] },
        validated_at: null,
        start_at: { gte: cutoffStart, lte: now },
        // status nao deve ser CANCELADO/ADIADO (esses nao precisam validar)
        status: { notIn: ['CANCELADO', 'ADIADO'] },
        ...(filterByUser ? { assigned_user_id: params.actorUserId } : {}),
        ...(filterByUser ? {} : { assigned_user_id: { not: null } }),
      },
      select: {
        id: true, type: true, title: true, status: true,
        start_at: true, end_at: true,
        assigned_user_id: true,
        assigned_user: { select: { id: true, name: true } },
        patient: { select: { id: true, name: true, phone: true } },
        lead: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { start_at: 'desc' },
      take: 200,
    });
  }

  // ─── Validacao clinica (Fase 23) ──────────────────────────────────
  //
  // Workflow: dentista atribuido (assigned_user) ATESTA que o atendimento
  // realmente aconteceu, separando a validacao clinica do simples
  // status=CONCLUIDO marcado pela recepcao.
  //
  // Permissoes:
  //  - validate(): dentista atribuido OU admin
  //  - unvalidate(): so admin (recepcao/dentista nao podem desfazer)
  //
  // Side effects ao validar:
  //  - status vira CONCLUIDO se ainda nao for (dispara hook das visit dates)
  //  - last_visit_at do paciente atualiza automaticamente
  //  - Notifica o paciente via socket (assigned_user dashboard refresh)

  async validate(
    eventId: string,
    actorUserId: string,
    isAdmin: boolean,
    notes?: string,
  ) {
    const event = await this.prisma.calendarEvent.findUnique({
      where: { id: eventId },
      select: {
        id: true, type: true, status: true, start_at: true, patient_id: true,
        assigned_user_id: true, validated_at: true,
      },
    });
    if (!event) throw new NotFoundException('Evento nao encontrado');
    if (event.validated_at) {
      throw new BadRequestException('Este atendimento ja foi validado');
    }
    if (!event.assigned_user_id) {
      throw new BadRequestException(
        'Atendimento sem dentista responsavel atribuido — atribua antes de validar',
      );
    }
    // Permissao: so o assigned_user OU admin
    if (event.assigned_user_id !== actorUserId && !isAdmin) {
      throw new ForbiddenException(
        'Apenas o dentista responsavel pelo atendimento pode valida-lo. ' +
        'Se precisa que outra pessoa valide, peca a um administrador.',
      );
    }

    // Atualiza tudo numa transacao (validation + status CONCLUIDO se necessario)
    const newStatus = event.status === 'CONCLUIDO' ? event.status : 'CONCLUIDO';
    const validated = await this.prisma.calendarEvent.update({
      where: { id: eventId },
      data: {
        validated_at: new Date(),
        validated_by_user_id: actorUserId,
        validation_notes: notes?.trim() || null,
        status: newStatus,
      },
      include: {
        validated_by: { select: { id: true, name: true } },
        assigned_user: { select: { id: true, name: true } },
      },
    });

    // Atualiza visit dates do paciente (mesmo hook do updateStatus)
    if (validated.patient_id && this.isClinicalEvent(validated.type) && validated.start_at) {
      await this.updatePatientVisitDates(validated.patient_id, validated.start_at).catch(() => {});
    }

    // Onda 5e v32 (Fase 25) — auto-conversao Lead → Patient quando dentista
    // valida atendimento clinico. Lead vira paciente da clinica
    // automaticamente (idempotente).
    if (this.isClinicalEvent(validated.type)) {
      await this.autoEnsurePatientFromEvent(eventId);
    }

    // Notifica via socket pra refresh em tempo real
    if (validated.assigned_user_id) {
      try {
        this.chatGateway.emitCalendarUpdate(validated.assigned_user_id, {
          eventId,
          action: 'validated',
          title: validated.title,
          type: validated.type,
        });
      } catch {}
    }

    this.logger.log(
      `[VALIDATE] Evento ${eventId} validado por user ${actorUserId} (admin=${isAdmin})`,
    );
    return validated;
  }

  async unvalidate(eventId: string, isAdmin: boolean) {
    if (!isAdmin) {
      throw new ForbiddenException('Apenas administradores podem reverter validacao clinica');
    }
    const event = await this.prisma.calendarEvent.findUnique({
      where: { id: eventId },
      select: { id: true, validated_at: true, assigned_user_id: true, type: true, title: true },
    });
    if (!event) throw new NotFoundException('Evento nao encontrado');
    if (!event.validated_at) {
      throw new BadRequestException('Este atendimento ainda nao foi validado');
    }

    const reverted = await this.prisma.calendarEvent.update({
      where: { id: eventId },
      data: {
        validated_at: null,
        validated_by_user_id: null,
        validation_notes: null,
      },
    });

    if (reverted.assigned_user_id) {
      try {
        this.chatGateway.emitCalendarUpdate(reverted.assigned_user_id, {
          eventId,
          action: 'unvalidated',
          title: reverted.title,
          type: reverted.type,
        });
      } catch {}
    }

    this.logger.log(`[UNVALIDATE] Evento ${eventId} validacao revertida pelo admin`);
    return reverted;
  }

  // ─── Patient visit dates helpers ──────────────────────────────────
  //
  // Mantém Patient.first_visit_at e last_visit_at atualizados conforme
  // CalendarEvents do tipo CONSULTA/PROCEDIMENTO/RETORNO mudam pra
  // CONFIRMADO/CONCLUIDO. Antes desses hooks os campos existiam no
  // schema mas nunca eram preenchidos (relatórios e Resumo Clínico
  // sempre mostravam "—").

  /** Tipos de evento que contam como "visita do paciente" */
  private isClinicalEvent(type: string): boolean {
    return ['CONSULTA', 'PROCEDIMENTO', 'RETORNO'].includes(type);
  }

  /**
   * Onda 17.32.181 — E-mail automatico "consulta agendada".
   * Best-effort: resolve o e-mail do paciente (ou do lead) e dispara.
   * Qualquer falha so loga — criar o evento nunca quebra por e-mail.
   */
  private async sendAppointmentCreatedEmail(
    event: any,
    patientId: string | null | undefined,
    leadId: string | null | undefined,
    tenantId: string,
  ): Promise<void> {
    try {
      let toEmail: string | null = null;
      let toName: string | null = null;
      if (patientId) {
        const patient = await this.prisma.patient.findUnique({
          where: { id: patientId },
          select: { name: true, email: true },
        });
        toEmail = patient?.email || null;
        toName = patient?.name || null;
      }
      if (!toEmail && leadId) {
        const lead = await this.prisma.lead.findUnique({
          where: { id: leadId },
          select: { name: true, email: true },
        });
        toEmail = lead?.email || null;
        toName = toName || lead?.name || null;
      }
      if (!toEmail) return;

      const tz = 'America/Maceio';
      const startAt = new Date(event.start_at);
      await this.emailAutomation.dispatch('agendamento_criado', tenantId, toEmail, {
        paciente_nome: toName || '',
        data: startAt.toLocaleDateString('pt-BR', { timeZone: tz }),
        hora: startAt.toLocaleTimeString('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit' }),
        profissional_nome: event.assigned_user?.name || '',
        titulo: event.title || '',
      });
    } catch (e: any) {
      this.logger.warn(`[AUTO-MAIL] agendamento_criado falhou: ${e?.message}`);
    }
  }

  /**
   * Onda 17.59 — Notificação imediata por WhatsApp "consulta agendada" (odonto),
   * espelhando o e-mail. Best-effort: resolve telefone do paciente (ou lead),
   * usa o endereço cadastrado da clínica no {local}, e manda na instância do
   * tenant. sendText já adiciona o 55. Falha só loga — criar evento nunca quebra.
   */
  private async sendAppointmentCreatedWhatsapp(
    event: any,
    patientId: string | null | undefined,
    leadId: string | null | undefined,
    tenantId: string,
  ): Promise<void> {
    try {
      // Onda 17.59 — prioriza o TELEFONE DO PACIENTE (é o alvo de "agende um
      // paciente com contato X"); cai pro lead se o paciente não tiver.
      let phone: string | null = null;
      let name: string | null = null;
      if (patientId) {
        const patient = await this.prisma.patient.findUnique({
          where: { id: patientId },
          select: { name: true, phone: true },
        });
        phone = patient?.phone || null;
        name = patient?.name || null;
      }
      if (!phone) { phone = event.lead?.phone || null; name = name || event.lead?.name || null; }
      if (!phone && leadId && !event.lead) {
        const lead = await this.prisma.lead.findUnique({
          where: { id: leadId },
          select: { name: true, phone: true },
        });
        phone = lead?.phone || null;
        name = name || lead?.name || null;
      }
      if (!phone) {
        // Diagnóstico: o e-mail saiu (tem e-mail) mas o paciente/lead não tem
        // TELEFONE no cadastro — por isso o WhatsApp não vai.
        this.logger.warn(`[AUTO-WPP] agendamento_criado: paciente/lead SEM telefone no cadastro (evento ${event.id}) — só o e-mail saiu`);
        return;
      }

      const instanceName = await this.resolveTenantWhatsappInstance(tenantId);
      if (!instanceName) {
        this.logger.warn(`[AUTO-WPP] agendamento_criado: sem instância WhatsApp pro tenant ${tenantId}`);
        return;
      }

      // Mesma leitura de hora dos outros disparos (naive-local-as-UTC).
      const startAt = new Date(event.start_at);
      const dateStr = `${String(startAt.getUTCDate()).padStart(2, '0')}/${String(startAt.getUTCMonth() + 1).padStart(2, '0')}`;
      const horaStr = `${String(startAt.getUTCHours()).padStart(2, '0')}:${String(startAt.getUTCMinutes()).padStart(2, '0')}`;
      const nome = (name || 'paciente').split(' ')[0];

      const dentistaFull = event.assigned_user?.name || '';
      const dParts = dentistaFull.split(' ');
      const dentista = dParts.length >= 3 ? `${dParts[0]} ${dParts[1]}` : dentistaFull;

      const { formatTenantAddress } = await import('@crm/shared');
      const tenantRow = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          address: true, address_number: true, address_complement: true,
          neighborhood: true, city: true, state: true,
        },
      }).catch(() => null);
      const local = event.location || formatTenantAddress(tenantRow);
      const localLine = local ? `📍 ${local}\n` : '';

      const msg =
        `Olá ${nome}! 😊\n\n` +
        `Sua consulta foi agendada para *${dateStr}* às *${horaStr}*` +
        `${dentista ? ` com ${dentista}` : ''}.\n` +
        localLine +
        `\nQualquer dúvida, é só chamar por aqui!`;

      await this.whatsapp.sendText(phone, msg, instanceName, undefined, tenantId);
      this.logger.log(`[AUTO-WPP] agendamento_criado enviado ao paciente (evento ${event.id})`);
    } catch (e: any) {
      this.logger.warn(`[AUTO-WPP] agendamento_criado falhou: ${e?.message}`);
    }
  }

  /**
   * Atualiza first_visit_at (se ainda NULL) e last_visit_at (se mais
   * recente que o atual). Idempotente — pode ser chamado várias vezes
   * com a mesma data sem efeito colateral.
   */
  private async updatePatientVisitDates(patientId: string, visitDate: Date): Promise<void> {
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { first_visit_at: true, last_visit_at: true },
    });
    if (!patient) return;

    const updateData: { first_visit_at?: Date; last_visit_at?: Date } = {};

    // first_visit_at: preenche só se ainda está NULL OU se essa visita é mais antiga
    if (!patient.first_visit_at || visitDate < patient.first_visit_at) {
      updateData.first_visit_at = visitDate;
    }

    // last_visit_at: atualiza se essa visita é mais recente
    if (!patient.last_visit_at || visitDate > patient.last_visit_at) {
      updateData.last_visit_at = visitDate;
    }

    if (Object.keys(updateData).length > 0) {
      await this.prisma.patient.update({ where: { id: patientId }, data: updateData });
      this.logger.log(`[VISIT_DATES] Paciente ${patientId} atualizado: ${JSON.stringify(updateData)}`);
    }
  }
}
