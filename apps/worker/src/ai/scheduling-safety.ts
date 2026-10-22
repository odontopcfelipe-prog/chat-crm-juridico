/**
 * Agendamento pela IA — helpers PUROS (sem banco) do confirm_slot e da rede de
 * segurança "disse que agendou sem ação" (ai.processor.ts, passos 13a e 15b).
 *
 * Contexto (out/2026, Instituto): a IA oferecia horário, o lead aceitava, ela
 * respondia "deixei agendado" e NENHUMA consulta era criada. As skills rodam no
 * caminho JSON legado (sem schema): a ação vinha ausente, dentro de `updates` ou
 * com outra grafia, e o código descartava em silêncio. Aqui:
 *  - normaliza a ação (onde quer que venha, data/hora em formatos variados);
 *  - detecta a AFIRMAÇÃO de marcação no texto (pergunta/oferta/negação/descrição/
 *    pagamento/horário tomado por outra pessoa não contam);
 *  - a rede é a 2ª linha (a 1ª é o contrato do prompt): SÓ marca quando o horário é
 *    INEQUÍVOCO — o paciente escolheu UM horário (o único da nossa proposta com data,
 *    ou o horário completo que ele mesmo citou) e a resposta diz esse mesmo; na
 *    dúvida não marca, e só reescreve afirmação falsa feita agora (assessBookingClaim);
 *  - monta os textos honestos que substituem o "agendei" falso.
 *
 * Agenda é naive-UTC (hora de Maceió gravada como UTC): "agora" = Date.now()-3h.
 * Comparar `start_at` com `new Date()` (UTC real) erra por 3h: as consultas das
 * próximas ~3h somem do "futuro" (cancelar/confirmar/remarcar não as achava) e um
 * horário de hoje que ainda vai acontecer era recusado como "já passou". Os helpers
 * de "agora" abaixo (maceioNowNaive/maceioTodayStr/isPastNaive/reminderDelayMs) são
 * os mesmos que o passo 15c/15d/15e e o book_appointment usam.
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

// ─── Datas e horas ────────────────────────────────────────────────────────────

/** Minúsculas e sem acento (os regex daqui são ASCII). */
function plain(s: string): string {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD só se a data existir (31/02 não passa). */
function isoDate(y: number, m: number, d: number): string | null {
  if (![y, m, d].every(Number.isInteger)) return null;
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Dia da semana (0=domingo) de um YYYY-MM-DD, ancorado ao meio-dia UTC. */
export function weekdayOf(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

/** DD/MM sem ano → a PRÓXIMA ocorrência a partir de hoje (hoje incluso). */
function nextDayMonth(d: number, m: number, todayStr: string): string | null {
  const y = Number(todayStr.slice(0, 4));
  const same = isoDate(y, m, d);
  if (same && same >= todayStr) return same;
  // Só vira o ano na virada (dez → jan): DD/MM que já passou há pouco ("09/10" no dia
  // 12/10) fica no ano corrente e a guarda recusa como "já passou" — nunca marca um
  // ano depois.
  const todayMonth = Number(todayStr.slice(5, 7));
  if (todayMonth >= 11 && m <= 2) return isoDate(y + 1, m, d);
  return same;
}

// Meses por extenso (texto já sem acento): "1º de novembro", "13 de outubro".
const MONTH_NAMES = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const MONTH_ALT = MONTH_NAMES.join('|');
const MONTH_DATE_SRC = `\\b(\\d{1,2})\\s*[ºª°]?\\s+de\\s+(${MONTH_ALT})(?:\\s+de\\s+(\\d{4}))?\\b`;
// "dia 14" sem mês — não "dia 14/10", "dia 14:00", "dia 1º de novembro" (data por extenso).
const DAY_OF_MONTH_SRC = `\\bdia\\s+(\\d{1,2})\\b(?!\\s*[/:h\\d])(?!\\s*[ºª°]?\\s+de\\s+(?:${MONTH_ALT})\\b)`;

/** "dia 14" (sem mês) → a próxima data com esse dia do mês. */
function nextDayOfMonth(d: number, todayStr: string): string | null {
  let y = Number(todayStr.slice(0, 4));
  let m = Number(todayStr.slice(5, 7));
  for (let i = 0; i < 3; i++) {
    const c = isoDate(y, m, d);
    if (c && c >= todayStr) return c;
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return null;
}

/** "9:00", "09:00:00", "8h", "8h30", "14hs", "9 horas", 9 → "HH:MM". */
export function normalizeTime(raw: unknown): string | undefined {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? `${pad2(raw)}:00` : undefined;
  }
  if (typeof raw !== 'string') return undefined;
  const s = plain(raw).trim().replace(/^(?:as|a)\s+/, '');
  let h: number;
  let min: number;
  let m = s.match(/^(\d{1,2})\s*(?::|h|\.)\s*(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(?:h|hs|hrs|horas?)?$/);
  if (m) {
    h = Number(m[1]);
    min = Number(m[2]);
  } else {
    m = s.match(/^(\d{1,2})\s*(?:h|hs|hrs|horas?)?$/);
    if (!m) return undefined;
    h = Number(m[1]);
    min = 0;
  }
  if (h > 23 || min > 59) return undefined;
  return `${pad2(h)}:${pad2(min)}`;
}

/**
 * Data do confirm_slot em qualquer formato que o modelo costuma mandar:
 * "2026-10-14", "2026-10-14T09:00…" (separa a hora), "14/10" (próxima ocorrência),
 * "14/10/2026", "14/10/26". Devolve também a hora quando vem junto — MENOS em ISO
 * com 'Z'/offset ("…T11:00:00.000Z", "…-03:00"): essa hora é de outro fuso, não a
 * de Maceió; fica só a data e a hora tem que vir do campo time (senão o confirm_slot
 * fica incompleto e quem decide é a rede 13a, pelo texto).
 */
export function normalizeDateValue(raw: unknown, todayStr: string): { date?: string; time?: string } {
  if (typeof raw !== 'string') return {};
  const s = raw.trim();
  let m = s.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s]+(\d{1,2}:\d{2})(?::\d{2}(?:\.\d+)?)?)?\s*(z|[+-]\d{2}(?::?\d{2})?)?/i,
  );
  if (m) {
    const zoned = !!m[5];
    return {
      date: isoDate(Number(m[1]), Number(m[2]), Number(m[3])) ?? undefined,
      time: m[4] && !zoned ? normalizeTime(m[4]) : undefined,
    };
  }
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}|\d{2}))?(?:\s*(?:,|as|às|-)?\s*(\d{1,2}(?::|h)\d{0,2}))?/i);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    let date: string | null;
    if (m[3]) {
      const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      date = isoDate(y, mo, d);
    } else {
      date = nextDayMonth(d, mo, todayStr);
    }
    return { date: date ?? undefined, time: m[4] ? normalizeTime(m[4]) : undefined };
  }
  return {};
}

// ─── Normalização do scheduling_action ───────────────────────────────────────

export type SchedulingActionName =
  | 'confirm_slot'
  | 'confirm_appointment'
  | 'reschedule_appointment'
  | 'cancel_appointment';

export interface NormalizedSchedulingAction {
  action: SchedulingActionName;
  date?: string;
  time?: string;
}

// Chave = nome sem acento/separador ("CONFIRM_SLOT", "confirm-slot" → "confirmslot").
const ACTION_ALIASES: Record<string, SchedulingActionName> = {
  confirmslot: 'confirm_slot',
  bookappointment: 'confirm_slot',
  bookslot: 'confirm_slot',
  confirmappointment: 'confirm_appointment',
  rescheduleappointment: 'reschedule_appointment',
  cancelappointment: 'cancel_appointment',
};

export function normalizeActionName(v: unknown): SchedulingActionName | null {
  if (typeof v !== 'string') return null;
  return ACTION_ALIASES[plain(v).replace(/[^a-z]/g, '')] ?? null;
}

/** confirm_slot completo (YYYY-MM-DD + HH:MM)? */
export function isValidConfirmSlot(
  a: unknown,
): a is { action: 'confirm_slot'; date: string; time: string } {
  const o = a as any;
  return (
    !!o &&
    o.action === 'confirm_slot' &&
    typeof o.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(o.date) &&
    typeof o.time === 'string' &&
    /^\d{2}:\d{2}$/.test(o.time)
  );
}

function normalizeOne(raw: unknown, todayStr: string, depth: number): NormalizedSchedulingAction | null {
  if (raw == null || depth > 2) return null;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.startsWith('{') || s.startsWith('[')) {
      try {
        return normalizeOne(JSON.parse(s), todayStr, depth + 1);
      } catch {
        return null;
      }
    }
    const action = normalizeActionName(s);
    return action ? { action } : null;
  }
  if (Array.isArray(raw)) {
    let first: NormalizedSchedulingAction | null = null;
    for (const item of raw) {
      const n = normalizeOne(item, todayStr, depth + 1);
      if (n && isValidConfirmSlot(n)) return n;
      if (n && !first) first = n;
    }
    return first;
  }
  if (typeof raw !== 'object') return null;
  const o = raw as Record<string, any>;
  const action = normalizeActionName(o.action ?? o.type ?? o.name);
  if (!action) return null;
  if (action !== 'confirm_slot') return { action };
  const d = normalizeDateValue(
    o.date ?? o.data ?? o.dia ?? o.day ?? o.datetime ?? o.date_time ?? o.start_at ?? o.start,
    todayStr,
  );
  const time = normalizeTime(o.time ?? o.hora ?? o.horario ?? o.hour) ?? d.time;
  const out: NormalizedSchedulingAction = { action };
  if (d.date) out.date = d.date;
  if (time) out.time = time;
  return out;
}

/**
 * Extrai e normaliza o scheduling_action de um JSON de resposta da IA (ou do input
 * do respond_to_client). Aceita: `scheduling_action` no topo, dentro de `updates`,
 * {"action":"confirm_slot",…} solto no topo, string/JSON em string, ação com grafia
 * variante e data/hora em formatos variados. Ação desconhecida = null.
 */
export function normalizeSchedulingAction(
  container: unknown,
  nowMs: number = Date.now(),
): NormalizedSchedulingAction | null {
  if (!container || typeof container !== 'object' || Array.isArray(container)) return null;
  const c = container as Record<string, any>;
  const todayStr = maceioTodayStr(nowMs);
  const upd =
    c.updates && typeof c.updates === 'object'
      ? c.updates
      : c.lead_update && typeof c.lead_update === 'object'
        ? c.lead_update
        : null;
  const candidates: unknown[] = [c.scheduling_action, c.schedulingAction, upd?.scheduling_action, upd?.schedulingAction];
  // {"reply":…,"action":"confirm_slot","date":…,"time":…} — sem o wrapper.
  if (c.action !== undefined) candidates.push(c);
  let first: NormalizedSchedulingAction | null = null;
  for (const cand of candidates) {
    const n = normalizeOne(cand, todayStr, 0);
    if (n && isValidConfirmSlot(n)) return n;
    if (n && !first) first = n;
  }
  return first;
}

// ─── "Disse que agendou" ─────────────────────────────────────────────────────

// Afirmações de marcação (texto já sem acento). firm=false = promessa/intenção
// ("deixo agendado", "vou deixar marcado", "fica marcado terça às 9h"): conta como
// afirmação (não pode sair sem a ação), mas NUNCA vira agendamento sozinha.
// needsSlot = só vale com dia + hora logo depois. resched = afirma REMARCAÇÃO ("remarquei",
// "foi remarcado"): nunca vira agendamento (mexeria numa consulta que já existe).
const CLAIM_RES: { re: RegExp; firm: boolean; needsSlot?: boolean; resched?: boolean }[] = [
  // "remarquei", "reagendei", "ficou remarcado", "foi reagendada", "Remarcado pra quinta!"
  { re: /\b(?:remarquei|reagendei)\b/, firm: true, resched: true },
  {
    re: /\b(?:esta|ta|ficou|foi)\s+(?:(?:tudo|ja|bem|certinho|entao|sim)\s+){0,2}(?:remarcad|reagendad)[oa]s?\b/,
    firm: true,
    resched: true,
  },
  {
    re: /^\W*(?:(?:pronto|prontinho|perfeito|otimo|feito|certo)\W+)?(?:remarcad|reagendad)[oa](?:\s+(?:para|pra|pro|no\s+dia|dia|na|no)\b|\W*$)/,
    firm: true,
    resched: true,
  },
  // "deixei agendado", "já deixei sua avaliação marcada"
  { re: /\b(?:ja\s+)?deixei\s+(?:[a-z]+\s+){0,3}?(?:agendad|marcad|reservad)[oa]s?\b/, firm: true },
  // "deixo agendado", "vou deixar marcado" (intenção, não fato)
  { re: /\b(?:ja\s+)?(?:deixo|vou\s+deixar)\s+(?:[a-z]+\s+){0,3}?(?:agendad|marcad|reservad)[oa]s?\b/, firm: false },
  // "agendei", "marquei", "confirmei seu horário", "garanti sua vaga"
  { re: /\b(?:agendei|marquei|reservei)\b/, firm: true },
  { re: /\bconfirmei\s+(?:o\s+|a\s+|seu\s+|sua\s+)?(?:horario|consulta|avaliacao|agendamento|vaga)\b/, firm: true },
  { re: /\bgaranti\s+(?:o\s+|a\s+|seu\s+|sua\s+)?(?:horario|consulta|avaliacao|vaga)\b/, firm: true },
  // "está agendado", "ficou marcado", "já está tudo agendado", "tá marcado".
  { re: /\b(?:esta|ta|ficou|foi)\s+(?:(?:tudo|ja|bem|certinho|entao|sim)\s+){0,2}(?:agendad|marcad|reservad)[oa]s?\b/, firm: true },
  // "fica + particípio" costuma ser descritivo ("a avaliação fica marcada com a Dra.
  // X", "a manutenção fica agendada 1x por mês"): só conta com dia + hora logo depois
  // ("então fica marcado terça às 9h") — e como intenção, nunca como fato.
  { re: /\bfica\s+(?:(?:entao|ja|tudo|certinho)\s+)?(?:agendad|marcad|reservad)[oa]s?\b/, firm: false, needsSlot: true },
  // "agendamento confirmado/feito"
  { re: /\bagendamento\s+(?:(?:esta|ta|foi|ficou|ja)\s+){0,2}(?:confirmado|feito|realizado|garantido|marcado)\b/, firm: true },
  // "sua avaliação com a Dra. X está confirmada", "seu horário ficou reservado"
  {
    re: /\b(?:consulta|avaliacao|horario|vaga)\b[^.!?\n]{0,40}?\b(?:esta|ta|ficou|foi)\s+(?:(?:ja|tudo|bem|entao)\s+)?(?:confirmad|agendad|marcad|reservad|garantid)[oa]s?\b/,
    firm: true,
  },
  // "Agendado pra terça às 9h!", "Prontinho, confirmado para quinta" (início da frase)
  {
    re: /^\W*(?:(?:pronto|prontinho|perfeito|otimo|feito|certo)\W+)?(?:agendad|marcad|confirmad)[oa]\s+(?:para|pra|pro|no\s+dia|dia|na|no|com)\b/,
    firm: true,
  },
  // "Agendado!", "Perfeito, marcado!" (a frase é só isso)
  { re: /^\W*(?:(?:pronto|prontinho|perfeito|otimo|feito|certo)\W+)?(?:agendad|marcad)[oa]\W*$/, firm: true },
];
// Antes da afirmação: oferta/pergunta/condição ("quer que eu…", "posso…", "se preferir…").
const OFFER_BEFORE_RE =
  /\b(?:quer\s+que|queria\s+que|gostaria|posso|podemos|pode\s+ser|prefere|preferir|se\s+(?:quiser|preferir|for|der|puder|tiver|estiver|achar|voce|o\s+senhor|a\s+senhora)|assim\s+que|depois\s+que|antes\s+de|caso|consigo|vou\s+(?:verificar|ver|confirmar|checar|conferir|tentar)|deixa\s+eu|vamos|para\s+(?:eu\s+)?(?:deixar|agendar|marcar|reservar)|pra\s+(?:eu\s+)?(?:deixar|agendar|marcar|reservar))\b/;
// Depois da afirmação: condição ("deixo agendado se preferir", "reservado depois que você confirmar").
const CONDITION_AFTER_RE =
  /\b(?:se\s+(?:quiser|preferir|for\s+bom|der|puder|voce\s+(?:quiser|preferir|puder)|o\s+senhor|a\s+senhora)|caso\s|assim\s+que|depois\s+que|quando\s+voce\s+(?:confirmar|escolher|decidir)|apos\s+(?:a\s+|sua\s+)?confirma|ate\s+(?:voce|o\s+senhor|a\s+senhora)\s+confirmar)/;
// Logo depois da afirmação: regra geral, não fato ("reservado por 24h", "agendada 1x por mês").
const DESCRIPTIVE_AFTER_RE =
  /^\s*(?:por\s+(?:\d|um\b|uma\b|ate\b)|durante\b|uma\s+vez\s+por|a\s+cada\b|todo\s+(?:mes|dia|ano)\b|todos\s+os\b|mensalmente|semanalmente|anualmente)/;
// Pagamento/cobrança "agendado" não é consulta ("o pagamento ficou agendado", "boleto foi agendado").
const PAYMENT_RE =
  /\b(?:pagamento|pagar|pago|boleto|pix|cobranca|parcela|fatura|transferencia|deposito|mensalidade|vencimento)s?\b/;
// Negação colada no verbo ("ainda não está agendado", "não deixei marcado").
const NEGATION_TAIL_RE = /\b(?:nao|nem)\s+(?:[^\s,;:]+\s+)?$/;
// Numa frase com "?", só conta verbo no passado/estado ("deixei", "ficou marcada") ou o
// particípio abrindo a frase ("Agendado para terça às 8h, combinado?") + uma pergunta
// DEPOIS da vírgula ("…, tudo bem?", "…, quer a localização?").
const ASSERTIVE_RE =
  /\b(?:deixei|agendei|marquei|reservei|confirmei|garanti|ficou|foi|esta|ta)\b|^\W*(?:(?:pronto|prontinho|perfeito|otimo|feito|certo)\W+)?(?:agendad|marcad|confirmad)[oa]\b/;
// A pergunta depois da afirmação é sobre o HORÁRIO (outro horário, prefere, pode ser,
// fica bom, confirma…)? Logística/cortesia ("quer a localização?", "posso te ajudar em
// algo mais?", "precisa de mais alguma coisa?") não põe a marcação em dúvida.
const SLOT_TAG_QUESTION_RE =
  /\b(?:outr[oa]s?|prefer\w*|pode\s+ser|fica\s+(?:bom|melhor|ok|tranquilo)|melhor|confirm\w*|serve|da\s+certo|(?:consegue|pode|podera)\s+(?:vir|ir|comparecer)|consegue$|horarios?|data(?!\s+de\s+nascimento)|agend\w*|marc\w*|remarc\w*|mud\w*|troc\w*|ess[ea]\s+(?:dia|hora))\b/;
// Cortesia/logística — com dia/hora citados ("quer que eu te lembre amanhã?") não é
// pergunta sobre o horário marcado.
const COURTESY_TAG_RE =
  /\b(?:lembr\w*|avis\w*|localiza\w*|endereco|mapa|ajud\w*|duvida\w*|chegar|antecedencia|document\w*|levar|traz\w*|mand\w*|envi\w*|link)\b/;
// Dia citado (dia da semana, amanhã/hoje, DD/MM, "dia 14", "12 de novembro").
const DAY_WORD_RE = new RegExp(
  `\\b(?:segunda|terca|quarta|quinta|sexta|sabado|domingo|amanha|hoje|\\d{1,2}\\/\\d{1,2}|dia\\s+\\d{1,2}|\\d{1,2}\\s*[ºª°]?\\s+de\\s+(?:${MONTH_ALT}))\\b`,
);
// Pedido de confirmação sem "?" ("é só confirmar", "me confirma").
const CONFIRM_REQUEST_RE =
  /\b(?:me\s+confirma|confirma\s+(?:pra|para)\s+mim|(?:e\s+)?so\s+(?:me\s+)?confirmar|aguardo\s+(?:a\s+|sua\s+|a\s+sua\s+)?confirmacao|posso\s+confirmar)\b/;
// "Tag" curta no fim da frase da afirmação ("…, tá?", "…, ok?", "…, tudo bem?"):
// confirmação social, não pergunta de verdade sobre o horário.
const SHORT_TAG_RE =
  /^(?:ta|ok|okay|certo|tudo\s+(?:bem|certo|ok)|combinado|pode\s+ser|beleza|blz|fechado|ne|joia|fica\s+bom|sim|bom)(?:\s+(?:pra|para)\s+(?:voce|vc|o\s+senhor|a\s+senhora))?$/;
