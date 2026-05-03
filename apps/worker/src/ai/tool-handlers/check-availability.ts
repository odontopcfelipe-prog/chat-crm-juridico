import type { ToolHandler, ToolContext } from '../tool-executor';
import { ensureOrcamentistaAssigned } from '../orcamentista';

/**
 * Verifica horários disponíveis de um dentista para agendamento.
 * Consulta UserSchedule, Holidays, ScheduleBlocks e CalendarEvents existentes.
 *
 * ⚠️ REGRA: AVALIAÇÃO inicial sempre vai pra um Orçamentista. Esse handler
 * usa ensureOrcamentistaAssigned() pra garantir que está consultando a agenda
 * de um dentista com especialidade "Orçamentista" (e atualiza
 * Conversation.assigned_dentist_id pra "lock in" — confirm_slot depois usa o
 * mesmo dentista, evitando race condition).
 *
 * UTC naive: as datas são armazenadas com os componentes locais como se fossem
 * UTC. Portanto usamos getUTCHours()/getUTCDay() em todo lugar.
 *
 * Onda 5e v9 (Fase 25):
 *   - Sabado liberado: removido skip hardcoded de fim de semana. Se o dentista
 *     tem UserSchedule pro day_of_week=6 (sabado), oferece. Domingo ainda nao
 *     aparece porque tipicamente nao tem UserSchedule, mas se algum dia tiver,
 *     o codigo respeita.
 *   - Feriados recorrentes funcionam: matching por data exata OU MM-DD igual
 *     quando recurring_yearly=true. Antes so detectava ano corrente.
 *   - ScheduleBlock respeitado: ferias/doenca/curso bloqueiam dia inteiro
 *     (all_day=true) ou intervalo de horas especifico.
 */
export class CheckAvailabilityHandler implements ToolHandler {
  name = 'check_availability';

  async execute(
    params: { date?: string; days_ahead?: number; duration_minutes?: number },
    context: ToolContext,
  ): Promise<any> {
    const prisma = context.prisma;
    const durationMinutes = params.duration_minutes || 60;

    // Garante que a conversa está atribuída a um Orçamentista (faz lock-in
    // pra próximas chamadas como confirm_slot usarem o mesmo dentista).
    const userId = await ensureOrcamentistaAssigned(prisma, context.conversationId);
    if (!userId) {
      return {
        available: false,
        message:
          'Nenhum Orçamentista cadastrado no sistema. Operador precisa criar um dentista com especialidade "Orçamentista" em Settings → Usuários antes de a IA poder agendar avaliações.',
      };
    }

    const daysToCheck = params.days_ahead ?? 14; // ampliado pra cobrir sabados na proxima semana
    const startDate = params.date ? new Date(`${params.date}T00:00:00Z`) : new Date();
    if (!params.date) {
      // Começa no próximo dia (UTC naive)
      startDate.setUTCDate(startDate.getUTCDate() + 1);
    }

    const slots: { date: string; times: string[] }[] = [];

    for (let i = 0; i < daysToCheck && slots.length < 5; i++) {
      const day = new Date(startDate.getTime());
      day.setUTCDate(day.getUTCDate() + i);

      // v9: removido skip hardcoded de domingo/sabado. Agora getSlots()
      // retorna [] se nao tem UserSchedule pro dia da semana — efeito
      // equivalente sem hardcode (clinicas que atendem sabado funcionam).
      const dateStr = day.toISOString().split('T')[0];
      const daySlots = await this.getSlots(prisma, userId, dateStr, durationMinutes);
      if (daySlots.length > 0) {
        slots.push({ date: dateStr, times: daySlots.slice(0, 6) });
      }
    }

    if (slots.length === 0) {
      return { available: false, message: 'Nenhum horário disponível nos próximos dias.' };
    }

    return { available: true, slots };
  }

