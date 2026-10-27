import { Logger } from '@nestjs/common';
import axios from 'axios';
import { startOfTodayMaceioUtc } from '@crm/shared';
import type { ToolHandler, ToolContext } from '../tool-executor';
import { isHolidayMatch, resolveConversationTenantId } from './check-availability';
import { isAiAutobookEnabled } from '../auto-book-gate';
import { isPastNaive, reminderDelayMs, REMINDER_MIN_DELAY_MS } from '../scheduling-safety';
import { resolveOwnedEnvChip } from '../../admin-alerts/env-chip';

/**
 * Evento ativo do dentista que se sobrepõe a [startAt, endAt) — a MESMA regra de
 * conflito da guarda abaixo. Exportada pra o ai.processor conferir os horários
 * alternativos antes de oferecê-los (o computeDaySlots não enxerga evento que
 * começou noutro dia / cruza a meia-noite — a guarda enxerga).
 */
export async function findDentistConflict(
  prisma: any,
  userId: string,
  startAt: Date,
  endAt: Date,
  ignoreEventIds: string[] = [],
): Promise<{ id: string; title: string; start_at: Date } | null> {
  return prisma.calendarEvent.findFirst({
    where: {
      ...(ignoreEventIds.length ? { id: { notIn: ignoreEventIds } } : {}),
      assigned_user_id: userId,
      status: { notIn: ['CANCELADO', 'CONCLUIDO'] },
      start_at: { lt: endAt },
      OR: [
        { end_at: { gt: startAt } },
        { end_at: null, start_at: { gte: startAt } },
      ],
    },
    select: { id: true, title: true, start_at: true },
  });
}

/** Título padrão do que a IA marca: a avaliação inicial com a Orçamentista (mesmo
 *  rótulo que a recepção usa). O nome do paciente NÃO vai no título — o card da
 *  agenda já mostra o nome (antes saía "Consulta — Fulano", que escondia o procedimento). */
export const AI_BOOKING_DEFAULT_TITLE = 'Avaliação';

/** Título do evento marcado pela IA: o que a IA mandou (ex.: "Profilaxia") ou "Avaliação".
 *  Tira o " — Fulano" que o modelo às vezes cola; "Consulta…"/"Avaliação…" viram "Avaliação"
 *  (a IA só marca a consulta inicial com a Orçamentista). */
export function aiBookingTitle(rawTitle?: string | null): string {
  const t = String(rawTitle ?? '')
    .replace(/\s+/g, ' ')
    .split(/\s+[—–-]\s+/)[0]
    .trim();
  if (!t || /^(consulta|avalia)/i.test(t)) return AI_BOOKING_DEFAULT_TITLE;
  return t;
}

/**
 * Descrição do evento marcado pela IA — quem marcou, por onde e se é paciente novo.
 * Ex.: "Avaliação agendada pela IA (Sophia) pelo WhatsApp — paciente novo".
 * `isNewPatient` = sem ficha (Patient) ligada ao lead: ainda não compareceu nem pagou
 * (regra do clinic-transfer-guard). Observação livre da IA vai numa 2ª linha.
 */
export function aiBookingDescription(p: {
  title: string;
  assistantName?: string | null;
  isNewPatient: boolean;
  extra?: string | null;
}): string {
  const who = String(p.assistantName ?? '').trim();
  const by = `pela IA${who ? ` (${who})` : ''} pelo WhatsApp`;
  const head = /avalia/i.test(p.title) ? `${p.title} agendada ${by}` : `Agendado ${by}`;
  const line = `${head}${p.isNewPatient ? ' — paciente novo' : ''}`;
  const extra = String(p.extra ?? '').trim();
  return extra ? `${line}\n${extra}` : line;
}

/**
 * Tipo de agendamento "Avaliação" ativo da clínica (nome casa /avalia/i), se existir.
 * Só procura com tenant definido (nunca mistura clínica). Falha/ausência = null.
 */
