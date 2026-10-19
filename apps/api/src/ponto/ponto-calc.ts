/**
 * Relógio de ponto — cálculo de horas (puro, sem banco; testado em ponto-calc.spec.ts).
 *
 * Regras:
 *  - A batida é um INSTANTE real (UTC). O dia é o de Maceió (UTC-3, sem horário de
 *    verão): 00:00 local = 03:00 UTC.
 *  - Entrada/saída sai da ORDEM das batidas válidas do dia: 1ª entrada, 2ª saída,
 *    3ª entrada (volta do almoço), 4ª saída... Batida anulada não entra.
 *  - Conta em MINUTOS CHEIOS, como o relógio mostra (08:00:59 vale 08:00) — assim a
 *    soma das linhas do espelho bate com o total do dia.
 *  - Saldo do dia = trabalhado − jornada prevista do dia da semana. Tolerância da CLT
 *    (art. 58 §1º): diferença de até 10 min no dia não conta; passou disso, conta
 *    inteira (Súmula 366 do TST).
 *  - Feriado (da clínica ou nacional) = jornada 0; o que trabalhar vira saldo positivo.
 *  - Dia passado sem batida com jornada > 0 = FALTA (−jornada), mas só a partir do
 *    1º registro do funcionário (antes disso o ponto não existia pra ele).
 *  - Dia com batida ímpar já passado = INCOMPLETO: não fecha saldo até o gestor
 *    lançar a batida que falta. Hoje fica "em andamento" e também não fecha.
 *  - Totais do mês = só dias fechados (até ontem).
 */

export const MACEIO_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Jornada padrão em minutos por dia da semana (0 = domingo): 44h semanais. */
export const DEFAULT_WEEKLY: number[] = [0, 480, 480, 480, 480, 480, 240];

/** CLT art. 58 §1º — variação de até 10 min no dia não é extra nem desconto. */
export const TOLERANCIA_DIARIA_MIN = 10;
/** CLT art. 66 — descanso mínimo entre duas jornadas. */
export const INTERJORNADA_MIN = 11 * 60;

const minuteOf = (d: Date) => Math.floor(d.getTime() / 60000);

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