  private async getSlots(
    prisma: any,
    userId: string,
    dateStr: string,
    durationMinutes: number,
  ): Promise<string[]> {
    const dayStart = new Date(`${dateStr}T00:00:00Z`);
    const dayEnd = new Date(`${dateStr}T23:59:59Z`);

    // v9: feriado matchea (1) data exata OU (2) recurring_yearly + MM-DD igual.
    // Antes so a clausula 1 era checada — feriados anuais cadastrados em 2026
    // nao bloqueavam o mesmo dia em 2027+. Helper isHolidayMatch resolve isso.
    if (await isHolidayMatch(prisma, dayStart)) return [];

    // v9: bloqueio de agenda (ferias/doenca/curso) — se cobre o dia INTEIRO
    // (all_day OR intervalo cobre 00:00-23:59), retorna []. Bloqueios parciais
    // (so manha, so tarde) sao tratados depois adicionando ao busyMinutes.
    const fullDayBlocks = await prisma.scheduleBlock.count({
      where: {
        user_id: userId,
        OR: [
          // all_day no proprio dia
          { all_day: true, start_at: { lte: dayEnd }, end_at: { gte: dayStart } },
          // intervalo cobre dia inteiro
          { all_day: false, start_at: { lte: dayStart }, end_at: { gte: dayEnd } },
        ],
      },
    });
    if (fullDayBlocks > 0) return [];

    // Agenda do dentista para o dia da semana
    const schedule = await prisma.userSchedule.findUnique({
      where: { user_id_day_of_week: { user_id: userId, day_of_week: dayStart.getUTCDay() } },
    });
    if (!schedule) return [];

    // Eventos existentes do dentista no dia
    const events = await prisma.calendarEvent.findMany({
      where: {
        assigned_user_id: userId,
        start_at: { gte: dayStart, lte: dayEnd },
        status: { notIn: ['CANCELADO', 'CONCLUIDO'] },
      },
      select: { start_at: true, end_at: true },
    });

    // v9: bloqueios PARCIAIS do dia (so manha/tarde) entram como busy time
    const partialBlocks = await prisma.scheduleBlock.findMany({
      where: {
        user_id: userId,
        all_day: false,
        // intersecta com o dia mas NAO cobre inteiro
        start_at: { lte: dayEnd },
        end_at: { gte: dayStart },
      },
      select: { start_at: true, end_at: true },
    });

    const [startH, startM] = (schedule.start_time || '08:00').split(':').map(Number);
    const [endH, endM] = (schedule.end_time || '18:00').split(':').map(Number);
    const workStart = startH * 60 + startM;
    const workEnd = endH * 60 + endM;

    const busyMinutes = new Set<number>();
    for (const ev of events) {
      const evStart = ev.start_at.getUTCHours() * 60 + ev.start_at.getUTCMinutes();
      const evEnd = ev.end_at
        ? ev.end_at.getUTCHours() * 60 + ev.end_at.getUTCMinutes()
        : evStart + 60;
      for (let m = evStart; m < evEnd; m++) busyMinutes.add(m);
    }

    // v9: somar bloqueios parciais (recortes do dia) ao busy
    for (const blk of partialBlocks) {
      // converte pra minutos LOCAIS do dia, clamping nos limites do dia
      const blkStartDay = blk.start_at < dayStart ? dayStart : blk.start_at;
      const blkEndDay = blk.end_at > dayEnd ? dayEnd : blk.end_at;
      const blkStart = blkStartDay.getUTCHours() * 60 + blkStartDay.getUTCMinutes();
      const blkEnd = blkEndDay.getUTCHours() * 60 + blkEndDay.getUTCMinutes();
      for (let m = blkStart; m < blkEnd; m++) busyMinutes.add(m);
    }

    // Bloqueia horário de almoço se definido
    if (schedule.lunch_start && schedule.lunch_end) {
      const [lsH, lsM] = schedule.lunch_start.split(':').map(Number);
      const [leH, leM] = schedule.lunch_end.split(':').map(Number);
      const lunchStart = lsH * 60 + lsM;
      const lunchEnd = leH * 60 + leM;
      for (let m = lunchStart; m < lunchEnd; m++) busyMinutes.add(m);
    }

    const available: string[] = [];
    for (let m = workStart; m + durationMinutes <= workEnd; m += 30) {
      let free = true;
      for (let d = 0; d < durationMinutes; d++) {
        if (busyMinutes.has(m + d)) { free = false; break; }
      }
      if (free) {
        const h = Math.floor(m / 60).toString().padStart(2, '0');
        const min = (m % 60).toString().padStart(2, '0');
        available.push(`${h}:${min}`);
      }
    }

    return available;
  }
}

/**
 * v9: detecta se uma data UTC eh feriado considerando recurring_yearly.
 *
 * Estrategia:
 *   1. Match por data exata (qualquer ano, recurring=false)
 *   2. Match por MM-DD igual quando recurring_yearly=true (Natal, Tiradentes)
 *
 * Helper exportado pra ser reusado por book-appointment.ts.
 */
export async function isHolidayMatch(prisma: any, date: Date): Promise<boolean> {
  const dayStart = new Date(date);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setUTCHours(23, 59, 59, 999);

  // Match 1: feriado de data exata caindo nesse dia
  const exactMatch = await prisma.holiday.count({
    where: {
      recurring_yearly: false,
      date: { gte: dayStart, lte: dayEnd },
    },
  });
  if (exactMatch > 0) return true;

  // Match 2: feriado recorrente — extrai MM-DD da data e compara via raw query
  // (Prisma nao tem helper pra extract month/day, entao usamos $queryRaw)
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const recurringMatch: { count: bigint }[] = await prisma.$queryRaw`
    SELECT COUNT(*) as count
    FROM "Holiday"
    WHERE recurring_yearly = true
      AND TO_CHAR(date, 'MM-DD') = ${`${mm}-${dd}`}
  `;
  return Number(recurringMatch[0]?.count ?? 0) > 0;
}
