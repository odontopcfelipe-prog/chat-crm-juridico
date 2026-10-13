/**
 * Agendamento pela IA — helpers PUROS (sem banco) de "agora" no referencial da agenda.
 *
 * Agenda é naive-UTC (hora de Maceió gravada como UTC): "agora" = Date.now()-3h.
 * Comparar `start_at` com `new Date()` (UTC real) erra por 3h: as consultas das
 * próximas ~3h somem do "futuro" (cancelar/confirmar/remarcar não as achava) e um
 * horário de hoje que ainda vai acontecer era recusado como "já passou".
 */

export const MACEIO_OFFSET_MS = 3 * 60 * 60 * 1000;

/** "Agora" de Maceió no referencial da agenda (naive-UTC). */
export function maceioNowNaive(nowMs: number = Date.now()): Date {
  return new Date(nowMs - MACEIO_OFFSET_MS);
}

/** Hoje em Maceió (YYYY-MM-DD). */
export function maceioTodayStr(nowMs: number = Date.now()): string {
  return maceioNowNaive(nowMs).toISOString().slice(0, 10);
}

/** Início naive (hora de Maceió como UTC) já passou? Compara no MESMO referencial. */
export function isPastNaive(startNaive: Date, nowMs: number = Date.now()): boolean {
  return startNaive.getTime() <= maceioNowNaive(nowMs).getTime();
}

/** Lembrete que sairia em menos de 1 min é pulado (mesmo piso da API). */
export const REMINDER_MIN_DELAY_MS = 60_000;

/**
 * Delay (ms) do lembrete "minutesBefore antes" de um evento naive — MESMA conta da
 * API (calendar.service.enqueueReminders): instante REAL = naive + 3h. Sem isso o
 * lembrete saía 3h adiantado.
 */
export function reminderDelayMs(startNaive: Date, minutesBefore: number, nowMs: number = Date.now()): number {
  return startNaive.getTime() + MACEIO_OFFSET_MS - minutesBefore * 60_000 - nowMs;
}