// O horário é de OUTRA pessoa ("já foi agendado por outro paciente", "está agendado
// pra outra pessoa", "já foi reservado por outro").
const NOT_OURS_RE =
  /\b(?:outr[oa]s?\s+(?:paciente|pessoa|cliente|crianca|familia)s?|alguem)\b|\bpor\s+outr[oa]s?\s*$/;
// "esse horário já está reservado", "o horário de 9h já está marcado", "às 9h já está
// marcado" — descreve o horário como TOMADO, não como marcado pro paciente.
const TAKEN_SUBJECT_RE =
  /\b(?:(?:ess[ea]|est[ea]|aquel[ea]|o)\s+(?:horario|dia|data)(?:\s+(?:de|das?|do)\s+\d{1,2}(?:h\d{0,2}|:\d{2})?)?|(?:as|das?)\s+\d{1,2}(?:h\d{0,2}|:\d{2})?)\s+ja\s+(?:esta|ta|foi|ficou)\b/;
// "já está marcado, mas tenho às 10h" — contraste que oferece OUTRO horário.
const ALREADY_TAKEN_BUT_RE =
  /\bja\s+(?:esta|ta|foi|ficou)\s+(?:agendad|marcad|reservad|ocupad|preenchid)[oa]s?\b[^.!?]*?\b(?:mas|porem|so\s+que)\s+(?:[a-z]+\s+){0,2}?(?:tenho|temos|consigo|ha|tem|posso)\b/;
// Marca de que é o horário DO paciente ("pra você", "sua avaliação").
const FOR_PATIENT_RE = /\b(?:(?:pra|para)\s+(?:voce|vc|o\s+senhor|a\s+senhora)|seu|sua)\b/;
// "Reservei dois horários pra você: …" — oferta de opções, não marcação.
const OFFER_LIST_AFTER_RE =
  /^\s*(?:(?:pra|para)\s+(?:voce|vc|o\s+senhor|a\s+senhora)\s+)?(?:dois|duas|tres|quatro|alguns|algumas|uns|umas|\d+|ess[ea]s|est[ea]s)\s+(?:horarios|opcoes|vagas|datas|horas)\b/;
// STATUS, não marcação: "foi marcada como falta", "está marcado como compareceu/concluído".
const STATUS_AFTER_RE =
  /^\s*como\s+(?:falta|faltou|faltante|ausen\w*|compareceu|comparecid[oa]|comparecimento|presen\w*|nao\s+(?:compareceu|veio|realizad[oa])|no\s*-?\s*show|concluid[oa]|realizad[oa]|atendid[oa]|finalizad[oa]|encerrad[oa]|cancelad[oa]|desmarcad[oa]|pendente|confirmad[oa]|pag[oa]|quitad[oa]|atrasad[oa]|em\s+(?:atendimento|aberto))\b/;
// Marcado por um TERCEIRO de FORA ("agendado pelo laboratório", "pela clínica parceira",
// "pelo hospital"): nunca é a IA afirmando que marcou agora. "pelo convênio/plano" é
// forma de pagamento, não quem marcou — não entra.
const THIRD_PARTY_RE =
  /\b(?:pel[oa]s?|por\s+(?:um|uma|o|a|nosso|nossa|seu|sua))\s+(?:(?:nosso|nossa|seu|sua)\s+)?(?:laboratorio|lab|clinica\s+(?:parceira|de\s+(?:radiologia|imagem|exames?))|outra\s+clinica|parceir[oa]|hospital|radiologia|radiologista|protetico|medic[oa])\b/;
// Marcado pela PRÓPRIA clínica ("pela recepção", "pela nossa equipe", "pela Dra. X"): pode
// ser a recepção contando que marcou ("a moça marcou pra mim?") — ou a IA disfarçando a
// própria afirmação logo depois do "sim" do paciente. Quem decide é o assessBookingClaim.
const CLINIC_PARTY_RE =
  /\b(?:pel[oa]s?|por\s+(?:um|uma|o|a|nosso|nossa|seu|sua))\s+(?:(?:nosso|nossa|seu|sua)\s+)?(?:recepcao|recepcionista|secretaria|secretari[oa]|atendente|equipe|central|dentista|dr|dra|doutor|doutora|ortodontista)\b/;
// 1ª pessoa no passado ("deixei/agendei/marquei"): a IA dizendo que ELA marcou.
const FIRST_PERSON_FACT_RE = /\b(?:deixei|agendei|marquei|reservei|remarquei|reagendei|confirmei|garanti)\b/;
// Prazo distante/genérico ("daqui a 6 meses", "em 1 ano", "no próximo retorno"): sem dia +
// hora concretos, não é um horário marcado agora.
const DISTANT_RE =
  /\b(?:(?:daqui|dentro\s+de|em|apos|depois\s+de)\s+(?:a\s+)?(?:\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|alguns|algumas|poucos)\s+(?:mes|meses|ano|anos)|(?:proxim[oa]|outr[oa])\s+(?:retorno|revisao|manutencao|limpeza|ano)|(?:semestral|anual)mente|todo\s+(?:semestre|ano))\b/;
// Fala de consulta PASSADA ("sua consulta de ontem", "sua última consulta").
const PAST_MARKER_RE =
  /\b(?:ontem|anteontem|(?:semana|mes|ano)\s+passad[oa]|ultim[oa]\s+(?:consulta|avaliacao|vez|sessao|visita|atendimento|limpeza|manutencao|retorno))\b/;
// Dia FUTURO sem DD/MM (dia da semana, hoje/amanhã, "dia 14").
const FUTURE_DAY_WORD_RE = /\b(?:segunda|terca|quarta|quinta|sexta|sabado|domingo|amanha|hoje|dia\s+\d{1,2})\b/;
// Marcado pra OUTRA pessoa da família ("agendado pra sua filha").
const OTHER_PERSON_RE =
  /\b(?:(?:pra|para|da|do|de)\s+(?:a\s+|o\s+)?(?:sua|seu|tua|teu)|(?:sua|seu))\s+(?:filh[oa]s?|espos[oa]|marido|mae|pai|irma|irmao|avo|net[oa]|sobrinh[oa]|namorad[oa]|companheir[oa]|dependente|crianca|bebe|entead[oa]|sogr[oa]|tia|tio|prim[oa])\b/;

/** Início da oração (vírgula/";"/":"/" e "/" mas " antes de `from`). */
function clauseStartOf(s: string, from: number): number {
  const left = s.slice(0, from);
  const cut = Math.max(left.lastIndexOf(','), left.lastIndexOf(';'), left.lastIndexOf(':'), left.lastIndexOf(' e '), left.lastIndexOf(' mas '));
  return cut < 0 ? 0 : cut;
}

/** Trecho da frase entre vírgulas/";"/" e " em volta do match (a "oração" da afirmação). */
function clauseAround(s: string, from: number, to: number): string {
  const r = s.slice(to).search(/[,;:]|\s(?:e|mas)\s/);
  return s.slice(clauseStartOf(s, from), r < 0 ? s.length : to + r);
}

/**
 * A afirmação fala de consulta que JÁ PASSOU? Data explícita (DD/MM) toda antes de
 * hoje ("sua última consulta foi marcada para 10/09"), ou "ontem"/"última consulta"
 * sem nenhum dia futuro citado depois ("sua consulta de ontem foi remarcada pra terça"
 * continua sendo afirmação).
 */
function talksAboutPast(s: string, matchAt: number, matchEnd: number, clause: string, todayStr: string): boolean {
  let dates = explicitDateTokens(clause, todayStr);
  // "foi marcada para quinta, 10/09": a data colada logo depois da oração.
  if (!dates.length) dates = explicitDateTokens(s.slice(matchEnd, matchEnd + 30), todayStr);
  if (dates.length) return dates.every((d) => d.date < todayStr);
  return PAST_MARKER_RE.test(clause) && !FUTURE_DAY_WORD_RE.test(s.slice(matchAt).replace(PAST_MARKER_RE, ' '));
}

interface ClaimHit {
  firm: boolean;
  asks: boolean;
  /** "remarquei", "foi remarcado" — nunca vira agendamento. */
  resched: boolean;
  /** "agendado pra sua filha" — de outra pessoa. */
  other: boolean;
  /** "agendada pela recepção/equipe/Dra." — só conta como afirmação nossa no contexto certo. */
  clinicParty?: boolean;
}

/**
 * A frase afirma/promete marcação? null = não; firm=false = só intenção ("vou deixar
 * agendado"); asks = a frase da afirmação pergunta DE VERDADE (não só a tag curta
 * "…, tá?" / "…, pode ser?"). Não é afirmação de marcação FEITA AGORA: status ("marcada
 * como falta"), consulta passada, terceiro de fora ("pelo laboratório"), prazo distante
 * sem dia + hora ("daqui a 6 meses"). "pela recepção/equipe/Dra." volta com
 * `clinicParty` (o assessBookingClaim decide pelo contexto).
 */
function sentenceClaim(s: string, isQuestion: boolean, todayStr: string): ClaimHit | null {
  let found: ClaimHit | null = null;
  let clinic: ClaimHit | null = null;
  for (const { re, firm, needsSlot, resched } of CLAIM_RES) {
    const m = re.exec(s);
    if (!m) continue;
    const end = m.index + m[0].length;
    const before = s.slice(0, m.index);
    const after = s.slice(end);
    if (needsSlot) {
      const near = after.slice(0, 35);
      if (!DAY_WORD_RE.test(near) || !timeTokens(near).length) continue;
    }
    // Condição depois: na intenção vale a frase toda ("deixo agendado, se preferir"); no
    // FATO só a oração dela ("deixei agendado se você quiser") — "deixei agendado terça às
    // 8h, se quiser te mando a localização" / ", caso precise remarcar…" continua afirmação.
    const cut = after.search(/[,;:]|\s(?:e|mas|porem)\s/);
    const condScope = firm && cut >= 0 ? after.slice(0, cut) : after;
    if (OFFER_BEFORE_RE.test(before) || NEGATION_TAIL_RE.test(before) || CONDITION_AFTER_RE.test(condScope)) continue;
    const clause = clauseAround(s, m.index, end);
    if (DESCRIPTIVE_AFTER_RE.test(after) || PAYMENT_RE.test(clause)) continue;
    // Horário TOMADO / de outra pessoa / oferta de opções — não é marcação do paciente.
    if (NOT_OURS_RE.test(clause) || OFFER_LIST_AFTER_RE.test(after)) continue;
    if (!FOR_PATIENT_RE.test(clause) && (TAKEN_SUBJECT_RE.test(clause) || ALREADY_TAKEN_BUT_RE.test(s.slice(m.index)))) continue;
    // Status / consulta passada / terceiro / prazo distante — não é marcação feita agora.
    if (STATUS_AFTER_RE.test(after) || THIRD_PARTY_RE.test(clause)) continue;
    // Dia + hora concretos na afirmação ("deixei agendada sua próxima manutenção para quinta
    // (15/10) às 9h", "…para daqui a 1 mês, dia 12/11 às 9h"): é marcação de agora, mesmo
    // citando "próximo retorno" / "daqui a N meses".
    const fromClause = s.slice(clauseStartOf(s, m.index));
    const concrete = DAY_WORD_RE.test(fromClause) && timeTokens(fromClause).length > 0;
    if (DISTANT_RE.test(clause) && !concrete) continue;
    // Data que já passou só descarta se não é a IA dizendo que ELA marcou (1ª pessoa, com
    // hora, sem "ontem/última consulta"): "deixei agendado para 05/01 às 9h" (em outubro) é
    // afirmação falsa — o paciente quer o ano que vem.
    const ownPastDate = FIRST_PERSON_FACT_RE.test(m[0]) && !PAST_MARKER_RE.test(clause) && timeTokens(s.slice(m.index)).length > 0;
    if (!ownPastDate && talksAboutPast(s, m.index, end, clause, todayStr)) continue;
    const clinicParty = CLINIC_PARTY_RE.test(clause);
    const other = OTHER_PERSON_RE.test(clause);
    let asks = false;
    if (isQuestion) {
      // Sem vírgula/"e" a frase inteira é a pergunta ("Deixei agendado terça às 8h?").
      if (!ASSERTIVE_RE.test(m[0])) continue;
      const sep = [...after.matchAll(/,|\se\s/g)].pop();
      if (!sep) continue;
      // A afirmação no passado/estado NUNCA é descartada por causa da pergunta: só
      // pergunta de verdade sobre o horário (não tag curta, logística ou cortesia) põe
      // a marcação em dúvida.
      const tagRaw = after.slice(sep.index! + sep[0].length);
      const tag = tagRaw.replace(EMOJI_STRIP_RE, ' ').replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
      const tagStr = tag.join(' ');
      const shortTag = tag.length <= 4 && SHORT_TAG_RE.test(tagStr);
      const citesSlot = DAY_WORD_RE.test(tagRaw) || timeTokens(tagRaw).length > 0;
      asks = !shortTag && (SLOT_TAG_QUESTION_RE.test(tagStr) || (citesSlot && !COURTESY_TAG_RE.test(tagStr)));
    }
    const hit: ClaimHit = { firm, asks, resched: !!resched, other };
    if (clinicParty) {
      // Só vale se nenhuma outra leitura da frase for afirmação "nossa" sem terceiro.
      if (!clinic || (firm && !clinic.firm)) clinic = { ...hit, clinicParty: true };
      continue;
    }
    if (firm) return hit;
    found = hit;
  }
  return found ?? clinic;
}

interface SentencePart {
  start: number; // posição no texto ORIGINAL
  end: number;
  body: string; // sem acento, minúsculo, sem a pontuação final
  isQuestion: boolean;
}

// Frase = até . ! ? ou quebra de linha; "Dra." e "1.500" não quebram a frase.
const SENTENCE_RE = /(?:\b(?:dra|dr|sra|sr|srta|prof|profa)\.|\d[.,]\d|[^.!?\n])+[.!?]*/gi;
const ABBREV_RE = /\b(dra|dr|sra|sr|srta|prof|profa)\./g;

function splitSentences(text: string): SentencePart[] {
  const out: SentencePart[] = [];
  for (const m of String(text || '').matchAll(SENTENCE_RE)) {
    const p = plain(m[0]).replace(ABBREV_RE, '$1');
    const body = p.replace(/[.!?]+$/, '');
    out.push({
      start: m.index!,
      end: m.index! + m[0].length,
      body: body.trim(),
      isQuestion: p.slice(body.length).includes('?'),
    });
  }
  return out;
}

export interface BookingClaimAnalysis {
  /** Frases (sem acento) que afirmam ou prometem a marcação. */
  claims: string[];
  /** Alguma é FATO (passado/estado: "deixei", "agendei", "está agendado")? */
  firm: boolean;
  /**
   * A FRASE da afirmação pergunta de verdade ("deixei agendado terça às 9h, prefere
   * outro?") ou a resposta pede confirmação ("me confirma", "é só confirmar"). Tag
   * curta no fim ("…, tá?", "…, ok?", "…, pode ser?") e pergunta em OUTRA frase
   * ("Quer que eu te mande a localização?") não contam.
   */
  asksConfirmation: boolean;
  /** Há alguma pergunta na resposta (qualquer frase) — "vou deixar agendado…. Pode ser?" é proposta. */
  hasQuestion: boolean;
  /** Alguma afirmação é de REMARCAÇÃO ("remarquei", "foi remarcado") — nunca vira agendamento. */
  reschedule: boolean;
  /** TODAS as afirmações são de outra pessoa ("agendado pra sua filha"). */
  otherPerson: boolean;
  /** Alguma afirmação é de outra pessoa — nunca vira agendamento do paciente. */
  anyOtherPerson: boolean;
  /**
   * Frases "agendada pela recepção/equipe/Dra." que NÃO entraram em `claims` (sem
   * `opts.clinicParty`): só são afirmação nossa logo depois de o paciente aceitar/pedir
   * horário — quem decide é o assessBookingClaim.
   */
  clinicParty: string[];
}

/**
 * Lê as afirmações de marcação da resposta. Pergunta/oferta ("quer que eu deixe
 * agendado?", "posso deixar marcado?"), condição ("se preferir, deixo marcado"),
 * negação ("ainda não está agendado"), descrição ("a avaliação fica marcada com a
 * Dra. X", "reservado por 24h"), pagamento ("boleto foi agendado"), horário TOMADO
 * ("esse horário já está reservado", "já foi agendado por outro paciente"), oferta
 * ("reservei dois horários pra você"), status ("foi marcada como falta"), consulta
 * passada ("sua última consulta foi marcada para 10/09"), terceiro de fora ("agendado
 * pelo laboratório") e prazo distante sem dia + hora ("daqui a 6 meses") não contam.
 * "pela recepção/equipe/Dra." vai pra `clinicParty` — e entra em `claims` só com
 * `opts.clinicParty`. `todayStr` (Maceió) decide o que é data passada.
 */
export function analyzeBookingClaims(
  text: string | null | undefined,
  todayStr: string = maceioTodayStr(),
  opts: { clinicParty?: boolean } = {},
): BookingClaimAnalysis {
  const src = String(text || '');
  const claims: string[] = [];
  const clinicParty: string[] = [];
  let firm = false;
  let asks = false;
  let reschedule = false;
  let others = 0;
  for (const p of splitSentences(src)) {
    if (!p.body) continue;
    const c = sentenceClaim(p.body, p.isQuestion, todayStr);
    if (!c) continue;
    if (c.clinicParty && !opts.clinicParty) {
      clinicParty.push(p.body);
      continue;
    }
    claims.push(p.body);
    if (c.firm) firm = true;
    if (c.asks) asks = true;
    if (c.resched) reschedule = true;
    if (c.other) others++;
  }
  return {
    claims,
    firm,
    asksConfirmation: asks || CONFIRM_REQUEST_RE.test(plain(src)),
    hasQuestion: src.includes('?'),
    reschedule,
    otherPerson: claims.length > 0 && others === claims.length,
    anyOtherPerson: others > 0,
    clinicParty,
  };
}

/**
 * Frases da resposta que afirmam (ou prometem) uma marcação — inclusive "agendada pela
 * recepção/equipe/Dra.", que só o assessBookingClaim (com a mensagem do paciente) sabe se
 * é afirmação nossa. É o filtro de ENTRADA da rede 13a: vazio = nem roda a rede.
 */
export function findBookingClaims(text: string | null | undefined, todayStr?: string): string[] {
  const a = analyzeBookingClaims(text, todayStr);
  return [...a.claims, ...a.clinicParty];
}

/** A resposta AFIRMA (ou promete) marcação por conta própria (sem "pela recepção/equipe")? */
export function claimsBooked(text: string | null | undefined, todayStr?: string): boolean {
  return analyzeBookingClaims(text, todayStr).claims.length > 0;
}

// ─── Recuperar o horário do texto ────────────────────────────────────────────

export interface FreeSlotDay {
  date: string; // YYYY-MM-DD
  times: string[]; // HH:MM livres (computeDaySlots)
}

export interface SlotRef {
  date: string;
  time: string;
}

/** Horário pedido que não está livre; `onwards` = "a partir de 1º de novembro" (dali em diante). */
export type RequestedSlot = Partial<SlotRef> & { onwards?: boolean };

export interface SlotMentions {
  dates: Set<string>;
  weekdays: Set<number>;
  times: Set<string>;
  /** "terça que vem", "próxima terça", "semana que vem": a data exata é ambígua. */
  relativeQualifier: boolean;
  /** Alguma data veio explícita (DD/MM, ISO ou do confirm_slot)? */
  explicitDate: boolean;
}

const WEEKDAY_KEYS = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
const WEEKDAY_ALT = WEEKDAY_KEYS.join('|');
// "terça que vem", "próxima terça", "outra semana", "terça seguinte" — semana/mês relativo.
const RELATIVE_QUALIFIER_RE = new RegExp(
  `\\b(?:(?:${WEEKDAY_ALT}|feira|semana|mes)\\s+que\\s+vem|proxim[oa]\\s+(?:semana|${WEEKDAY_ALT})|(?:outra|proxima)\\s+semana|semana\\s+seguinte|(?:${WEEKDAY_ALT})(?:[\\s-]*feira)?\\s+seguinte)\\b`,
);