export async function findEvaluationAppointmentTypeId(prisma: any, tenantId?: string | null): Promise<string | null> {
  if (!tenantId || !prisma?.appointmentType?.findFirst) return null;
  try {
    const t = await prisma.appointmentType.findFirst({
      where: { tenant_id: tenantId, active: true, name: { contains: 'avalia', mode: 'insensitive' } },
      orderBy: { name: 'asc' },
      select: { id: true },
    });
    return t?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Agenda uma reunião/consulta para o lead.
 *
 * Efeitos:
 *  1. Cria CalendarEvent (type=CONSULTA, created_by_ai=true) para o dentista atribuído.
 *  2. Cria EventReminders de 30min (lembrete principal), 60min e 1440min (antecedência).
 *  3. Enfileira jobs na fila 'calendar-reminders' (canal WHATSAPP) para todos os lembretes.
 *
 * Os lembretes viajam pelo ReminderProcessor existente (vão pro event.lead.phone, o
 * paciente). O dentista NÃO é avisado por paciente — recebe o "Resumo diário do dentista".
 */
export class BookAppointmentHandler implements ToolHandler {
  name = 'book_appointment';
  private readonly logger = new Logger(BookAppointmentHandler.name);

  async execute(
    params: {
      date: string;       // YYYY-MM-DD
      time: string;       // HH:MM
      title?: string;
      description?: string;
      duration_minutes?: number;
    },
    context: ToolContext,
  ): Promise<any> {
    const prisma = context.prisma;

    if (!params.date || !params.time) {
      return { success: false, error: 'date e time são obrigatórios (YYYY-MM-DD e HH:MM)' };
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(params.date)) {
      return { success: false, error: `Data inválida: "${params.date}". Use YYYY-MM-DD.` };
    }
    if (!/^\d{2}:\d{2}$/.test(params.time)) {
      return { success: false, error: `Hora inválida: "${params.time}". Use HH:MM (24h).` };
    }

    // Resolve assigned dentist + tenant
    const convo = await prisma.conversation.findUnique({
      where: { id: context.conversationId },
      select: { assigned_dentist_id: true, assigned_user_id: true, tenant_id: true },
    });

    const assignedUserId = convo?.assigned_dentist_id || convo?.assigned_user_id;
    if (!assignedUserId) {
      return {
        success: false,
        error: 'Nenhum dentista atribuído a esta conversa. Use escalate_to_human antes de agendar.',
      };
    }

    // FREIO — agendamento automático pela IA é OPT-IN (default OFF). Sem isso, a IA
    // NÃO cria evento na agenda sozinha (evita "agendando o pessoal sozinho").
    if (!(await isAiAutobookEnabled(prisma, convo?.tenant_id))) {
      this.logger.warn(
        `[book_appointment] Auto-agendamento DESATIVADO (tenant ${convo?.tenant_id ?? 'null'}) — NÃO criando evento.`,
      );
      return {
        success: false,
        error:
          'O agendamento automático pela IA está DESATIVADO nesta clínica. NÃO crie o evento — ' +
          'diga ao paciente que a RECEPÇÃO vai confirmar o horário e retornar o contato.',
      };
    }

    const durationMinutes = params.duration_minutes ?? 60;

    // UTC naive: datas são gravadas com os componentes locais como se fossem UTC.
    // Constrói direto via Date.UTC para não sofrer conversão pelo fuso da VPS.
    const [y, mo, d] = params.date.split('-').map(Number);
    const [h, mi] = params.time.split(':').map(Number);
    const startAt = new Date(Date.UTC(y, mo - 1, d, h, mi, 0, 0));
    const endAt = new Date(startAt.getTime() + durationMinutes * 60 * 1000);

    // "Já passou" no MESMO referencial da agenda (naive = hora de Maceió como UTC).
    // Antes comparava com Date.now() REAL e recusava um horário de hoje 3h antes da hora.
    if (isPastNaive(startAt)) {
      return { success: false, error: 'Data/hora já passou. Ofereça outro horário.' };
    }

    // Remarcação pela IA: as consultas antigas DESTA conversa (que serão canceladas
    // só depois do sucesso) não contam como conflito nem como "já tem agendamento".
    const ignoreIds: string[] = Array.isArray(context.ignoreEventIds) ? context.ignoreEventIds.filter(Boolean) : [];
    const notIgnored = ignoreIds.length ? { id: { notIn: ignoreIds } } : {};

    // Conflito com evento existente do dentista
    const conflict = await findDentistConflict(prisma, assignedUserId, startAt, endAt, ignoreIds);

    if (conflict) {
      return {
        success: false,
        error: `Horário indisponível — já existe "${conflict.title}" nesse horário.`,
      };
    }

    // Onda 5e v9 (Fase 25) — validacoes de defesa em profundidade.
    // check_availability JA filtra esses casos, mas se a IA "alucinar" e
    // chamar book_appointment direto com hora invalida, recusamos aqui.
    // (book direto sem check tambem acontece quando user manda data fixa
    // tipo "agenda dia 25/12 as 9h").

    // 1. Feriado (incluindo recorrentes anuais via isHolidayMatch) — só os DESTA
    // clínica + globais; o feriado de outra clínica não bloqueia esta agenda.
    const holidayTenantId = convo?.tenant_id ?? (await resolveConversationTenantId(prisma, context));
    if (await isHolidayMatch(prisma, startAt, holidayTenantId)) {
      return {
        success: false,
        error: `Data ${params.date} é feriado. Ofereça outro dia ao paciente.`,
      };
    }

    // 2. Bloqueio de agenda (ferias, doenca, curso) cobrindo o horario
    const blockHit = await prisma.scheduleBlock.findFirst({
      where: {
        user_id: assignedUserId,
        OR: [
          // all_day cobrindo o dia
          {
            all_day: true,
            start_at: { lte: endAt },
            end_at: { gte: startAt },
          },
          // intervalo de horas se sobrepondo
          {
            all_day: false,
            start_at: { lt: endAt },
            end_at: { gt: startAt },
          },
        ],
      },
      select: { reason: true, start_at: true, end_at: true, all_day: true },
    });
    if (blockHit) {
      return {
        success: false,
        error: `Dentista esta bloqueado nesse periodo (${blockHit.reason}). Ofereça outro horário.`,
      };
    }

    // 3. v10: UserSchedule pode ter MULTIPLOS turnos no mesmo dia
    // (ex: Manha 08-12 + Tarde 14-18). O appointment precisa caber INTEIRO
    // dentro de UM dos turnos (nao pode atravessar gap entre manha e tarde).
    const dow = startAt.getUTCDay();
    const shifts = await prisma.userSchedule.findMany({
      where: { user_id: assignedUserId, day_of_week: dow },
      orderBy: [{ sort_order: 'asc' }, { start_time: 'asc' }],
    });
    if (shifts.length === 0) {
      const dayName = ['domingo','segunda','terca','quarta','quinta','sexta','sabado'][dow];
      return {
        success: false,
        error: `Dentista nao atende em ${dayName}. Ofereça outro dia.`,
      };
    }
    const apptStartMin = startAt.getUTCHours() * 60 + startAt.getUTCMinutes();
    const apptEndMin = endAt.getUTCHours() * 60 + endAt.getUTCMinutes();

    // Procura turno que cobre o appointment INTEIRO + verifica conflito
    // com lunch interno do turno (backward compat com lunch_start/end)
    let validShift: typeof shifts[number] | null = null;
    let lunchHit: { start: string; end: string } | null = null;
    for (const shift of shifts) {
      const [wsH, wsM] = (shift.start_time || '08:00').split(':').map(Number);
      const [weH, weM] = (shift.end_time || '18:00').split(':').map(Number);
      const workStart = wsH * 60 + wsM;
      const workEnd = weH * 60 + weM;
      if (apptStartMin >= workStart && apptEndMin <= workEnd) {
        // Cabe nesse turno — agora checa lunch interno (compat)
        if (shift.lunch_start && shift.lunch_end) {
          const [lsH, lsM] = shift.lunch_start.split(':').map(Number);
          const [leH, leM] = shift.lunch_end.split(':').map(Number);
          const lunchStart = lsH * 60 + lsM;
          const lunchEnd = leH * 60 + leM;
          if (apptEndMin > lunchStart && apptStartMin < lunchEnd) {
            lunchHit = { start: shift.lunch_start, end: shift.lunch_end };
            continue; // procura outro turno que nao tenha conflito de lunch
          }
        }
        validShift = shift;
        break;
      }
    }

    if (!validShift) {
      // Mensagem amigavel listando turnos disponiveis
      const turnList = shifts
        .map((s: { label?: string | null; start_time: string; end_time: string }) =>
          `${s.label ? s.label + ' ' : ''}${s.start_time}-${s.end_time}`,
        )
        .join(', ');
      if (lunchHit) {
        return {
          success: false,
          error: `Horario ${params.time} cai no almoco do dentista (${lunchHit.start}-${lunchHit.end}). Turnos disponiveis: ${turnList}.`,
        };
      }
      return {
        success: false,
        error: `Horario ${params.time} fora dos turnos do dentista. Atende: ${turnList}.`,
      };
    }

    // Resolve patient_id se o lead já foi convertido em Patient — habilita
    // Timeline + Resumo Clínico (consultas count, first/last visit) a refletir
    // consultas agendadas pela IA, não só pelo operador no front.
    let resolvedPatientId: string | undefined;
    if (context.leadId) {
      const linkedPatient = await prisma.patient.findUnique({
        where: { lead_id: context.leadId },
        select: { id: true },
      });
      if (linkedPatient) resolvedPatientId = linkedPatient.id;
    }

    // Onda 17.61 — DEDUP: a IA não pode agendar 2x o mesmo paciente perto do mesmo
    // horário (gera lembretes repetidos — caso da Ana 14:00 + 14:30, agravado pela
    // duplicação de lead do 9º dígito). Se já há CONSULTA AGENDADO/CONFIRMADO desse
    // lead/paciente dentro de ±3h do horário pedido, retorna o existente sem criar.
    const DUP_WINDOW_MS = 3 * 60 * 60 * 1000;
    const dupOwner: any[] = [];
    if (context.leadId) dupOwner.push({ lead_id: context.leadId });
    if (resolvedPatientId) dupOwner.push({ patient_id: resolvedPatientId });
    if (dupOwner.length) {
      const existing = await prisma.calendarEvent.findFirst({
        where: {
          ...notIgnored,
          type: 'CONSULTA',
          status: { in: ['AGENDADO', 'CONFIRMADO'] },
          tenant_id: convo.tenant_id || undefined,
          OR: dupOwner,
          start_at: {
            gte: new Date(startAt.getTime() - DUP_WINDOW_MS),
            lte: new Date(startAt.getTime() + DUP_WINDOW_MS),
          },
        },
        select: { id: true },
      });
      if (existing) {
        this.logger.warn(`[book_appointment] DEDUP — lead=${context.leadId} já tem agendamento ${existing.id} perto de ${startAt.toISOString()}; NÃO duplicando.`);
        return {
          success: true,
          eventId: existing.id,
          already_booked: true,
          message: 'Esse paciente já tem um agendamento próximo desse horário — mantive o existente pra NÃO duplicar. Avise que já está marcado e não crie outro.',
        };
      }
    }

    // Bloqueio de agendamento de DEVEDOR (opt-in por clínica, default OFF). Mesma
    // regra do CalendarService.create da API (a IA não passa por lá). A IA NÃO tem
    // admin pra liberar, então SEMPRE barra quando ligado e o paciente tem boleto
    // atrasado ao vivo. Verificação AO VIVO — pagar/cancelar destrava sozinho.
    if (resolvedPatientId && convo.tenant_id) {
      const flag = await prisma.globalSetting.findUnique({
        where: { key: `BLOCK_SCHED_ON_OVERDUE_${convo.tenant_id}` },
      });
      if (flag?.value === 'true') {
        const patient = await prisma.patient.findUnique({
          where: { id: resolvedPatientId },
          select: { lead_id: true },
        });
        const or: any[] = [
          { patient_id: resolvedPatientId },
          { treatment_plan: { patient_id: resolvedPatientId } },
        ];
        if (patient?.lead_id) {
          const custs = await prisma.paymentGatewayCustomer.findMany({
            where: { lead_id: patient.lead_id, tenant_id: convo.tenant_id },
            select: { external_id: true },
          });
          const extIds = custs.map((c: { external_id: string }) => c.external_id).filter(Boolean) as string[];
          if (extIds.length) or.push({ customer_external_id: { in: extIds } });
        }
        const overdueCount = await prisma.paymentGatewayCharge.count({
          where: {
            tenant_id: convo.tenant_id,
            status: { in: ['PENDING', 'OVERDUE'] },
            received_in_cash: false,
            // Vence HOJE ainda está no prazo (mesma régua da API — calendar.service).
            due_date: { lt: startOfTodayMaceioUtc() },
            OR: or,
          },
        });
        if (overdueCount > 0) {
          this.logger.warn(`[book_appointment] BLOQUEIO devedor — paciente=${resolvedPatientId} tem ${overdueCount} boleto(s) atrasado(s); NÃO agenda.`);
          return {
            success: false,
            error:
              'Paciente com boleto em atraso — a política da clínica não permite agendar até regularizar. ' +
              'NÃO agende. Oriente o paciente a pagar/negociar no Financeiro; a recepção pode liberar manualmente se necessário.',
          };
        }
      }
    }

    // Procedimento no TÍTULO ("Avaliação" por padrão — sem o nome do paciente, que o
    // card já mostra) + descrição dizendo que foi a IA e se é paciente novo (sem ficha).
    // Se a clínica cadastrou um tipo "Avaliação", o evento já sai com ele.
    // Paciente novo = sem ficha E lead que ainda não virou paciente (is_client=false) —
    // mesma regra do selo "Novo" da agenda (lead vira paciente ao comparecer/pagar).
    let leadIsClient = false;
    if (!resolvedPatientId && context.leadId && prisma.lead?.findUnique) {
      try {
        const l = await prisma.lead.findUnique({ where: { id: context.leadId }, select: { is_client: true } });
        leadIsClient = l?.is_client === true;
      } catch {
        /* sem a flag: trata como novo (não tem ficha) */
      }
    }
    const title = aiBookingTitle(params.title);
    const description = aiBookingDescription({
      title,
      assistantName: context.assistantName,
      isNewPatient: !resolvedPatientId && !leadIsClient,
      extra: params.description,
    });
    const appointmentTypeId = /avalia/i.test(title)
      ? await findEvaluationAppointmentTypeId(prisma, convo.tenant_id)
      : null;

    // Cria o CalendarEvent + reminders em uma só chamada
    const event = await prisma.calendarEvent.create({
      data: {
        type: 'CONSULTA',
        title,
        description,
        ...(appointmentTypeId ? { appointment_type_id: appointmentTypeId } : {}),
        start_at: startAt,
        end_at: endAt,
        status: 'AGENDADO',
        priority: 'NORMAL',
        assigned_user_id: assignedUserId,
        lead_id: context.leadId,
        patient_id: resolvedPatientId,
        conversation_id: context.conversationId,
        // created_by_id é OBRIGATÓRIO no schema (relation User) — a IA não é um User,
        // então fica o dentista responsável. Quem marcou de verdade é o created_by_ai:
        // a agenda mostra "Agendado pela IA" no lugar do criador.
        created_by_id: assignedUserId,
        created_by_ai: true,
        // Conta do evento: a da conversa; sem ela, a do contato (mesma resolução do
        // feriado acima) — o evento não nasce sem conta.
        tenant_id: holidayTenantId || undefined,
        // Onda 5e v26: alinhado com defaults da UI [1d, 1h, 15min antes].
        // Filtra pelo tempo restante (nao cria reminder cuja antecedencia ja passou) —
        // no instante REAL (naive + 3h), mesma conta da API.
        reminders: {
          create: [1440, 60, 15]
            .filter((m) => reminderDelayMs(startAt, m) >= REMINDER_MIN_DELAY_MS)
            .map((m) => ({ minutes_before: m, channel: 'WHATSAPP' as const })),
        },
      },
      include: {
        reminders: true,
        assigned_user: { select: { id: true, name: true, phone: true } },
        lead: { select: { id: true, name: true, phone: true } },
      },
    });

    // Enfileira cada lembrete com delay correspondente
    if (context.reminderQueue) {
      for (const r of event.reminders) {
        // start_at é naive (hora de Maceió gravada como UTC): o disparo REAL é naive + 3h
        // (mesma conta do calendar.service.enqueueReminders da API). Antes usava o naive
        // direto e o lembrete saía 3h ADIANTADO ("1h antes" chegava 4h antes).
        const delay = reminderDelayMs(event.start_at, r.minutes_before);
        if (delay < REMINDER_MIN_DELAY_MS) continue; // não tem tempo para disparar antes
        try {
          await context.reminderQueue.add(
            'send-reminder',
            { reminderId: r.id, eventId: event.id, channel: r.channel },
            {
              delay,
              // ANTI-DUPLICIDADE: 1 tentativa (ver calendar.service.enqueueReminders).
              // attempts:3 reenviava o lembrete quando a Evolution entregava mas
              // respondia erro → paciente recebia 2x. Sem retry = sem reenvio.
              jobId: `reminder-${r.id}`,
              attempts: 1,
              removeOnComplete: true,
              removeOnFail: 50,
            },
          );
        } catch (e: any) {
          this.logger.warn(`[book_appointment] Falha ao enfileirar lembrete ${r.id}: ${e.message}`);
        }
      }
    } else {
      this.logger.warn('[book_appointment] reminderQueue indisponível — lembretes NÃO foram enfileirados');
    }

    // Sem aviso imediato ao dentista: era 1 WhatsApp POR paciente marcado, a qualquer
    // hora (a IA marca de madrugada). A agenda do dentista chega numa mensagem só, o
    // "Resumo diário do dentista"; os ADMs têm o aviso próprio (admin-alerts, opt-in).

    // Onda 5e v18 (Fase 25, A.3) — confirmacao FORMAL imediata ao paciente
    // (data, hora, dentista, endereco, aviso de lembrete). A IA tambem
    // respondera naturalmente no proximo turno, mas essa mensagem garante
    // que o paciente tem uma confirmacao "oficial" estruturada no historico
    // do WhatsApp pra consultar depois.
    // skipPatientNotify: quando chamado pelo confirm_slot da IA, a confirmação ao paciente
    // é o próprio finalText da IA — sem isto o paciente recebe 2 mensagens de confirmação.
    if (!context.skipPatientNotify) {
      try {
        await this.notifyPatient(event, prisma);
      } catch (e: any) {
        this.logger.warn(`[book_appointment] Falha ao notificar paciente: ${e.message}`);
      }
    }

    return {
      success: true,
      eventId: event.id,
      date: params.date,
      time: params.time,
      duration_minutes: durationMinutes,
      message: `Avaliacao agendada para ${params.date} às ${params.time} com duração de ${durationMinutes}min.`,
    };
  }

  // ─── Onda 5e v18: Confirmacao FORMAL imediata ao paciente ─────────────
  private async notifyPatient(event: any, prisma: any): Promise<void> {
    if (!event.lead?.phone) {
      this.logger.warn(`[book_appointment] Lead ${event.lead_id} sem telefone — confirmacao ao paciente pulada`);
      return;
    }

    const apiUrlRow = await prisma.globalSetting.findUnique({ where: { key: 'EVOLUTION_API_URL' } });
    const apiKeyRow = await prisma.globalSetting.findUnique({ where: { key: 'EVOLUTION_GLOBAL_APIKEY' } });
    let apiUrl = apiUrlRow?.value || process.env.EVOLUTION_API_URL || '';
    const apiKey = apiKeyRow?.value || process.env.EVOLUTION_GLOBAL_APIKEY || '';
    if (!apiUrl) {
      this.logger.warn('[book_appointment] EVOLUTION_API_URL ausente — confirmacao ao paciente pulada');
      return;
    }
    if (!/^https?:\/\//i.test(apiUrl)) apiUrl = `https://${apiUrl}`;
    apiUrl = apiUrl.replace(/\/+$/, '');

    // Chip padrão do servidor SÓ se for da clínica do evento (env-chip.ts). null = não
    // envia: o paciente fica sem a confirmação formal, como já ficava quando a Evolution
    // recusava o chip vazio/morto; o evento e os lembretes seguem normais.
    const instance = await resolveOwnedEnvChip(prisma, event.tenant_id, 'book_appointment');
    if (!instance) {
      this.logger.warn(
        `[book_appointment] Confirmação ao paciente não enviada — clínica ${event.tenant_id ?? '?'} sem chip próprio (chip padrão do servidor vazio ou de outra clínica)`,
      );
      return;
    }

    // Tenta pegar endereco da clinica (GlobalSetting CLINIC_ADDRESS)
    const addrRow = await prisma.globalSetting
      .findUnique({ where: { key: 'CLINIC_ADDRESS' } })
      .catch(() => null);
    const clinicAddress = addrRow?.value || '';

    const dateStr = this.formatDate(event.start_at);
    const timeStr = this.formatTime(event.start_at);
    const firstName = (event.lead?.name || 'paciente').split(' ')[0];
    // "Dra. Suellen Passos" -> "Dra. Suellen"
    const dentistFull = event.assigned_user?.name || '';
    const parts = dentistFull.split(' ');
    const dentista = parts.length >= 3 ? `${parts[0]} ${parts[1]}` : dentistFull;

    const lines = [
      `Pronto, ${firstName}! ✅`,
      ``,
      `Sua avaliação ${dentista ? 'com ' + dentista + ' ' : ''}está confirmada:`,
      ``,
      `📅 ${dateStr}`,
      `⏰ ${timeStr}`,
    ];
    if (event.location) {
      lines.push(`📍 ${event.location}`);
    } else if (clinicAddress) {
      lines.push(`📍 ${clinicAddress}`);
    }
    lines.push(``);
    lines.push(`Te aviso 1 dia antes pra confirmar. Qualquer coisa, é só me chamar aqui. 😊`);

    await axios.post(
      `${apiUrl}/message/sendText/${instance}`,
      { number: event.lead.phone, text: lines.join('\n') },
      { headers: { apikey: apiKey }, timeout: 15000 },
    );

    this.logger.log(
      `[book_appointment] Confirmacao formal enviada ao paciente ${event.lead.name} (${event.lead.phone})`,
    );
  }

  private formatDate(d: Date): string {
    return d.toLocaleDateString('pt-BR', {
      timeZone: 'UTC',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  private formatTime(d: Date): string {
    return d.toLocaleTimeString('pt-BR', {
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
