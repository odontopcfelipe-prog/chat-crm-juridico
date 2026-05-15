/**
 * Helpers de agendamento — usados pelo InfluencerSchedule (api + worker).
 *
 * computeNextRunAt: dada a configuração de um schedule, retorna a próxima
 * data/hora em que ele deve disparar. Retorna null se o schedule já terminou
 * (ONCE no passado) ou se a config é inválida.
 */

export type ScheduleType = 'ONCE' | 'RECURRING';
export type Recurrence = 'DAILY' | 'WEEKLY' | 'MONTHLY';

export interface InfluencerScheduleConfig {
  schedule_type: ScheduleType;
  run_at?: Date | string | null;
  recurrence?: Recurrence | string | null;
  weekdays?: number[]; // 0=dom..6=sab
  day_of_month?: number | null;
  hour?: number | null;
  minute?: number | null;
}

/**
 * Calcula a próxima execução. Para RECURRING, baseia-se em `after` (geralmente
 * = agora ou last_run_at). Procura nos próximos 366 dias um match.
 */
export function computeNextRunAt(
  cfg: InfluencerScheduleConfig,
  after: Date = new Date(),
): Date | null {
  if (cfg.schedule_type === 'ONCE') {
    if (!cfg.run_at) return null;
    const at = typeof cfg.run_at === 'string' ? new Date(cfg.run_at) : cfg.run_at;
    return at.getTime() > after.getTime() ? at : null;
  }

  if (cfg.schedule_type !== 'RECURRING') return null;
  const recurrence = cfg.recurrence as Recurrence | null | undefined;
  const hour = cfg.hour ?? 0;
  const minute = cfg.minute ?? 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  // Começa do próximo minuto pra evitar disparar imediatamente após salvar
  const start = new Date(after.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  // Candidato inicial: hoje na hora/minuto configurada. Se já passou, joga pra amanhã.
  const candidate = new Date(start.getTime());
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() < start.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }

  for (let i = 0; i < 366; i++) {
    if (recurrence === 'DAILY') {
      return new Date(candidate.getTime());
    }
    if (recurrence === 'WEEKLY') {
      const dow = candidate.getDay(); // 0=dom..6=sab
      const allowed = (cfg.weekdays && cfg.weekdays.length > 0) ? cfg.weekdays : [];
      if (allowed.length === 0) return null; // sem dias selecionados, nunca dispara
      if (allowed.includes(dow)) return new Date(candidate.getTime());
    }
    if (recurrence === 'MONTHLY') {
      const dom = cfg.day_of_month;
      if (!dom || dom < 1 || dom > 31) return null;
      // Se o dia configurado não existe no mês (ex: 31 em fevereiro), pula pro
      // último dia do mês — comportamento esperado pra "dia 31 todo mês"
      const year = candidate.getFullYear();
      const month = candidate.getMonth();
      const lastDayOfMonth = new Date(year, month + 1, 0).getDate();
      const effectiveDay = Math.min(dom, lastDayOfMonth);
      if (candidate.getDate() === effectiveDay) return new Date(candidate.getTime());
    }
    candidate.setDate(candidate.getDate() + 1);
  }
  return null; // não achou em 1 ano — provavelmente config inválida
}

/**
 * Interpolação de variáveis do template ({{nome}}, {{handle}}, etc).
 * Variáveis ausentes/nulas são substituídas por string vazia.
 */
export function interpolateTemplate(
  body: string,
  vars: Record<string, string | null | undefined>,
): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    return v == null ? '' : String(v);
  });
}
