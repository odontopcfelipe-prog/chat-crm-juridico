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
  'CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA', 'BLOQUEIO', 'TAREFA', 'OUTRO',
  'AUDIENCIA', 'PERICIA', 'PRAZO',
] as const;
// Onda 17.61 — fluxo de recepção mais rico: + COMPARECEU (paciente chegou),
// EM_ATENDIMENTO e NO_SHOW (faltou). DESMARCOU usa CANCELADO (mesmo efeito: libera
// o slot / dispara lista de espera). Os já-existentes (CANCELADO/CONCLUIDO/ADIADO)
// seguem com a mesma lógica de disparo/waitlist; os novos são estados intermediários.
const EVENT_STATUSES = ['AGENDADO', 'CONFIRMADO', 'COMPARECEU', 'EM_ATENDIMENTO', 'CONCLUIDO', 'CANCELADO', 'NO_SHOW', 'ADIADO'] as const;

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
        lead: { select: { id: true, name: true, phone: true, profile_picture_url: true } },
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
        lead: { select: { id: true, name: true, phone: true, profile_picture_url: true } },
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

  /**
   * Boletos ATRASADOS (ao vivo) do paciente — mesma regra do Financeiro: em aberto
   * (PENDING/OVERDUE) + NÃO recebido em espécie + vencido (due_date < agora).
   * Cancelado (DELETED/CANCELLED/REFUNDED) e pago (RECEIVED/CONFIRMED) já ficam de
   * fora por não estarem em OPEN. Cobre os 3 vínculos charge↔paciente: patient_id
   * direto, via treatment_plan, e a cadeia do cliente do gateway (boleto importado
   * sem patient_id/plano). Usado pelo bloqueio de agendamento de devedor.
   */
  private async getPatientOverdue(
    patientId: string,
    tenantId?: string | null,
  ): Promise<{ count: number; total: number }> {
    if (!tenantId) return { count: 0, total: 0 };
    const or: any[] = [
      { patient_id: patientId },
      { treatment_plan: { patient_id: patientId } },
    ];
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { lead_id: true },
    });
    if (patient?.lead_id) {
      const custs = await this.prisma.paymentGatewayCustomer.findMany({
        where: { lead_id: patient.lead_id, tenant_id: tenantId },
        select: { external_id: true },
      });
      const extIds = custs.map((c) => c.external_id).filter(Boolean) as string[];
      if (extIds.length) or.push({ customer_external_id: { in: extIds } });
    }
    const rows = await this.prisma.paymentGatewayCharge.findMany({
      where: {
        tenant_id: tenantId,
        status: { in: ['PENDING', 'OVERDUE'] },
        received_in_cash: false,
        due_date: { lt: new Date() },
        OR: or,
      },
      select: { amount: true },
    });
    const total = rows.reduce((s, r) => s + Number(r.amount), 0);
    return { count: rows.length, total };
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
    // Bloqueio de agendamento de devedor: liberação do admin (com motivo).
    override_overdue_block?: boolean;
    override_overdue_reason?: string;
    actor_roles?: string[]; // papéis do usuário (injetado pelo controller, não do DTO)
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

    // Bloqueio de agendamento de DEVEDOR (opt-in por clínica, default OFF). Regra
    // AO VIVO: conta boletos abertos vencidos do paciente — pagar/cancelar destrava
    // sozinho (nada persistido). Bloqueia TODOS os tipos. Admin pode LIBERAR aquele
    // agendamento com MOTIVO, que fica registrado no próprio evento (auditoria).
    let overdueOverride: { by: string; reason: string } | null = null;
    if (resolvedPatientId && data.tenant_id) {
      const flag = await this.prisma.globalSetting.findUnique({
        where: { key: `BLOCK_SCHED_ON_OVERDUE_${data.tenant_id}` },
      });
      if (flag?.value === 'true') {
        const overdue = await this.getPatientOverdue(resolvedPatientId, data.tenant_id);
        if (overdue.count > 0) {
          const isAdmin = (data.actor_roles || []).some((r) => r === 'ADMIN' || r === 'SUPER_ADMIN');
          const reason = (data.override_overdue_reason || '').trim();
          if (data.override_overdue_block && isAdmin && reason) {
            overdueOverride = { by: data.created_by_id, reason };
          } else {
            const brl = overdue.total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
            throw new BadRequestException({
              code: 'SCHEDULING_BLOCKED_OVERDUE',
              message: `Paciente com ${overdue.count} boleto(s) em atraso (${brl}). Regularize no Financeiro ou peça a um administrador para liberar.`,
              overdue: { count: overdue.count, total: overdue.total },
            });
          }
        }
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
        // Auditoria da liberação de devedor (só preenchido quando um admin libera).
        overdue_override_by_user_id: overdueOverride?.by ?? null,
        overdue_override_at: overdueOverride ? new Date() : null,
        overdue_override_reason: overdueOverride?.reason ?? null,
        recurrence_rule: data.recurrence_rule,
        recurrence_end: data.recurrence_end ? new Date(data.recurrence_end) : null,
        recurrence_days: data.recurrence_days ?? [],
        reminders: data.reminders?.length
          ? {
              // Onda 18.x — DEDUP por (minutes_before, channel): sem isso, uma antecedencia
              // repetida no payload/config virava 2 EventReminder -> 2 jobs -> lembrete
              // duplicado no MESMO minuto ("cafezinho" 2x). Mantem 1 por combinacao.
              create: [
                ...new Map(
                  data.reminders.map((r) => [
                    `${r.minutes_before}:${r.channel ?? 'PUSH'}`,
                    { minutes_before: r.minutes_before, channel: r.channel ?? 'PUSH' },
                  ]),
                ).values(),
              ],
            }
          : undefined,
      },
      include: {
        assigned_user: { select: { id: true, name: true } },
        // is_client: a Agenda do Comercial roteia lead-não-cliente pro chip COMERCIAL
        lead: { select: { id: true, name: true, phone: true, is_client: true } },
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
      if (event.type === 'ORTODONTIA') {
        // Onda 18.x — ortô é por ORDEM DE CHEGADA e tem uma "Confirmação de
        // agendamento" IMEDIATA própria (texto "a partir das {hora}", sem hora
        // fixa), OPT-IN (default OFF). Só sai na hora que marca SE o toggle
        // APPOINTMENT_ORTO_IMMEDIATE_ENABLED estiver ligado na Central. O texto
        // padrão "agendada às {hora}" NUNCA é usado pra ortô (contradiz ordem de
        // chegada). Sem e-mail (o disparo de ortô é por WhatsApp).
        const imm = await this.prisma.globalSetting
          .findUnique({ where: { key: `APPOINTMENT_ORTO_IMMEDIATE_ENABLED_${data.tenant_id}` } })
          .catch(() => null);
        if (imm?.value === 'true') {
          void this.sendAppointmentEventWhatsapp(event, resolvedPatientId, resolvedLeadId, data.tenant_id, 'created');
        }
      } else {
        // Onda 18.x — o aviso imediato "sua consulta foi agendada às {hora}" agora
        // RESPEITA o toggle "Confirmação de agendamento" (APPOINTMENT_CONFIRMATION_
        // ENABLED, default LIGADO). Antes saía SEMPRE, ignorando o toggle —
        // "desliguei a confirmação e mesmo assim chegou". Desligou → não sai nem o
        // WhatsApp nem o e-mail na criação (a confirmação de 24h já era gated por
        // esta mesma key no worker).
        const conf = await this.prisma.globalSetting
          .findUnique({ where: { key: `APPOINTMENT_CONFIRMATION_ENABLED_${data.tenant_id}` } })
          .catch(() => null);
        if ((conf?.value ?? 'true') !== 'false') {
          void this.sendAppointmentEventEmail(event, resolvedPatientId, resolvedLeadId, data.tenant_id, 'agendamento_criado');
          // Onda 17.59 — notificação imediata por WhatsApp "consulta agendada"
          // (espelha o e-mail; o WhatsApp imediato antes só existia pra audiência/perícia).
          void this.sendAppointmentEventWhatsapp(event, resolvedPatientId, resolvedLeadId, data.tenant_id, 'created');
        } else if (!resolvedPatientId && resolvedLeadId && (event as any).lead?.is_client === false) {
          // Confirmação CLÍNICA desligada, mas o agendamento é de LEAD não-cliente:
          // a versão COMERCIAL tem toggle próprio. Só chama com o toggle comercial
          // LIGADO (lá dentro o ramo comercial assume — a versão clínica não vaza).
          const { comercialAgendaEnabledKey } = await import('@crm/shared');
          const cc = await this.prisma.globalSetting
            .findUnique({ where: { key: comercialAgendaEnabledKey('comercial_confirmacao', data.tenant_id) } })
            .catch(() => null);
          if (cc?.value === 'true') {
            void this.sendAppointmentEventWhatsapp(event, resolvedPatientId, resolvedLeadId, data.tenant_id, 'created');
          }
        }
      }
    }

    // Enqueue WhatsApp + Email reminders (bounded — não trava o create se o Redis pendurar)
    await this.boundedQueueOp(
      this.enqueueReminders(event.id, event.start_at, event.reminders || []),
      'enqueueReminders(create)',
    );

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

  /**
   * Onda 17.61 — Limita uma op de fila (Redis/BullMQ) por tempo. Se o Redis estiver
   * lento/indisponível, NÃO trava a resposta do save/update (o evento já foi gravado
   * no banco). Em timeout/erro, só loga — os lembretes viram best-effort em vez de
   * deixar o botão "Salvando…" preso para sempre.
   */
  private async boundedQueueOp(p: Promise<unknown>, label: string, ms = 6000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve(p).catch((e: any) =>
          this.logger.warn(`[boundedQueueOp] ${label} falhou: ${e?.message ?? e}`),
        ),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.logger.warn(`[boundedQueueOp] ${label} excedeu ${ms}ms — seguindo sem travar o save`);
            resolve();
          }, ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async enqueueReminders(eventId: string, startAt: Date, reminders: { id: string; minutes_before: number; channel: string }[]) {
    for (const r of reminders) {
      if (r.channel !== 'WHATSAPP' && r.channel !== 'EMAIL') continue; // PUSH handled by cron
      // Onda 17.59 — start_at é "naive local" gravado nos campos UTC (Maceió UTC-3).
      // Sem somar o offset, o lembrete disparava ~3h ADIANTADO (o "15 min antes"
      // caía 3h15 antes). Soma 3h pra achar o instante REAL e agendar no minuto certo.
      const MACEIO_OFFSET_MS = 3 * 60 * 60 * 1000;
      const realStartMs = startAt.getTime() + MACEIO_OFFSET_MS;
      const triggerAt = realStartMs - r.minutes_before * 60 * 1000;
      const delay = triggerAt - Date.now();
      // Agendamento RETROATIVO / no mesmo dia com o horário do lembrete já vencido:
      // NÃO enfileira. Antes o `Math.max(..., 1000)` forçava o lembrete a disparar NA
      // HORA (1s) pra um evento passado — ex.: agendamento lançado hoje pro dia 17 (pra
      // constar a visita) mandava "sua consulta é em ~1 hora" 3 dias DEPOIS. Também
      // cobre "agendado pro mesmo dia a menos de 1h": o lembrete de 1h não dá tempo,
      // então é pulado. Só enfileira lembrete cujo horário ainda está por vir (>1 min).
      if (delay < 60_000) {
        this.logger.log(`Lembrete ${r.id} PULADO (evento ${eventId}): horário já passou ou muito próximo (delay=${Math.round(delay / 1000)}s).`);
        continue;
      }
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
          // ANTI-DUPLICIDADE: 1 tentativa só. Com attempts:3, quando a Evolution
          // ENTREGA a mensagem mas responde erro/timeout, o worker marca "falha",
          // reseta sent_at=null e o BullMQ RE-ENTREGA o job → o paciente recebe o
          // MESMO lembrete/confirmação 2x quase no mesmo segundo. Sem retry, um erro
          // ambíguo não vira reenvio. Backstop da confirmação de 48h: o scheduler de
          // 24h (AppointmentConfirmation) cobre se o de 48h não sair.
          jobId,
          attempts: 1,
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
        // is_client: a Agenda do Comercial roteia lead-não-cliente pro chip COMERCIAL
        lead: { select: { id: true, name: true, phone: true, is_client: true } },
        reminders: true,
      },
    });

    // v20: trata reminders separadamente — se frontend enviou novo array,
    // substitui completamente (deleteMany + createMany). Mantem comportamento
    // antigo se nao enviar (reminders existentes ficam intactos).
    let finalReminders = event.reminders;
    if (incomingReminders !== undefined) {
      // Cancela jobs antigos no BullMQ ANTES de deletar do banco (bounded — não trava o save)
      await this.boundedQueueOp(this.cancelReminderJobs(event.id), 'cancelReminderJobs(update)');
      // Substitui no banco
      await this.prisma.eventReminder.deleteMany({ where: { event_id: event.id } });
      if (incomingReminders.length > 0) {
        // Onda 18.x — DEDUP por (minutes_before, channel) — ver create(). Evita 2
        // EventReminder identicos (lembrete duplicado no mesmo minuto).
        await this.prisma.eventReminder.createMany({
          data: [
            ...new Map(
              incomingReminders.map((r) => [
                `${r.minutes_before}:${r.channel ?? 'WHATSAPP'}`,
                { event_id: event.id, minutes_before: r.minutes_before, channel: r.channel ?? 'WHATSAPP' },
              ]),
            ).values(),
          ],
        });
      }
      // Recarrega pra ter os IDs novos pra enqueue
      finalReminders = await this.prisma.eventReminder.findMany({ where: { event_id: event.id } });
      this.logger.log(`[update] reminders substituidos pro evento ${event.id} (${incomingReminders.length} novos)`);
    }

    // Se start_at mudou OU reminders foram alterados, re-enfileirar
    const shouldReEnqueue = (data.start_at || incomingReminders !== undefined) && finalReminders?.length;
    if (shouldReEnqueue) {
      // bounded — se o Redis pendurar, o save não fica preso (lembrete vira best-effort)
      await this.boundedQueueOp(
        this.enqueueReminders(event.id, event.start_at, finalReminders),
        'enqueueReminders(update)',
      );
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

    // Onda 17.59 — CONSULTA odonto REMARCADA: avisa o paciente no WhatsApp que o
    // horário mudou (espelha a notificação de criação). Só evento clínico com a
    // DATA alterada; respeita o toggle "Re-agendamento" da Central.
    if (this.isClinicalEvent(finalType ?? '') && dateChanged && before?.tenant_id) {
      void this.sendAppointmentEventWhatsapp(event, event.patient_id, event.lead_id, before.tenant_id, 'rescheduled');
      void this.sendAppointmentEventEmail(event, event.patient_id, event.lead_id, before.tenant_id, 'agendamento_remarcado');
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
      status: { notIn: ['CANCELADO', 'CONCLUIDO', 'NO_SHOW', 'ADIADO'] }, // Onda 17.61 — Desmarcou/Faltou/Adiado liberam o horário (ficam registrados, mas não ocupam o slot)
      // Onda 18.x — ORTODONTIA é atendimento em FLUXO (vários pacientes no mesmo
      // horário): não ocupa slot exclusivo, então não conta como conflito.
      type: { not: 'ORTODONTIA' },
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
        status: { notIn: ['CANCELADO', 'CONCLUIDO', 'NO_SHOW', 'ADIADO'] }, // Onda 17.61 — Desmarcou/Faltou/Adiado liberam o horário (ficam registrados, mas não ocupam o slot)
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

  async updateAppointmentType(id: string, data: { name?: string; duration?: number; color?: string; active?: boolean }, tenantId?: string) {
    await this.assertAppointmentTypeTenant(id, tenantId);
    return this.prisma.appointmentType.update({ where: { id }, data });
  }

  async deleteAppointmentType(id: string, tenantId?: string) {
    await this.assertAppointmentTypeTenant(id, tenantId);
    await this.prisma.appointmentType.delete({ where: { id } });
    return { deleted: true };
  }

  // Onda 17.61 (segurança/IDOR) — bloqueia editar/excluir tipo de agendamento de outro tenant.
  private async assertAppointmentTypeTenant(id: string, tenantId?: string) {
    if (!tenantId) return;
    const t = await this.prisma.appointmentType.findUnique({ where: { id }, select: { tenant_id: true } });
    if (!t || (t.tenant_id && t.tenant_id !== tenantId)) {
      throw new NotFoundException('Tipo de agendamento não encontrado');
    }
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
            lead: { select: { id: true, name: true, phone: true, profile_picture_url: true } },
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
  async getReminderPreview(reminderId: string, tenantId?: string) {
    const reminder = await this.prisma.eventReminder.findFirst({
      where: {
        id: reminderId,
        // Onda 17.61 (segurança/IDOR) — escopa ao tenant via evento (404 se for de outro).
        ...(tenantId ? { event: { OR: [{ tenant_id: tenantId }, { tenant_id: null }] } } : {}),
      },
      include: {
        event: {
          select: {
            id: true, title: true, start_at: true, lead_id: true,
            lead: { select: { id: true, name: true, phone: true, profile_picture_url: true } },
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
          status: { notIn: ['CANCELADO', 'CONCLUIDO', 'NO_SHOW', 'ADIADO'] }, // Onda 17.61 — Desmarcou/Faltou/Adiado liberam o horário (ficam registrados, mas não ocupam o slot)
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
  async resendReminder(reminderId: string, tenantId?: string) {
    const reminder = await this.prisma.eventReminder.findFirst({
      where: {
        id: reminderId,
        ...(tenantId ? { event: { OR: [{ tenant_id: tenantId }, { tenant_id: null }] } } : {}),
      },
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
  async cancelReminder(reminderId: string, tenantId?: string) {
    const reminder = await this.prisma.eventReminder.findFirst({
      where: {
        id: reminderId,
        ...(tenantId ? { event: { OR: [{ tenant_id: tenantId }, { tenant_id: null }] } } : {}),
      },
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
      // Onda 18.x — DEDUP: nunca persistir antecedencia repetida (mesma
      // minutes_before+channel). Uma config duplicada fazia TODO agendamento
      // gravar 2 EventReminder iguais -> lembrete duplicado ("cafezinho" 2x). Raiz.
      config.default_antecedencias = [
        ...new Map(
          config.default_antecedencias.map((a) => [`${a.minutes_before}:${a.channel}`, a]),
        ).values(),
      ];
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
  private async resolveTenantWhatsappInstance(
    tenant_id?: string,
    purpose?: 'COMERCIAL' | 'CLINICA' | 'FINANCEIRO',
  ): Promise<string | null> {
    // Onda 17.64 — se a clínica separou os chips por função, prefere o chip DAQUELA
    // função (ex: disparo clínico sai pelo chip CLINICA). SEMPRE escopado por
    // tenant_id — nunca resolve instância de outro tenant (sem listInstances).
    if (purpose && tenant_id) {
      const byPurpose = await this.prisma.instance.findFirst({
        where: { type: 'whatsapp', tenant_id, purpose },
        orderBy: { created_at: 'asc' },
        select: { name: true },
      });
      if (byPurpose?.name) return byPurpose.name;
    }
    // Fallback pra AGENDA/COMERCIAL exclui o FINANCEIRO (mundo isolado): a conversa
    // de cobrança dá bump em last_message_at e sequestrava o chip — mesmo padrão do
    // resolveTenantInstance do reminder worker. Quando o purpose PEDIDO é FINANCEIRO,
    // o fallback antigo se mantém (quem cobra decide o próprio fallback).
    const excluiFin = purpose !== 'FINANCEIRO';

    // Onda 18.x — UNIÃO Comercial↔Clínica: se o chip pedido (CLINICA/COMERCIAL) está
    // fora, usa o OUTRO chip clínico ANTES de qualquer fallback. São o mesmo "mundo"
    // (paciente/lead) — pode trocar entre eles, mas NUNCA cai no Financeiro (número de
    // cobrança). Assim o disparo não para quando a Clínica cai: sai pelo Comercial.
    if (excluiFin && tenant_id && (purpose === 'CLINICA' || purpose === 'COMERCIAL')) {
      const irmao = purpose === 'CLINICA' ? 'COMERCIAL' : 'CLINICA';
      const bySibling = await this.prisma.instance.findFirst({
        where: { type: 'whatsapp', tenant_id, purpose: irmao },
        orderBy: { created_at: 'asc' },
        select: { name: true },
      });
      if (bySibling?.name) return bySibling.name;
    }

    // Nomes dos chips FINANCEIRO do tenant — pra NUNCA vazarem no fallback por conversa
    // (a cobrança dá bump em last_message_at e sequestra a instância mais recente).
    const finNames = excluiFin && tenant_id
      ? (await this.prisma.instance.findMany({
          where: { type: 'whatsapp', tenant_id, purpose: 'FINANCEIRO' },
          select: { name: true },
        })).map((i) => i.name)
      : [];

    const convo = await this.prisma.conversation.findFirst({
      where: {
        instance_name: { not: null },
        ...(tenant_id ? { tenant_id } : {}),
        ...(excluiFin
          ? { NOT: [
              { inbox: { purpose: 'FINANCEIRO' } },
              ...(finNames.length ? [{ instance_name: { in: finNames } }] : []),
            ] }
          : {}),
      },
      orderBy: { last_message_at: 'desc' },
      select: { instance_name: true },
    });
    if (convo?.instance_name) return convo.instance_name;
    const inst = await this.prisma.instance.findFirst({
      where: {
        type: 'whatsapp',
        ...(tenant_id ? { tenant_id } : {}),
        ...(excluiFin ? { NOT: { purpose: 'FINANCEIRO' } } : {}),
      },
      orderBy: { created_at: 'asc' },
      select: { name: true },
    });
    if (inst?.name) return inst.name;
    // Onda 18.x — disparo de PACIENTE (CLINICA/COMERCIAL): se só sobrou o chip
    // Financeiro, NÃO envia por ele. Devolve null → o chamador registra FAILED e o
    // aviso de tela pede pra reconectar. Melhor não enviar do que sair do número de
    // cobrança. Só quando o purpose PEDIDO é FINANCEIRO é que o financeiro é usado.
    if (excluiFin) return null;
    const qualquer = await this.prisma.instance.findFirst({
      where: { type: 'whatsapp', ...(tenant_id ? { tenant_id } : {}) },
      orderBy: { created_at: 'asc' },
      select: { name: true },
    });
    return qualquer?.name ?? null;
  }

  // ─── Confirmação de agendamento (Onda 17.56) — mensagem editável ─────
  // O liga/desliga vive em APPOINTMENT_CONFIRMATION_ENABLED_<tenant> (painel
  // Operacional). Aqui guardamos só o TEXTO, em
  // APPOINTMENT_CONFIRMATION_TEMPLATE_<tenant>. O worker scheduler aplica.
  async getAppointmentConfirmationConfig(tenant_id?: string) {
    const DEFAULT =
      'Oi {nome}, tudo bem? 😊\n\nAqui é pra confirmar seu atendimento com {dentista} amanhã, *{data}* às *{hora}*.\n{local_line}\nPosso confirmar sua presença? 🙂 Qualquer imprevisto, me avisa que a gente ajeita um novo horário.';
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

  // ─── Confirmação de ORTODONTIA (Onda 18.x) — por ORDEM DE CHEGADA ─────
  // Disparo SEPARADO da confirmação normal: só vale pra eventos type=ORTODONTIA
  // e avisa que o atendimento é por ordem de chegada. Liga/desliga vive em
  // APPOINTMENT_CONFIRMATION_ORTO_ENABLED_<tenant> (Central). Aqui só o TEXTO,
  // em APPOINTMENT_CONFIRMATION_ORTO_TEMPLATE_<tenant>. O worker scheduler aplica.
  async getAppointmentConfirmationOrtoConfig(tenant_id?: string) {
    const { DEFAULT_CONFIRMACAO_ORTO } = await import('@crm/shared');
    const key = tenant_id ? `APPOINTMENT_CONFIRMATION_ORTO_TEMPLATE_${tenant_id}` : 'APPOINTMENT_CONFIRMATION_ORTO_TEMPLATE';
    try {
      const setting = await this.prisma.globalSetting.findUnique({ where: { key } });
      if (!setting?.value) return { template: DEFAULT_CONFIRMACAO_ORTO };
      const parsed = JSON.parse(setting.value);
      const tpl = typeof parsed.template === 'string' && parsed.template.trim() ? parsed.template : DEFAULT_CONFIRMACAO_ORTO;
      return { template: tpl };
    } catch (e) {
      this.logger.warn(`Falha ao parsear ${key}, usando default: ${(e as any)?.message}`);
      return { template: DEFAULT_CONFIRMACAO_ORTO };
    }
  }

  async setAppointmentConfirmationOrtoConfig(tenant_id: string | undefined, config: { template?: string }) {
    if (config.template !== undefined) {
      if (typeof config.template !== 'string') throw new BadRequestException('template deve ser string');
      if (config.template.length > 1500) throw new BadRequestException('template ultrapassa 1500 caracteres');
    }
    const key = tenant_id ? `APPOINTMENT_CONFIRMATION_ORTO_TEMPLATE_${tenant_id}` : 'APPOINTMENT_CONFIRMATION_ORTO_TEMPLATE';
    const value = JSON.stringify({ template: config.template ?? '' });
    await this.prisma.globalSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    this.logger.log(`[APPOINTMENT_CONFIRMATION_ORTO_TEMPLATE] salvo pra ${key}`);
    return this.getAppointmentConfirmationOrtoConfig(tenant_id);
  }

  // ─── Lembrete de ORTODONTIA · ~1h antes (portões) — Onda 18.x ─────────
  // Disparo SÓ pra eventos type=ORTODONTIA: avisa ~1h antes que os portões
  // abrem. Liga/desliga em APPOINTMENT_ORTO_REMINDER_ENABLED_<tenant> (Central);
  // texto em APPOINTMENT_ORTO_REMINDER_TEMPLATE_<tenant>. O worker envia direto.
  async getAppointmentOrtoReminderConfig(tenant_id?: string) {
    const { DEFAULT_ORTO_REMINDER } = await import('@crm/shared');
    const key = tenant_id ? `APPOINTMENT_ORTO_REMINDER_TEMPLATE_${tenant_id}` : 'APPOINTMENT_ORTO_REMINDER_TEMPLATE';
    try {
      const setting = await this.prisma.globalSetting.findUnique({ where: { key } });
      if (!setting?.value) return { template: DEFAULT_ORTO_REMINDER };
      const parsed = JSON.parse(setting.value);
      const tpl = typeof parsed.template === 'string' && parsed.template.trim() ? parsed.template : DEFAULT_ORTO_REMINDER;
      return { template: tpl };
    } catch (e) {
      this.logger.warn(`Falha ao parsear ${key}, usando default: ${(e as any)?.message}`);
      return { template: DEFAULT_ORTO_REMINDER };
    }
  }

  async setAppointmentOrtoReminderConfig(tenant_id: string | undefined, config: { template?: string }) {
    if (config.template !== undefined) {
      if (typeof config.template !== 'string') throw new BadRequestException('template deve ser string');
      if (config.template.length > 1500) throw new BadRequestException('template ultrapassa 1500 caracteres');
    }
    const key = tenant_id ? `APPOINTMENT_ORTO_REMINDER_TEMPLATE_${tenant_id}` : 'APPOINTMENT_ORTO_REMINDER_TEMPLATE';
    const value = JSON.stringify({ template: config.template ?? '' });
    await this.prisma.globalSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    this.logger.log(`[APPOINTMENT_ORTO_REMINDER_TEMPLATE] salvo pra ${key}`);
    return this.getAppointmentOrtoReminderConfig(tenant_id);
  }

  // ─── Confirmação de agendamento de ORTODONTIA · IMEDIATA (Onda 18.x) ──
  // Sai NA HORA que marca o agendamento (não espera 24h). Aviso "agendamos pra
  // você" com ordem de chegada. Liga/desliga em APPOINTMENT_ORTO_IMMEDIATE_ENABLED
  // (Central); texto em APPOINTMENT_ORTO_IMMEDIATE_TEMPLATE. Aplicado no create().
  async getAppointmentOrtoImmediateConfig(tenant_id?: string) {
    const { DEFAULT_ORTO_IMMEDIATE } = await import('@crm/shared');
    const key = tenant_id ? `APPOINTMENT_ORTO_IMMEDIATE_TEMPLATE_${tenant_id}` : 'APPOINTMENT_ORTO_IMMEDIATE_TEMPLATE';
    try {
      const setting = await this.prisma.globalSetting.findUnique({ where: { key } });
      if (!setting?.value) return { template: DEFAULT_ORTO_IMMEDIATE };
      const parsed = JSON.parse(setting.value);
      const tpl = typeof parsed.template === 'string' && parsed.template.trim() ? parsed.template : DEFAULT_ORTO_IMMEDIATE;
      return { template: tpl };
    } catch (e) {
      this.logger.warn(`Falha ao parsear ${key}, usando default: ${(e as any)?.message}`);
      return { template: DEFAULT_ORTO_IMMEDIATE };
    }
  }

  async setAppointmentOrtoImmediateConfig(tenant_id: string | undefined, config: { template?: string }) {
    if (config.template !== undefined) {
      if (typeof config.template !== 'string') throw new BadRequestException('template deve ser string');
      if (config.template.length > 1500) throw new BadRequestException('template ultrapassa 1500 caracteres');
    }
    const key = tenant_id ? `APPOINTMENT_ORTO_IMMEDIATE_TEMPLATE_${tenant_id}` : 'APPOINTMENT_ORTO_IMMEDIATE_TEMPLATE';
    const value = JSON.stringify({ template: config.template ?? '' });
    await this.prisma.globalSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    this.logger.log(`[APPOINTMENT_ORTO_IMMEDIATE_TEMPLATE] salvo pra ${key}`);
    return this.getAppointmentOrtoImmediateConfig(tenant_id);
  }

  // ─── Re-agendamento (Onda 17.59) — mensagem editável ─────────────────
  // Liga/desliga vive em APPOINTMENT_RESCHEDULED_ENABLED (Central). Aqui só o TEXTO,
  // em APPOINTMENT_RESCHEDULED_TEMPLATE_<tenant>. Aplicado em sendAppointmentEventWhatsapp.
  readonly DEFAULT_RESCHEDULED_TEMPLATE =
    'Olá {nome}! 😊\n\nSua consulta foi *remarcada* para *{data}* às *{hora}* com {dentista}.\n{local_line}\nQualquer dúvida, é só chamar por aqui!';

  async getAppointmentRescheduledConfig(tenant_id?: string) {
    const key = tenant_id ? `APPOINTMENT_RESCHEDULED_TEMPLATE_${tenant_id}` : 'APPOINTMENT_RESCHEDULED_TEMPLATE';
    try {
      const setting = await this.prisma.globalSetting.findUnique({ where: { key } });
      if (!setting?.value) return { template: this.DEFAULT_RESCHEDULED_TEMPLATE };
      const parsed = JSON.parse(setting.value);
      const tpl = typeof parsed.template === 'string' && parsed.template.trim() ? parsed.template : this.DEFAULT_RESCHEDULED_TEMPLATE;
      return { template: tpl };
    } catch (e) {
      this.logger.warn(`Falha ao parsear ${key}, usando default: ${(e as any)?.message}`);
      return { template: this.DEFAULT_RESCHEDULED_TEMPLATE };
    }
  }

  async setAppointmentRescheduledConfig(tenant_id: string | undefined, config: { template?: string }) {
    if (config.template !== undefined) {
      if (typeof config.template !== 'string') throw new BadRequestException('template deve ser string');
      if (config.template.length > 1500) throw new BadRequestException('template ultrapassa 1500 caracteres');
    }
    const key = tenant_id ? `APPOINTMENT_RESCHEDULED_TEMPLATE_${tenant_id}` : 'APPOINTMENT_RESCHEDULED_TEMPLATE';
    const value = JSON.stringify({ template: config.template ?? '' });
    await this.prisma.globalSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    this.logger.log(`[APPOINTMENT_RESCHEDULED_TEMPLATE] salvo pra ${key}`);
    return this.getAppointmentRescheduledConfig(tenant_id);
  }

  // ─── Agenda do COMERCIAL — textos editáveis (6 disparos, 1 endpoint) ──────
  // Versão dos disparos de agendamento pro LEAD (não-cliente), enviada pelo chip
  // COMERCIAL. Texto em COMERCIAL_AGENDA_TEMPLATE_<id>_<tenant> (JSON {template});
  // o liga/desliga vive no painel Operacional (COMERCIAL_AGENDA_ENABLED_<id>_<t>).
  async getComercialAgendaTemplate(tenant_id: string | undefined, id: string) {
    const { isComercialAgendaId, defaultComercialAgendaTemplate, comercialAgendaTemplateKey } = await import('@crm/shared');
    if (!isComercialAgendaId(id)) throw new BadRequestException(`disparo comercial inválido: ${id}`);
    if (!tenant_id) throw new BadRequestException('tenant_id ausente');
    const fallback = defaultComercialAgendaTemplate(id);
    try {
      const row = await this.prisma.globalSetting.findUnique({ where: { key: comercialAgendaTemplateKey(id, tenant_id) } });
      if (!row?.value) return { template: fallback };
      const parsed = JSON.parse(row.value);
      const tpl = typeof parsed.template === 'string' && parsed.template.trim() ? parsed.template : fallback;
      return { template: tpl };
    } catch {
      return { template: fallback };
    }
  }

  async setComercialAgendaTemplate(tenant_id: string | undefined, id: string, config: { template?: string }) {
    const { isComercialAgendaId, comercialAgendaTemplateKey } = await import('@crm/shared');
    if (!isComercialAgendaId(id)) throw new BadRequestException(`disparo comercial inválido: ${id}`);
    if (!tenant_id) throw new BadRequestException('tenant_id ausente');
    if (config.template !== undefined) {
      if (typeof config.template !== 'string') throw new BadRequestException('template deve ser string');
      if (config.template.length > 1500) throw new BadRequestException('template ultrapassa 1500 caracteres');
    }
    const key = comercialAgendaTemplateKey(id, tenant_id);
    const value = JSON.stringify({ template: config.template ?? '' });
    await this.prisma.globalSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    this.logger.log(`[COMERCIAL_AGENDA_TEMPLATE] ${id} salvo (tenant ${tenant_id})`);
    return this.getComercialAgendaTemplate(tenant_id, id);
  }

  /** Onda 17.56 — teste GENÉRICO: envia a mensagem de QUALQUER disparo (com dados
   *  de exemplo) pra um número, pra ver na hora se o WhatsApp da clínica entrega. */
  async sendTestDisparo(tenant_id: string | undefined, disparo: string, phone: string, text?: string) {
    let num = (phone || '').replace(/\D/g, '');
    if (num.length < 10) {
      throw new BadRequestException('Telefone inválido — use DDD + número (ex.: 82999998888)');
    }
    // Adiciona o código do Brasil (55) quando vem só DDD + número (10–11 dígitos).
    if (num.length === 10 || num.length === 11) num = `55${num}`;

    // Onda 18.17 — o teste sai pelo MESMO chip que vai disparar de verdade:
    // cobrança pelo FINANCEIRO, agenda do comercial pelo COMERCIAL, resto CLINICA.
    // Fallback interno pra outro chip do tenant se a função ainda não foi separada.
    const { isFinTemplateId, defaultFinTemplate, isComercialAgendaId } = await import('@crm/shared');
    const testPurpose: 'CLINICA' | 'FINANCEIRO' | 'COMERCIAL' =
      isFinTemplateId(disparo) ? 'FINANCEIRO' : isComercialAgendaId(disparo) ? 'COMERCIAL' : 'CLINICA';
    const instanceName = await this.resolveTenantWhatsappInstance(tenant_id, testPurpose);
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
            name: true,
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
      clinica: (tenantRow as any)?.name || 'sua clínica', antecedencia: '1 dia', qtd: '1',
      // Onda 18.17 — exemplos das variáveis de cobrança (senão sairiam vazias).
      valor: 'R$ 350,00', link: 'https://cobranca.exemplo/boleto/teste', descricao: ' (Pix recebido)',
      // Negociação aprovada — exemplos dos blocos/valores (senão o teste sai sem eles).
      condicoes: '• Entrada: R$ 10,00\n• 8x de R$ 5,34\n• Total: R$ 52,74',
      condicoes_sem_total: '• Entrada: R$ 10,00\n• 8x de R$ 5,34',
      // Negociação aprovada (itens) + envio do PIX (codigo_pix, cru) + confirmação (metodo).
      itens: '• Clareamento dental\n• Limpeza (2x)',
      codigo_pix: '00020126...EXEMPLO...5204000053039865802BR',
      metodo: ' via PIX',
      entrada: '10,00', parcelas: '8', valor_parcela: '5,34', total: '52,74', forma: 'boleto',
      // Recall de revisão — exemplo do procedimento (senão sairia vazio no teste).
      procedimento: 'Limpeza',
    };
    const apply = (t: string) =>
      (t || '')
        .replace(/\{local_line\}/g, V.local ? `📍 ${V.local}\n` : '')
        .replace(/\{agenda\}/g, '- 14:00  Felipe (teste) (Avaliacao)')
        .replace(/\{(\w+)\}/g, (_m, k) => V[k] ?? '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    let msg = '';
    // Onda 17.59 — se o editor mandou o texto ATUAL da tela (`text`), testa ELE
    // (fiel ao que o usuário vê, mesmo ANTES de salvar). Senão, lê o texto SALVO
    // do disparo (comportamento antigo). Mesma substituição de variáveis nos dois.
    if (text && text.trim()) {
      msg = apply(text);
    } else switch (disparo) {
      case 'confirmacao':
        msg = apply((await this.getAppointmentConfirmationConfig(tenant_id)).template);
        break;
      case 'confirmacao_orto':
        msg = apply((await this.getAppointmentConfirmationOrtoConfig(tenant_id)).template);
        break;
      case 'confirmacao_orto_imediata':
        msg = apply((await this.getAppointmentOrtoImmediateConfig(tenant_id)).template);
        break;
      case 'lembrete_orto_1h':
        msg = apply((await this.getAppointmentOrtoReminderConfig(tenant_id)).template);
        break;
      case 'reagendamento':
        msg = apply((await this.getAppointmentRescheduledConfig(tenant_id)).template);
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
      case 'confirmacao_48h':
        msg = apply((await this.getReminderConfig(tenant_id)).templates.consulta_confirmacao);
        break;
      case 'aniversario':
      case 'aniversario_classica':
        msg = apply((await this.getBirthdayGreetingConfig(tenant_id)).template);
        break;
      case 'aniversario_desejo':
        msg = apply((await this.getBirthdayGreetingConfig(tenant_id)).message2_template || '');
        break;
      case 'aniversario_presente':
        msg = apply((await this.getBirthdayGreetingConfig(tenant_id)).message3_template || '');
        break;
      case 'resumo_dentista':
        msg = apply((await this.getDentistDailySummaryConfig(tenant_id)).template);
        break;
      case 'nps':
        msg = `Oi Felipe! Como foi sua consulta hoje com ${dentistName}? De 0 a 10, o quanto você indicaria a gente? 😊 (mensagem de teste)`;
        break;
      default:
        // Recall de revisão: sem texto da tela, testa o texto SALVO (mesma
        // resolução do worker: TenantSetting → GlobalSetting global → default).
        if (disparo === 'recall_preventivo') {
          const { DEFAULT_RECALL_TEMPLATE } = await import('@crm/shared');
          let tpl = DEFAULT_RECALL_TEMPLATE;
          try {
            const ts = tenant_id
              ? await (this.prisma as any).tenantSetting.findUnique({
                  where: { tenant_id_key: { tenant_id, key: 'RECALL_MESSAGE_TEMPLATE' } },
                })
              : null;
            if (ts?.value?.trim()) tpl = ts.value;
            else {
              const gs = await this.prisma.globalSetting.findUnique({ where: { key: 'RECALL_MESSAGE_TEMPLATE' } });
              if (gs?.value?.trim()) tpl = gs.value;
            }
          } catch { /* default */ }
          msg = apply(tpl);
          break;
        }
        // Agenda do Comercial: sem texto da tela, testa o texto SALVO (ou default).
        if (isComercialAgendaId(disparo)) {
          msg = apply((await this.getComercialAgendaTemplate(tenant_id, disparo)).template);
          break;
        }
        // Onda 18.17 — cobrança: sem texto da tela, testa o default do estágio.
        if (isFinTemplateId(disparo)) {
          msg = apply(defaultFinTemplate(disparo));
          break;
        }
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

    // Regra canônica de "profissional que atende" (igual findLawyers / sendTestDisparo
    // L1976): DENTIST OU ADMIN com especialidade. Antes era só DENTIST → ortodontista
    // ADMIN (ex.: Dra. Suellen) não recebia o resumo da PRÓPRIA agenda do dia.
    const dentists = await this.prisma.user.findMany({
      where: {
        ...(tenant_id ? { tenant_id } : {}),
        OR: [
          { roles: { has: 'DENTIST' } },
          { roles: { has: 'ADMIN' }, specialties: { isEmpty: false } },
        ],
      },
      select: { id: true, name: true, phone: true },
    });

    // Onda 17.56 — instância Evolution real do tenant (mesmo motivo do teste de
    // confirmação: sem nome, sendText cairia no default 'whatsapp' inexistente).
    const summaryInstanceName =
      config.channel === 'WHATSAPP' ? await this.resolveTenantWhatsappInstance(tenant_id, 'CLINICA') : null;

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
        void this.logDispatch({ tenantId: tenant_id, type: 'resumo_dentista', recipientName: u.name, status: 'FAILED', error: 'Dentista sem telefone cadastrado', refUserId: u.id });
        continue;
      }
      const phone = u.phone.replace(/\D/g, '');
      try {
        await this.whatsapp.sendText(phone, msg, summaryInstanceName ?? undefined, undefined, tenant_id);
        results.push({ user_id: u.id, name: u.name, sent: true });
        void this.logDispatch({ tenantId: tenant_id, type: 'resumo_dentista', recipientName: u.name, recipientPhone: phone, status: 'SENT', refUserId: u.id });
      } catch (e: any) {
        results.push({ user_id: u.id, name: u.name, sent: false, reason: `whatsapp falhou: ${e.message}` });
        void this.logDispatch({ tenantId: tenant_id, type: 'resumo_dentista', recipientName: u.name, recipientPhone: phone, status: 'FAILED', error: e?.message, refUserId: u.id });
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
    config: {
      enabled?: boolean; send_at?: string; template?: string; last_run_date?: string;
      message2_enabled?: boolean; message2_send_at?: string; message2_template?: string; message2_last_run_date?: string;
      message3_enabled?: boolean; message3_send_at?: string; message3_template?: string; message3_last_run_date?: string;
    },
  ) {
    for (const [field, val] of [['send_at', config.send_at], ['message2_send_at', config.message2_send_at], ['message3_send_at', config.message3_send_at]] as const) {
      if (val !== undefined && !/^\d{2}:\d{2}$/.test(val)) {
        throw new BadRequestException(`${field} deve estar no formato HH:MM`);
      }
    }
    for (const [field, val] of [['template', config.template], ['message2_template', config.message2_template], ['message3_template', config.message3_template]] as const) {
      if (val !== undefined) {
        if (typeof val !== 'string') throw new BadRequestException(`${field} deve ser string`);
        if (val.length > 2000) throw new BadRequestException(`${field} ultrapassa 2000 caracteres`);
      }
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

  /** Aniversariantes ATIVOS de hoje (fuso Maceió). Prisma ORM + filtro no Node —
   *  o SQL cru `FROM patients` voltava vazio (nome de tabela/coluna). "Hoje" é o
   *  dia de Maceió (UTC-3), lido via getUTC* do instante now-3h. */
  private async birthdayPatientsToday(tenant_id: string) {
    const today = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const tm = today.getUTCMonth();
    const td = today.getUTCDate();
    const rows = await this.prisma.patient.findMany({
      where: { tenant_id, status: 'ACTIVE', birth_date: { not: null } },
      select: { id: true, name: true, phone: true, birth_date: true },
      take: 5000,
    }).catch(() => [] as any[]);
    return (rows as any[])
      .filter((r) => {
        const bd = new Date(r.birth_date);
        return bd.getUTCMonth() === tm && bd.getUTCDate() === td;
      })
      .map((r) => ({ id: r.id as string, name: r.name as string, phone: (r.phone ?? null) as string | null }));
  }

  /**
   * Onda 17.60 — aniversariantes ATIVOS, do HOJE até `days` dias à frente (fuso
   * Maceió). `days=366` cobre o ANO inteiro. Carrega os pacientes com data de
   * nascimento e calcula o "próximo aniversário" de cada um no Node (lida com
   * wrap de ano e 29/02 — JS normaliza Date.UTC). Ordena por quão perto está.
   */
  async getUpcomingBirthdays(tenant_id: string, days = 30) {
    if (!tenant_id) return { total: 0, today: 0, items: [] as any[], sem_data: 0, total_ativos: 0 };
    const N = Math.min(Math.max(days, 0), 366);
    const today = new Date(Date.now() - 3 * 60 * 60 * 1000); // dia de Maceió
    const todayY = today.getUTCFullYear();
    const todayMs = Date.UTC(todayY, today.getUTCMonth(), today.getUTCDate());
    const [rows, totalAtivos, semData] = await Promise.all([
      // Onda 17.60 — Prisma ORM (não SQL cru): o $queryRawUnsafe com `FROM patients`
      // voltava vazio (a contagem por ORM achava 6, a lista crua dava 0). O ORM usa
      // o nome certo de tabela/coluna do schema.
      this.prisma.patient.findMany({
        where: { tenant_id, status: 'ACTIVE', birth_date: { not: null } },
        select: {
          id: true, name: true, phone: true, birth_date: true,
          // Onda 17.61 — conversa mais recente do paciente (Patient → lead →
          // conversations) pro botão do WhatsApp abrir o chat INTERNO do sistema.
          lead: { select: { conversations: { select: { id: true }, orderBy: { last_message_at: 'desc' }, take: 1 } } },
        },
        take: 5000,
      }).catch(() => [] as any[]),
      // quantos pacientes ATIVOS existem e quantos estão SEM data de nascimento (pra
      // a tela mostrar "X sem nascimento — preencha pra aparecerem").
      this.prisma.patient.count({ where: { tenant_id, status: 'ACTIVE' } }).catch(() => 0),
      this.prisma.patient.count({ where: { tenant_id, status: 'ACTIVE', birth_date: null } }).catch(() => 0),
    ]);
    const items = (rows as any[]).map((r) => {
      const bd = new Date(r.birth_date);
      const bm = bd.getUTCMonth();
      const bdd = bd.getUTCDate();
      // próximo aniversário a partir de hoje (se já passou este ano, vai pro ano que vem)
      let nextMs = Date.UTC(todayY, bm, bdd);
      if (nextMs < todayMs) nextMs = Date.UTC(todayY + 1, bm, bdd);
      const daysUntil = Math.round((nextMs - todayMs) / 86400000);
      return {
        id: r.id, name: r.name, phone: r.phone,
        birth_day: bdd, birth_month: bm + 1,
        days_until: daysUntil, is_today: daysUntil === 0,
        next_date: new Date(nextMs).toISOString().slice(0, 10),
        conversation_id: r.lead?.conversations?.[0]?.id ?? null,
      };
    })
      .filter((i) => i.days_until <= N)
      .sort((a, b) => a.days_until - b.days_until || a.name.localeCompare(b.name));
    return {
      total: items.length,
      today: items.filter((i) => i.is_today).length,
      items,
      sem_data: Number(semData) || 0,
      total_ativos: Number(totalAtivos) || 0,
    };
  }

  /**
   * Onda 17.61 — abre (ou cria) a conversa INTERNA do paciente pra o ícone do
   * WhatsApp da tela de aniversariantes SEMPRE cair no nosso chat, nunca no externo.
   *
   * Caminho:
   *  1. Acha o lead do paciente — por `Patient.lead_id` OU pelo telefone (com/sem 55).
   *     Isso conserta o caso "paciente já tem conversa mas o lead_id está null".
   *  2. Se o lead tem conversa, devolve a mais recente.
   *  3. Se não tem conversa (ou nem lead), cria lead (se preciso) + conversa ABERTO
   *     usando a instância do tenant — assim o operador abre a conversa vazia e já
   *     manda a primeira mensagem pelo nosso WhatsApp.
   */
  async openOrCreateConversation(tenant_id: string, patient_id: string): Promise<{ conversation_id: string | null }> {
    if (!tenant_id || !patient_id) return { conversation_id: null };
    const patient = await this.prisma.patient.findFirst({
      where: { id: patient_id, tenant_id },
      select: { id: true, name: true, phone: true, lead_id: true },
    }).catch(() => null);
    if (!patient?.phone) return { conversation_id: null };

    const digits = patient.phone.replace(/\D/g, '');
    // Variantes BR do telefone (com/sem 55, com/sem o 9) — o número da conversa
    // existente pode estar gravado em qualquer um desses formatos.
    const variants = this.phoneVariants(patient.phone);

    // 1. lead por lead_id OU por telefone (tenant-scoped)
    let leadId: string | null = patient.lead_id || null;
    if (!leadId && variants.length) {
      const lead = await this.prisma.lead.findFirst({
        where: { tenant_id, phone: { in: variants } },
        select: { id: true },
      }).catch(() => null);
      leadId = lead?.id ?? null;
    }

    // Garante que o lead tenha o nome do paciente (senão o chat mostra "-").
    if (leadId && patient.name) {
      await this.prisma.lead.updateMany({
        where: { id: leadId, OR: [{ name: null }, { name: '' }] },
        data: { name: patient.name },
      }).catch(() => {});
    }

    // 2. conversa existente do lead (mais recente, qualquer status)
    if (leadId) {
      const conv = await this.prisma.conversation.findFirst({
        where: { lead_id: leadId },
        orderBy: { last_message_at: 'desc' },
        select: { id: true },
      }).catch(() => null);
      if (conv) return { conversation_id: conv.id };
    }

    // 3. find-or-create: cria lead (se não houver) + conversa ABERTO
    if (!leadId) {
      const created = await this.prisma.lead.create({
        data: { phone: digits || patient.phone, name: patient.name || null, tenant_id, origin: 'aniversario' },
        select: { id: true },
      }).catch(() => null);
      leadId = created?.id ?? null;
    }
    if (!leadId) return { conversation_id: null };

    const instanceName = await this.resolveTenantWhatsappInstance(tenant_id, 'CLINICA').catch(() => null);
    const conv = await this.prisma.conversation.create({
      data: {
        lead_id: leadId,
        tenant_id,
        channel: 'whatsapp',
        status: 'ABERTO',
        external_id: `${digits}@s.whatsapp.net`,
        ...(instanceName ? { instance_name: instanceName } : {}),
      },
      select: { id: true },
    }).catch(() => null);
    return { conversation_id: conv?.id ?? null };
  }

  /**
   * Variantes BR de um telefone pra casar com `Lead.phone` (que pode estar gravado
   * em vários formatos): com/sem 55 e com/sem o 9 do celular. Ex.: "(82) 99964-6293"
   * → ["5582999646293","82999646293","558299646293","8299646293", ...].
   */
  private phoneVariants(raw: string): string[] {
    const d = (raw || '').replace(/\D/g, '');
    if (!d) return [];
    const set = new Set<string>();
    const no55 = d.startsWith('55') ? d.slice(2) : d;
    set.add(d);
    set.add(no55);
    set.add(`55${no55}`);
    if (no55.length >= 10) {
      const ddd = no55.slice(0, 2);
      const local = no55.slice(2);
      let alt: string | null = null;
      if (local.length === 9 && local.startsWith('9')) alt = ddd + local.slice(1); // tira o 9
      else if (local.length === 8) alt = ddd + '9' + local; // poe o 9
      if (alt) { set.add(alt); set.add(`55${alt}`); }
    }
    return Array.from(set).filter(Boolean);
  }

  /**
   * Manda o parabéns pra todos os aniversariantes de hoje do tenant.
   * Usado pelo cron diário e pelo "Enviar agora" manual.
   */
  async sendBirthdayGreetingsNow(tenant_id: string, which: 1 | 2 | 3 = 1) {
    const config = await this.getBirthdayGreetingConfig(tenant_id);
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenant_id }, select: { name: true } });
    const clinica = tenant?.name || 'nossa clínica';
    // Onda 17.61 — qual mensagem disparar (1 = clássica, 2 = o desejo, 3 = o presente).
    const template = (which === 3 ? config.message3_template : which === 2 ? config.message2_template : config.template) || config.template;

    const patients = await this.birthdayPatientsToday(tenant_id);
    // Chip CLINICA do tenant (paciente-facing). Sem resolver, o sendText caía no instance
    // DEFAULT do Evolution (resolveEvolutionConfig) — num tenant multi-chip pode ser outro
    // chip / offline, e o parabéns não entregava.
    const instance = (await this.resolveTenantWhatsappInstance(tenant_id, 'CLINICA').catch(() => null)) ?? undefined;
    const results: { patient_id: string; name: string; sent: boolean; reason?: string }[] = [];

    for (const p of patients) {
      if (!p.phone) {
        results.push({ patient_id: p.id, name: p.name, sent: false, reason: 'sem telefone' });
        void this.logDispatch({ tenantId: tenant_id, type: 'aniversario', recipientName: p.name, status: 'FAILED', error: 'Paciente sem telefone cadastrado', refPatientId: p.id });
        continue;
      }
      const firstName = (p.name || '').split(' ')[0] || p.name;
      const msg = template
        .replace(/\{nome\}/g, firstName)
        .replace(/\{clinica\}/g, clinica)
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      const phone = p.phone.replace(/\D/g, '');
      let res: any = null;
      try {
        // Chip CLINICA do tenant (resolvido acima) + tenant_id pra a config da Evolution.
        res = await this.whatsapp.sendText(phone, msg, instance, undefined, tenant_id);
      } catch (e: any) {
        results.push({ patient_id: p.id, name: p.name, sent: false, reason: `whatsapp erro: ${e?.message}` });
        void this.logDispatch({ tenantId: tenant_id, type: 'aniversario', recipientName: p.name, recipientPhone: phone, status: 'FAILED', error: e?.message, refPatientId: p.id });
        continue;
      }
      // sendText NÃO lança em falha HTTP (Evolution devolve {statusCode,error}/exists:false).
      // Sem conferir o retorno, um envio RECUSADO era marcado "SENT" mentiroso.
      const ok = !!res && typeof res === 'object'
        && !(typeof res.statusCode === 'number' && res.statusCode >= 400)
        && !(res.error && !res.key)
        && res.exists !== false
        && !!(res.key?.id || res.messageId || res.id);
      if (ok) {
        results.push({ patient_id: p.id, name: p.name, sent: true });
        void this.logDispatch({ tenantId: tenant_id, type: 'aniversario', recipientName: p.name, recipientPhone: phone, status: 'SENT', refPatientId: p.id });
      } else {
        const reason = res?.exists === false ? 'número não está no WhatsApp' : `Evolution recusou (${JSON.stringify(res).slice(0, 120)})`;
        results.push({ patient_id: p.id, name: p.name, sent: false, reason });
        void this.logDispatch({ tenantId: tenant_id, type: 'aniversario', recipientName: p.name, recipientPhone: phone, status: 'FAILED', error: reason, refPatientId: p.id });
      }
    }

    this.logger.log(
      `[BIRTHDAY_GREETING] msg${which} disparada: ${results.filter((r) => r.sent).length}/${patients.length} aniversariantes (tenant ${tenant_id})`,
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
      status: { notIn: ['CANCELADO', 'CONCLUIDO', 'NO_SHOW', 'ADIADO'] }, // Onda 17.61 — Desmarcou/Faltou/Adiado liberam o horário (ficam registrados, mas não ocupam o slot)
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

  async updateHoliday(id: string, data: { date?: string; name?: string; recurring_yearly?: boolean }, tenantId?: string) {
    await this.assertHolidayTenant(id, tenantId);
    const updateData: any = {};
    if (data.date) updateData.date = new Date(data.date);
    if (data.name !== undefined) updateData.name = data.name;
    if (data.recurring_yearly !== undefined) updateData.recurring_yearly = data.recurring_yearly;
    return this.prisma.holiday.update({ where: { id }, data: updateData });
  }

  async deleteHoliday(id: string, tenantId?: string) {
    await this.assertHolidayTenant(id, tenantId);
    await this.prisma.holiday.delete({ where: { id } });
    return { deleted: true };
  }

  // Onda 17.61 (segurança/IDOR) — feriado tem que ser do tenant do chamador.
  private async assertHolidayTenant(id: string, tenantId?: string) {
    if (!tenantId) return;
    const h = await this.prisma.holiday.findUnique({ where: { id }, select: { tenant_id: true } });
    if (!h || (h.tenant_id && h.tenant_id !== tenantId)) {
      throw new NotFoundException('Feriado não encontrado');
    }
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
    tenantId?: string,
  ) {
    await this.assertScheduleBlockTenant(id, tenantId);
    const updateData: any = {};
    if (data.start_at) updateData.start_at = new Date(data.start_at);
    if (data.end_at) updateData.end_at = new Date(data.end_at);
    if (data.all_day !== undefined) updateData.all_day = data.all_day;
    if (data.reason !== undefined) updateData.reason = data.reason;
    if (data.notes !== undefined) updateData.notes = data.notes;
    return this.prisma.scheduleBlock.update({ where: { id }, data: updateData });
  }

  // Onda 17.61 (segurança/IDOR) — bloqueio de agenda tem que ser do tenant do chamador.
  private async assertScheduleBlockTenant(id: string, tenantId?: string) {
    if (!tenantId) return;
    const b = await this.prisma.scheduleBlock.findUnique({ where: { id }, select: { tenant_id: true } });
    if (!b || (b.tenant_id && b.tenant_id !== tenantId)) {
      throw new NotFoundException('Bloqueio não encontrado');
    }
  }

  async deleteScheduleBlock(id: string, tenantId?: string) {
    await this.assertScheduleBlockTenant(id, tenantId);
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

  async search(query: string, tenantId?: string, assignedUserId?: string) {
    return this.prisma.calendarEvent.findMany({
      where: {
        ...(tenantId ? { tenant_id: tenantId } : {}),
        // DENTIST/role sem "ver toda agenda" só acha os PRÓPRios eventos (igual findAll).
        ...(assignedUserId ? { assigned_user_id: assignedUserId } : {}),
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } },
          // Onda 18.x — busca contextual do header: casar também pelo NOME do
          // paciente/lead do evento (relation filter). Sem isto, "buscar Fulano"
          // na agenda não achava nada (só título/descrição).
          { patient: { name: { contains: query, mode: 'insensitive' } } },
          { lead: { name: { contains: query, mode: 'insensitive' } } },
        ],
      },
      include: {
        assigned_user: { select: { id: true, name: true } },
        lead: { select: { id: true, name: true, phone: true, profile_picture_url: true } },
        patient: { select: { id: true, name: true, phone: true, avatar_url: true } },
        appointment_type: { select: { name: true } },
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

  /**
   * Confirma que o evento existe e pertence ao tenant do usuario, SEM checar
   * posse (created_by/assigned_user). Usado na troca de STATUS, que e liberada
   * a QUALQUER pessoa com acesso a agenda (view_agenda) — diferente de
   * checkOwnership, que restringe edicao estrutural ao dono/admin.
   */
  async checkSameTenant(eventId: string, tenantId?: string): Promise<boolean> {
    const event = await this.prisma.calendarEvent.findUnique({
      where: { id: eventId },
      select: { tenant_id: true },
    });
    if (!event) throw new NotFoundException('Evento nao encontrado');
    if (tenantId && event.tenant_id && event.tenant_id !== tenantId) return false;
    return true;
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
        // Onda 17.59 — consulta odonto guarda o contato no PACIENTE (não no lead)
        patient: { select: { phone: true } },
      },
    });

    if (!event) {
      throw new NotFoundException(`Evento ${eventId} não encontrado`);
    }

    // Onda 17.59 — antes só AUDIENCIA/PERICIA (legado jurídico). Agora também
    // CONSULTA/PROCEDIMENTO/RETORNO (odonto): o "Notificar" dispara o lembrete na
    // hora, via a MESMA engine dos lembretes agendados — vira teste de 1 clique.
    const isHearing = ['AUDIENCIA', 'PERICIA'].includes(event.type);
    const isClinical = this.isClinicalEvent(event.type);
    if (!isHearing && !isClinical) {
      throw new BadRequestException(
        `Notificação manual não disponível para o tipo ${event.type}`,
      );
    }

    if (!event.patient?.phone && !event.lead?.phone) {
      throw new BadRequestException(
        'Paciente/cliente vinculado ao evento não possui telefone cadastrado',
      );
    }

    if (['CANCELADO', 'CONCLUIDO'].includes(event.status)) {
      throw new BadRequestException(
        `Evento está ${event.status} — notificação não enviada`,
      );
    }

    // CONSULTA odonto → envia AGORA pela MESMA engine da "agendada" (tenant-aware,
    // passa tenantId pro sendText), SÍNCRONO, e retorna o resultado REAL — não só
    // "enfileirado". Se o WhatsApp não sair, o toast mostra o MOTIVO (sem instância,
    // sem telefone, Evolution recusou) em vez de mentir "enviado".
    if (isClinical) {
      const fullEvent = await this.prisma.calendarEvent.findUnique({
        where: { id: eventId },
        include: {
          assigned_user: { select: { id: true, name: true } },
          lead: { select: { id: true, name: true, phone: true, profile_picture_url: true } },
        },
      });
      if (!fullEvent?.tenant_id) {
        throw new BadRequestException('Evento sem clínica vinculada — não dá pra notificar');
      }
      const r = await this.sendAppointmentEventWhatsapp(
        fullEvent, fullEvent.patient_id, fullEvent.lead_id, fullEvent.tenant_id, 'created',
      );
      if (!r.sent) {
        throw new BadRequestException(r.reason || 'Não foi possível enviar o WhatsApp ao paciente');
      }
      this.logger.log(`[NOTIFY] WhatsApp manual (consulta) enviado para evento ${eventId} ("${event.title}")`);
      return { queued: true, message: 'WhatsApp enviado ao paciente ✅' };
    }

    // AUDIENCIA/PERICIA (legado): remove job pendente e re-enfileira sem delay.
    try {
      const existing = await this.reminderQueue.getJob(`hearing-notify-${eventId}`);
      if (existing) await existing.remove();
    } catch {}

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
        // status nao deve ser CANCELADO/ADIADO/NO_SHOW (esses nao precisam validar)
        status: { notIn: ['CANCELADO', 'ADIADO', 'NO_SHOW'] },
        ...(filterByUser ? { assigned_user_id: params.actorUserId } : {}),
        ...(filterByUser ? {} : { assigned_user_id: { not: null } }),
      },
      select: {
        id: true, type: true, title: true, status: true,
        start_at: true, end_at: true,
        assigned_user_id: true,
        assigned_user: { select: { id: true, name: true } },
        patient: { select: { id: true, name: true, phone: true } },
        lead: { select: { id: true, name: true, phone: true, profile_picture_url: true } },
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
    return ['CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA'].includes(type);
  }

  /**
   * Onda 17.32.181 — E-mail automatico "consulta agendada".
   * Best-effort: resolve o e-mail do paciente (ou do lead) e dispara.
   * Qualquer falha so loga — criar o evento nunca quebra por e-mail.
   */
  private async sendAppointmentEventEmail(
    event: any,
    patientId: string | null | undefined,
    leadId: string | null | undefined,
    tenantId: string,
    eventKey: 'agendamento_criado' | 'agendamento_remarcado',
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

      // Onda 17.59 — hora "naive local" (igual WhatsApp/lembrete). NÃO usar timeZone
      // aqui: start_at já está nos campos UTC como hora local, então converter
      // mostrava 3h a MENOS no e-mail.
      const startAt = new Date(event.start_at);
      const data = `${String(startAt.getUTCDate()).padStart(2, '0')}/${String(startAt.getUTCMonth() + 1).padStart(2, '0')}/${startAt.getUTCFullYear()}`;
      const hora = `${String(startAt.getUTCHours()).padStart(2, '0')}:${String(startAt.getUTCMinutes()).padStart(2, '0')}`;
      await this.emailAutomation.dispatch(eventKey, tenantId, toEmail, {
        paciente_nome: toName || '',
        data,
        hora,
        profissional_nome: event.assigned_user?.name || '',
        titulo: event.title || '',
      });
    } catch (e: any) {
      this.logger.warn(`[AUTO-MAIL] ${eventKey} falhou: ${e?.message}`);
    }
  }

  /**
   * Onda 17.59 — Notificação imediata por WhatsApp "consulta agendada" (odonto),
   * espelhando o e-mail. Best-effort: resolve telefone do paciente (ou lead),
   * usa o endereço cadastrado da clínica no {local}, e manda na instância do
   * tenant. sendText já adiciona o 55. Falha só loga — criar evento nunca quebra.
   */
  private async sendAppointmentEventWhatsapp(
    event: any,
    patientId: string | null | undefined,
    leadId: string | null | undefined,
    tenantId: string,
    kind: 'created' | 'rescheduled',
  ): Promise<{ sent: boolean; reason?: string }> {
    try {
      // Evento no PASSADO não notifica o paciente. Caso real: agendamento RETROATIVO /
      // no mesmo dia lançado DEPOIS do horário, só pra CONSTAR que a visita aconteceu —
      // não faz sentido mandar "sua consulta foi agendada para [dia que já passou]".
      // start_at é naive-UTC de Maceió (+3h = instante real).
      const MACEIO_OFFSET_MS = 3 * 60 * 60 * 1000;
      const realStartMs = new Date(event?.start_at).getTime() + MACEIO_OFFSET_MS;
      if (Number.isFinite(realStartMs) && realStartMs < Date.now()) {
        this.logger.log(`[AUTO-WPP] evento ${event?.id} no passado — não notifica (${kind}).`);
        return { sent: false, reason: 'evento_passado' };
      }

      // ── AGENDA DO COMERCIAL ────────────────────────────────────────────────
      // Evento de LEAD (sem paciente, lead ainda não-cliente) com o toggle
      // comercial da faixa LIGADO → sai a versão COMERCIAL (texto próprio, chip
      // COMERCIAL) NO LUGAR da clínica — nunca os dois. Toggle OFF (default) →
      // fluxo clínico atual, intocado. Ortodontia fica sempre no fluxo clínico.
      let comercial = false;
      if (event?.type !== 'ORTODONTIA' && !patientId && leadId) {
        const l = event?.lead && typeof event.lead.is_client === 'boolean'
          ? event.lead
          : await this.prisma.lead.findUnique({ where: { id: leadId }, select: { is_client: true } }).catch(() => null);
        if (l && l.is_client === false) {
          const { comercialAgendaEnabledKey } = await import('@crm/shared');
          const cid = kind === 'rescheduled' ? 'comercial_reagendamento' : 'comercial_confirmacao';
          const cs = await this.prisma.globalSetting.findUnique({ where: { key: comercialAgendaEnabledKey(cid, tenantId) } });
          comercial = cs?.value === 'true';
        }
      }

      // O re-agendamento ("remarcada") respeita o toggle da Central
      // (APPOINTMENT_RESCHEDULED_ENABLED, default LIGADO). O "agendada" sai sempre
      // pra evento clínico (igual o e-mail), sem toggle. A versão COMERCIAL tem
      // toggle PRÓPRIO (já avaliado acima) — não passa por este.
      if (kind === 'rescheduled' && !comercial) {
        const s = await this.prisma.globalSetting.findUnique({
          where: { key: `APPOINTMENT_RESCHEDULED_ENABLED_${tenantId}` },
        });
        if ((s?.value ?? 'true') === 'false') {
          return { sent: false, reason: 'Aviso de re-agendamento está desligado na Central de Disparos' };
        }
      }

      // Prioriza o TELEFONE DO PACIENTE; cai pro lead se o paciente não tiver.
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
        this.logger.warn(`[AUTO-WPP] agendamento_${kind}: paciente/lead SEM telefone no cadastro (evento ${event.id}) — só o e-mail saiu`);
        return { sent: false, reason: 'Paciente sem telefone cadastrado' };
      }

      // Versão comercial sai pelo chip COMERCIAL (fallback interno do resolve cobre
      // tenant sem chip comercial — cai no principal, nunca no financeiro).
      const instanceName = await this.resolveTenantWhatsappInstance(tenantId, comercial ? 'COMERCIAL' : 'CLINICA');
      if (!instanceName) {
        this.logger.warn(`[AUTO-WPP] agendamento_${kind}: sem instância WhatsApp pro tenant ${tenantId}`);
        return { sent: false, reason: 'Sem instância WhatsApp conectada pra esta clínica' };
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

      let msg: string;
      if (comercial) {
        // AGENDA DO COMERCIAL: texto próprio editável (Central › seção Comercial).
        const cid = kind === 'rescheduled' ? 'comercial_reagendamento' : 'comercial_confirmacao';
        const tpl = (await this.getComercialAgendaTemplate(tenantId, cid)).template;
        msg = tpl
          .replace(/\{local_line\}/g, localLine)
          .replace(/\{nome_completo\}/g, name || 'você')
          .replace(/\{nome\}/g, nome)
          .replace(/\{dentista\}/g, dentista || 'a clínica')
          .replace(/\{data\}/g, dateStr)
          .replace(/\{hora\}/g, horaStr)
          .replace(/\{local\}/g, local || '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      } else if (kind === 'rescheduled') {
        // Texto editável na Central (APPOINTMENT_RESCHEDULED_TEMPLATE).
        const tpl = (await this.getAppointmentRescheduledConfig(tenantId)).template;
        msg = tpl
          .replace(/\{local_line\}/g, localLine)
          .replace(/\{nome\}/g, nome)
          .replace(/\{dentista\}/g, dentista || 'a clínica')
          .replace(/\{data\}/g, dateStr)
          .replace(/\{hora\}/g, horaStr)
          .replace(/\{local\}/g, local || '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      } else if (event.type === 'ORTODONTIA') {
        // Onda 18.x — ortô usa o TEXTO EDITÁVEL da "Confirmação de agendamento de
        // ortodontia (na hora)" (APPOINTMENT_ORTO_IMMEDIATE_TEMPLATE), que fala "a
        // partir das {hora}" / ordem de chegada — nunca "às {hora}" (hora fixa
        // contradiz ordem de chegada). Chamado no create() SÓ quando o toggle está
        // ligado; cobre também o botão "Notificar" manual.
        const tpl = (await this.getAppointmentOrtoImmediateConfig(tenantId)).template;
        msg = tpl
          .replace(/\{local_line\}/g, localLine)
          .replace(/\{nome_completo\}/g, name || 'paciente')
          .replace(/\{nome\}/g, nome)
          .replace(/\{dentista\}/g, dentista || 'a clínica')
          .replace(/\{data\}/g, dateStr)
          .replace(/\{hora\}/g, horaStr)
          .replace(/\{local\}/g, local || '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      } else {
        msg =
          `Olá ${nome}! 😊\n\n` +
          `Sua consulta foi agendada para *${dateStr}* às *${horaStr}*` +
          `${dentista ? ` com ${dentista}` : ''}.\n` +
          localLine +
          `\nQualquer dúvida, é só chamar por aqui!`;
      }

      // sendText retorna OBJETO DE ERRO em vez de lançar em falhas HTTP da Evolution
      // (ex.: instância offline, número sem WhatsApp). Checa pra reportar a verdade.
      const sendResult: any = await this.whatsapp.sendText(phone, msg, instanceName, undefined, tenantId);
      // Central de Disparos 2.0 — a versão COMERCIAL (lead) ganha type próprio pra
      // métrica/resumo contarem separado da versão clínica.
      const dispatchType = kind === 'rescheduled'
        ? (comercial ? 'agendamento_remarcado_comercial' : 'agendamento_remarcado')
        : (comercial ? 'agendamento_criado_comercial' : 'agendamento_criado');
      if (!sendResult || sendResult?.statusCode >= 400 || sendResult?.error) {
        const reason = `Evolution recusou o envio${sendResult?.statusCode ? ` (HTTP ${sendResult.statusCode})` : ''}${sendResult?.error ? `: ${sendResult.error}` : ' — instância pode estar offline'}`;
        this.logger.warn(`[AUTO-WPP] agendamento_${kind} falhou no envio (evento ${event.id}): ${reason}`);
        void this.logDispatch({ tenantId, type: dispatchType, recipientName: name, recipientPhone: phone, status: 'FAILED', error: reason, refEventId: event.id, refPatientId: patientId });
        return { sent: false, reason };
      }
      this.logger.log(`[AUTO-WPP] agendamento_${kind} enviado ao paciente (evento ${event.id})`);
      void this.logDispatch({ tenantId, type: dispatchType, recipientName: name, recipientPhone: phone, status: 'SENT', externalMessageId: sendResult?.data?.key?.id ?? null, refEventId: event.id, refPatientId: patientId });
      return { sent: true };
    } catch (e: any) {
      this.logger.warn(`[AUTO-WPP] agendamento_${kind} falhou: ${e?.message}`);
      void this.logDispatch({ tenantId, type: kind === 'rescheduled' ? 'agendamento_remarcado' : 'agendamento_criado', status: 'FAILED', error: e?.message, refEventId: event?.id, refPatientId: patientId });
      return { sent: false, reason: e?.message || 'Falha desconhecida ao enviar WhatsApp' };
    }
  }

  /**
   * Onda 17.60 — registra um disparo no histórico unificado (DispatchLog). Só
   * pros tipos SEM tabela própria (aniversário, resumo do dentista, agendada/
   * remarcada). Lembrete/Confirmação/NPS já têm tabela e são lidos direto.
   * Best-effort: NUNCA lança — logar não pode quebrar o disparo.
   */
  private async logDispatch(params: {
    tenantId?: string | null;
    type: string;
    channel?: string;
    recipientName?: string | null;
    recipientPhone?: string | null;
    status: 'SENT' | 'FAILED' | 'DELIVERED' | 'READ';
    error?: string | null;
    externalMessageId?: string | null;
    refEventId?: string | null;
    refPatientId?: string | null;
    refUserId?: string | null;
  }): Promise<void> {
    try {
      await this.prisma.dispatchLog.create({
        data: {
          tenant_id: params.tenantId ?? null,
          type: params.type,
          channel: params.channel ?? 'WHATSAPP',
          recipient_name: params.recipientName ?? null,
          recipient_phone: params.recipientPhone ?? null,
          status: params.status,
          error: params.error ?? null,
          external_message_id: params.externalMessageId ?? null,
          ref_event_id: params.refEventId ?? null,
          ref_patient_id: params.refPatientId ?? null,
          ref_user_id: params.refUserId ?? null,
        },
      });
    } catch (e: any) {
      this.logger.warn(`[DISPATCH_LOG] falha ao registrar ${params.type}: ${e?.message}`);
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
