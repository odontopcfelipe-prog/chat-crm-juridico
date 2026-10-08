/**
 * Utilitário de horário de expediente — POR CLÍNICA.
 *
 * Centraliza: (a) detecção se o instante atual está dentro do expediente,
 * (b) geração da string informativa injetada no prompt via
 * {{business_hours_info}}, (c) cálculo do próximo expediente útil
 * (pulando dias sem atendimento e feriados da clínica) e (d) a checagem de
 * feriado que a agenda da IA usa (findClinicHoliday).
 *
 * De onde vem o horário de uma clínica (o primeiro que existir vence):
 *  1. Grade por dia de Ajustes › IA — TenantSetting AI_CLINIC_HOURS;
 *  2. Horário do escritório DA CLÍNICA — TenantSetting com as chaves abaixo;
 *  3. Horário global legado — GlobalSetting com as mesmas chaves → defaults.
 * Chaves (chave a chave, a da clínica vence a global):
 *  - AFTER_HOURS_START      (default "17:00") — hora em que FECHA
 *  - AFTER_HOURS_END        (default "08:00") — hora em que ABRE
 *  - BUSINESS_DAYS          (default "1,2,3,4,5") — seg=1 ... dom=0
 *  - TIMEZONE               (default "America/Maceio")
 *  - AFTER_HOURS_AI_ENABLED (default "true") — cron AfterHours liga a IA fora do expediente
 *
 * Feriados: os da clínica + os globais (tenant_id NULL). Sem clínica, só os
 * globais — NUNCA os de outra clínica.
 */

import { AI_CLINIC_HOURS_KEY, formatClinicHours, normalizeClinicHours, type ClinicHours } from './ai-profile';

export interface BusinessHoursSettings {
  start: { h: number; m: number }; // ex: 17:00
  end: { h: number; m: number };   // ex: 08:00
  businessDays: Set<number>;       // ex: {1,2,3,4,5}
  timezone: string;                // ex: "America/Maceio"
  /** Grade por dia da clínica (Ajustes › IA). Presente = vence start/end/businessDays. */
  clinicHours?: ClinicHours | null;
}

export interface BusinessHoursStatus {
  /** true = clínica aberta agora; false = fora do expediente/feriado. */
  isBusinessHour: boolean;
  /** Data "naive" no fuso da clínica — usada para extrair h/m/dow via getUTC*. */
  nowLocal: Date;
  /** Hora local formatada (HH:MM). */
  currentTime: string;
  /** Nome do dia da semana em pt-BR (ex: "sábado"). */
  currentDayName: string;
  /** true = hoje é feriado (da clínica ou global) conforme tabela Holiday. */
  isHoliday: boolean;
  /** Nome do feriado, se houver. */
  holidayName?: string | null;
}

const DAY_NAMES_PT = [
  'domingo', 'segunda-feira', 'terça-feira', 'quarta-feira',
  'quinta-feira', 'sexta-feira', 'sábado',
];

const DAY_NAMES_PT_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

const DAY_NAMES_PT_LOWER = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

// ─── Carregamento de settings ──────────────────────────────────────────

export const OFFICE_HOURS_KEYS = [
  'AFTER_HOURS_AI_ENABLED',
  'AFTER_HOURS_START',
  'AFTER_HOURS_END',
  'BUSINESS_DAYS',
  'TIMEZONE',
] as const;
export type OfficeHoursKey = (typeof OFFICE_HOURS_KEYS)[number];

export interface OfficeHoursValues {
  /** Valor efetivo de cada chave: o da clínica, senão o global (ausente = default). */
  values: Partial<Record<OfficeHoursKey, string>>;
  /** Chaves que a clínica tem gravadas (TenantSetting) — o resto veio do global. */
  ownKeys: OfficeHoursKey[];
  /** Grade por dia de Ajustes › IA, se a clínica tiver ao menos um dia aberto. */
  clinicHours: ClinicHours | null;
}

/**
 * Valores crus do horário do escritório de UMA clínica: TenantSetting vence
 * GlobalSetting, chave a chave. Sem tenant = só o global (comportamento legado).
 */