/** Horas citadas (com a posição [pos, end) no texto sem acento). */
function timeTokens(t: string): { pos: number; end: number; time: string }[] {
  const out: { pos: number; end: number; time: string }[] = [];
  const add = (m: RegExpMatchArray, h: number, min: number) => {
    if (Number.isInteger(h) && Number.isInteger(min) && h >= 0 && h <= 23 && min >= 0 && min <= 59) {
      out.push({ pos: m.index!, end: m.index! + m[0].length, time: `${pad2(h)}:${pad2(min)}` });
    }
  };
  for (const m of t.matchAll(/\b(\d{1,2}):(\d{2})\b/g)) add(m, Number(m[1]), Number(m[2]));
  for (const m of t.matchAll(/\b(\d{1,2})\s?h(?:rs?|s)?(\d{2})?\b/g)) add(m, Number(m[1]), m[2] ? Number(m[2]) : 0);
  // "9 horas" é hora; "daqui a 1 hora", "por 2 horas", "dura 1 hora" é duração.
  for (const m of t.matchAll(/(?<!\b(?:daqui\s+a|em|por|durante|de|dura|ha|uns|umas|mais|menos)\s+)\b(\d{1,2})\s+horas?\b/g)) {
    add(m, Number(m[1]), 0);
  }
  for (const m of t.matchAll(/\b(as|a)\s+(\d{1,2})\b(?![/:\d]|\s?h)/g)) {
    let h = Number(m[2]);
    // "às 2", "às 3"… (1–6, sem "h") na fala de agenda = 14h, 15h… — a clínica não
    // atende de madrugada. "às 2 da manhã" fica 2h; "as 2 opções"/"as 3 vezes" (artigo)
    // e "daqui a 1 mês" (prazo) não são hora.
    const rest = t.slice(m.index! + m[0].length);
    if (/^\s*(?:[ºª°]|(?:opcoes|opcao|vez|vezes|parcelas?|sessoes|consultas|pessoas|dias?|semanas?|mes|meses|anos?|horas?|minutos?|horarios|datas|primeir\w*|ultim\w*|unidades|etapas|fotos|coisas|duvidas)\b)/.test(rest)) continue;
    if (m[1] === 'as' && h >= 1 && h <= 6 && !/^\s+(?:da|de|pela)\s+(?:manha|madrugada)\b/.test(rest)) h += 12;
    add(m, h, 0);
  }
  for (const m of t.matchAll(/\bmeio[\s-]dia\b/g)) add(m, 12, 0);
  for (const m of t.matchAll(/\b(\d{1,2})(?::(\d{2})|\s?h(\d{2})?)?\s+(?:da|de)\s+(?:tarde|noite)\b/g)) {
    const h = Number(m[1]);
    if (h >= 1 && h < 12) add(m, h + 12, Number(m[2] || m[3] || 0));
  }
  return out;
}

/** Datas EXPLÍCITAS (ISO, DD/MM, DD/MM/AAAA) com a posição [pos, end) no texto sem acento. */
function explicitDateTokens(t: string, todayStr: string): { pos: number; end: number; date: string }[] {
  const out: { pos: number; end: number; date: string }[] = [];
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const d = isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (d) out.push({ pos: m.index!, end: m.index! + m[0].length, date: d });
  }
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g)) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const date = m[3]
      ? isoDate(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), mo, d)
      : nextDayMonth(d, mo, todayStr);
    if (date) out.push({ pos: m.index!, end: m.index! + m[0].length, date });
  }
  // Por extenso: "1º de novembro", "13 de outubro de 2026".
  for (const m of t.matchAll(new RegExp(MONTH_DATE_SRC, 'g'))) {
    const d = Number(m[1]);
    const mo = MONTH_NAMES.indexOf(m[2]) + 1;
    const date = m[3] ? isoDate(Number(m[3]), mo, d) : nextDayMonth(d, mo, todayStr);
    if (date) out.push({ pos: m.index!, end: m.index! + m[0].length, date });
  }
  return out;
}

/**
 * Palavra de dia SEM DD/MM: dia da semana, hoje/amanhã/depois de amanhã, "dia 14" e
 * os relativos ("terça que vem", "próxima semana", "outro dia" — data incerta).
 */
interface DayWordToken {
  pos: number;
  end: number;
  date?: string;
  weekday?: number;
  relative?: boolean;
  /** hoje/amanhã/depois de amanhã: a data depende do dia em que a mensagem foi escrita. */
  relDay?: boolean;
}

const WEEKDAY_WORD_RE = new RegExp(
  // "segunda opção/vez/consulta" é ordinal, não dia.
  `\\b(${WEEKDAY_ALT})\\b(?:[\\s-]*feira)?(?!\\s+(?:opcao|opcoes|vez|vezes|consulta|etapa|sessao|parcela|via)\\b)`,
  'g',
);
const RELATIVE_QUALIFIER_G = new RegExp(RELATIVE_QUALIFIER_RE.source, 'g');

function dayWordTokens(t: string, todayStr: string): DayWordToken[] {
  const out: DayWordToken[] = [];
  const add = (m: RegExpMatchArray, extra: Omit<DayWordToken, 'pos' | 'end'>) =>
    out.push({ pos: m.index!, end: m.index! + m[0].length, ...extra });
  for (const m of t.matchAll(RELATIVE_QUALIFIER_G)) add(m, { relative: true });
  for (const m of t.matchAll(/\boutr[oa]s?\s+(?:dia|data|semana)s?\b/g)) add(m, { relative: true });
  for (const m of t.matchAll(/\bdepois\s+de\s+amanha\b/g)) add(m, { date: addDays(todayStr, 2), relDay: true });
  for (const m of t.matchAll(/(?<!depois\s+de\s+)\bamanha\b/g)) add(m, { date: addDays(todayStr, 1), relDay: true });
  for (const m of t.matchAll(/\bhoje\b/g)) add(m, { date: todayStr, relDay: true });
  for (const m of t.matchAll(WEEKDAY_WORD_RE)) add(m, { weekday: WEEKDAY_KEYS.indexOf(m[1]) });
  for (const m of t.matchAll(new RegExp(DAY_OF_MONTH_SRC, 'g'))) {
    const date = nextDayOfMonth(Number(m[1]), todayStr);
    if (date) add(m, { date });
  }
  return out;
}

/** A palavra de dia é compatível com a data? Relativo ("terça que vem") nunca é. */
function dayWordAgrees(w: DayWordToken, date: string): boolean {
  if (w.relative) return false;
  if (w.date) return w.date === date;
  if (w.weekday !== undefined) return weekdayOf(date) === w.weekday;
  return true;
}

/** Datas (DD/MM, "dia 14", amanhã, hoje), dias da semana e horas citados no texto. */
export function extractSlotMentions(text: string | null | undefined, todayStr: string): SlotMentions {
  let t = plain(String(text || ''));
  const dates = new Set<string>();
  const weekdays = new Set<number>();
  const explicit = explicitDateTokens(t, todayStr);
  for (const e of explicit) dates.add(e.date);
  const relativeQualifier = RELATIVE_QUALIFIER_RE.test(t);
  for (const m of t.matchAll(new RegExp(DAY_OF_MONTH_SRC, 'g'))) {
    const date = nextDayOfMonth(Number(m[1]), todayStr);
    if (date) dates.add(date);
  }
  if (/\bdepois\s+de\s+amanha\b/.test(t)) {
    dates.add(addDays(todayStr, 2));
    t = t.replace(/\bdepois\s+de\s+amanha\b/g, ' ');
  }
  if (/\bamanha\b/.test(t)) dates.add(addDays(todayStr, 1));
  if (/\bhoje\b/.test(t)) dates.add(todayStr);
  WEEKDAY_KEYS.forEach((w, i) => {
    if (new RegExp(`\\b${w}\\b`).test(t)) weekdays.add(i);
  });
  const times = new Set(timeTokens(t).map((x) => x.time));
  return { dates, weekdays, times, relativeQualifier, explicitDate: explicit.length > 0 };
}

const hasSlotMention = (m: SlotMentions) => m.dates.size > 0 || m.weekdays.size > 0 || m.times.size > 0;

/** O horário bate com tudo o que foi citado (data, dia da semana, hora)? */
function mentionsAgree(m: SlotMentions, slot: SlotRef): boolean {
  return (
    (m.dates.size === 0 || m.dates.has(slot.date)) &&
    (m.weekdays.size === 0 || m.weekdays.has(weekdayOf(slot.date))) &&
    (m.times.size === 0 || m.times.has(slot.time))
  );
}

export type SlotRecovery =
  | { status: 'match'; date: string; time: string }
  | { status: 'ambiguous'; candidates: SlotRef[] }
  | { status: 'none'; reason: 'sem_dia_ou_hora' | 'nao_livre' | 'dia_relativo' };

const bySlot = (a: SlotRef, b: SlotRef) =>
  a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date);

function fromCandidates(cands: SlotRef[]): SlotRecovery {
  cands.sort(bySlot);
  if (cands.length === 1) return { status: 'match', ...cands[0] };
  if (cands.length > 1) return { status: 'ambiguous', candidates: cands };
  return { status: 'none', reason: 'nao_livre' };
}

function matchMentions(m: SlotMentions, freeDays: FreeSlotDay[]): SlotRecovery {
  const hasDay = m.dates.size > 0 || m.weekdays.size > 0;
  if (!hasDay || m.times.size === 0) return { status: 'none', reason: 'sem_dia_ou_hora' };
  // "terça que vem" / "próxima terça" sem data: pode ser 13/10 ou 20/10 — não chuta.
  if (m.relativeQualifier && !m.explicitDate) return { status: 'none', reason: 'dia_relativo' };
  const seen = new Set<string>();
  const cands: SlotRef[] = [];
  for (const d of freeDays) {
    // Data e dia da semana citados têm que concordar ("terça" + "amanhã" que não é terça = nada).
    const dayOk =
      (m.dates.size === 0 || m.dates.has(d.date)) && (m.weekdays.size === 0 || m.weekdays.has(weekdayOf(d.date)));
    if (!dayOk) continue;
    for (const time of d.times) {
      const k = `${d.date} ${time}`;
      if (m.times.has(time) && !seen.has(k)) {
        seen.add(k);
        cands.push({ date: d.date, time });
      }
    }
  }
  return fromCandidates(cands);
}

function withHint(m: SlotMentions, hint?: Partial<SlotRef> | null): SlotMentions {
  if (!hint) return m;
  const dates = new Set(m.dates);
  const times = new Set(m.times);
  let explicitDate = m.explicitDate;
  if (hint.date && dates.size === 0) {
    dates.add(hint.date);
    explicitDate = true;
  }
  if (hint.time && times.size === 0) times.add(hint.time);
  return { ...m, dates, times, explicitDate };
}

/**
 * Recupera o horário de uma resposta que disse "deixei agendado" sem a ação.
 * Casa data/dia da semana + hora citados com os horários LIVRES calculados neste
 * turno ({{available_slots}}). Só devolve 'match' com exatamente UM candidato.
 * Ordem: frases da afirmação → resposta inteira → (faltando dia ou hora na resposta)
 * completa com a última mensagem do paciente ("pode ser terça 9h" + "Perfeito,
 * deixei agendado!"). `hint` = data/hora parcial que veio num confirm_slot incompleto.
 * Dia da semana com "que vem"/"próxima" sem data explícita = 'dia_relativo' (não chuta).
 * NÃO decide se pode marcar — isso é do assessBookingClaim.
 */
export function recoverSlotFromText(
  reply: string,
  freeDays: FreeSlotDay[],
  todayStr: string,
  opts: { claimText?: string; contextText?: string | null; hint?: Partial<SlotRef> | null } = {},
): SlotRecovery {
  const attempts = [opts.claimText, reply].filter((x): x is string => !!x && !!x.trim());
  for (const txt of attempts) {
    const r = matchMentions(withHint(extractSlotMentions(txt, todayStr), opts.hint), freeDays);
    if (r.status !== 'none' || r.reason !== 'sem_dia_ou_hora') return r;
  }
  if (opts.contextText) {
    const own = withHint(extractSlotMentions(reply, todayStr), opts.hint);
    const ctx = extractSlotMentions(opts.contextText, todayStr);
    const ownHasDay = own.dates.size > 0 || own.weekdays.size > 0;
    const day = ownHasDay ? own : ctx;
    return matchMentions(
      {
        dates: day.dates,
        weekdays: day.weekdays,
        times: own.times.size > 0 ? own.times : ctx.times,
        relativeQualifier: day.relativeQualifier,
        explicitDate: day.explicitDate,
      },
      freeDays,
    );
  }
  return { status: 'none', reason: 'sem_dia_ou_hora' };
}

// Oração que NÃO oferece o horário citado nela: nosso aviso honesto ("deixei anotada
// sua preferência por… pra recepção confirmar"), "não consegui terça às 9h", "não
// tenho às 9h", horário de outra pessoa.
const NOT_OFFERED_CLAUSE_RE =
  /\b(?:deixei\s+anotad|nao\s+(?:tenho|temos|ha|consegui|conseguimos|deu|da|esta\s+(?:mais\s+)?(?:livre|disponivel))|sem\s+(?:vaga|horario)|indisponive|ocupad|lotad|preenchid|outr[oa]s?\s+(?:paciente|pessoa|cliente))/;

/** Trechos [início, fim) do texto (sem acento) cujas horas NÃO são oferta nossa. */
function notOfferedRanges(t: string): [number, number][] {
  const out: [number, number][] = [];
  const cut = /[.!?\n;,]|\s(?:mas|porem)\s/g;
  let start = 0;
  const push = (end: number) => {
    if (NOT_OFFERED_CLAUSE_RE.test(t.slice(start, end))) out.push([start, end]);
  };
  for (const m of t.matchAll(cut)) {
    // "Dra." / "1.500" / "13/10" não cortam (só pontuação seguida de espaço/fim).
    if (m[0] === '.' && /\w/.test(t[m.index! + 1] || '')) continue;
    push(m.index!);
    start = m.index! + m[0].length;
  }
  push(t.length);
  return out;
}

/** Hora oferecida SEM data explícita confiável ("tenho quarta às 9h", "amanhã às 8h"). */
interface UndatedOffer {
  time: string;
  /** Data provável (dia da semana/amanhã/hoje/"dia 14") — só pra PROPOR, nunca marca. */
  soft?: string;
}

interface ParsedOffer {
  /** Hora pareada com uma data EXPLÍCITA (DD/MM/ISO) que nada contradiz — pode virar marcação. */
  dated: SlotRef[];
  /** Horas oferecidas sem data explícita confiável (ou contraditas por outra palavra de dia). */
  undated: UndatedOffer[];
  /** Os itens na ORDEM do texto ("o primeiro", "a segunda opção"); date = data explícita ou provável. */
  ordered: OfferItem[];
}

interface OfferItem {
  time: string;
  date?: string;
  /** A data é EXPLÍCITA (pode virar marcação); senão é só a provável (pra propor). */
  dated: boolean;
}

