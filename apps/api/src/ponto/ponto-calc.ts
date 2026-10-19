/**
 * Relógio de ponto — cálculo de horas (puro, sem banco; testado em ponto-calc.spec.ts).
 * É o número que vai pra contabilidade: qualquer mudança aqui precisa de teste.
 *
 * Regras:
 *  - A batida é um INSTANTE real (UTC). O dia é o de Maceió (UTC-3, sem horário de
 *    verão): 00:00 local = 03:00 UTC.
 *  - Entrada/saída sai da ORDEM das batidas válidas do dia: 1ª entrada, 2ª saída
 *    (intervalo), 3ª volta, 4ª saída... Batida anulada não entra.
 *  - Conta em MINUTOS CHEIOS, como o relógio mostra (08:00:59 vale 08:00) — a soma
 *    das linhas do espelho bate com o total do dia.
 *  - Previsto do dia = horário do funcionário VIGENTE naquele dia (entrada→saída,
 *    menos o intervalo). Feriado = previsto zero.
 *  - Tolerância (CLT art. 58 §1º + Súmula 366 do TST): se cada batida ficou a até
 *    5 min do horário e a soma das diferenças no dia não passou de 10 min, o dia
 *    fecha certinho (saldo zero). Passou disso, conta a diferença INTEIRA.
 *  - Saldo positivo em dia de trabalho = hora extra; negativo = atraso/saída antes.
 *    Trabalho em domingo ou feriado fora do horário = "extra domingo/feriado"
 *    (separado, a contabilidade aplica o adicional). Dia de trabalho sem batida =
 *    FALTA (horas do dia). Só conta dentro do período do funcionário na equipe.
 *  - Batida ímpar em dia passado = INCOMPLETO: não fecha saldo até o adm ajustar.
 *    Hoje fica em andamento. Totais do mês = só dias fechados (até ontem).
 */

export const MACEIO_OFFSET_MS = 3 * 60 * 60 * 1000;

/** CLT art. 58 §1º — até 5 min por batida, até 10 min no dia. */
export const TOLERANCIA_MARCACAO_MIN = 5;
export const TOLERANCIA_DIARIA_MIN = 10;
/** CLT art. 66 — descanso mínimo entre duas jornadas. */
export const INTERJORNADA_MIN = 11 * 60;

const minuteOf = (d: Date) => Math.floor(d.getTime() / 60000);

// ─── Datas (dia de Maceió) ───────────────────────────────────────

/** Dia de Maceió (YYYY-MM-DD) de um instante real. */
export function maceioYmd(at: Date): string {
  return new Date(at.getTime() - MACEIO_OFFSET_MS).toISOString().slice(0, 10);
}

/** Hora de Maceió (HH:mm) de um instante real. */
export function maceioHhmm(at: Date): string {
  return new Date(at.getTime() - MACEIO_OFFSET_MS).toISOString().slice(11, 16);
}

/** Instante real de uma data/hora LOCAL de Maceió. */
export function maceioLocalToInstant(ymd: string, hhmm: string): Date {
  return new Date(Date.parse(`${ymd}T${hhmm}:00.000Z`) + MACEIO_OFFSET_MS);
}

export function weekdayOf(ymd: string): number {
  return new Date(`${ymd}T00:00:00.000Z`).getUTCDay();
}

export function addDays(ymd: string, n: number): string {
  return new Date(Date.parse(`${ymd}T12:00:00.000Z`) + n * 86400000).toISOString().slice(0, 10);
}

export function isValidYm(ym: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(ym || '');
}