export async function loadOfficeHoursValues(
  prisma: any,
  tenantId?: string | null,
): Promise<OfficeHoursValues> {
  const [globalRows, tenantRows] = await Promise.all([
    prisma.globalSetting.findMany({ where: { key: { in: [...OFFICE_HOURS_KEYS] } } }),
    tenantId
      ? prisma.tenantSetting.findMany({
          where: { tenant_id: tenantId, key: { in: [...OFFICE_HOURS_KEYS, AI_CLINIC_HOURS_KEY] } },
        })
      : Promise.resolve([]),
  ]);
  const values: Partial<Record<OfficeHoursKey, string>> = {};
  for (const r of globalRows as { key: OfficeHoursKey; value: string }[]) {
    if (r.value) values[r.key] = r.value;
  }
  const ownKeys: OfficeHoursKey[] = [];
  let clinicHours: ClinicHours | null = null;
  for (const r of tenantRows as { key: string; value: string }[]) {
    if (r.key === AI_CLINIC_HOURS_KEY) {
      const h = normalizeClinicHours(r.value);
      if (h && Object.values(h.days).some(Boolean)) clinicHours = h;
    } else if (r.value) {
      values[r.key as OfficeHoursKey] = r.value;
      ownKeys.push(r.key as OfficeHoursKey);
    }
  }
  return { values, ownKeys, clinicHours };
}

/** Liga/desliga do cron AfterHours (default ligado). */
export function isAfterHoursAiEnabled(values: OfficeHoursValues['values']): boolean {
  return (values.AFTER_HOURS_AI_ENABLED ?? 'true').toLowerCase() !== 'false';
}

export async function loadBusinessHoursSettings(
  prisma: any,
  tenantId?: string | null,
): Promise<BusinessHoursSettings> {
  const { values, clinicHours } = await loadOfficeHoursValues(prisma, tenantId);
  return {
    start: parseHHMM(values.AFTER_HOURS_START ?? '17:00'),
    end: parseHHMM(values.AFTER_HOURS_END ?? '08:00'),
    businessDays: parseBusinessDays(values.BUSINESS_DAYS ?? '1,2,3,4,5'),
    timezone: values.TIMEZONE || 'America/Maceio',
    clinicHours,
  };
}

function parseHHMM(value: string): { h: number; m: number } {
  const parts = value.split(':');
  const h = Number.parseInt(parts[0] ?? '0', 10);
  const m = Number.parseInt(parts[1] ?? '0', 10);
  return {
    h: Number.isFinite(h) && h >= 0 && h < 24 ? h : 0,
    m: Number.isFinite(m) && m >= 0 && m < 60 ? m : 0,
  };
}