// Fronteira de oração (a "hora" e o "dia" dela ficam na mesma oração).
const CLAUSE_CUT_RE = /[,;:!?\n]|\.(?!\w)|\s(?:ou|e|mas|porem)\s/g;
const SENTENCE_CUT_RE = /[!?\n]|\.(?!\w)/;
// Palavra de dia COLADA numa data explícita: "terça (13/10)", "amanhã (terça, 13/10)",
// "amanhã, dia 13/10" (antes da data) / "13/10 (terça)", "13/10, terça" (depois).
const GLUED_BEFORE_DATE_RE = new RegExp(`^[\\s,(\\-]*(?:(?:${WEEKDAY_ALT})(?:[\\s-]*feira)?[\\s,(\\-]*)?(?:dia\\s+)?$`);
const GLUED_AFTER_DATE_RE = /^[\s,)\-]*\(?\s*$/;
const gluedToDate = (t: string, w: { pos: number; end: number }, d: { pos: number; end: number }) =>
  (w.end <= d.pos && GLUED_BEFORE_DATE_RE.test(t.slice(w.end, d.pos))) ||
  (d.end <= w.pos && GLUED_AFTER_DATE_RE.test(t.slice(d.end, w.pos)));

/**
 * O dia em que a NOSSA mensagem foi escrita, quando ela mesma diz ("Hoje (12/10)…",
 * "amanhã (13/10)…") — o "hoje/amanhã" dela é relativo a esse dia (a proposta pode ser
 * de ontem). Só vale entre 7 dias atrás e hoje, e sem contradição; senão, hoje e
 * `anchored: false` (o "amanhã" solto dela tem data INCERTA).
 */
function messageTodayOf(
  t: string,
  dates: { pos: number; end: number; date: string }[],
  todayStr: string,
): { today: string; anchored: boolean } {
  const found = new Set<string>();
  for (const m of t.matchAll(/\b(?:hoje|depois\s+de\s+amanha|(?<!depois\s+de\s+)amanha)\b/g)) {
    const w = { pos: m.index!, end: m.index! + m[0].length };
    const back = m[0] === 'hoje' ? 0 : m[0] === 'amanha' ? 1 : 2;
    for (const d of dates) if (gluedToDate(t, w, d)) found.add(addDays(d.date, -back));
  }
  const [only] = [...found];
  return found.size === 1 && only <= todayStr && only >= addDays(todayStr, -7)
    ? { today: only, anchored: true }
    : { today: todayStr, anchored: false };
}

/**
 * Lê a NOSSA proposta: cada hora oferecida fica com a data EXPLÍCITA citada logo antes
 * dela (sem nenhuma antes, a logo depois) — sem o produto cartesiano dia × hora — MAS
 * só quando nenhuma palavra de dia entre a data e a hora (ou na oração da hora)
 * contradiz essa data: em "Na terça (13/10) está lotada, mas tenho quarta às 9h" ou
 * "Hoje (12/10) não tenho. Amanhã às 8h", a hora NÃO é da data citada — vira `undated`
 * (com a data provável em `soft`, só pra propor). Hora em oração que não oferece
 * ("deixei anotada sua preferência por…", "não consegui terça às 9h", "não tenho às
 * 9h") não conta.
 */
function parseOffer(text: string | null | undefined, todayStr: string): ParsedOffer {
  const t = plain(String(text || ''));
  const dates = explicitDateTokens(t, todayStr).sort((a, b) => a.pos - b.pos);
  const times = timeTokens(t).sort((a, b) => a.pos - b.pos);
  const notOffered = notOfferedRanges(t);
  const cuts = [...t.matchAll(CLAUSE_CUT_RE)].map((m) => ({ pos: m.index!, end: m.index! + m[0].length }));
  // hoje/amanhã DA MENSAGEM (que pode ser de ontem) — e o dia da semana resolve a partir dele.
  const { today: msgToday, anchored } = messageTodayOf(t, dates, todayStr);
  // Palavra de dia COLADA numa data explícita com que concorda ("terça (13/10)", "13/10,
  // terça", "amanhã, dia 13/10") é parte dessa data — não contradiz nem governa outra hora.
  const words = dayWordTokens(t, msgToday).filter(
    (w) => !dates.some((d) => dayWordAgrees(w, d.date) && gluedToDate(t, w, d)),
  );
  const wordsIn = (from: number, to: number) => words.filter((w) => w.pos < to && w.end > from);
  // Contradiz a data? "amanhã"/"hoje" soltos sem a mensagem dizer em que dia foi escrita
  // têm data INCERTA (a proposta pode ser de ontem): não confirmam a data — na dúvida, não.
  const conflicts = (w: DayWordToken, date: string) => !dayWordAgrees(w, date) || (!!w.relDay && !anchored);

  const dated: SlotRef[] = [];
  const undated: UndatedOffer[] = [];
  const ordered: OfferItem[] = [];
  const pushOrdered = (it: OfferItem) => {
    if (!ordered.some((o) => o.time === it.time && o.date === it.date && o.dated === it.dated)) ordered.push(it);
  };
  let prevEnd = 0;
  let prevSoft: { soft?: string; end: number } | null = null;
  for (const tm of times) {
    const segStart = prevEnd;
    prevEnd = tm.end;
    if (notOffered.some(([a, b]) => tm.pos >= a && tm.pos < b)) continue;
    // Oração da hora: da última fronteira antes dela até a próxima fronteira, hora ou data.
    const clauseStart = cuts.filter((c) => c.end <= tm.pos).reduce((acc, c) => Math.max(acc, c.end), 0);
    const tailEnd = Math.min(
      cuts.find((c) => c.pos >= tm.end)?.pos ?? t.length,
      times.find((x) => x.pos >= tm.end)?.pos ?? t.length,
      dates.find((d) => d.pos >= tm.end)?.pos ?? t.length,
    );
    const tail = wordsIn(tm.end, tailEnd);
    const before = dates.filter((d) => d.end <= tm.pos);
    const ref = before.length ? before[before.length - 1] : dates.find((d) => d.pos >= tm.end);
    if (ref) {
      const between = ref.pos < tm.pos ? wordsIn(ref.end, tm.pos) : wordsIn(Math.min(clauseStart, tm.pos), ref.pos);
      if (![...between, ...tail].some((w) => conflicts(w, ref.date))) {
        if (!dated.some((s) => s.date === ref.date && s.time === tm.time)) dated.push({ date: ref.date, time: tm.time });
        pushOrdered({ date: ref.date, time: tm.time, dated: true });
        prevSoft = null;
        continue;
      }
    }
    // Sem data explícita confiável: a data provável vem das palavras de dia da própria
    // fala dessa hora (desde a hora anterior); todas têm que concordar num dia só.
    const near = [...wordsIn(segStart, tm.pos), ...tail];
    let soft: string | undefined;
    if (near.length) {
      if (!near.some((w) => w.relative)) {
        const ds = [...new Set(near.filter((w) => w.date).map((w) => w.date!))];
        const wds = [...new Set(near.filter((w) => w.weekday !== undefined).map((w) => w.weekday!))];
        if (ds.length === 1) soft = wds.every((wd) => weekdayOf(ds[0]) === wd) ? ds[0] : undefined;
        else if (!ds.length && wds.length === 1) soft = nextWeekdayDate(wds[0], msgToday);
      }
    } else if (prevSoft && !SENTENCE_CUT_RE.test(t.slice(prevSoft.end, tm.pos))) {
      // "quarta às 9h ou às 14h": a 2ª hora continua no mesmo dia da 1ª.
      soft = prevSoft.soft;
    }
    undated.push({ time: tm.time, ...(soft ? { soft } : {}) });
    pushOrdered({ time: tm.time, ...(soft ? { date: soft } : {}), dated: false });
    prevSoft = { soft, end: tm.end };
  }
  return { dated: dated.sort(bySlot), undated, ordered };
}

/**
 * Horários que NÓS oferecemos com data EXPLÍCITA ("terça (13/10) às 8h ou quarta
 * (14/10) às 14h") — só esses podem virar marcação por um "sim". Dia da semana /
 * "amanhã" sem DD/MM não contam (a oferta pode ser de outro dia e mudaria de data),
 * nem hora cujo dia citado contradiz a data ("terça (13/10) lotada, tenho quarta às 9h").
 */
export function extractOfferedSlots(text: string | null | undefined, todayStr: string): SlotRef[] {
  return parseOffer(text, todayStr).dated;
}

const slotOf = (startNaive: Date): SlotRef => {
  const iso = startNaive.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
};

/** O horário é o de uma consulta que o paciente JÁ tem (start naive)? */
export function isExistingAppointmentSlot(slot: SlotRef, existingStarts: Date[]): boolean {
  return existingStarts.some((s) => {
    const e = slotOf(s);
    return e.date === slot.date && e.time === slot.time;
  });
}

/**
 * A resposta fala de uma consulta que JÁ existe ("sua consulta está marcada pra
 * terça às 9h")? Sem dia/hora citados e com consulta futura = assume que sim
 * (não dá pra afirmar que é marcação nova). "terça que vem" casa com qualquer terça.
 */
export function mentionsExistingAppointment(text: string, existingStarts: Date[], todayStr: string): boolean {
  if (!existingStarts.length) return false;
  const m = extractSlotMentions(text, todayStr);
  if (!hasSlotMention(m)) return true;
  return existingStarts.some((s) => mentionsAgree(m, slotOf(s)));
}

// ─── O paciente aceitou? ─────────────────────────────────────────────────────

// "não posso/consigo/dá" sobre OUTRA coisa ("não posso pagar agora", "não posso atrasar",
// "não posso chegar antes") não é recusa do horário — só quando o complemento é o
// horário/dia, "ir" ou "vir" (ou nada).
const NOT_SLOT_COMPLEMENT = String.raw`(?:(?:pra|para)\s+)?(?:me\s+)?(?:pagar|parcelar|atrasar|faltar|demorar|esquecer|perder|gastar|comer|beber|dirigir|trazer|levar|ficar\s+(?:muito|sem)|chegar\s+(?:atrasad[oa]|tarde|depois|antes)|sair\s+(?:muito\s+)?(?:tarde|antes))`;
// Recusa que GOVERNA o horário/agenda: "não posso", "não consigo", "não dá", "não vou
// poder", "não quero esse", "posso não" (Nordeste), "prefiro outro", "outro dia",
// "terça não", "às 8h não", "não, …" — e sem "não": "8h é muito cedo pra mim", "complica
// pra mim", "fica difícil", "nem pensar". "não tenho compromisso" / "não vejo a hora" /
// "não posso pagar agora" NÃO são recusa.
const PATIENT_REFUSAL_RE = new RegExp(
  [
    String.raw`^\W*(?:nao|nops)\W*$`,
    String.raw`^\W*nao\s*[,.;!]`,
    String.raw`\b(?:nao|nem)\s+(?:(?:vou|vai|irei|iria|to|estou|vou\s+mais)\s+)?(?:posso|poderei|poderia|podendo|poder|consigo|conseguirei|conseguiria|conseguindo|conseguir|da|dar|daria|serve|servem|funciona|rola|ir)\b(?!\s+${NOT_SLOT_COMPLEMENT}\b)`,
    String.raw`\bnao\s+quero\s+(?:mais|ess[ea]s?|ness[ea]|nest[ea]|marcar|agendar|horario)\b`,
    String.raw`\bnao\s+(?:fica|e)\s+bom\b`,
    String.raw`\bnao\s+tenho\s+como\b`,
    String.raw`\b(?:posso|consigo|da|quero|serve|rola|vou\s+poder|vai\s+dar)\s+nao\b`,
    String.raw`\bimpossivel\b`,
    String.raw`\bprefiro\s+outr`,
    String.raw`\boutr[oa]s?\s+(?:dia|horario|data|hora|semana|periodo|turno|opcao|opcoes)\b`,
    String.raw`\bnenhum[a]?\s+(?:dess[ea]s|deles|delas|horario|dia|opcao|dos\s+(?:dois|tres)|das\s+(?:duas|tres))\b`,
    String.raw`^\W*nenhum[a]?\W*$`,
    // ocupado no turno: "de manhã tenho aula", "trabalho à tarde", "estudo de manhã"
    String.raw`(?<!\bnao\s+)\b(?:tenho\s+(?:aula|trabalho|curso|faculdade|escola|reuniao|plantao)|trabalho|estudo|to\s+trabalhando|estou\s+trabalhando)\b[^,.;!?\n]{0,20}?\b(?:de|pela|a|na|no|durante\s+a)\s+(?:manha|tarde|noite)\b`,
    String.raw`\b(?:de|pela|a)\s+(?:manha|tarde|noite)\s+(?:eu\s+)?(?:tenho\s+(?:aula|trabalho|curso|faculdade|escola|reuniao|plantao)|trabalho|estudo)\b`,
    String.raw`\b(?:ess[ea]|ness[ea]|nest[ea]|segunda|terca|quarta|quinta|sexta|sabado|domingo|amanha|hoje|horario|dia)\s+(?:(?:dia|horario|feira|ai|ja)\s+)?(?:eu\s+)?nao\b(?!\s+(?:tenho\s+compromisso|vejo\s+a\s+hora|importa|tem\s+problema|precisa|esquec|(?:e|eh|fica|seria)\s+(?:muito\s+)?(?:cedo|tarde|problema|longe)))`,
    // a HORA seguida de "não": "terça às 8h não", "às 8 não", "8h não dá", "dia 20 não"
    String.raw`\b\d{1,2}(?:(?::|h)\d{2}|\s?h(?:rs?|s)?)?\s+(?:(?:ai|ja|entao|tambem|tb|tbm)\s+)?(?:eu\s+)?nao\b(?!\s+(?:tenho\s+compromisso|vejo\s+a\s+hora|importa|tem\s+problema|precisa|esquec|(?:e|eh|fica|seria)\s+(?:muito\s+)?(?:cedo|tarde|problema|longe)))`,
    // o item da lista seguido de "não": "o segundo não", "o 2º não"
    String.raw`\b(?:[oa]\s+(?:primeir|segund|terceir|ultim)[oa]|\d\s*[ºª°])\s+nao\b`,
    // sem "não": cedo/tarde demais, "complica", "fica difícil", "ruim pra mim", "nem pensar"
    // ("não é muito cedo", "não complica" não são recusa)
    String.raw`(?<!\b(?:nao|nem)\s+(?:e|eh|fica|seria|ta|esta)\s+)\b(?:muito|mt|mto)\s+(?:cedo|tarde)\b`,
    String.raw`(?<!\b(?:nao|nem)\s+(?:e|eh|fica|seria|ta|esta)\s+)\b(?:cedo|tarde)\s+demais\b`,
    String.raw`(?<!\bnao\s+)\bcomplica(?:do|da|r)?\b`,
    String.raw`(?<!\bnao\s+)\b(?:fica|ficaria|seria)\s+(?:muito\s+|meio\s+|bem\s+|um\s+pouco\s+)?(?:dificil|ruim|puxado|apertado|corrido|complicado)\b`,
    String.raw`(?<!\bnao\s+(?:e|eh|fica|seria|ta|esta)\s+)\b(?:dificil|ruim|puxado|apertado|corrido)\s+(?:pra|para)\s+mim\b`,
    String.raw`\bnem\s+(?:pensar|a\s+pau|morto|morta)\b`,
    String.raw`\bde\s+jeito\s+nenhum\b`,
  ].join('|'),
);
// "muito cedo/tarde" sobre uma hora: recusa essa hora E as vizinhas (cedo: as de antes até
// 1h depois; tarde: as de depois até 1h antes).
const TOO_EARLY_RE = /(?<!\b(?:nao|nem)\s+(?:e|eh|fica|seria|ta|esta)\s+)\b(?:(?:muito|mt|mto)\s+cedo|cedo\s+demais)\b/;
const TOO_LATE_RE = /(?<!\b(?:nao|nem)\s+(?:e|eh|fica|seria|ta|esta)\s+)\b(?:(?:muito|mt|mto)\s+tarde|tarde\s+demais)\b/;
// Qualquer negação — num aceite, só passa se for uma das benignas abaixo.
const NEGATION_RE = /\b(?:nao|nem|nunca|jamais)\b/;
const BENIGN_NEGATION_RE = new RegExp(
  String.raw`\bnao\s+(?:vejo\s+a\s+hora|(?:tenho|tem)\s+(?:nenhum\s+|nenhuma\s+)?(?:compromisso|problema|preferencia)|ha\s+problema|(?:e|eh|fica|seria)\s+(?:muito\s+)?(?:cedo|tarde|problema|longe)|complica|importa|precisa(?:\s+[a-z]+)?|se\s+preocup[a-z]*|(?:vou\s+)?esquec[a-z]*|(?:vou\s+)?faltar[a-z]*|(?:(?:vou|vai|to|estou)\s+)?(?:posso|poderei|poderia|consigo|conseguiria|da|dar)\s+${NOT_SLOT_COMPLEMENT}[a-z]*)\b`,
  'g',
);
// Ressalva / adiamento ("ok, mas…", "vou pensar", "depois vejo", "talvez", "só a partir de…").
const PATIENT_HESITATION_RE =
  /\b(?:mas|porem|so\s+que|antes|depois|talvez|acho\s+que|sera|a\s+partir|vou\s+(?:pensar|ver|analisar|avaliar|confirmar|falar|consultar|me\s+organizar))\b/;
// Motivo ("porque trabalho às 10", "pois saio às 18h"): contexto, não o horário escolhido.
// ("pois é, pode ser" é só interjeição.)
const REASON_CLAUSE_RE = /\s*\b(?:porque|pq|por\s*que|pois(?!\s+(?:e|eh|sim|nao)\b)|ja\s+que|visto\s+que)\b[^.!?\n]*/g;
// "De acordo" PURO não tem prazo/data/ordinal ("consigo só a partir de 1º de novembro",
// "pode ser, mês que vem").
const PURE_BLOCK_RE = new RegExp(
  String.raw`\d|[ºª°]|\b(?:a\s+partir|so\s+(?:a|no|na|em|de|do|da|dia|semana|mes|ano|quando|se)|semana|mes|meses|ano|anos|proxim\w*|depois|antes|quando|primeir\w*|segund\w*|terceir\w*|ultim\w*|${MONTH_ALT})\b`,
);
// Aceite curto ("sim", "pode ser", "ok", "fechado", "esse mesmo").
const PATIENT_ACCEPT_RE =
  /\b(?:sim|pode(?:\s+ser)?|quero|fechado|fechou|combinado|confirmo|confirmado|confirma|isso|ok(?:ay|ey|k+)?|blz|beleza|perfeito|otimo|certo|show|top|joia|bora|vamos|claro|ta\s+(?:bom|otimo|certo)|tudo\s+(?:bem|certo)|aceito|serve|da\s+(?:sim|certo)|consigo|posso|com\s+certeza|positivo|esse|essa)\b/;
// Pergunta do paciente sobre o HORÁRIO/agenda (impede o aceite): "tem às 9h?", "pode ser?".
const SLOT_QUESTION_RE =
  /\b(?:pode\s+ser|tem\s+(?:vaga|horario)|teria|horario|vaga|agenda|marc[a-z]*|agend[a-z]*|confirm[a-z]*|remarc[a-z]*|outr[oa])\b/;
// Pergunta de LOGÍSTICA que não condiciona o aceite ("sim! qual o endereço?").
const LOGISTICS_QUESTION_RE =
  /\b(?:endereco|localizacao|onde\s+(?:fica|e)|como\s+(?:chego|chegar|faco\s+(?:pra|para)\s+chegar)|estacionamento|estacionar|levar|documento|rg|cpf|carteirinha|demora|quanto\s+tempo|dura|duracao|andar|sala|jejum|acompanhante|ponto\s+de\s+referencia)\b/;
const ACK_EMOJI_RE = /[\u{1F44D}\u{2705}\u{1F44C}\u{1F91D}]/u; // 👍 ✅ 👌 🤝
const EMOJI_STRIP_RE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}]/gu;

export type Period = 'manha' | 'tarde';
// Turno citado ("de tarde", "pela manhã", "cedinho") — sem as saudações.
const periodOf = (t: string): Period | null => {
  const s = t.replace(/\b(?:boa\s+(?:tarde|noite)|bom\s+dia)\b/g, ' ');
  if (/\b(?:tarde|noite)\b/.test(s)) return 'tarde';
  if (/\b(?:manha|cedo|cedinho)\b/.test(s)) return 'manha';
  return null;
};
/** O turno (se houver) bate com o horário? */
const periodOk = (p: Period | null, slot: { time: string }): boolean =>
  !((p === 'tarde' && slot.time < '12:00') || (p === 'manha' && slot.time >= '12:00'));
// O turno APONTA uma opção da proposta ("a da tarde", "o horário da manhã", "essa da
// tarde") — vs. só preferência ("prefiro de tarde", "de tarde", "à tarde"), que pode
// querer dizer "tem outro dia à tarde?" e nunca fecha horário sozinha.
const PERIOD_PICK_RE =
  /\b(?:a|o|ess[ea]|est[ea]|aquel[ea])\s+(?:(?:opcao|horario|vaga|hora)\s+)?(?:da|de|do)\s+(?:tarde|manha|noite)\b/;
const sameSlot = (a: SlotRef, b: SlotRef) => a.date === b.date && a.time === b.time;
const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const isComplete = (m: SlotMentions) => (m.dates.size > 0 || m.weekdays.size > 0) && m.times.size > 0;
const slotPeriod = (s: { time: string }): Period => (s.time < '12:00' ? 'manha' : 'tarde');

/** Ordinal que aponta um item da NOSSA lista ("o primeiro", "a segunda opção", "o último", "opção 2"). */
interface OrdinalPick {
  /** 0-based; -1 = o último. */
  idx: number;
  /** "a segunda" (sem "opção") também pode ser o DIA — segunda-feira. */
  weekday: number | null;
}
const ORDINAL_STEMS: Record<string, number> = { primeir: 0, segund: 1, terceir: 2, quart: 3, ultim: -1 };
// [1] posse ("minha primeira vez") [2] artigo [3] radical [4] gênero [5] "-feira" (é dia)
// [6] substantivo ("opção") [7] não é item de lista ("primeira vez", "o primeiro que tiver").
const ORDINAL_WORD_RE =
  /\b(?:(minha|meu|sua|seu|nossa|nosso)\s+)?(?:([oa]|ess[ea]|est[ea]|aquel[ea])\s+)?(primeir|segund|terceir|quart|ultim)([oa])\b(?:[\s-]*(feira))?(?:\s+(opcao|horario|hora|vaga|data|alternativa))?(?:\s+(vez|vezes|consulta|avaliacao|sessao|que\s+tiver|que\s+der|disponivel|livre|vago|possivel))?/g;
// "opção 2", "alternativa 1".
const ORDINAL_OPT_NUM_RE = /\b(?:opcao|alternativa)\s*(\d)\b/g;
// "o 1º", "a 2ª", "2ª opção".
const ORDINAL_NUM_RE = /\b(\d)\s*[ºª°](?:\s*(opcao|horario|hora|vaga|data|alternativa)\b)?/g;
// Sem "opção/horário" logo depois, o ordinal só aponta item da lista se o que vem depois
// NÃO é substantivo: fim, pontuação/emoji ou palavra solta ("o segundo mesmo", "o primeiro,
// por favor", "o 1º não"). "o segundo dente", "3º ano", "2º andar", "1º semestre", "1º de
// novembro", "2º sábado", "o primeiro dia" não são escolha da lista.
const ORD_TAIL_OK_RE =
  /^(?:\s*$|\s*[^\sa-z0-9]|\s+(?:mesm[oa]|msm|ai|ae|entao|por\s+favor|pfv|pf|pls|sim|nao|nem|pode|ok|okay|serve|e|eh|ta|esta|fica|fico|vai|seria|pra|para|q|que|ja|tbm|tb|tambem|blz|beleza|show|perfeito|otimo|isso|obrigad[oa]|valeu|vlw|da\s+lista|de\s+cima)\b)/;
// Antes do ordinal NUMÉRICO sem "opção": artigo/demonstrativo ou início da oração ("o 1º",
// "a 2ª", "2ª"). "dia 1º", "no 1º", "do 2º" é data/outra coisa.
const ORD_NUM_BEFORE_OK_RE = /(?:^|[^\sa-z0-9]\s*|(?:^|\s)(?:o|a|ess[ea]|est[ea]|aquel[ea])\s+)$/;

/** Ordinais da mensagem e o texto SEM eles ("a segunda opção" não vira segunda-feira). */
function findOrdinals(t: string): { picks: OrdinalPick[]; stripped: string } {
  const picks: OrdinalPick[] = [];
  const cuts: [number, number][] = [];
  for (const m of t.matchAll(ORDINAL_WORD_RE)) {
    const [, poss, art, stem, gender, feira, noun, notItem] = m;
    if (poss || feira || notItem || (!art && !noun)) continue;
    if (!noun && !ORD_TAIL_OK_RE.test(t.slice(m.index! + m[0].length))) continue;
    // "a quarta" é quarta-feira; só "o quarto" / "a quarta opção" é ordinal.
    if (stem === 'quart' && gender === 'a' && !noun) continue;
    picks.push({ idx: ORDINAL_STEMS[stem], weekday: stem === 'segund' && gender === 'a' && !noun ? 1 : null });
    cuts.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of t.matchAll(ORDINAL_OPT_NUM_RE)) {
    const n = Number(m[1]);
    if (n < 1) continue;
    picks.push({ idx: n - 1, weekday: null });
    cuts.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of t.matchAll(ORDINAL_NUM_RE)) {
    const n = Number(m[1]);
    const noun = m[2];
    if (n < 1) continue;
    if (!noun && (!ORD_NUM_BEFORE_OK_RE.test(t.slice(0, m.index!)) || !ORD_TAIL_OK_RE.test(t.slice(m.index! + m[0].length)))) continue;
    picks.push({ idx: n - 1, weekday: null });
    cuts.push([m.index!, m.index! + m[0].length]);
  }
  let stripped = t;
  for (const [a, b] of cuts.sort((x, y) => y[0] - x[0])) stripped = `${stripped.slice(0, a)} ${stripped.slice(b)}`;
  return { picks, stripped };
}

/** Leitura da última mensagem do paciente. */
interface PatientReading {
  /** Recusa que governa o horário ("não posso", "terça não", "prefiro outro"). */
  refuses: boolean;
  /** As orações de recusa ("terca nao", "nao posso de manha"). */
  refusals: string[];
  /** Pode valer como aceite: sem recusa, negação, ressalva nem pergunta sobre o horário. */
  accepts: boolean;
  /**
   * Recusou numa oração e ESCOLHEU noutra ("terça não, quarta sim", "não posso terça, pode
   * ser quarta às 8h") — só vale contra a NOSSA proposta com data, nunca o recusado.
   */
  partial: boolean;
  /** "de acordo" PURO ("sim", "pode ser", "👍") — sem dia/hora/turno/ordinal. */
  pure: boolean;
  /** Dia/hora/turno da parte que aceita (frases sem pergunta; no `partial`, só a oração da escolha). */
  accept: SlotMentions;
  /** Idem, sem os ordinais ("a segunda opção" não é segunda-feira). */
  acceptNoOrd: SlotMentions;
  acceptPeriod: Period | null;
  /** O turno aponta UMA opção da proposta ("a da tarde") — não é só preferência. */
  acceptPeriodPick: boolean;
  /** "o primeiro", "a segunda opção", "o último" — item da nossa lista. */
  ordinals: OrdinalPick[];
  /** O que ele QUER: a mensagem sem as orações de recusa (inclui "tem quarta às 10h?"). */
  wantText: string;
  want: SlotMentions;
  wantPeriod: Period | null;
  /** Perguntou sobre o horário/agenda ("pode ser dia 1º?", "tem às 9h?") — um "Pode sim!" responde a ISSO. */
  slotQuestion: boolean;
}