export function isValidYm(ym: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(ym || '');
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

export type DayStatus =
  | 'OK'           // dia fechado com batidas pares
  | 'HOJE'         // em andamento
  | 'INCOMPLETO'   // batida ímpar em dia passado
  | 'FALTA'        // sem batida em dia de jornada
  | 'FOLGA'        // sem batida em dia sem jornada
  | 'FERIADO'      // sem batida em feriado
  | 'FUTURO'
  | 'SEM_REGISTRO'; // antes do 1º registro do funcionário

export interface DayPair {
  in: string;
  out: string | null;
  minutes: number;
}

export interface DayCalc {
  date: string;
  weekday: number;
  pairs: DayPair[];
  worked_min: number;
  interval_min: number;
  expected_min: number;
  /** Saldo após a tolerância. null = o dia não fecha (hoje, incompleto, futuro, antes do início). */
  balance_min: number | null;
  status: DayStatus;
  holiday: string | null;
  alerts: string[];
}

export interface MonthTotals {
  worked_min: number;
  expected_min: number;
  balance_min: number;
  extra_min: number;
  debit_min: number;
  days_worked: number;
  absences: number;
  incomplete: number;
  today_worked_min: number;
}

export interface DayInput {
  date: string;
  punches: Date[];
  weekly: number[];
  holiday: string | null;
  todayYmd: string;
  now: Date;
  /** 1º dia com batida do funcionário (null = nunca bateu). */
  startYmd: string | null;
}

export function computeDay(input: DayInput): DayCalc {
  const { date, weekly, holiday, todayYmd, now, startYmd } = input;
  const sorted = [...input.punches].sort((a, b) => a.getTime() - b.getTime());
  const isToday = date === todayYmd;
  const weekday = weekdayOf(date);

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

  const expected = holiday ? 0 : Math.max(0, Math.round(weekly[weekday] ?? 0));
  const n = sorted.length;
  const alerts: string[] = [];
  let status: DayStatus;
  let balance: number | null = null;

  if (date > todayYmd) {
    status = 'FUTURO';
  } else if (isToday) {
    status = 'HOJE';
  } else if (n === 0) {
    if (!startYmd || date < startYmd) status = 'SEM_REGISTRO';
    else if (expected > 0) {
      status = 'FALTA';
      balance = -expected;
    } else {
      status = holiday ? 'FERIADO' : 'FOLGA';
      balance = 0;
    }
  } else if (n % 2 === 1) {
    status = 'INCOMPLETO';
    alerts.push('Falta uma batida (entrada sem saída)');
  } else {
    status = 'OK';
    const raw = worked - expected;
    balance = expected > 0 && Math.abs(raw) <= TOLERANCIA_DIARIA_MIN ? 0 : raw;
    // CLT art. 71 (com a mesma tolerância de 10 min: 4h04 no sábado não é "jornada acima de 4h")
    if (worked > 6 * 60 + TOLERANCIA_DIARIA_MIN && interval < 60) {
      alerts.push('Intervalo menor que 1h (jornada acima de 6h)');
    } else if (worked > 4 * 60 + TOLERANCIA_DIARIA_MIN && interval < 15) {
      alerts.push('Intervalo menor que 15 min (jornada acima de 4h)');
    }
    if (expected === 0 && worked > 0) {
      alerts.push(holiday ? `Trabalho no feriado (${holiday})` : 'Trabalho em dia de folga');
    }
  }
  if (worked > 10 * 60) alerts.push('Mais de 10h no dia (limite de 2h extras)');

  return {
    date,
    weekday,
    pairs,
    worked_min: worked,
    interval_min: interval,
    expected_min: expected,
    balance_min: balance,
    status,
    holiday,
    alerts,
  };
}

export interface MonthInput {
  ym: string;
  /** Batidas válidas do funcionário — pode incluir o dia anterior ao mês (interjornada). */
  punches: Date[];
  weekly: number[];
  /** YYYY-MM-DD → nome do feriado. */
  holidays: Map<string, string>;
  todayYmd: string;
  now: Date;
  startYmd: string | null;
}

export function computeMonth(input: MonthInput): { days: DayCalc[]; totals: MonthTotals } {
  const { days: ymds } = monthRange(input.ym);
  const byDay = new Map<string, Date[]>();
  for (const p of input.punches) {
    const k = maceioYmd(p);
    const arr = byDay.get(k);
    if (arr) arr.push(p);
    else byDay.set(k, [p]);
  }
  for (const arr of byDay.values()) arr.sort((a, b) => a.getTime() - b.getTime());

  // Última saída do dia anterior ao mês (descanso entre jornadas do dia 1).
  const prevYmd = maceioYmd(new Date(Date.parse(`${ymds[0]}T12:00:00.000Z`) - 24 * 60 * 60 * 1000));
  const prev = byDay.get(prevYmd) ?? [];
  let lastOut: Date | null = prev.length > 0 && prev.length % 2 === 0 ? prev[prev.length - 1] : null;

  const totals: MonthTotals = {
    worked_min: 0,
    expected_min: 0,
    balance_min: 0,
    extra_min: 0,
    debit_min: 0,
    days_worked: 0,
    absences: 0,
    incomplete: 0,
    today_worked_min: 0,
  };

  const days = ymds.map((date) => {
    const punches = byDay.get(date) ?? [];
    const day = computeDay({
      date,
      punches,
      weekly: input.weekly,
      holiday: input.holidays.get(date) ?? null,
      todayYmd: input.todayYmd,
      now: input.now,
      startYmd: input.startYmd,
    });

    if (punches.length > 0) {
      if (lastOut) {
        const rest = minuteOf(punches[0]) - minuteOf(lastOut);
        if (rest < INTERJORNADA_MIN) {
          day.alerts.push(`Descanso entre jornadas de ${fmtMin(rest)} (mínimo 11h)`);
        }
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
      if (day.balance_min > 0) totals.extra_min += day.balance_min;
      else totals.debit_min += -day.balance_min;
    }
    return day;
  });

  return { days, totals };
}

/** Valida e normaliza a jornada semanal (7 números de 0 a 1440 minutos). */
export function normalizeWeekly(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length !== 7) return null;
  const out = v.map((x) => Math.round(Number(x)));
  return out.every((x) => Number.isFinite(x) && x >= 0 && x <= 1440) ? out : null;
}