function parseBusinessDays(value: string): Set<number> {
  const days = value
    .split(',')
    .map((v) => Number.parseInt(v.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 6);
  return new Set(days.length > 0 ? days : [1, 2, 3, 4, 5]);
}

// ─── Cálculo do "agora" no fuso da clínica ─────────────────────────────

/**
 * Retorna um Date cujos componentes UTC correspondem à hora LOCAL no fuso
 * informado. Não é um instante real — serve só para extrair h/m/dow via
 * getUTCHours/getUTCMinutes/getUTCDay.
 */
export function nowInTimezone(timezone: string): Date {
  const parts: Record<string, string> = {};
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  for (const p of formatted) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const hourStr = parts.hour === '24' ? '00' : parts.hour;
  return new Date(
    `${parts.year}-${parts.month}-${parts.day}T${hourStr}:${parts.minute}:${parts.second}Z`,
  );
}

// ─── Classificação do momento ──────────────────────────────────────────

/** Janela de atendimento de um dia da semana ("HH:MM"), ou null se não atende. */
function dayWindow(dow: number, settings: BusinessHoursSettings): { open: string; close: string } | null {
  if (settings.clinicHours) {
    return settings.clinicHours.days[String(dow) as '0'] ?? null;
  }
  if (!settings.businessDays.has(dow)) return null;
  return { open: formatHHMM(settings.end), close: formatHHMM(settings.start) };
}

export function isBusinessMoment(nowLocal: Date, settings: BusinessHoursSettings): boolean {
  const win = dayWindow(nowLocal.getUTCDay(), settings);
  if (!win) return false;
  const hhmm = formatHHMM(nowLocal);
  return hhmm >= win.open && hhmm < win.close;
}

// ─── Feriados ──────────────────────────────────────────────────────────

/**
 * Feriado no dia de `dayLocal` (componentes getUTC* = dia local, convenção
 * naive-UTC do app) para a clínica `tenantId`: feriados DELA + globais
 * (tenant_id NULL). Sem tenant, só os globais — nunca os de outra clínica.
 * Erro de banco propaga (a agenda da IA prefere falhar a oferecer um feriado).
 */
export async function findClinicHoliday(
  prisma: any,
  dayLocal: Date,
  tenantId?: string | null,
): Promise<{ name: string } | null> {
  const y = dayLocal.getUTCFullYear();
  const mo = dayLocal.getUTCMonth();
  const d = dayLocal.getUTCDate();
  const dayStart = new Date(Date.UTC(y, mo, d, 0, 0, 0, 0));
  const dayEnd = new Date(Date.UTC(y, mo, d, 23, 59, 59, 999));

  // Feriado exato (não recorrente)
  const exact = await prisma.holiday.findFirst({
    where: {
      date: { gte: dayStart, lte: dayEnd },
      recurring_yearly: false,
      ...(tenantId ? { OR: [{ tenant_id: tenantId }, { tenant_id: null }] } : { tenant_id: null }),
    },
    select: { name: true },
  });
  if (exact) return { name: exact.name || 'Feriado' };

  // Feriado recorrente anual (mesmo mês/dia, qualquer ano)
  const month = mo + 1;
  const day = d;
  const raw = tenantId
    ? await prisma.$queryRaw`
        SELECT name FROM "Holiday"
        WHERE recurring_yearly = true
          AND EXTRACT(MONTH FROM date) = ${month}
          AND EXTRACT(DAY FROM date) = ${day}
          AND (tenant_id = ${tenantId} OR tenant_id IS NULL)
        LIMIT 1
      `
    : await prisma.$queryRaw`
        SELECT name FROM "Holiday"
        WHERE recurring_yearly = true
          AND EXTRACT(MONTH FROM date) = ${month}
          AND EXTRACT(DAY FROM date) = ${day}
          AND tenant_id IS NULL
        LIMIT 1
      `;
  const arr = raw as any[];
  if (arr.length > 0) return { name: arr[0]?.name || 'Feriado' };
  return null;
}

async function checkHoliday(
  prisma: any,
  nowLocal: Date,
  tenantId?: string | null,
): Promise<{ isHoliday: boolean; name?: string | null }> {
  try {
    const h = await findClinicHoliday(prisma, nowLocal, tenantId);
    if (h) return { isHoliday: true, name: h.name };
  } catch {
    // Falha ao consultar não bloqueia o fluxo — assume não feriado
  }
  return { isHoliday: false };
}

// ─── API pública ───────────────────────────────────────────────────────

export async function computeBusinessHoursStatus(
  prisma: any,
  tenantId?: string | null,
): Promise<BusinessHoursStatus> {
  const settings = await loadBusinessHoursSettings(prisma, tenantId);
  return statusFor(prisma, settings, tenantId);
}

async function statusFor(
  prisma: any,
  settings: BusinessHoursSettings,
  tenantId?: string | null,
): Promise<BusinessHoursStatus> {
  const nowLocal = nowInTimezone(settings.timezone);
  const holiday = await checkHoliday(prisma, nowLocal, tenantId);
  const withinHours = isBusinessMoment(nowLocal, settings) && !holiday.isHoliday;

  return {
    isBusinessHour: withinHours,
    nowLocal,
    currentTime: formatHHMM(nowLocal),
    currentDayName: DAY_NAMES_PT[nowLocal.getUTCDay()] ?? '',
    isHoliday: holiday.isHoliday,
    holidayName: holiday.name ?? null,
  };
}

/**
 * String pronta para injetar no system prompt via {{business_hours_info}}.
 * - Dentro do expediente: string vazia (skill segue fluxo normal sem poluir o prompt).
 * - Fora do expediente ou feriado: bloco multi-linha com data/hora atual,
 *   motivo do fechamento, dias/horários DA CLÍNICA e próximo expediente útil.
 */
export async function computeBusinessHoursInfo(
  prisma: any,
  tenantId?: string | null,
): Promise<string> {
  const settings = await loadBusinessHoursSettings(prisma, tenantId);
  const status = await statusFor(prisma, settings, tenantId);
  if (status.isBusinessHour) return '';

  const next = await computeNextBusinessStart(prisma, status.nowLocal, settings, tenantId);

  const dow = status.nowLocal.getUTCDay();
  const reason = status.isHoliday
    ? `FERIADO (${status.holidayName || 'feriado local'})`
    : dayWindow(dow, settings)
      ? 'FORA DO HORÁRIO COMERCIAL'
      : dow === 0 || dow === 6
        ? 'FIM DE SEMANA'
        : 'DIA SEM ATENDIMENTO';

  const lines = [
    `🕐 AGORA: ${capitalize(status.currentDayName)} ${status.currentTime} (${settings.timezone}).`,
    `CLÍNICA FECHADA — ${reason}.`,
    `Funcionamento: ${describeSchedule(settings)}`,
    `Próximo expediente: ${next}.`,
  ];
  return lines.join('\n');
}

/**
 * Dias/horários de atendimento em texto, a partir da configuração da clínica.
 * Ex.: "Segunda a sexta, das 08:00 às 17:00." / grade de Ajustes › IA.
 */
export function describeSchedule(settings: BusinessHoursSettings): string {
  if (settings.clinicHours) return formatClinicHours(settings.clinicHours);
  return `${capitalize(formatBusinessDays(settings.businessDays))}, das ${formatHHMM(settings.end)} às ${formatHHMM(settings.start)}.`;
}

/**
 * Dias da semana em texto natural, de segunda a domingo. Sequências de 3+
 * dias viram intervalo. Ex.: {1..5} → "segunda a sexta";
 * {1,3,5} → "segunda, quarta e sexta"; {1..6} → "segunda a sábado".
 */
export function formatBusinessDays(days: Set<number>): string {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const runs: number[][] = [];
  for (const d of order) {
    if (!days.has(d)) continue;
    const last = runs[runs.length - 1];
    if (last && order.indexOf(last[last.length - 1]!) === order.indexOf(d) - 1) last.push(d);
    else runs.push([d]);
  }
  if (runs.length === 1 && runs[0]!.length === 7) return 'todos os dias';
  const parts: string[] = [];
  for (const r of runs) {
    if (r.length >= 3) parts.push(`${DAY_NAMES_PT_LOWER[r[0]!]} a ${DAY_NAMES_PT_LOWER[r[r.length - 1]!]}`);
    else for (const d of r) parts.push(DAY_NAMES_PT_LOWER[d]!);
  }
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}`;
}

/**
 * Retorna string legível do próximo momento em que a clínica abre.
 * Ex: "Seg 21/04 às 08:00".
 */
async function computeNextBusinessStart(
  prisma: any,
  nowLocal: Date,
  settings: BusinessHoursSettings,
  tenantId?: string | null,
): Promise<string> {
  // Parte do dia atual e avança até achar dia de atendimento não-feriado.
  // Se hoje atende e ainda é antes da abertura, a abertura é hoje.
  const nowHHMM = formatHHMM(nowLocal);

  for (let offset = 0; offset < 14; offset++) {
    const candidate = new Date(nowLocal.getTime());
    candidate.setUTCDate(candidate.getUTCDate() + offset);

    const win = dayWindow(candidate.getUTCDay(), settings);
    if (!win) continue;

    // Se for hoje e já passou do horário de abertura, pular
    if (offset === 0 && nowHHMM >= win.open) continue;

    const holiday = await checkHoliday(prisma, candidate, tenantId);
    if (holiday.isHoliday) continue;

    const dayName = DAY_NAMES_PT_SHORT[candidate.getUTCDay()] ?? '';
    const dd = String(candidate.getUTCDate()).padStart(2, '0');
    const mm = String(candidate.getUTCMonth() + 1).padStart(2, '0');
    return `${dayName} ${dd}/${mm} às ${win.open}`;
  }
  return 'próximo dia útil';
}

// ─── Helpers de formatação ────────────────────────────────────────────

function formatHHMM(d: Date | { h: number; m: number }): string {
  const h = d instanceof Date ? d.getUTCHours() : d.h;
  const m = d instanceof Date ? d.getUTCMinutes() : d.m;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