const CLAUSE_SPLIT_RE = /[,.;!?\n]+|\s+(?:mas|porem|so\s+que)\s+/;

/** Tira as orações de recusa ("terça às 9h não consigo, tem quarta às 10h?" → "tem quarta as 10h"). */
function dropRefusalClauses(t: string): string {
  return t
    .split(CLAUSE_SPLIT_RE)
    .map((c) => c.trim())
    .filter((c) => c && !PATIENT_REFUSAL_RE.test(c))
    .join(', ');
}

function readPatient(text: string | null | undefined, todayStr: string): PatientReading {
  const raw = String(text || '').trim();
  // O motivo ("porque trabalho às 10") é contexto: a hora dele não é escolha nem pedido.
  const t = plain(raw).replace(REASON_CLAUSE_RE, ' ').trim();
  // Pergunta sobre o horário/agenda ("tem às 9h?", "pode ser?") impede o aceite;
  // pergunta de logística em outra frase ("sim! qual o endereço?") não.
  let blockingQuestion = false;
  let slotQuestion = false;
  const acceptParts: string[] = [];
  for (const s of t.split(/(?<=[.!?\n])/).map((x) => x.trim()).filter(Boolean)) {
    if (!s.includes('?')) {
      acceptParts.push(s);
      continue;
    }
    // A pergunta é a última oração ("sim, qual o endereço?" → "sim" + pergunta).
    const body = s.replace(/[?!.\s]+$/, '');
    const comma = body.lastIndexOf(',');
    const question = comma >= 0 ? body.slice(comma + 1) : body;
    if (comma >= 0) acceptParts.push(body.slice(0, comma));
    const aboutSlot =
      hasSlotMention(extractSlotMentions(question, todayStr)) || !!periodOf(question) || SLOT_QUESTION_RE.test(question);
    if (aboutSlot) slotQuestion = true;
    if (aboutSlot || !LOGISTICS_QUESTION_RE.test(question)) blockingQuestion = true;
  }
  const acceptText = acceptParts.join(' ');
  const refuses = PATIENT_REFUSAL_RE.test(t);
  const negates = NEGATION_RE.test(t.replace(BENIGN_NEGATION_RE, ' '));
  const accepts = !!acceptText && !blockingQuestion && !refuses && !negates && !PATIENT_HESITATION_RE.test(t);
  // Recusa numa oração + escolha noutra ("terça não, quarta sim"): a escolha é a parte
  // sem as orações de recusa — sem outra negação, ressalva ou pergunta sobre o horário.
  const rest = refuses && acceptText && !blockingQuestion ? dropRefusalClauses(acceptText) : '';
  const restOrd = rest ? findOrdinals(rest) : null;
  const partial =
    !!restOrd &&
    !NEGATION_RE.test(rest.replace(BENIGN_NEGATION_RE, ' ')) &&
    !PATIENT_HESITATION_RE.test(rest) &&
    (restOrd.picks.length > 0 || hasSlotMention(extractSlotMentions(restOrd.stripped, todayStr)) || PERIOD_PICK_RE.test(rest));
  const chosenText = partial ? rest : acceptText;
  const ord = findOrdinals(chosenText);
  const accept = extractSlotMentions(chosenText, todayStr);
  const acceptNoOrd = ord.picks.length ? extractSlotMentions(ord.stripped, todayStr) : accept;
  const acceptPeriod = periodOf(chosenText);
  const words = acceptText.replace(EMOJI_STRIP_RE, '').trim();
  const pure =
    accepts &&
    acceptText.length <= 60 &&
    !acceptPeriod &&
    !hasSlotMention(accept) &&
    !ord.picks.length &&
    !PURE_BLOCK_RE.test(words) &&
    (words ? PATIENT_ACCEPT_RE.test(words) : ACK_EMOJI_RE.test(raw));
  const wantText = refuses ? dropRefusalClauses(t) : t;
  const refusals = refuses ? t.split(CLAUSE_SPLIT_RE).map((c) => c.trim()).filter((c) => c && PATIENT_REFUSAL_RE.test(c)) : [];
  return {
    refuses,
    // "não, obrigada" casa no texto inteiro (^não,) mesmo sem oração de recusa sozinha.
    refusals: refuses && !refusals.length ? [t] : refusals,
    accepts,
    partial,
    pure,
    accept,
    acceptNoOrd,
    acceptPeriod,
    acceptPeriodPick: !!acceptPeriod && PERIOD_PICK_RE.test(chosenText),
    ordinals: ord.picks,
    wantText,
    want: extractSlotMentions(wantText, todayStr),
    wantPeriod: periodOf(wantText),
    slotQuestion,
  };
}

/**
 * O que o paciente RECUSOU (pra nunca re-oferecer): `slots` = horários recusados (da
 * nossa proposta, ou o dia+hora/turno que ele citou na recusa); `dates` = dia inteiro
 * ("terça não"); `times` = hora sem dia ("às 8h não dá"); `periods` = turno ("não posso
 * de manhã"; "8h é muito cedo" = 8h e as de antes até 1h depois). Recusa genérica ("não
 * posso", "nenhum desses") = tudo o que oferecemos. `softDates` / `softTimes` = de
 * preferência evitar (os dias da proposta recusada / do horário recusado; as horas a menos
 * de 1h da recusada) — as alternativas só caem aí se não sobrar outra.
 */
export interface RefusalInfo {
  slots: SlotRef[];
  dates: string[];
  times: string[];
  periods: Period[];
  softDates: string[];
  softTimes: string[];
}

function refusalOf(
  r: PatientReading,
  ordered: OfferItem[],
  freeDays: FreeSlotDay[],
  todayStr: string,
): RefusalInfo | null {
  if (!r.refuses) return null;
  const out: RefusalInfo = { slots: [], dates: [], times: [], periods: [], softDates: [], softTimes: [] };
  const push = <T>(list: T[], v: T) => {
    if (!list.includes(v)) list.push(v);
  };
  const addSlot = (s: SlotRef) => {
    if (!out.slots.some((x) => sameSlot(x, s))) out.slots.push({ date: s.date, time: s.time });
  };
  const offered: SlotRef[] = ordered.filter((it) => it.date).map((it) => ({ date: it.date!, time: it.time }));
  const pool: SlotRef[] = [...offered, ...freeDays.flatMap((d) => d.times.map((time) => ({ date: d.date, time })))];
  const allDates = [...new Set(pool.map((s) => s.date))];
  const allTimes = [...new Set(pool.map((s) => s.time))];
  // "não, quarta" / "não posso, pode ser o segundo": a escolha da outra oração APONTA um item
  // da proposta — o "não" solto é dos outros. "não posso, só sábado" (sábado não está na
  // proposta) continua recusando o que oferecemos.
  const partialHitsOffer =
    r.partial &&
    (r.ordinals.length > 0 ||
      ordered.some((it) =>
        it.date
          ? mentionsAgree(r.acceptNoOrd, { date: it.date, time: it.time }) && periodOk(r.acceptPeriod, it)
          : r.acceptNoOrd.dates.size === 0 &&
            r.acceptNoOrd.weekdays.size === 0 &&
            (r.acceptNoOrd.times.size === 0 || r.acceptNoOrd.times.has(it.time)) &&
            periodOk(r.acceptPeriod, it),
      ));
  for (const c of r.refusals) {
    const { picks, stripped } = findOrdinals(c);
    const listPicks = ordered.length >= 2 ? picks : [];
    for (const o of listPicks) {
      const it = ordered[o.idx < 0 ? ordered.length - 1 : o.idx];
      if (it?.date) addSlot({ date: it.date, time: it.time });
    }
    const m = extractSlotMentions(listPicks.length ? stripped : c, todayStr);
    const per = periodOf(c);
    const hasDay = m.dates.size > 0 || m.weekdays.size > 0;
    const hasTime = m.times.size > 0;
    const dayOk = (d: string) =>
      (m.dates.size === 0 || m.dates.has(d)) && (m.weekdays.size === 0 || m.weekdays.has(weekdayOf(d)));
    // "8h é muito cedo pra mim" / "muito cedo" (à nossa proposta): essa hora e as vizinhas.
    const early = TOO_EARLY_RE.test(c);
    const late = TOO_LATE_RE.test(c);
    if (early || late) {
      const refs = hasTime ? [...m.times] : offered.filter((s) => !hasDay || dayOk(s.date)).map((s) => s.time);
      if (refs.length) {
        const lim = early ? Math.max(...refs.map(minutesOf)) + 60 : Math.min(...refs.map(minutesOf)) - 60;
        for (const tm of allTimes) if (early ? minutesOf(tm) < lim : minutesOf(tm) > lim) push(out.times, tm);
        if (!hasTime) offered.filter((s) => !hasDay || dayOk(s.date)).forEach(addSlot);
        continue;
      }
    }
    if (!hasDay && !hasTime && !per) {
      if (!listPicks.length && !partialHitsOffer) {
        offered.forEach(addSlot);
        for (const s of offered) push(out.softDates, s.date);
      }
      continue;
    }
    if (hasDay && !hasTime && !per) {
      for (const d of allDates) if (dayOk(d)) push(out.dates, d);
    } else if (hasDay) {
      for (const s of pool) {
        if (dayOk(s.date) && (!hasTime || m.times.has(s.time)) && periodOk(per, s)) {
          addSlot(s);
          // "terça às 8h não": as alternativas preferem outro dia.
          if (hasTime) push(out.softDates, s.date);
        }
      }
    } else if (hasTime) {
      for (const tm of m.times) {
        push(out.times, tm);
        // "às 8h fica difícil": 8h30 também é provável que não sirva.
        for (const x of allTimes) if (x !== tm && Math.abs(minutesOf(x) - minutesOf(tm)) < 60) push(out.softTimes, x);
      }
    } else if (per) {
      push(out.periods, per);
    }
  }
  return out;
}

/** O horário cai no que o paciente recusou? `soft` = evita também os dias/horas "de preferência evitar". */
function avoids(ref: RefusalInfo | null | undefined, s: SlotRef, soft = false): boolean {
  if (!ref) return false;
  return (
    ref.slots.some((x) => sameSlot(x, s)) ||
    ref.dates.includes(s.date) ||
    ref.times.includes(s.time) ||
    ref.periods.includes(slotPeriod(s)) ||
    (soft && (ref.softDates.includes(s.date) || (ref.softTimes || []).includes(s.time)))
  );
}

/**
 * Dias livres sem o que o paciente recusou (horários, dia, hora, turno) — pras
 * alternativas depois de uma recusa (de preferência noutro dia; se não sobrar nada
 * assim, no mesmo dia). Sem recusa, devolve os dias como estão.
 */
export function withoutRefused(freeDays: FreeSlotDay[], ref: RefusalInfo | null | undefined): FreeSlotDay[] {
  if (!ref) return freeDays;
  const keep = (soft: boolean) =>
    freeDays
      .map((d) => ({ date: d.date, times: d.times.filter((time) => !avoids(ref, { date: d.date, time }, soft)) }))
      .filter((d) => d.times.length > 0);
  const strict = keep(true);
  return strict.length ? strict : keep(false);
}

/**
 * Mensagem do paciente é um "de acordo" PURO ("sim", "pode ser", "ok", "👍") — sem
 * dia/hora/turno próprio, sem pergunta sobre o horário, recusa, negação ou ressalva.
 */
export function isPureAcceptance(text: string | null | undefined, todayStr: string): boolean {
  return readPatient(text, todayStr).pure;
}

/**
 * A última mensagem do paciente ACEITA este horário (sem olhar a proposta)? Cita o
 * horário (dia/hora que batem, turno compatível) ou é um "de acordo" puro. Pergunta
 * sobre o horário ("tem terça às 9h?"), recusa, ressalva e "terça que vem" sem data = não.
 * A decisão de MARCAR usa resolvePatientChoice (que exige a proposta com data).
 */
export function patientAcceptedSlot(text: string | null | undefined, slot: SlotRef, todayStr: string): boolean {
  const r = readPatient(text, todayStr);
  if (!r.accepts || !periodOk(r.acceptPeriod, slot)) return false;
  if (hasSlotMention(r.accept)) {
    if (r.accept.relativeQualifier && !r.accept.explicitDate) return false;
    return mentionsAgree(r.accept, slot);
  }
  return r.pure;
}

export interface PatientChoice {
  /** O horário que o paciente escolheu, quando INEQUÍVOCO e livre. */
  slot: SlotRef | null;
  /** Veio da NOSSA proposta de UM só horário (aceite puro ou citando-o). */
  fromSingleOffer: boolean;
  /**
   * Horário(s) possíveis, mas NÃO inequívocos — nunca marca: 2+ → perguntar qual; 1 →
   * pedir confirmação (oferta sem DD/MM, só o turno "prefiro de tarde"…).
   */
  candidates: SlotRef[];
  /**
   * Pediu/escolheu um horário que NÃO está entre os livres (dizer que não deu) — ou só uma
   * data fora da agenda ("pode ser dia 1º?", "a partir de 1º de novembro" → `onwards`).
   */
  unavailable: RequestedSlot | null;
}

/** Próxima data (a partir de amanhã) com esse dia da semana. */
function nextWeekdayDate(wd: number, todayStr: string): string | undefined {
  for (let i = 1; i <= 7; i++) {
    const d = addDays(todayStr, i);
    if (weekdayOf(d) === wd) return d;
  }
  return undefined;
}

/** "terça" / "dia 20" citados → a data (a próxima, a partir de amanhã, pro dia da semana). */
function requestedDateOf(m: SlotMentions, todayStr: string): string | undefined {
  if (m.dates.size === 1) return [...m.dates][0];
  if (m.dates.size === 0 && m.weekdays.size === 1) return nextWeekdayDate([...m.weekdays][0], todayStr);
  return undefined;
}

/**
 * Qual horário o paciente ESCOLHEU — só quando é inequívoco:
 *  - "de acordo" puro ("sim", "ok", "👍") → só se a NOSSA última fala propôs exatamente
 *    UM horário, com data explícita (parseOffer) e nenhuma outra hora sem data;
 *  - citou dia/hora (com ou sem turno) → (o que ele disse ∩ horários da nossa proposta)
 *    reduz a UM com data explícita; sem proposta (ou fora dela), só o horário COMPLETO
 *    (dia + hora) que ele citou, casando com UM horário livre;
 *  - só o turno ("prefiro de tarde", "de tarde") é preferência: nunca fecha horário
 *    (no máximo pede confirmação) — "a da tarde" (aponta UMA opção) escolhe;
 *  - hora da proposta sem DD/MM ("tenho quarta às 9h") nunca fecha: vai pra `candidates`;
 *  - ordinal ("o primeiro", "a segunda opção", "o último") depois da nossa LISTA aponta
 *    aquele item (com data explícita → escolhe; "a segunda" com uma segunda-feira na lista
 *    é ambíguo);
 *  - recusa numa oração + escolha noutra ("terça não, quarta sim") → só a proposta com
 *    data, sem o recusado, reduzida a UM;
 *  - recusa, negação, ressalva, pergunta sobre o horário, "terça que vem" sem data → nenhum.
 * Escolhido mas não livre (ou pedido completo fora dos livres) → `unavailable`.
 */
export function resolvePatientChoice(input: {
  patientText?: string | null;
  lastOutText?: string | null;
  freeDays: FreeSlotDay[];
  todayStr: string;
}): PatientChoice {
  const { freeDays, todayStr } = input;
  const out: PatientChoice = { slot: null, fromSingleOffer: false, candidates: [], unavailable: null };
  if (!String(input.patientText || '').trim()) return out;
  const r = readPatient(input.patientText, todayStr);
  const { dated: offeredAll, undated: undatedAll, ordered } = parseOffer(input.lastOutText, todayStr);
  // O que ele recusou nunca é opção ("terça não, quarta sim" → só a quarta).
  const refused = refusalOf(r, ordered, freeDays, todayStr);
  const offered = offeredAll.filter((s) => !avoids(refused, s));
  const undated = undatedAll.filter((u) => !u.soft || !avoids(refused, { date: u.soft, time: u.time }));
  const softOf = (list: UndatedOffer[]): SlotRef[] =>
    list.filter((u) => u.soft).map((u) => ({ date: u.soft!, time: u.time }));
  const isFree = (s: SlotRef) => freeDays.some((d) => d.date === s.date && d.times.includes(s.time));
  const relative = (m: SlotMentions) => m.relativeQualifier && !m.explicitDate;
  // Nenhum inequívoco: guarda os possíveis (sem repetir) pra perguntar/pedir confirmação.
  const unsure = (list: SlotRef[]) => {
    out.candidates = list.filter((s, i) => list.findIndex((x) => sameSlot(x, s)) === i).sort(bySlot);
  };
  // Ordinal aponta item da LISTA (2+ itens; com 1 só, "o primeiro/o último" é ele).
  const listPick =
    r.ordinals.length > 0 &&
    (ordered.length >= 2 || (ordered.length === 1 && r.ordinals.every((o) => (o.idx === 0 || o.idx === -1) && o.weekday === null)));
  // Sem lista, "a segunda" é o dia; "a segunda opção" não cita dia nenhum.
  const acc = r.ordinals.length && !r.ordinals.some((o) => o.weekday !== null) ? r.acceptNoOrd : r.accept;

  if ((r.accepts || r.partial) && !relative(r.accept)) {
    if (listPick) {
      const at = (o: OrdinalPick) => ordered[o.idx < 0 ? ordered.length - 1 : o.idx];
      const picked = r.ordinals.map(at).filter((it): it is OfferItem => !!it);
      // "a segunda" com uma segunda-feira na lista: pode ser o dia → ambíguo.
      const wd = r.ordinals.filter((o) => o.weekday !== null).map((o) => o.weekday!);
      const clash = ordered.filter((it) => it.date && wd.includes(weekdayOf(it.date)) && !picked.includes(it));
      const items = [...picked, ...clash];
      // O resto do que ele disse (dia/hora/turno) tem que bater com o item.
      const m = r.acceptNoOrd;
      const fitsItem = (it: OfferItem) =>
        periodOk(r.acceptPeriod, it) &&
        (it.date
          ? mentionsAgree(m, { date: it.date, time: it.time }) && !avoids(refused, { date: it.date, time: it.time })
          : m.dates.size === 0 && m.weekdays.size === 0 && (m.times.size === 0 || m.times.has(it.time)));
      const ok = items.filter(fitsItem);
      const dated = (list: OfferItem[]) => list.filter((it) => it.date).map((it) => ({ date: it.date!, time: it.time }));
      if (ok.length === 1 && ok[0].dated && !clash.length) {
        out.slot = { date: ok[0].date!, time: ok[0].time };
        out.fromSingleOffer = ordered.length === 1;
      } else {
        unsure(dated(ok.length ? ok : items));
      }
    } else if (r.partial) {
      // Recusou uma parte e escolheu outra: só vale a NOSSA proposta com data, reduzida a UM.
      const fits = (s: SlotRef) => mentionsAgree(acc, s) && periodOk(r.acceptPeriod, s);
      const fromOffer = offered.filter(fits);
      const fromUndated = undated.filter((u) =>
        u.soft
          ? fits({ date: u.soft, time: u.time })
          : (acc.times.size === 0 || acc.times.has(u.time)) && periodOk(r.acceptPeriod, u),
      );
      if (fromOffer.length === 1 && !fromUndated.length) out.slot = fromOffer[0];
      else unsure([...fromOffer, ...softOf(fromUndated)]);
    } else {
      const citesSlot = hasSlotMention(acc);
      if (!citesSlot && !r.acceptPeriod) {
        if (r.pure && offered.length === 1 && !undated.length) {
          out.slot = offered[0];
          out.fromSingleOffer = true;
        } else if (r.pure) {
          unsure([...offered, ...softOf(undated)]);
        }
      } else {
        const fits = (s: SlotRef) => mentionsAgree(acc, s) && periodOk(r.acceptPeriod, s);
        const fromOffer = offered.filter(fits);
        // Hora oferecida sem DD/MM: com data provável, tem que bater; sem, basta a hora/turno.
        const fromUndated = undated.filter((u) =>
          u.soft
            ? fits({ date: u.soft, time: u.time })
            : (acc.times.size === 0 || acc.times.has(u.time)) && periodOk(r.acceptPeriod, u),
        );
        const possible = fromOffer.length + fromUndated.length;
        const picks = citesSlot || r.acceptPeriodPick;
        if (picks && fromOffer.length === 1 && possible === 1) {
          out.slot = fromOffer[0];
          out.fromSingleOffer = offered.length === 1 && !undated.length;
        } else if (possible > 1 || !picks) {
          unsure([...fromOffer, ...softOf(fromUndated)]);
        } else if (isComplete(acc)) {
          const m = matchMentions(acc, freeDays);
          // Bate com uma hora da proposta sem DD/MM? Só marca se a data provável dela é a mesma.
          const sameAsOffer = (s: SlotRef) => fromUndated.every((u) => u.soft === s.date && u.time === s.time);
          if (m.status === 'match' && periodOk(r.acceptPeriod, m)) {
            if (sameAsOffer(m)) out.slot = { date: m.date, time: m.time };
            else unsure([{ date: m.date, time: m.time }]);
          } else if (m.status === 'ambiguous') {
            unsure(m.candidates.filter((c) => periodOk(r.acceptPeriod, c)));
          }
        } else {
          unsure(softOf(fromUndated));
        }
      }
    }
  }
  if (out.slot && !isFree(out.slot)) {
    out.unavailable = out.slot;
    out.slot = null;
    out.fromSingleOffer = false;
  }
  // Pediu um horário COMPLETO que não está livre ("quero dia 20 às 9h", "tem quarta às 10h?").
  if (!out.slot && !out.unavailable && !out.candidates.length && isComplete(r.want) && !relative(r.want)) {
    const m = matchMentions(r.want, freeDays);
    if (m.status === 'none' && m.reason === 'nao_livre') {
      const date = requestedDateOf(r.want, todayStr);
      const time = r.want.times.size === 1 ? [...r.want.times][0] : undefined;
      out.unavailable = { ...(date ? { date } : {}), ...(time ? { time } : {}) };
    }
  }
  // Pediu uma DATA (sem hora) fora dos dias livres ("pode ser dia 1º?", "consigo só a partir
  // de 1º de novembro"): aquele dia não deu. Dia da semana que contradiz a data ("recebo dia
  // 5, pode ser sábado?") ou sem pedido não conta.
  const w = r.want;
  const onwards = FROM_DATE_RE.test(r.wantText);
  if (
    !out.slot &&
    !out.unavailable &&
    !out.candidates.length &&
    w.dates.size === 1 &&
    w.times.size === 0 &&
    !relative(w) &&
    (onwards || SCHEDULING_REQUEST_RE.test(r.wantText))
  ) {
    const [date] = [...w.dates];
    const agrees = w.weekdays.size === 0 || w.weekdays.has(weekdayOf(date));
    if (agrees && !freeDays.some((d) => d.date === date && d.times.length > 0)) {
      out.unavailable = onwards ? { date, onwards: true } : { date };
    }
  }
  return out;
}

