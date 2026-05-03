import { Logger } from '@nestjs/common';
import axios from 'axios';
import type { ToolHandler, ToolContext } from '../tool-executor';
import { isHolidayMatch } from './check-availability';

/**
 * Agenda uma reunião/consulta para o lead.
 *
 * Efeitos:
 *  1. Cria CalendarEvent (type=CONSULTA, created_by_ai=true) para o dentista atribuído.
 *  2. Cria EventReminders de 30min (lembrete principal), 60min e 1440min (antecedência).
 *  3. Enfileira jobs na fila 'calendar-reminders' (canal WHATSAPP) para todos os lembretes.
 *  4. Dispara notificação IMEDIATA ao dentista via WhatsApp ("Novo agendamento pela IA").
 *
 * Os lembretes viajam pelo ReminderProcessor existente, que já sabe enviar para
 * event.lead.phone (cliente) e event.assigned_user.phone (dentista).
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

    const durationMinutes = params.duration_minutes ?? 60;

    // UTC naive: datas são gravadas com os componentes locais como se fossem UTC.
    // Constrói direto via Date.UTC para não sofrer conversão pelo fuso da VPS.
    const [y, mo, d] = params.date.split('-').map(Number);
    const [h, mi] = params.time.split(':').map(Number);
    const startAt = new Date(Date.UTC(y, mo - 1, d, h, mi, 0, 0));
    const endAt = new Date(startAt.getTime() + durationMinutes * 60 * 1000);

    if (startAt.getTime() <= Date.now()) {
      return { success: false, error: 'Data/hora já passou. Ofereça outro horário.' };
    }

    // Conflito com evento existente do dentista
    const conflict = await prisma.calendarEvent.findFirst({
      where: {
        assigned_user_id: assignedUserId,
        status: { notIn: ['CANCELADO', 'CONCLUIDO'] },
        start_at: { lt: endAt },
        OR: [
          { end_at: { gt: startAt } },
          { end_at: null, start_at: { gte: startAt } },
        ],
      },
      select: { id: true, title: true, start_at: true },
    });

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

    // 1. Feriado (incluindo recorrentes anuais via isHolidayMatch)
    if (await isHolidayMatch(prisma, startAt)) {
      return {
        success: false,
        error: `Data ${params.date} é feriado nacional. Ofereça outro dia ao paciente.`,
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

    // Cria o CalendarEvent + reminders em uma só chamada
    const event = await prisma.calendarEvent.create({
      data: {
        type: 'CONSULTA',
        title: params.title || 'Consulta',
        description: params.description || 'Reunião agendada automaticamente pela IA',
        start_at: startAt,
        end_at: endAt,
        status: 'AGENDADO',
        priority: 'NORMAL',
        assigned_user_id: assignedUserId,
        lead_id: context.leadId,
        patient_id: resolvedPatientId,
        conversation_id: context.conversationId,
        created_by_id: assignedUserId,
        created_by_ai: true,
        tenant_id: convo.tenant_id || undefined,
        reminders: {
          create: [
            { minutes_before: 30, channel: 'WHATSAPP' },
            { minutes_before: 60, channel: 'WHATSAPP' },
            { minutes_before: 1440, channel: 'WHATSAPP' },
          ],
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
        const fireAt = new Date(event.start_at.getTime() - r.minutes_before * 60 * 1000);
        const delay = fireAt.getTime() - Date.now();
        if (delay <= 0) continue; // não tem tempo para disparar antes
        try {
          await context.reminderQueue.add(
            'send-reminder',
            { reminderId: r.id, eventId: event.id, channel: r.channel },
            {
              delay,
              jobId: `reminder-${r.id}`,
              attempts: 3,
              backoff: { type: 'exponential', delay: 5000 },
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

    // Notificação imediata ao dentista via WhatsApp
    try {
      await this.notifyDentist(event, prisma);
    } catch (e: any) {
      this.logger.warn(`[book_appointment] Falha ao notificar dentista: ${e.message}`);
    }

    // Onda 5e v18 (Fase 25, A.3) — confirmacao FORMAL imediata ao paciente
    // (data, hora, dentista, endereco, aviso de lembrete). A IA tambem
    // respondera naturalmente no proximo turno, mas essa mensagem garante
    // que o paciente tem uma confirmacao "oficial" estruturada no historico
    // do WhatsApp pra consultar depois.
    try {
      await this.notifyPatient(event, prisma);
    } catch (e: any) {
      this.logger.warn(`[book_appointment] Falha ao notificar paciente: ${e.message}`);
    }

    return {
      success: true,
      eventId: event.id,
      date: params.date,
      time: params.time,
      duration_minutes: durationMinutes,
      dentist_notified: !!event.assigned_user?.phone,
      message: `Avaliacao agendada para ${params.date} às ${params.time} com duração de ${durationMinutes}min. Dentista e paciente notificados via WhatsApp.`,
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

    const instance = process.env.EVOLUTION_INSTANCE_NAME || '';

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

  // ─── Notificação imediata ao dentista responsável ────────────────────
  private async notifyDentist(event: any, prisma: any): Promise<void> {
    if (!event.assigned_user?.phone) {
      this.logger.warn(`[book_appointment] Dentista ${event.assigned_user_id} sem telefone — notificação pulada`);
      return;
    }

    const apiUrlRow = await prisma.globalSetting.findUnique({ where: { key: 'EVOLUTION_API_URL' } });
    const apiKeyRow = await prisma.globalSetting.findUnique({ where: { key: 'EVOLUTION_GLOBAL_APIKEY' } });

    let apiUrl = apiUrlRow?.value || process.env.EVOLUTION_API_URL || '';
    const apiKey = apiKeyRow?.value || process.env.EVOLUTION_GLOBAL_APIKEY || '';
    if (!apiUrl) {
      this.logger.warn('[book_appointment] EVOLUTION_API_URL ausente — notificação ao dentista pulada');
      return;
    }
    if (!/^https?:\/\//i.test(apiUrl)) apiUrl = `https://${apiUrl}`;
    apiUrl = apiUrl.replace(/\/+$/, '');

    const instance = process.env.EVOLUTION_INSTANCE_NAME || '';
    const dateStr = this.formatDate(event.start_at);
    const timeStr = this.formatTime(event.start_at);
    const endTimeStr = event.end_at ? this.formatTime(event.end_at) : null;

    const lines = [
      `📅 *Novo agendamento pela IA*`,
      ``,
      `*Cliente:* ${event.lead?.name || 'Não identificado'}`,
      `*Telefone:* ${event.lead?.phone || 'N/A'}`,
      `*Data:* ${dateStr}`,
      `*Horário:* ${timeStr}${endTimeStr ? ` - ${endTimeStr}` : ''}`,
      `*Assunto:* ${event.title}`,
    ];
    if (event.description) lines.push(`*Obs:* ${event.description}`);
    lines.push('', '_Agendado automaticamente pela assistente virtual._');

    await axios.post(
      `${apiUrl}/message/sendText/${instance}`,
      { number: event.assigned_user.phone, text: lines.join('\n') },
      { headers: { apikey: apiKey }, timeout: 15000 },
    );

    this.logger.log(
      `[book_appointment] Notificação enviada ao dentista ${event.assigned_user.name} (${event.assigned_user.phone})`,
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