export function isValidYmd(ymd: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || '')) return false;
  const d = new Date(`${ymd}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd;
}

/** Dias do mês (YYYY-MM-DD) + janela em instantes reais [startUtc, endUtc). */
export function monthRange(ym: string): { startUtc: Date; endUtc: Date; days: string[] } {
  const [y, m] = ym.split('-').map(Number);
  const startUtc = new Date(Date.UTC(y, m - 1, 1) + MACEIO_OFFSET_MS);
  const endUtc = new Date(Date.UTC(y, m, 1) + MACEIO_OFFSET_MS);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days: string[] = [];
  for (let d = 1; d <= last; d++) days.push(`${ym}-${String(d).padStart(2, '0')}`);
  return { startUtc, endUtc, days };
}

/** 485 → "8h05"; −70 → "-1h10". */
export function fmtMin(min: number): string {
  const sign = min < 0 ? '-' : '';
  const abs = Math.abs(Math.round(min));
  return `${sign}${Math.floor(abs / 60)}h${String(abs % 60).padStart(2, '0')}`;
}

// ─── Horário do funcionário ──────────────────────────────────────

export interface DaySchedule {
  in: string;
  out: string;
  break_start: string | null;
  break_end: string | null;
}
/** 7 posições (0 = domingo); null = folga. */
export type WeekSchedule = (DaySchedule | null)[];
export interface ScheduleVersion {
  valid_from: string;
  days: WeekSchedule;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const hhmmToMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** Valida um dia do horário. Vazio = folga (null). */
export function normalizeDaySchedule(raw: any): { ok: true; value: DaySchedule | null } | { ok: false; error: string } {
  if (raw == null) return { ok: true, value: null };
  const s = (v: any) => (typeof v === 'string' ? v.trim() : '');
  const inn = s(raw.in);
  const out = s(raw.out);
  const bs = s(raw.break_start);
  const be = s(raw.break_end);
  if (!inn && !out && !bs && !be) return { ok: true, value: null };
  if (!HHMM.test(inn) || !HHMM.test(out)) return { ok: false, error: 'Informe entrada e saída (HH:mm).' };
  if (hhmmToMin(out) <= hhmmToMin(inn)) return { ok: false, error: 'A saída tem que ser depois da entrada.' };
  if (!bs && !be) return { ok: true, value: { in: inn, out, break_start: null, break_end: null } };
  if (!HHMM.test(bs) || !HHMM.test(be)) return { ok: false, error: 'Informe início e fim do intervalo (HH:mm).' };
  const [a, b, c, d] = [inn, bs, be, out].map(hhmmToMin);
  if (!(a < b && b < c && c < d)) {
    return { ok: false, error: 'O intervalo tem que ficar entre a entrada e a saída.' };
  }
  return { ok: true, value: { in: inn, out, break_start: bs, break_end: be } };
}

export function normalizeWeek(raw: any): { ok: true; value: WeekSchedule } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length !== 7) return { ok: false, error: 'O horário precisa dos 7 dias da semana.' };
  const out: WeekSchedule = [];
  for (let i = 0; i < 7; i++) {
    const r = normalizeDaySchedule(raw[i]);
    if (!r.ok) return { ok: false, error: `${WEEKDAY_NAMES[i]}: ${r.error}` };
    out.push(r.value);
  }
  return { ok: true, value: out };
}

export const WEEKDAY_NAMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

/** Minutos previstos no dia (entrada→saída menos o intervalo). */
export function expectedOf(s: DaySchedule | null): number {
  if (!s) return 0;
  const total = hhmmToMin(s.out) - hhmmToMin(s.in);
  return s.break_start && s.break_end ? total - (hhmmToMin(s.break_end) - hhmmToMin(s.break_start)) : total;
}

/** Horários previstos de cada batida (minutos desde 00:00). */
export function marksOf(s: DaySchedule | null): number[] {
  if (!s) return [];
  return s.break_start && s.break_end
    ? [s.in, s.break_start, s.break_end, s.out].map(hhmmToMin)
    : [s.in, s.out].map(hhmmToMin);
}

/** Nome da batida pela posição no dia (0 = 1ª). Com intervalo previsto: 4 batidas nomeadas. */
export function punchLabel(index: number, hasBreak: boolean): string {
  if (index === 0) return 'Entrada';
  if (index === 1) return hasBreak ? 'Saída para o intervalo' : 'Saída';
  if (index === 2) return hasBreak ? 'Volta do intervalo' : 'Entrada';
  if (index === 3) return 'Saída';
  return index % 2 === 0 ? 'Entrada' : 'Saída';
}

/** Horário do dia pela versão vigente (a mais recente com valid_from <= dia). */
export function scheduleOn(versions: ScheduleVersion[], ymd: string): DaySchedule | null {
  let best: ScheduleVersion | null = null;
  for (const v of versions) {
    if (v.valid_from <= ymd && (!best || v.valid_from > best.valid_from)) best = v;
  }
  return best ? best.days[weekdayOf(ymd)] ?? null : null;
}

// ─── Feriados nacionais (Lei 662/49, 6.802/80, 10.607/02, 14.759/23) ──

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Feriados NACIONAIS do ano (carnaval e Corpus Christi são ponto facultativo — não entram). */
export function nationalHolidays(year: number): Map<string, string> {
  const fixed: [string, string][] = [
    ['01-01', 'Confraternização Universal'],
    ['04-21', 'Tiradentes'],
    ['05-01', 'Dia do Trabalho'],
    ['09-07', 'Independência do Brasil'],
    ['10-12', 'Nossa Senhora Aparecida'],
    ['11-02', 'Finados'],
    ['11-15', 'Proclamação da República'],
    ['12-25', 'Natal'],
  ];
  const map = new Map<string, string>(fixed.map(([md, n]) => [`${year}-${md}`, n]));
  if (year >= 2024) map.set(`${year}-11-20`, 'Dia da Consciência Negra');
  map.set(addDays(easterSunday(year), -2), 'Sexta-feira Santa');
  return map;
}

/** Feriados do mês: nacionais + os da clínica (os da clínica têm prioridade no nome). */
export function holidaysForMonth(ym: string, clinic: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [d, n] of nationalHolidays(Number(ym.slice(0, 4)))) if (d.startsWith(ym)) out.set(d, n);
  for (const [d, n] of clinic) if (d.startsWith(ym)) out.set(d, n);
  return out;
}

// ─── Cálculo do dia ──────────────────────────────────────────────

export type DayStatus =
  | 'OK'               // dia fechado com batidas pares
  | 'HOJE'             // em andamento
  | 'INCOMPLETO'       // batida ímpar em dia passado
  | 'FALTA'            // sem batida em dia de trabalho
  | 'FOLGA'            // sem batida em dia sem horário
  | 'FERIADO'          // sem batida em feriado
  | 'FUTURO'
  | 'FORA_DO_PERIODO'; // antes de entrar / depois de sair da equipe do ponto

export interface DayPair {
  in: string;
  out: string | null;
  minutes: number;
}

export interface DayCalc {
  date: string;
  weekday: number;
  schedule: DaySchedule | null;
  pairs: DayPair[];
  worked_min: number;
  interval_min: number;
  expected_min: number;
  /** Saldo do dia. null = não fecha (hoje, incompleto, futuro, fora do período). */
  balance_min: number | null;
  /** Dentro da tolerância da CLT (o dia fechou como previsto). */
  tolerance_applied: boolean;
  extra_min: number;
  extra_dsr_min: number;
  debit_min: number;
  absence_min: number;
  status: DayStatus;
  holiday: string | null;
  alerts: string[];
}

export interface MonthTotals {
  worked_min: number;
  expected_min: number;
  balance_min: number;
  /** Extra em dia normal. */
  extra_min: number;
  /** Extra em domingo/feriado sem horário. */
  extra_dsr_min: number;
  /** Atrasos e saídas antes do horário (dias trabalhados). */
  debit_min: number;
  /** Horas das faltas (dias inteiros sem batida). */
  absence_min: number;
  absences: number;
  days_worked: number;
  incomplete: number;
  today_worked_min: number;
}

export interface DayInput {
  date: string;
  punches: Date[];
  schedule: DaySchedule | null;
  holiday: string | null;
  todayYmd: string;
  now: Date;
  /** 1º dia na equipe do ponto (null = não é da equipe: nada conta). */
  startYmd: string | null;
  /** Último dia na equipe (null = ativo). */
  endYmd?: string | null;
}

export function computeDay(input: DayInput): DayCalc {
  const { date, holiday, todayYmd, now, startYmd } = input;
  const endYmd = input.endYmd ?? null;
  const sorted = [...input.punches].sort((a, b) => a.getTime() - b.getTime());
  const isToday = date === todayYmd;
  const weekday = weekdayOf(date);
  const schedule = input.schedule;

  const pairs: DayPair[] = [];
  for (let i = 0; i < sorted.length; i += 2) {
    const a = sorted[i];
    const b = sorted[i + 1] ?? null;
    let minutes = 0;
    if (b) minutes = minuteOf(b) - minuteOf(a);
    else if (isToday) minutes = Math.max(0, minuteOf(now) - minuteOf(a)); // ainda trabalhando
    pairs.push({ in: maceioHhmm(a), out: b ? maceioHhmm(b) : null, minutes });
  }
  const worked = pairs.reduce((s, p) => s + p.minutes, 0);

  let interval = 0;
  for (let i = 2; i < sorted.length; i += 2) {
    interval += minuteOf(sorted[i]) - minuteOf(sorted[i - 1]);
  }

  const inPeriod = !!startYmd && date >= startYmd && (!endYmd || date <= endYmd);
  const expected = holiday ? 0 : expectedOf(schedule);
  const n = sorted.length;
  const alerts: string[] = [];
  const day: DayCalc = {
    date,
    weekday,
    schedule,
    pairs,
    worked_min: worked,
    interval_min: interval,
    expected_min: inPeriod ? expected : 0,
    balance_min: null,
    tolerance_applied: false,
    extra_min: 0,
    extra_dsr_min: 0,
    debit_min: 0,
    absence_min: 0,
    status: 'OK',
    holiday,
    alerts,
  };

  if (date > todayYmd) {
    day.status = 'FUTURO';
    return day;
  }
  if (!inPeriod) {
    day.status = 'FORA_DO_PERIODO';
    if (n > 0) alerts.push('Batida fora do período na equipe do ponto (não conta)');
    return day;
  }
  if (isToday) {
    day.status = 'HOJE';
  } else if (n === 0) {
    if (expected > 0) {
      day.status = 'FALTA';
      day.balance_min = -expected;
      day.absence_min = expected;
    } else {
      day.status = holiday ? 'FERIADO' : 'FOLGA';
      day.balance_min = 0;
    }
  } else if (n % 2 === 1) {
    day.status = 'INCOMPLETO';
    alerts.push('Falta uma batida (entrada sem saída)');
  } else {
    day.status = 'OK';
    if (expected === 0) {
      day.balance_min = worked;
      if (weekday === 0 || holiday) day.extra_dsr_min = worked;
      else day.extra_min = worked;
      alerts.push(holiday ? `Trabalho no feriado (${holiday})` : weekday === 0 ? 'Trabalho no domingo' : 'Trabalho em dia de folga');
    } else {
      const marks = marksOf(schedule);
      if (n === marks.length) {
        const deltas = sorted.map((p, i) => Math.abs(hhmmToMin(maceioHhmm(p)) - marks[i]));
        day.tolerance_applied =
          deltas.every((d) => d <= TOLERANCIA_MARCACAO_MIN) &&
          deltas.reduce((s, d) => s + d, 0) <= TOLERANCIA_DIARIA_MIN;
      }
      const balance = day.tolerance_applied ? 0 : worked - expected;
      day.balance_min = balance;
      if (balance > 0) day.extra_min = balance;
      else if (balance < 0) day.debit_min = -balance;
    }
  }

  // Intervalo (CLT art. 71) — com a mesma tolerância de 10 min nos limites.
  if (day.status === 'OK' && n >= 2) {
    if (schedule?.break_start && n === 2 && expected > 0) {
      alerts.push('Intervalo não registrado (faltam as batidas do intervalo)');
    } else if (worked > 6 * 60 + TOLERANCIA_DIARIA_MIN && interval < 60) {
      alerts.push('Intervalo menor que 1h (jornada acima de 6h)');
    } else if (worked > 4 * 60 + TOLERANCIA_DIARIA_MIN && interval < 15) {
      alerts.push('Intervalo menor que 15 min (jornada acima de 4h)');
    }
  }
  if (worked > 10 * 60) alerts.push('Mais de 10h no dia (limite de 2h extras)');
  return day;
}

// ─── Mês ─────────────────────────────────────────────────────────

export interface MonthInput {
  ym: string;
  /** Batidas válidas do funcionário — pode incluir o dia anterior ao mês (interjornada). */
  punches: Date[];
  versions: ScheduleVersion[];
  /** Feriados da CLÍNICA (YYYY-MM-DD → nome); os nacionais entram sozinhos. */
  holidays: Map<string, string>;
  todayYmd: string;
  now: Date;
  startYmd: string | null;
  endYmd?: string | null;
}

export function emptyTotals(): MonthTotals {
  return {
    worked_min: 0,
    expected_min: 0,
    balance_min: 0,
    extra_min: 0,
    extra_dsr_min: 0,
    debit_min: 0,
    absence_min: 0,
    absences: 0,
    days_worked: 0,
    incomplete: 0,
    today_worked_min: 0,
  };
}

export function computeMonth(input: MonthInput): { days: DayCalc[]; totals: MonthTotals } {
  const { days: ymds } = monthRange(input.ym);
  const holidays = holidaysForMonth(input.ym, input.holidays);
  const byDay = new Map<string, Date[]>();
  for (const p of input.punches) {
    const k = maceioYmd(p);
    const arr = byDay.get(k);
    if (arr) arr.push(p);
    else byDay.set(k, [p]);
  }
  for (const arr of byDay.values()) arr.sort((a, b) => a.getTime() - b.getTime());

  // Última saída do dia anterior ao mês (descanso entre jornadas do dia 1).
  const prev = byDay.get(addDays(ymds[0], -1)) ?? [];
  let lastOut: Date | null = prev.length > 0 && prev.length % 2 === 0 ? prev[prev.length - 1] : null;

  const totals = emptyTotals();
  const days = ymds.map((date) => {
    const punches = byDay.get(date) ?? [];
    const day = computeDay({
      date,
      punches,
      schedule: scheduleOn(input.versions, date),
      holiday: holidays.get(date) ?? null,
      todayYmd: input.todayYmd,
      now: input.now,
      startYmd: input.startYmd,
      endYmd: input.endYmd ?? null,
    });

    if (punches.length > 0) {
      if (lastOut && day.status !== 'FORA_DO_PERIODO') {
        const rest = minuteOf(punches[0]) - minuteOf(lastOut);
        if (rest < INTERJORNADA_MIN) day.alerts.push(`Descanso entre jornadas de ${fmtMin(rest)} (mínimo 11h)`);
      }
      lastOut = punches.length % 2 === 0 ? punches[punches.length - 1] : null;
    }

    if (day.status === 'HOJE') totals.today_worked_min = day.worked_min;
    if (day.status === 'OK') totals.days_worked++;
    if (day.status === 'FALTA') totals.absences++;
    if (day.status === 'INCOMPLETO') totals.incomplete++;
    if (day.balance_min !== null) {
      totals.worked_min += day.worked_min;
      totals.expected_min += day.expected_min;
      totals.balance_min += day.balance_min;
      totals.extra_min += day.extra_min;
      totals.extra_dsr_min += day.extra_dsr_min;
      totals.debit_min += day.debit_min;
      totals.absence_min += day.absence_min;
    }
    return day;
  });

  return { days, totals };
}