// "a partir de 1º de novembro", "só depois do dia 1º": dali em diante, não aquele dia.
const FROM_DATE_RE = /\b(?:a\s+partir\s+d[eoa]|depois\s+d[eoa](?!\s+amanha))\b/;

// ─── Decisão da rede de segurança (13a) ─────────────────────────────────────

export type BookingNetDecision =
  /** A resposta não afirma marcação. */
  | { kind: 'no_claim' }
  /** Fala de consulta que o paciente JÁ tem — não mexe. */
  | { kind: 'existing' }
  /** Proposta com pedido de confirmação ("vou deixar agendado terça às 9h, pode ser?") — não mexe. */
  | { kind: 'offer' }
  /** Pode marcar: o paciente escolheu UM horário sem ambiguidade e a resposta diz esse mesmo. */
  | { kind: 'book'; slot: SlotRef }
  /** Afirmação falsa que NÃO pode virar consulta: troca a frase por um pedido de confirmação. */
  | {
      kind: 'correct';
      why: string;
      /** Horário(s) pra pedir confirmação (1 identificado ou até 3 possíveis); [] = oferecer livres. */
      propose: SlotRef[];
      ambiguous: boolean;
      /** Paciente já tem consulta futura (remarcação?) — resposta honesta + equipe. */
      hasExisting: boolean;
      /** Pediu um horário que NÃO está livre: dizer que aquele não deu e oferecer 2. */
      requested: RequestedSlot | null;
      /** O resto da resposta sem a afirmação falsa (e sem o que dependia dela). */
      keepText: string;
      /**
       * O paciente RECUSOU e `propose` são alternativas NOSSAS (não o que ele escolheu): o
       * texto é OFERTA ("Sem problemas! Tenho X ou Y, qual fica melhor?" — buildBookingFixText),
       * nunca "me confirma: …", que presume uma escolha que ele não fez.
       */
      offer: boolean;
      /**
       * O que ele recusou (horários, dia, hora, turno): nenhuma alternativa pode cair aí —
       * no fallback, oferecer de withoutRefused(freeDays, refused). null = não recusou.
       */
      refused: RefusalInfo | null;
    };

// O paciente PEDIU um dia/horário ("pode ser terça 13/10 às 9h?", "quero mudar pra quinta").
const SCHEDULING_REQUEST_RE =
  /\b(?:pode\s+ser|podemos|poderia|pode\s+(?:marcar|remarcar|passar|mudar|trocar)|quero|queria|gostaria|prefiro|preferia|remarc\w*|reagend\w*|mudar|muda|trocar|troca|passar|passa|tem\s+como|teria|tem\s+(?:vaga|horario)|consigo|da\s+pra|marca\w*|agenda\w*)\b/;

/** Entrada da rede 13a (assessBookingClaim). */
export interface BookingClaimInput {
  reply: string;
  freeDays: FreeSlotDay[];
  todayStr: string;
  patientText?: string | null;
  /** Nossa última fala antes da mensagem do paciente (a proposta que ele aceitou). */
  lastOutText?: string | null;
  existingStarts?: Date[];
  hint?: Partial<SlotRef> | null;
}

/**
 * HEURÍSTICA da rede 13a — decide correct/keep e QUAL horário propor. O 'book' dela
 * ainda passa pelo portão final do assessBookingClaim (modo conservador), que só deixa
 * marcar o caso estreito; o resto vira pedido de confirmação desse mesmo horário.
 * Critérios dela pra 'book' (todos):
 *  - o paciente não tem consulta (de hoje em diante / recém-atendida);
 *  - o paciente ESCOLHEU um horário sem ambiguidade (resolvePatientChoice): "sim" puro
 *    só vale se a nossa última fala propôs UM horário com data explícita; citando
 *    dia/hora/turno, (o que ele disse ∩ a proposta) tem que dar UM; sem proposta, só o
 *    horário completo que ele mesmo citou;
 *  - a resposta diz esse MESMO horário (ou não diz horário nenhum que o contradiga);
 *  - a frase da afirmação não pergunta de verdade nem pede confirmação;
 *  - é FATO ("deixei/agendei/está agendado") — intenção ("vou deixar agendado") só
 *    quando ele aceitou o horário ÚNICO que nós propusemos.
 * "Agendada pela recepção/equipe/Dra." só conta como afirmação nossa logo depois de ele
 * aceitar/escolher/pedir horário. Faltando algo: proposta pura passa; afirmação falsa vira
 * pedido de confirmação — ou OFERTA sem o recusado, ou "Não consegui X" (pedido fora da
 * agenda).
 */
function assessBookingClaimHeuristic(input: BookingClaimInput): BookingNetDecision {
  const { reply, freeDays, todayStr } = input;
  let a = analyzeBookingClaims(reply, todayStr);
  if (!a.claims.length && !a.clinicParty.length) return { kind: 'no_claim' };
  const existing = input.existingStarts || [];
  const patient = String(input.patientText || '');
  const pr = readPatient(patient, todayStr);
  const choice = resolvePatientChoice({ patientText: patient, lastOutText: input.lastOutText, freeDays, todayStr });
  if (!a.claims.length) {
    // Só "agendada pela recepção/equipe/Dra.": é a IA disfarçando a própria afirmação
    // quando o paciente ACABOU de aceitar/escolher/pedir um horário ("sim" à proposta).
    // Senão (ex.: "a moça marcou pra mim?") pode ser a recepção mesmo — não mexe.
    const justChose =
      !!choice.slot ||
      choice.candidates.length > 0 ||
      pr.pure ||
      (pr.accepts && hasSlotMention(pr.accept)) ||
      (!pr.refuses && hasSlotMention(pr.want) && SCHEDULING_REQUEST_RE.test(pr.wantText));
    if (!justChose) return { kind: 'no_claim' };
    a = analyzeBookingClaims(reply, todayStr, { clinicParty: true });
  }
  const parsedOffer = parseOffer(input.lastOutText, todayStr);
  const refused = refusalOf(pr, parsedOffer.ordered, freeDays, todayStr);
  const isFree = (s: SlotRef) => freeDays.some((d) => d.date === s.date && d.times.includes(s.time));
  const replyMentions = extractSlotMentions(reply, todayStr);
  const replyCites = hasSlotMention(replyMentions);
  // "Perfeito, agendado!" (sem dia/hora) depois de um "sim"/"pode ser" puro: o
  // horário é o da NOSSA proposta anterior (só data explícita pareada com a hora).
  const acceptedOffer =
    !input.hint && input.lastOutText && !replyCites && pr.pure ? extractOfferedSlots(input.lastOutText, todayStr) : [];

  // (1) Consulta que JÁ existe — antes de qualquer recuperação. Resposta sem dia/hora
  // fala dela, MENOS quando afirma REMARCAÇÃO ("remarquei!") ou o paciente acabou de
  // PEDIR outro dia/horário ("não vou poder dia 20, pode ser terça 13/10 às 9h?") — aí é
  // afirmação falsa de mudança: resposta honesta + equipe.
  if (existing.length) {
    const starts = existing.map(slotOf);
    const agreesExisting = (m: SlotMentions) => starts.some((s) => mentionsAgree(m, s));
    const wantCites = hasSlotMention(pr.want);
    const wantIsExisting = wantCites && agreesExisting(pr.want);
    const asksOther = wantCites && !wantIsExisting && SCHEDULING_REQUEST_RE.test(pr.wantText);
    const aboutExisting = acceptedOffer.length
      ? acceptedOffer.some((s) => isExistingAppointmentSlot(s, existing))
      : replyCites
        ? agreesExisting(replyMentions) || (!a.reschedule && wantIsExisting)
        : !a.reschedule && !asksOther;
    if (aboutExisting) return { kind: 'existing' };
  }

  // (2) Qual horário a resposta diz? A mensagem do paciente só completa com o que ele
  // QUER (sem as orações de recusa).
  let rec = recoverSlotFromText(reply, freeDays, todayStr, {
    claimText: a.claims.join('. '),
    contextText: (pr.refuses ? pr.wantText : patient) || null,
    hint: input.hint,
  });
  // A resposta não diz o horário (ou só parte dele, que bate), ou diz "terça às 8h" e há
  // duas terças livres com 8h, uma delas a que ele escolheu sem ambiguidade (proposta com
  // data): é o que ele escolheu — senão uma resposta certa virava "me confirma" em laço.
  const chosen = choice.slot;
  if (
    chosen &&
    mentionsAgree(withHint(extractSlotMentions(reply, todayStr), input.hint), chosen) &&
    ((rec.status === 'none' && rec.reason === 'sem_dia_ou_hora') ||
      (rec.status === 'ambiguous' && rec.candidates.some((c) => sameSlot(c, chosen))))
  ) {
    rec = { status: 'match', ...chosen };
  }
  const recSlot: SlotRef | null = rec.status === 'match' ? { date: rec.date, time: rec.time } : null;
  const saysChosen = !!recSlot && !!choice.slot && sameSlot(recSlot, choice.slot);

  // "Agendado pra sua filha" sem horário livre recuperável: não dá pra ter certeza de que
  // é afirmação falsa (a recepção pode ter marcado pra ela) — não reescreve.
  if (a.otherPerson && !recSlot) return { kind: 'no_claim' };

  // Remarcação ("remarquei") e marcação de outra pessoa nunca viram consulta do paciente.
  if (
    !existing.length &&
    saysChosen &&
    !a.asksConfirmation &&
    (a.firm || choice.fromSingleOffer) &&
    !a.reschedule &&
    !a.anyOtherPerson
  ) {
    return { kind: 'book', slot: recSlot! };
  }

  // (3) Proposta ("vou deixar agendado terça às 9h. Pode ser?") — não é afirmação falsa.
  if (!a.firm && (a.asksConfirmation || a.hasQuestion)) return { kind: 'offer' };

  // (4) Não marca. Pede confirmação do horário certo (ou dos possíveis).
  let requested = choice.unavailable;
  // A resposta "marcou" um horário que nem está entre os livres ("deixei sua manutenção
  // agendada para daqui a 1 mês, dia 12/11 às 9h") a quem pediu/aceitou marcar: diz que
  // AQUELE não deu ("Não consegui quinta (12/11) às 9h…") em vez de pedir confirmação
  // de outro horário como se ele tivesse escolhido.
  if (
    !requested &&
    !choice.slot &&
    !choice.candidates.length &&
    !pr.refuses &&
    rec.status === 'none' &&
    rec.reason === 'nao_livre' &&
    (pr.accepts || SCHEDULING_REQUEST_RE.test(pr.wantText))
  ) {
    const cm = withHint(extractSlotMentions(a.claims.join('. '), todayStr), input.hint);
    const date = cm.relativeQualifier && !cm.explicitDate ? undefined : requestedDateOf(cm, todayStr);
    if (date && cm.times.size === 1) requested = { date, time: [...cm.times][0] };
  }
  const why = existing.length
    ? 'paciente já tem consulta'
    : requested
      ? 'horário pedido não está livre'
      : pr.refuses && !choice.slot && !choice.candidates.length
        ? 'paciente recusou o horário proposto'
        : rec.status === 'none' && !choice.slot
          ? rec.reason
          : !choice.slot
            ? choice.candidates.length > 1
              ? `${choice.candidates.length} horários possíveis na proposta`
              : 'paciente não escolheu um horário sem ambiguidade'
            : !saysChosen
              ? 'a resposta diz um horário diferente do escolhido'
              : a.asksConfirmation
                ? 'afirmação junto com pergunta/pedido de confirmação'
                : a.reschedule
                  ? 'afirmação de remarcação sem ação'
                  : a.anyOtherPerson
                    ? 'marcação de outra pessoa'
                    : 'promessa sem ação ("vou deixar agendado")';
  let propose: SlotRef[] = [];
  let ambiguous = false;
  let offer = false;
  // Nada do que ele recusou volta como proposta.
  const allowed = (s: SlotRef) => !avoids(refused, s);
  if (choice.slot) {
    propose = [choice.slot];
  } else if (choice.candidates.length) {
    // 2+ → "é X ou Y?"; 1 (oferta sem DD/MM, só o turno) → "me confirma: pode ser X?".
    propose = choice.candidates.filter((s) => isFree(s) && allowed(s)).slice(0, 3);
    ambiguous = propose.length > 1;
  }
  if (!requested && !propose.length) {
    const wantCites = hasSlotMention(pr.want);
    const pRec = wantCites ? matchMentions(pr.want, freeDays) : null;
    const wanted = (s: SlotRef) => (!wantCites || mentionsAgree(pr.want, s)) && periodOk(pr.wantPeriod, s);
    // Recusou: o horário da resposta só vale (como o que ele pediu) se ele citou o que quer.
    const recWanted = !!recSlot && allowed(recSlot) && (!pr.refuses || wantCites) && wanted(recSlot);
    if (recWanted) {
      propose = [recSlot!];
    } else if (pRec?.status === 'match' && periodOk(pr.wantPeriod, pRec) && allowed(pRec)) {
      propose = [{ date: pRec.date, time: pRec.time }];
    } else if (pRec?.status === 'ambiguous' && pRec.candidates.some(allowed)) {
      propose = pRec.candidates.filter(allowed).slice(0, 2);
      ambiguous = propose.length > 1;
    } else if (rec.status === 'ambiguous' && !pr.refuses) {
      // Os pares que a própria resposta citou (sem o produto cartesiano dia × hora).
      const cands = rec.candidates;
      const paired = extractOfferedSlots(reply, todayStr).filter((s) => cands.some((c) => sameSlot(c, s)));
      propose = (paired.length >= 2 ? paired : cands).slice(0, 2);
      ambiguous = true;
    } else if (pr.refuses) {
      // Recusou ("não posso", "não posso de manhã"): OFERECE alternativas sem o recusado
      // (horários, dia, turno) — o horário que a IA disse primeiro, se ele não recusou;
      // o resto de preferência noutro dia.
      offer = true;
      const recOk = !!recSlot && isFree(recSlot) && allowed(recSlot) && wanted(recSlot);
      let pool = withoutRefused(freeDays, refused);
      const narrowed = pool
        .map((d) => ({ date: d.date, times: d.times.filter((time) => wanted({ date: d.date, time })) }))
        .filter((d) => d.times.length > 0);
      if (narrowed.length) pool = narrowed;
      // Duas opções que de fato diferem: outro dia, ou 1h+ de distância no mesmo dia.
      const apart = (x: SlotRef, y: SlotRef) => x.date !== y.date || Math.abs(minutesOf(x.time) - minutesOf(y.time)) >= 60;
      // Recusou UM item da nossa lista ("terça às 8h não"): os outros itens dela vêm primeiro.
      const restOffered = parsedOffer.dated.filter(
        (s) => isFree(s) && allowed(s) && wanted(s) && !(recOk && sameSlot(s, recSlot!)),
      );
      const fillers = [...restOffered, ...alternativeCandidates(pool, recOk ? recSlot : null)];
      propose = recOk ? [recSlot!] : [];
      const next = (ok: (f: SlotRef) => boolean) => fillers.find((f) => !propose.some((p) => sameSlot(p, f)) && ok(f));
      while (propose.length < 2) {
        const f =
          next((f) => propose.every((p) => p.date !== f.date)) ??
          next((f) => propose.every((p) => apart(p, f))) ??
          next(() => true);
        if (!f) break;
        propose.push(f);
      }
    }
  }
  return {
    kind: 'correct',
    why,
    propose,
    ambiguous,
    hasExisting: existing.length > 0,
    requested,
    // "Pode sim!" que respondia a "pode ser dia 1º?" cai junto com a afirmação.
    keepText: stripBookingClaimText(reply, todayStr, { dropBareYes: pr.slotQuestion }),
    offer,
    refused,
  };
}

// ─── Portão FINAL da rede 13a: MODO CONSERVADOR na marcação ──────────────────
//
// Decisão do dono do produto (out/2026): a heurística acima passou por 4 rodadas e
// cada uma criou regressão ALTA — marcar horário que o paciente NÃO escolheu ("minha
// filha tá no 3º ano" virou a 3ª opção da lista). Marcar errado é muito pior que pedir
// "me confirma" uma vez a mais. A heurística continua decidindo correct/keep e QUAL
// horário propor, mas a rede só devolve 'book' no caso ESTREITO, auditável lendo:
//  (a) a NOSSA última fala ofereceu exatamente UM horário: uma data DD/MM e uma hora,
//      nenhuma outra data/dia/hora; ela PEDE a confirmação dele (pelo menos uma pergunta
//      — "pode ser?", "fica bom pra você?" — junto ou depois da oferta; "Oi, tudo bem?"
//      antes não conta) e toda pergunta dela é sobre ESSE horário, sem "ou", e não pede
//      outra coisa antes ("me avisa", "vou ver com a Dra.") — senão o "sim"/"ok" pode ser
//      pra outra coisa (ciência, saudação);
//  (b) a última mensagem dele é um "sim" PURO e curto da lista fechada (isStrictYes);
//  (c) a afirmação da IA cita esse mesmo horário ou nenhum (e a resposta não cita outro);
//  (d) sem consulta futura e não é remarcação;
//  + o básico: afirmação sem pergunta de verdade, do próprio paciente, horário livre.
// Fora disso, o 'book' vira 'correct' propondo o MESMO horário ("Pra eu deixar certinho
// na agenda, me confirma: pode ser terça (13/10) às 8h?") — e o "sim" a essa pergunta
// já cai no caso estreito. E o contrário: 'correct' da heurística que É o caso estreito
// ("uhum", "tá", "ss"…) vira 'book'. NÃO afrouxe isto com heurística: amplie a lista fechada.
// Exemplos que NÃO marcam mais (viram "me confirma"): "o primeiro", "a da tarde", "quinta
// às 8 tá ótimo", "terça não, quarta sim", "sim, pelo convênio", "pode ser terça 8h.
// quanto custa?", "quero sim" a "quer que eu veja um horário?".

// (b) "Sim" puro — lista FECHADA. Variações: maiúscula, pontuação, emoji, letra repetida
// ("simmm", "siiim"), combinações ("pode sim", "sim, pode", "sim sim").
const STRICT_YES_TOKEN = String.raw`(?:s+|s+i+m+|pode(?:\s+(?:ser|marcar|agendar|confirmar))?|ok+|okay|okey|beleza|blz|fechado|combinado|confirmo|confirmado|perfeito|otimo|isso(?:\s+mesmo)?|u+h+u+m+|a+h+a+m+|ta(?:\s+bom)?)`;
// Cortesia que não muda o sentido ("sim, obrigada", "sim senhora", "Bom dia! Pode ser") —
// nunca sozinha.
const STRICT_YES_COURTESY = String.raw`(?:obrigad[oa]|brigad[oa]|obg|por\s+favor|pfv|senhora|senhor|bom\s+dia|boa\s+(?:tarde|noite)|oi|ola)`;
const STRICT_YES_RE = new RegExp(
  String.raw`^(?:${STRICT_YES_TOKEN}|${STRICT_YES_COURTESY})(?:\s+(?:${STRICT_YES_TOKEN}|${STRICT_YES_COURTESY}))*$`,
);
const STRICT_YES_COURTESY_G = new RegExp(String.raw`\b${STRICT_YES_COURTESY}\b`, 'g');
const STRICT_YES_EMOJI_RE = /[\u{1F44D}\u{1F44C}\u{2705}]/u; // 👍 👌 ✅

/**
 * A mensagem é um "sim" PURO e curto da lista fechada ("sim", "s", "ss", "simmm", "pode
 * ser", "pode", "pode marcar", "ok", "beleza", "blz", "fechado", "combinado", "confirmo",
 * "confirmado", "perfeito", "ótimo", "isso (mesmo)", "uhum", "aham", "tá (bom)", 👍 👌 ✅)?
 * Nada fora da lista (só cortesia/saudação junto): sem dígito, data, pergunta, "não"/"nem",
 * no máximo 5 palavras.
 */
export function isStrictYes(text: string | null | undefined): boolean {
  const raw = String(text || '').trim();
  if (!raw || /\d|\?/.test(raw)) return false;
  const ackEmoji = STRICT_YES_EMOJI_RE.test(raw);
  const t = plain(raw)
    .replace(EMOJI_STRIP_RE, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return ackEmoji;
  if (t.split(' ').length > 5 || !STRICT_YES_RE.test(t)) return false;
  // Só cortesia ("obrigada") não é "sim" — a não ser com 👍.
  return ackEmoji || t.replace(STRICT_YES_COURTESY_G, ' ').trim().length > 0;
}

// (a) Pergunta da nossa fala que só pede o "sim" pro horário. Lista fechada.
const SLOT_CONFIRM_QUESTION_RE = new RegExp(
  String.raw`^(?:(?:e|entao)\s+)?(?:` +
    [
      String.raw`pode\s+ser`,
      String.raw`posso\s+(?:marcar|agendar|confirmar|reservar|deixar(?:\s+(?:marcado|agendado|reservado|confirmado))?)`,
      String.raw`podemos\s+(?:marcar|agendar|confirmar)`,
      String.raw`(?:fica|ficaria)\s+(?:bom|otimo)`,
      String.raw`(?:te\s+)?(?:serve|atende)`,
      String.raw`da\s+certo`,
      String.raw`tudo\s+(?:bem|certo)`,
      String.raw`combinado|fechado|ok|confirma`,
      String.raw`vamos\s+(?:marcar|agendar|deixar\s+(?:marcado|agendado))`,
      String.raw`quer\s+(?:marcar|agendar|confirmar)`,
      String.raw`quer\s+que\s+eu\s+(?:marque|agende|reserve|confirme|deixe\s+(?:marcado|agendado|reservado))`,
      String.raw`(?:o\s+)?que\s+(?:acha|tal)`,
      String.raw`consegue(?:\s+vir)?`,
    ].join('|') +
    String.raw`)(?:\s+(?:sua|a)\s+(?:avaliacao|consulta|limpeza|manutencao))?(?:\s+(?:pra|para)\s+(?:voce|vc|mim|a\s+senhora|o\s+senhor))?(?:\s+(?:entao|assim))?$`,
);
// Vocativo no fim da pergunta ("…, pode ser, Maria?"): 1–2 palavras com maiúscula.
const VOCATIVE_RE = /^(?:\p{Lu}[\p{L}.]*\s*){1,2}$/u;
const DDMM_RE = /\b\d{1,2}\/\d{1,2}\b/;

/** Tudo o que foi citado (data, dia da semana, hora) é ESTE horário — nada de outro. */
function citesOnly(m: SlotMentions, slot: SlotRef): boolean {
  return (
    !m.relativeQualifier &&
    [...m.dates].every((d) => d === slot.date) &&
    [...m.weekdays].every((w) => w === weekdayOf(slot.date)) &&
    [...m.times].every((t) => t === slot.time)
  );
}

// A nossa fala pede OUTRA coisa antes do "sim" ("fala com seu marido e me avisa", "vou
// ver com a Dra. e te aviso", "pensa com calma"): o "ok"/"beleza" seguinte é ciência, não aceite.
const DEFER_RE = new RegExp(
  String.raw`\b(?:` +
    [
      String.raw`me\s+(?:avis[ae]|fal[ae]|diz|diga|respond[ae]|retorn[ae]|d[ae]\s+(?:um|uma)\s+(?:retorno|resposta|toque))`,
      String.raw`te\s+(?:aviso|retorno|chamo|falo|confirmo|digo|dou\s+(?:um|uma)\s+(?:retorno|resposta))`,
      String.raw`vou\s+(?:ver|verificar|checar|consultar|confirmar|falar|conversar|perguntar)`,
      String.raw`(?:fala|fale|conversa|converse|ve|veja|verifica|verifique|confere|confira|consulta|consulte)\s+com`,
      String.raw`pergunt[ae]\s+(?:pr[ao]|para|ao|a)\b`,
      String.raw`pens[ae]\b|pensar\b|com\s+calma`,
      String.raw`quando\s+(?:puder|souber|decidir)`,
    ].join('|') +
    String.raw`)`,
);

/**
 * (a) A nossa fala PEDE a confirmação deste horário: pelo menos UMA pergunta sobre ele
 * (cita só ele, ou é "pode ser?"… da lista fechada) que traz o horário ou vem DEPOIS
 * dele — "Oi, tudo bem?" antes da oferta é saudação e não conta — e toda pergunta é
 * sobre ele, sem "ou". Sem pergunta ("Tenho terça (13/10) às 8h. Me avisa se der
 * certo.") o "ok" é ciência: 'none'.
 */
function slotConfirmQuestion(text: string, slot: SlotRef, todayStr: string): 'ok' | 'other' | 'none' {
  const slotPos = text.search(DDMM_RE);
  let asked = false;
  for (const p of splitSentences(text)) {
    if (!p.isQuestion) continue;
    if (/\bou\b/.test(p.body)) return 'other';
    // A pergunta é a última oração ("Tenho terça (13/10) às 8h, pode ser?" → "pode ser").
    const clauses = text
      .slice(p.start, p.end)
      .split(/[;\u2013\u2014]|[,:](?!\d)/) // travessão corta; "08:00" e "150,00" não
      .map((c) => c.replace(/[?!.\s]+$/, '').trim())
      .filter(Boolean);
    if (clauses.length > 1 && VOCATIVE_RE.test(clauses[clauses.length - 1])) clauses.pop();
    const q = plain(clauses[clauses.length - 1] || '');
    const m = extractSlotMentions(q, todayStr);
    if (hasSlotMention(m) ? !citesOnly(m, slot) : !SLOT_CONFIRM_QUESTION_RE.test(q)) return 'other';
    if (slotPos >= 0 && p.end > slotPos) asked = true;
  }
  return asked ? 'ok' : 'none';
}

/** Por que o 'book' NÃO é o caso estreito (null = é: pode marcar). */
function strictBookingBlocker(input: BookingClaimInput, slot: SlotRef): string | null {
  const { todayStr } = input;
  // (a) A nossa última fala: UM horário, data DD/MM + hora, nada mais.
  const out = String(input.lastOutText || '');
  const om = extractSlotMentions(out, todayStr);
  const offer = parseOffer(out, todayStr);
  if (
    !DDMM_RE.test(out) ||
    om.dates.size !== 1 ||
    om.times.size !== 1 ||
    !citesOnly(om, slot) ||
    offer.dated.length !== 1 ||
    offer.undated.length !== 0 ||
    !sameSlot(offer.dated[0], slot)
  ) {
    return 'a nossa última fala não ofereceu exatamente este horário (um só, com DD/MM)';
  }
  const asked = slotConfirmQuestion(out, slot, todayStr);
  if (asked === 'other') return 'a nossa última fala pergunta outra coisa';
  if (asked === 'none') return 'a nossa última fala não pediu confirmação deste horário';
  if (DEFER_RE.test(plain(out))) return 'a nossa última fala pede outra coisa antes (me avisa / vou ver / fala com…)';
  // (b) "Sim" puro, lista fechada.
  if (!isStrictYes(input.patientText)) return 'a mensagem do paciente não é um "sim" puro';
  // (c) A afirmação cita este horário ou nenhum; a resposta não cita outro dia/hora.
  const a = analyzeBookingClaims(input.reply, todayStr, { clinicParty: true });
  const replyM = withHint(extractSlotMentions(input.reply, todayStr), input.hint);
  if (
    !citesOnly(extractSlotMentions(a.claims.join('. '), todayStr), slot) ||
    replyM.relativeQualifier ||
    !mentionsAgree(replyM, slot) ||
    (input.hint?.date && input.hint.date !== slot.date) ||
    (input.hint?.time && input.hint.time !== slot.time)
  ) {
    return 'a resposta cita outro horário';
  }
  // (d) Sem consulta futura, sem remarcação.
  if ((input.existingStarts || []).length) return 'paciente já tem consulta';
  if (a.reschedule) return 'afirmação de remarcação';
  // E o básico: afirmação sem pergunta de verdade, do próprio paciente, horário livre.
  if (a.asksConfirmation || a.anyOtherPerson) return 'afirmação com pergunta ou de outra pessoa';
  if (!input.freeDays.some((d) => d.date === slot.date && d.times.includes(slot.time))) return 'horário não está livre';
  return null;
}

/**
 * Rede de segurança "disse que agendou sem confirm_slot" — decisão PURA (o
 * ai.processor busca as consultas e executa). É a 2ª linha (a 1ª é o contrato do
 * prompt). A heurística (assessBookingClaimHeuristic) decide no_claim / existing /
 * offer / correct e o horário; o portão FINAL abaixo (modo conservador) faz 'book' sair
 * SÓ no caso estreito (strictBookingBlocker):
 *  - 'book' da heurística fora dele → 'correct' pedindo a confirmação desse horário;
 *  - 'correct' da heurística que É o caso estreito → 'book' (ex.: "uhum", "tá", "ss",
 *    "simmm" — da lista fechada, mas ela não lê como aceite: sem isso o paciente ficava
 *    num laço de "me confirma" e ainda recebia horário que não propusemos).
 */
export function assessBookingClaim(input: BookingClaimInput): BookingNetDecision {
  const d = assessBookingClaimHeuristic(input);
  if (d.kind === 'correct') {
    const offered = parseOffer(input.lastOutText, input.todayStr).dated;
    if (offered.length === 1 && !strictBookingBlocker(input, offered[0])) return { kind: 'book', slot: offered[0] };
    return d;
  }
  if (d.kind !== 'book') return d;
  const blocker = strictBookingBlocker(input, d.slot);
  if (!blocker) return d;
  const { reply, freeDays, todayStr } = input;
  const pr = readPatient(input.patientText, todayStr);
  return {
    kind: 'correct',
    why: `modo conservador: ${blocker}`,
    propose: [d.slot],
    ambiguous: false,
    hasExisting: (input.existingStarts || []).length > 0,
    requested: null,
    keepText: stripBookingClaimText(reply, todayStr, { dropBareYes: pr.slotQuestion }),
    offer: false,
    refused: refusalOf(pr, parseOffer(input.lastOutText, todayStr).ordered, freeDays, todayStr),
  };
}

// Frases que só fazem sentido com a consulta marcada (lembrete, "te espero", despedida,
// "te mando a localização", "já está tudo certo", "é só comparecer", "chegar 10 minutinhos
// antes", "já está na agenda", "pode ficar tranquila"). "O endereço é Rua X" (o que ele
// perguntou) NÃO entra.
const BOOKING_FOLLOWUP_RE =
  /\b(?:lembr\w*|confirmac\w*|te\s+esper\w*|te\s+aguard\w*|te\s+receb\w*|te\s+ver|ate\s+la|nos\s+vemos|ate\s+(?:amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|breve|mais)|qualquer\s+(?:duvida|coisa)|a\s+disposicao|me\s+chama|chegar\s+com|antecedencia|(?:mando|envio|passo|mandarei|enviarei|vou\s+(?:te\s+)?(?:mandar|enviar|passar))\s+(?:pra\s+voce\s+|para\s+voce\s+)?(?:o\s+|a\s+)?(?:endereco|localizacao|mapa|link)|tudo\s+(?:certo|certinho|ok|pronto|organizado|resolvido)|(?:e|eh)\s+so\s+(?:comparecer|chegar|vir|aparecer|vir\s+aqui)|chegar\s+(?:uns\s+|com\s+)?(?:\d+|dez|quinze|cinco)\s+min\w*\s+antes|(?:ja\s+)?(?:esta|ta|estara)\s+(?:tudo\s+)?na\s+agenda|(?:pode\s+)?fic(?:ar|a)\s+tranquil\w*)\b/;
// Frase que é só "sim" ("Pode sim!", "Consigo sim", "Claro que pode!"): responde à
// pergunta do paciente — se ele perguntou do HORÁRIO, cai junto com a afirmação falsa.
const BARE_YES_RE =
  /^(?:claro\s+que\s+)?(?:pode|posso|podemos|consigo|conseguimos|da|tem|temos|claro|com\s+certeza|sim)(?:\s+ser)?(?:\s+(?:sim|que\s+sim|pode|claro))?$/;
// Interjeição de "deu certo" ("Perfeito!", "Prontinho, Ana!"): sozinha, cai junto com a afirmação.
const CELEBRATE_WORDS =
  '(?:otima|excelente|boa)\\s+escolha|pronto|prontinho|perfeit[oa]|otim[oa]|certo|certinho|combinado|feito|fechado|anotado|maravilh[oa]|que\\s+maravilha|show(?:\\s+de\\s+bola)?|top|massa|beleza|que\\s+bom|que\\s+otimo|oba|legal|excelente|isso|tudo\\s+(?:certo|certinho|ok)|ok|obrigad[oa]';
// Acolhimento ("Sem problemas!", "Claro!", "Bom dia!"): sozinho não é conteúdo, mas fica
// na frente do que sobrar ("Sem problemas! Cancelei sua consulta anterior.").
const SOFT_ACK_WORDS =
  'sem\\s+problemas?|tudo\\s+bem|claro|entendi|entendo|poxa|que\\s+pena|imagina|tranquilo|ah|oi|ola|bom\\s+dia|boa\\s+(?:tarde|noite)|sim|com\\s+certeza|perfeitamente';
const LEADING_ACK_RE = new RegExp(`^(?:[^a-z0-9]*(${CELEBRATE_WORDS}|${SOFT_ACK_WORDS})\\b)+`);
const CELEBRATE_RE = new RegExp(`^(?:${CELEBRATE_WORDS})$`);
// Palavras que sozinhas não fazem conteúdo depois da interjeição ("Combinado então!").
const FILLER_WORDS = new Set(['entao', 'mesmo', 'viu', 'ta', 'tah', 'bem', 'ai', 'ne', 'la', 'aqui', 'agora', 'ja', 'tudo', 'isso', 'ok', 'sim', 'muito', 'demais', 'hein']);
// Horário de funcionamento ("Abrimos às 8h e fechamos às 18h") é informação, não o horário marcado.
const OPENING_HOURS_RE =
  /\b(?:abr(?:e|em|imos|indo)|fech(?:a|am|amos)|funciona\w*|atend(?:e|em|emos)|expediente|aberto|aberta|horario\s+de\s+(?:funcionamento|atendimento))\b/;

/**
 * A frase é só interjeição/acolhimento (+ vocativo: "Perfeito, Ana!", "Sem problemas,
 * Maria!")? 'celebrate' = cai sempre; 'soft' = só fica se sobrar conteúdo; null = tem
 * conteúdo ("Sim, aceitamos cartão.", "Claro, a avaliação é gratuita.").
 */
function ackOnly(orig: string): 'celebrate' | 'soft' | null {
  const deacc = orig.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(EMOJI_STRIP_RE, ' ');
  const m = deacc.toLowerCase().match(LEADING_ACK_RE);
  if (!m) return null;
  const rest = deacc
    .slice(m[0].length)
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => /[A-Za-z]{2,}/.test(w) && !FILLER_WORDS.has(w.toLowerCase()));
  // Sobrou só nome próprio (maiúscula) = vocativo.
  if (rest.some((w) => !/^[A-Z]/.test(w))) return null;
  const first = m[0].toLowerCase().replace(/^[^a-z0-9]+/, '').match(new RegExp(`^(?:${CELEBRATE_WORDS}|${SOFT_ACK_WORDS})`))![0];
  return CELEBRATE_RE.test(first) ? 'celebrate' : 'soft';
}

/**
 * O resto da resposta sem a afirmação falsa: tira a(s) frase(s) de "agendei", as que
 * dependem dela (lembrete, "te espero", dia/hora repetidos), perguntas e interjeições
 * soltas ("Perfeito, Ana!"). Fica TODA frase informativa, mesmo curta — a resposta à
 * pergunta dele ("A avaliação é gratuita.", "Sim, aceitamos cartão.", "Abrimos às 8h e
 * fechamos às 18h.", "O endereço é Rua X, 123.") — e o acolhimento na frente dela ("Sem
 * problemas! …"). Sem nenhuma frase informativa → ''. `dropBareYes`: o paciente perguntou
 * do horário ("pode ser dia 1º?") e o "Pode sim!" respondia a isso — cai também.
 */
export function stripBookingClaimText(
  text: string | null | undefined,
  todayStr: string,
  opts: { dropBareYes?: boolean } = {},
): string {
  const src = String(text || '');
  const parts = splitSentences(src);
  const kinds = parts.map((p): 'drop' | 'soft' | 'info' => {
    // Número conta ("O valor é R$ 150.").
    const words = p.body.split(/\s+/).filter((w) => /[a-z]{2,}|\d/.test(w));
    // Sem pontuação, emoji e vocativo ("Pode sim, Maria!" → "pode sim").
    const bare = src
      .slice(p.start, p.end)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(EMOJI_STRIP_RE, ' ')
      .split(/[^A-Za-z0-9]+/)
      .filter((w, i) => w && (i === 0 || !/^[A-Z]/.test(w)))
      .join(' ')
      .toLowerCase();
    if (
      words.length < 2 ||
      p.isQuestion ||
      !!sentenceClaim(p.body, p.isQuestion, todayStr) ||
      BOOKING_FOLLOWUP_RE.test(p.body) ||
      CONFIRM_REQUEST_RE.test(p.body) ||
      (opts.dropBareYes && BARE_YES_RE.test(bare))
    ) {
      return 'drop';
    }
    // Dia/hora repetidos ("Terça (13/10) às 9h com a Dra. X.") caem; horário de
    // funcionamento ("Abrimos às 8h…", "de segunda a sexta, das 8h às 18h") fica.
    const m = extractSlotMentions(p.body, todayStr);
    if (hasSlotMention(m)) {
      const days = m.dates.size + m.weekdays.size > 0;
      const opening = OPENING_HOURS_RE.test(p.body) && (!days || timeTokens(p.body).length >= 2);
      if (!opening) return 'drop';
    }
    const ack = ackOnly(src.slice(p.start, p.end));
    return ack === 'celebrate' ? 'drop' : ack === 'soft' ? 'soft' : 'info';
  });
  if (!kinds.includes('info')) return '';
  let out = src;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (kinds[i] === 'drop') out = out.slice(0, parts[i].start) + out.slice(parts[i].end);
  }
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/^[ \t]+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[\s.!?,;:]+/, '')
    .trim();
}

// ─── Curadoria de horários ───────────────────────────────────────────────────

/**
 * PROPOSTA SUGERIDA: o horário mais cedo de cada um dos 2 dias mais próximos +
 * 1 horário da TARDE (do dia mais próximo que tiver) — antes o 3º era sempre o 2º
 * horário da manhã e a tarde nunca aparecia. Sem tarde, o 2º horário do dia mais
 * próximo. Máx. 2 por dia; ordem cronológica.
 */
export function pickSuggestedSlots(days: FreeSlotDay[]): SlotRef[] {
  const near = days.filter((d) => d.times.length > 0).slice(0, 2);
  const out: SlotRef[] = near.map((d) => ({ date: d.date, time: d.times[0] }));
  const taken = (date: string, time: string) => out.some((s) => s.date === date && s.time === time);
  const perDay = (date: string) => out.filter((s) => s.date === date).length;
  if (out.length < 3) {
    for (const d of near) {
      const aft = d.times.find((t) => t >= '12:00' && !taken(d.date, t));
      if (aft && perDay(d.date) < 2) {
        out.push({ date: d.date, time: aft });
        break;
      }
    }
  }
  if (out.length < 3) {
    for (const d of near) {
      const next = d.times.find((t) => !taken(d.date, t));
      if (next && perDay(d.date) < 2) {
        out.push({ date: d.date, time: next });
        break;
      }
    }
  }
  return out.sort(bySlot);
}

// ─── Sábado / fim de semana ──────────────────────────────────────────────────

const WEEKEND_TERM = String.raw`(?:sabados?|(?:fim|fins|final|finais)\s+de\s+semana|fds)`;
const WEEKEND_TERM_RE = new RegExp(String.raw`\b${WEEKEND_TERM}\b`);
// Sábado é o dia que ele NÃO pode/já passou: "sábado eu trabalho", "trabalho de segunda a
// sábado", "fim de semana passado tive dor".
const WEEKEND_OTHER_RE = new RegExp(
  String.raw`\b(?:segunda|seg)\s+a\s+sabado\b|\btrabalh\w*\b[^.!?\n]{0,25}\b${WEEKEND_TERM}\b|\b${WEEKEND_TERM}\b[^.!?\n]{0,20}\btrabalh\w*|\b${WEEKEND_TERM}\s+(?:passad|retrasad)\w*|\bultimos?\s+${WEEKEND_TERM}\b`,
);
// "sábado não", "não posso no sábado", "menos sábado", "nem no fim de semana".
const WEEKEND_NEG_RE = new RegExp(
  String.raw`\b${WEEKEND_TERM}\s+(?:eu\s+)?(?:nao|nunca|jamais|nem)\b|\b(?:nao|nem|nunca|menos|exceto|tirando)\s+(?:(?:posso|consigo|da|rola|vou|tenho)\s+)?(?:(?:no|na|nos|nas|aos?|de|em|o|um)\s+)?${WEEKEND_TERM}\b`,
);
// "durante a semana não consigo", "dia de semana não dá", "não posso em dia útil".
const WEEKDAYS_NO_RE =
  /\b(?:durante\s+a\s+semana|dias?\s+(?:de\s+semana|uteis|util)|de\s+segunda\s+a\s+sexta)\b[^.!?\n]{0,15}\b(?:nao|nunca|impossivel|complicado|dificil)\b|\bnao\s+(?:posso|consigo|da)\s+(?:(?:em|nos?|de)\s+)?(?:durante\s+a\s+semana|dias?\s+(?:de\s+semana|uteis|util))/;
const WEEKDAY_NAME_RE = /\b(?:segunda|terca|quarta|quinta|sexta|amanha)\b/;

/**
 * A mensagem pede SÁBADO/fim de semana ("só posso final de semana", "tem sábado?",
 * "durante a semana não consigo") — e não o contrário ("sábado não posso", "sábado eu
 * trabalho", "fim de semana passado").
 */
export function wantsWeekend(text: string | null | undefined): boolean {
  const t = plain(String(text || ''));
  if (!t.trim()) return false;
  if (WEEKDAYS_NO_RE.test(t)) return true;
  if (!WEEKEND_TERM_RE.test(t)) return false;
  return !WEEKEND_OTHER_RE.test(t) && !WEEKEND_NEG_RE.test(t);
}

/**
 * As últimas mensagens do paciente (ordem cronológica) pedem fim de semana? Olha as 2
 * mais recentes, da última pra trás: "só posso final de semana" seguido de "ok" ainda
 * vale; se depois ele citou dia de semana ("pode ser terça?") ou recusou o sábado, não.
 */
export function prefersWeekend(inboundTexts: (string | null | undefined)[]): boolean {
  const recent = inboundTexts.filter((t) => String(t || '').trim()).slice(-2);
  for (let i = recent.length - 1; i >= 0; i--) {
    const t = plain(String(recent[i]));
    if (wantsWeekend(t)) return true;
    if (WEEKEND_TERM_RE.test(t) || WEEKDAY_NAME_RE.test(t)) return false;
  }
  return false;
}

/** Os próximos `n` sábados (YYYY-MM-DD) a partir de `fromDate` (incluso). */
export function upcomingSaturdays(fromDate: string, n: number): string[] {
  let d = fromDate;
  while (weekdayOf(d) !== 6) d = addDays(d, 1);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(addDays(d, 7 * i));
  return out;
}

/** Junta dias livres (sem repetir data), em ordem cronológica. */
export function mergeFreeDays(...lists: FreeSlotDay[][]): FreeSlotDay[] {
  const byDate = new Map<string, FreeSlotDay>();
  for (const list of lists) for (const d of list) if (!byDate.has(d.date)) byDate.set(d.date, d);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Até k itens espalhados uniformemente pela lista (o 1º e o último entram), na ordem. */
function evenly(list: string[], k: number): string[] {
  if (k <= 0) return [];
  if (list.length <= k) return list;
  if (k === 1) return [list[0]];
  const idx = new Set<number>();
  for (let i = 0; i < k; i++) idx.add(Math.round((i * (list.length - 1)) / (k - 1)));
  return [...idx].sort((a, b) => a - b).map((i) => list[i]);
}

/**
 * Até k horários de um turno: todos se couberem; senão todas as horas cheias (são
 * as que o paciente mais pede: "tem às 15h?") e o resto das vagas com as meias
 * horas, espalhadas. Mais de k horas cheias → k horas cheias espalhadas.
 */
function pickPeriodTimes(list: string[], k: number): string[] {
  if (list.length <= k) return list;
  const full = list.filter((t) => t.endsWith(':00'));
  if (full.length >= k) return evenly(full, k);
  const rest = list.filter((t) => !t.endsWith(':00'));
  return [...full, ...evenly(rest, k - full.length)].sort();
}

/**
 * Horários de um dia pra AGENDA COMPLETA: manhã E tarde, até `perPeriod` (6) de
 * cada, com as meias horas. Antes era `slice(0, 6)` e, com a manhã livre, a tarde
 * sumia; depois, 4 por turno só de hora cheia — e o prompt manda usar SOMENTE os
 * listados, então a IA negava horário livre ("tem às 15h?", "8h30?").
 */
export function compactDayTimes(times: string[], perPeriod = 6): string {
  const sorted = [...times].sort();
  const morning = sorted.filter((t) => t < '12:00');
  const afternoon = sorted.filter((t) => t >= '12:00');
  const parts: string[] = [];
  if (morning.length) parts.push(`manhã ${pickPeriodTimes(morning, perPeriod).join(', ')}`);
  if (afternoon.length) parts.push(`tarde ${pickPeriodTimes(afternoon, perPeriod).join(', ')}`);
  return parts.join(' / ');
}

/**
 * Horários livres na ORDEM de preferência pra substituir um que falhou: o mais
 * cedo de cada dia primeiro (dias diferentes), depois os demais; nunca o recusado.
 */
export function alternativeCandidates(freeDays: FreeSlotDay[], exclude?: SlotRef | null): SlotRef[] {
  const days = [...freeDays]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({
      date: d.date,
      times: [...d.times].sort().filter((t) => !(exclude && d.date === exclude.date && t === exclude.time)),
    }))
    .filter((d) => d.times.length > 0);
  const out: SlotRef[] = days.map((d) => ({ date: d.date, time: d.times[0] }));
  for (const d of days) for (const t of d.times.slice(1)) out.push({ date: d.date, time: t });
  return out;
}

/**
 * Até `n` horários livres pra oferecer no lugar de um que falhou: o mais cedo
 * primeiro, em dias diferentes quando houver, nunca o horário recusado.
 */
export function pickAlternativeSlots(freeDays: FreeSlotDay[], exclude?: SlotRef | null, n = 2): SlotRef[] {
  return alternativeCandidates(freeDays, exclude).slice(0, n).sort(bySlot);
}

/** Ordena cronologicamente (dia, depois hora). */
export function sortSlots(slots: SlotRef[]): SlotRef[] {
  return [...slots].sort(bySlot);
}

/** Recusa da guarda que é DESTE horário (ofereça outro) — vs. recusa que vale pra qualquer um (devedor…). */
export function isSlotSpecificRefusal(error: string | null | undefined): boolean {
  return /indisponivel|ja passou|fora dos turnos|almoco|nao atende|feriado|bloquead/.test(plain(error || ''));
}

// ─── Textos ao paciente ──────────────────────────────────────────────────────

const WEEKDAY_LABELS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/** "09:00" → "9h", "08:30" → "8h30". */
export function formatHourBR(time: string): string {
  const [h, m] = time.split(':').map(Number);
  return m ? `${h}h${pad2(m)}` : `${h}h`;
}

/** "terça (14/10) às 9h". */
export function formatSlotLabel(date: string, time: string): string {
  return `${WEEKDAY_LABELS[weekdayOf(date)]} (${date.slice(8, 10)}/${date.slice(5, 7)}) às ${formatHourBR(time)}`;
}

const labels = (slots: SlotRef[]) => slots.map((s) => formatSlotLabel(s.date, s.time));
/** "a", "a ou b", "a, b ou c". */
const orList = (o: string[]) => (o.length <= 1 ? o.join('') : `${o.slice(0, -1).join(', ')} ou ${o[o.length - 1]}`);

/** Guarda recusou o horário (ocupado/turno/feriado…): oferece 2 livres, sem prometer retorno. */
export function buildSlotTakenText(alts: SlotRef[]): string {
  const o = labels(alts);
  return o.length > 1
    ? `Esse horário não está mais livre na agenda. Tenho ${o[0]} ou ${o[1]}, qual fica melhor pra você?`
    : `Esse horário não está mais livre na agenda. Tenho ${o[0]}, pode ser?`;
}

/** Disse que agendou sem dizer QUAL horário (ou ambíguo): pede a escolha entre livres (até 3). */
export function buildConfirmChoiceText(alts: SlotRef[], ambiguous: boolean): string {
  const o = labels(alts.slice(0, 3));
  if (ambiguous && o.length > 1) return `Só pra eu deixar certinho na agenda: é ${orList(o)}?`;
  return o.length > 1
    ? `Pra eu deixar certinho na agenda, me confirma: fica melhor ${orList(o)}?`
    : `Pra eu deixar certinho na agenda, me confirma: pode ser ${o[0]}?`;
}

/**
 * O paciente pediu/escolheu um horário que NÃO está livre (fora dos dias calculados,
 * ocupado…): diz que aquele não deu e oferece até 2 livres. Sem alternativa, só o aviso.
 */
export function buildRequestedUnavailableText(requested: RequestedSlot | null | undefined, alts: SlotRef[]): string {
  let head: string;
  if (requested?.date && requested?.time) {
    head = `Não consegui ${formatSlotLabel(requested.date, requested.time)} na agenda.`;
  } else if (requested?.date) {
    // Só a data ("pode ser dia 1º?"): "Não consegui horário no domingo (01/11)." / "a
    // partir de 1º de novembro": "Não consegui horário a partir de domingo (01/11)."
    const wd = weekdayOf(requested.date);
    const d = requested.date;
    const prep = requested.onwards ? 'a partir de' : wd === 0 || wd === 6 ? 'no' : 'na';
    head = `Não consegui horário ${prep} ${WEEKDAY_LABELS[wd]} (${d.slice(8, 10)}/${d.slice(5, 7)}).`;
  } else {
    head = 'Não consegui esse horário na agenda.';
  }
  const o = labels(alts.slice(0, 2));
  if (!o.length) return head;
  return o.length > 1
    ? `${head} Tenho ${o[0]} ou ${o[1]}, qual fica melhor pra você?`
    : `${head} Tenho ${o[0]}, pode ser?`;
}

/**
 * O paciente RECUSOU ("não posso", "não posso de manhã"): OFERECE outros horários — é
 * proposta nossa, não "me confirma: …" (ele não escolheu nada). `ack=false` quando o
 * texto mantido já começa acolhendo ("Sem problemas! …").
 */
export function buildRefusalOfferText(alts: SlotRef[], ack = true): string {
  const o = labels(alts.slice(0, 3));
  const head = ack ? 'Sem problemas! ' : '';
  if (!o.length) return `${head}Me diz qual dia e horário ficam melhores pra você que eu vejo na agenda.`;
  return o.length > 1 ? `${head}Tenho ${orList(o)}, qual fica melhor?` : `${head}Tenho ${o[0]}, pode ser?`;
}

/**
 * Texto que substitui a afirmação falsa quando HÁ alternativas (`alts`, já conferidas):
 * pediu horário que não está livre → "Não consegui X. Tenho A ou B…"; recusou
 * (`decision.offer`) → oferta "Sem problemas! Tenho A ou B, qual fica melhor?"; senão
 * pedido de confirmação ("me confirma: pode ser X?" / "é X ou Y?").
 */
export function buildBookingFixText(
  decision: { requested: RequestedSlot | null; ambiguous: boolean; offer?: boolean; keepText?: string },
  alts: SlotRef[],
  altsFromClaim: boolean,
): string {
  if (decision.requested && !altsFromClaim) return buildRequestedUnavailableText(decision.requested, alts);
  if (decision.offer) return buildRefusalOfferText(alts, !ackOnlyPrefix(decision.keepText));
  return buildConfirmChoiceText(alts, altsFromClaim && decision.ambiguous);
}

/** O texto mantido já abre com acolhimento ("Sem problemas! …")? */
function ackOnlyPrefix(keepText: string | null | undefined): boolean {
  const first = splitSentences(String(keepText || ''))[0];
  return !!first && ackOnly(String(keepText).slice(first.start, first.end)) !== null;
}

/**
 * Sem como marcar agora (freio desligado, sem Orçamentista, erro, remarcação…):
 * honesto, e a equipe é alertada. SEM pergunta no fim — não é proposta que um "ok"
 * do paciente confirme (quem confirma é a recepção).
 * Passe a `decision` da rede 13a: depois de uma RECUSA (`decision.offer`, ou recusa sem
 * horário escolhido) ele não deu preferência nenhuma — o texto é "a recepção te chama com
 * outras opções", nunca "anotei sua preferência" (nem por um horário que NÓS sugerimos).
 */
export function buildHonestPreferenceText(
  slot?: SlotRef | null,
  decision?: { offer?: boolean; refused?: RefusalInfo | null; keepText?: string } | null,
): string {
  if (decision && (decision.offer || (decision.refused && !slot))) {
    const head = ackOnlyPrefix(decision.keepText) ? '' : 'Sem problemas! ';
    return `${head}Vou pedir pra recepção te chamar com outras opções de horário.`;
  }
  return slot
    ? `Deixei anotada sua preferência por ${formatSlotLabel(slot.date, slot.time)} pra recepção confirmar com você.`
    : 'Deixei anotada sua preferência de horário pra recepção confirmar com você.';
}

// ─── Nota interna da IA (alerta pra equipe) ──────────────────────────────────

/** external_message_id das notas internas que a IA grava (fora do histórico do LLM). */
export const AI_TEAM_NOTE_PREFIX = 'note_ai_';

/** Mensagem que nunca foi pro paciente (nota interna / evento de transferência). */
export function isInternalMessage(m: { type?: string | null } | null | undefined): boolean {
  const t = m?.type || '';
  return t === 'internal_note' || t === 'note' || t === 'transfer_event';
}

/**
 * Texto da NOSSA última vez de falar antes da mensagem do paciente (todos os balões
 * seguidos, sem notas internas) — a proposta de horário costuma vir num balão e o
 * "qual fica melhor?" noutro. Pula a rajada de mensagens do paciente antes.
 */
export function lastOutTurnText(
  chronological: { direction: string; type?: string | null; text?: string | null; created_at: any }[],
  beforeMs: number,
): string | null {
  const msgs = chronological.filter((m) => !isInternalMessage(m) && new Date(m.created_at).getTime() < beforeMs);
  let i = msgs.length - 1;
  while (i >= 0 && msgs[i].direction === 'in') i--;
  const parts: string[] = [];
  while (i >= 0 && msgs[i].direction === 'out') {
    if (msgs[i].text) parts.unshift(String(msgs[i].text));
    i--;
  }
  return parts.length ? parts.join('\n\n') : null;
}

/** Nota interna gravada pela própria IA (alerta pra equipe). */
export function isAiTeamNote(m: { type?: string | null; external_message_id?: string | null } | null | undefined): boolean {
  return !!m && isInternalMessage(m) && String(m.external_message_id || '').startsWith(AI_TEAM_NOTE_PREFIX);
}

/**
 * Pro SAFEGUARD v28 (cancela consulta quando a IA diz "cancelei…" SEM ação) e pra 2ª
 * tentativa: o modelo deixou de emitir ação? Uma ação que a rede 13a ZEROU (confirm_slot
 * incompleto/inválido) conta como emitida — exatamente como antes da 13a existir;
 * senão o "cancelei sua consulta anterior" mantido no texto cancelaria a consulta real.
 */
export function modelEmittedNoAction(
  current: { action?: unknown } | null | undefined,
  droppedByNet: boolean,
): boolean {
  return !current?.action && !droppedByNet;
}

// Frase que diz que a consulta foi cancelada/desmarcada ("Cancelei sua consulta anterior.").
const CANCEL_CLAIM_RE = /\b(?:cancelei|desmarquei|removi|tirei\s+(?:da|do)\s+(?:agenda|sistema)|cancelad[oa]s?|desmarcad[oa]s?)\b/;

/**
 * Tira do texto mantido pela 13a as frases de cancelamento quando a consulta NÃO vai
 * ser cancelada neste turno: a 13a não marcou o horário novo (remarcação / consulta de
 * outra pessoa → a equipe resolve), então "Cancelei sua consulta anterior" é falso — e,
 * mantido, ainda armava o SAFEGUARD v28, que cancelava a consulta REAL do paciente.
 */
export function stripCancellationClaims(text: string | null | undefined): { text: string; stripped: boolean } {
  const s = String(text || '');
  const cut = splitSentences(s).filter((p) => CANCEL_CLAIM_RE.test(p.body));
  if (!cut.length) return { text: s, stripped: false };
  let out = '';
  let pos = 0;
  for (const p of cut) {
    out += s.slice(pos, p.start);
    pos = p.end;
  }
  out += s.slice(pos);
  out = out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return { text: out, stripped: true };
}

/** Janela em que um alerta da IA pra equipe ainda está "em aberto" (a recepção está resolvendo). */
export const AI_TEAM_NOTE_OPEN_MS = 12 * 60 * 60 * 1000;

/**
 * A IA alertou a equipe nesta conversa há pouco (nota note_ai_)? Aí um confirm_slot
 * que vier depois NÃO cancela consulta anterior: o alerta pode ser justamente de
 * remarcação/consulta de outra pessoa, e a recepção está cuidando.
 */
export function hasRecentAiTeamNote(
  messages: { type?: string | null; external_message_id?: string | null; created_at: any }[] | null | undefined,
  nowMs: number = Date.now(),
  windowMs: number = AI_TEAM_NOTE_OPEN_MS,
): boolean {
  return (messages || []).some((m) => isAiTeamNote(m) && nowMs - new Date(m.created_at).getTime() < windowMs);
}

// ─── Consultas que o paciente JÁ tem (rede 13a) ──────────────────────────────

/** Consulta ativa (vai acontecer / está acontecendo). Status reais: calendar.service EVENT_STATUSES. */
export const ACTIVE_APPOINTMENT_STATUSES = ['AGENDADO', 'CONFIRMADO', 'COMPARECEU', 'EM_ATENDIMENTO'];
/** Consulta que aconteceu (chegou / em atendimento / concluída). */
export const ATTENDED_APPOINTMENT_STATUSES = ['COMPARECEU', 'EM_ATENDIMENTO', 'CONCLUIDO'];
/** Atendida há até 12h ainda conta ("seu retorno ficou marcado com a recepção"). */
export const RECENT_ATTENDED_MS = 12 * 60 * 60 * 1000;

/**
 * Filtro Prisma (status + start_at, naive) das consultas que contam como "o paciente
 * JÁ tem" na rede 13a: as ativas de HOJE em diante — inclusive as de hoje que já
 * começaram (paciente atrasado, chegando, em atendimento) — e as atendidas nas
 * últimas 12h. Antes era só start_at > agora: "sua avaliação está marcada pra hoje
 * às 9h" às 9h10 era reescrito como se fosse marcação falsa.
 */
export function existingAppointmentFilter(nowMs: number = Date.now()): {
  status: { in: string[] };
  start_at: { gte: Date };
}[] {
  const todayStart = new Date(`${maceioTodayStr(nowMs)}T00:00:00.000Z`);
  const recentFloor = new Date(maceioNowNaive(nowMs).getTime() - RECENT_ATTENDED_MS);
  return [
    { status: { in: ACTIVE_APPOINTMENT_STATUSES }, start_at: { gte: todayStart } },
    { status: { in: ATTENDED_APPOINTMENT_STATUSES }, start_at: { gte: recentFloor } },
  ];
}
