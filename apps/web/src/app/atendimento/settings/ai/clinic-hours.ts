// Perfil da IA + horários da clínica — tipos e funções PURAS usados na tela
// Ajustes › IA.
//
// Componente client NÃO pode importar '@crm/shared' (o index cria um PrismaClient),
// então o trecho abaixo é cópia de packages/shared/src/ai-profile.ts — manter igual.
// (formatTenantAddress no fim é cópia de packages/shared/src/address.util.ts.)

// ─── cópia de packages/shared/src/ai-profile.ts — manter igual ───────────────

export const AI_CHIP_PURPOSES = ['COMERCIAL', 'CLINICA', 'FINANCEIRO'] as const;
export type AiChipPurpose = (typeof AI_CHIP_PURPOSES)[number];

/** auto = espelha o jeito do paciente (mensagens curtas x textão). */
export type AiReplyLength = 'auto' | 'curta' | 'media' | 'longa';
export const AI_REPLY_LENGTHS: readonly AiReplyLength[] = ['auto', 'curta', 'media', 'longa'];

export interface AiChipProfile {
  /** Nome da assistente neste chip (ex.: "Sophia"). */
  assistantName: string;
  /** Assina o 1º balão com "*Nome:*" no WhatsApp. */
  signature: boolean;
  replyLength: AiReplyLength;
  /**
   * Segundos que a IA espera o paciente parar de escrever antes de responder
   * (debounce). null = usa o padrão global (AI_COOLDOWN_SECONDS).
   */
  responseDelaySec: number | null;
  /** Instruções extras só deste chip (texto livre do admin). */
  instructions: string;
  /**
   * Minutos até a SEGUNDA tentativa de agendamento quando o paciente encerra sem
   * agendar ("ok", "vou pensar"). 0 = desligado. Uma vez por conversa a cada 24h.
   */
  schedulingRetryMin: number;
}

export const DEFAULT_ASSISTANT_NAME = 'Sophia';

export const DEFAULT_AI_CHIP_PROFILE: AiChipProfile = {
  assistantName: DEFAULT_ASSISTANT_NAME,
  signature: true,
  replyLength: 'auto',
  responseDelaySec: null,
  instructions: '',
  schedulingRetryMin: 5,
};

/** Lê o JSON salvo (ou objeto vindo da tela) e devolve um perfil válido, com defaults. */
/** Minutos da 2ª tentativa de agendamento: ausente = 5 (padrão); 0 = desligado; máx. 120. */
function normalizeRetryMin(v: unknown): number {
  if (v === undefined || v === null || v === '') return 5;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(120, Math.max(0, n)) : 5;
}

export function normalizeAiChipProfile(raw: unknown): AiChipProfile {
  let o: any = raw;
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw);
    } catch {
      o = null;
    }
  }
  if (!o || typeof o !== 'object') return { ...DEFAULT_AI_CHIP_PROFILE };
  const name = String(o.assistantName ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const delayNum = o.responseDelaySec === null || o.responseDelaySec === '' || o.responseDelaySec === undefined
    ? null
    : Number(o.responseDelaySec);
  return {
    assistantName: name || DEFAULT_ASSISTANT_NAME,
    signature: o.signature !== false,
    replyLength: AI_REPLY_LENGTHS.includes(o.replyLength) ? o.replyLength : 'auto',
    responseDelaySec:
      delayNum === null || !Number.isFinite(delayNum) ? null : Math.min(60, Math.max(0, Math.round(delayNum))),
    instructions: String(o.instructions ?? '').trim().slice(0, 2000),
    schedulingRetryMin: normalizeRetryMin(o.schedulingRetryMin),
  };
}

// ─── Horários de atendimento da clínica ──────────────────────────────────────

export interface ClinicDayHours {
  open: string; // "HH:MM"
  close: string; // "HH:MM"
}

/** Chave = dia da semana (0=domingo … 6=sábado). null/ausente = fechado. */
export interface ClinicHours {
  days: Partial<Record<'0' | '1' | '2' | '3' | '4' | '5' | '6', ClinicDayHours | null>>;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_NAMES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

export function normalizeClinicHours(raw: unknown): ClinicHours | null {
  let o: any = raw;
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== 'object' || !o.days || typeof o.days !== 'object') return null;
  const days: ClinicHours['days'] = {};
  for (let d = 0; d <= 6; d++) {
    const v = o.days[String(d)];
    if (v && HHMM.test(String(v.open)) && HHMM.test(String(v.close)) && String(v.open) < String(v.close)) {
      days[String(d) as '0'] = { open: String(v.open), close: String(v.close) };
    }
  }
  return { days };
}

/**
 * Texto natural pra IA e pro cadastro: agrupa dias seguidos com o mesmo horário.
 * Ex.: "Segunda a sexta, das 08:00 às 18:00; sábado, das 08:00 às 12:00. Domingo fechado."
 */
export function formatClinicHours(h: ClinicHours | null | undefined): string {
  if (!h) return '';
  // Ordem de leitura: segunda → domingo.
  const order = [1, 2, 3, 4, 5, 6, 0];
  const groups: { from: number; to: number; open: string; close: string }[] = [];
  for (const d of order) {
    const v = h.days[String(d) as '0'];
    if (!v) continue;
    const last = groups[groups.length - 1];
    const prevIdx = last ? order.indexOf(last.to) : -2;
    if (last && order.indexOf(d) === prevIdx + 1 && last.open === v.open && last.close === v.close) {
      last.to = d;
    } else {
      groups.push({ from: d, to: d, open: v.open, close: v.close });
    }
  }
  if (!groups.length) return '';
  const parts = groups.map((g) => {
    const days =
      g.from === g.to
        ? DAY_NAMES[g.from]
        : order.indexOf(g.to) === order.indexOf(g.from) + 1
          ? `${DAY_NAMES[g.from]} e ${DAY_NAMES[g.to]}`
          : `${DAY_NAMES[g.from]} a ${DAY_NAMES[g.to]}`;
    return `${days}, das ${g.open} às ${g.close}`;
  });
  const closed = order.filter((d) => !h.days[String(d) as '0']).map((d) => DAY_NAMES[d]);
  let text = parts.join('; ');
  text = text.charAt(0).toUpperCase() + text.slice(1) + '.';
  if (closed.length) {
    const c = closed.length === 1 ? closed[0] : `${closed.slice(0, -1).join(', ')} e ${closed[closed.length - 1]}`;
    text += ` ${c.charAt(0).toUpperCase() + c.slice(1)}: fechado.`;
  }
  return text;
}

// ─── cópia de packages/shared/src/address.util.ts — manter igual ─────────────

export interface TenantAddressParts {
  address?: string | null;
  address_number?: string | null;
  address_complement?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  state?: string | null;
  zip_code?: string | null;
}

export function formatTenantAddress(t: TenantAddressParts | null | undefined): string {
  if (!t) return '';
  const clean = (v: unknown) => (v == null ? '' : String(v).trim());
  const rua = clean(t.address);
  const numero = clean(t.address_number);
  const compl = clean(t.address_complement);
  const bairro = clean(t.neighborhood);
  const cidade = clean(t.city);
  const uf = clean(t.state);

  let street = rua;
  if (rua && numero) street = `${rua}, ${numero}`;
  else if (numero) street = numero;
  if (compl) street = street ? `${street} — ${compl}` : compl;

  const cidadeUf = cidade && uf ? `${cidade}/${uf}` : cidade || uf;
  const tail = [bairro, cidadeUf].filter(Boolean).join(', ');

  return [street, tail].filter(Boolean).join(', ').trim();
}

// ─── Só da tela (não existe no shared) ───────────────────────────────────────

/** Resposta de GET /settings/ai-profile (PUT /settings/ai-profile/clinic devolve o mesmo formato). */
export interface AiProfileResponse {
  clinic: {
    name: string | null;
    phone: string | null;
    email: string | null;
    zip_code: string | null;
    address: string | null;
    address_number: string | null;
    address_complement: string | null;
    neighborhood: string | null;
    city: string | null;
    state: string | null;
    /** Texto livre antigo do cadastro (Tenant.business_hours). */
    business_hours: string | null;
    /** Horário estruturado (AI_CLINIC_HOURS). null = nunca salvo. */
    hours: ClinicHours | null;
    formattedAddress: string;
  };
  summary: { text: string; exists: boolean; manuallyEdited: boolean };
  chips: Partial<Record<AiChipPurpose, AiChipProfile & { enabled?: boolean }>>;
  defaults: { cooldownSeconds: number };
}

/** Mensagem de erro da API (Nest manda string ou lista) ou o texto padrão. */
export function apiErrorMessage(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (Array.isArray(msg)) return msg.join(' ');
  return typeof msg === 'string' && msg ? msg : fallback;
}

/** Sugestão quando a clínica nunca salvou horário: seg–sex 08–18, sáb 08–12. */
export const SUGGESTED_CLINIC_HOURS: ClinicHours = {
  days: {
    '1': { open: '08:00', close: '18:00' },
    '2': { open: '08:00', close: '18:00' },
    '3': { open: '08:00', close: '18:00' },
    '4': { open: '08:00', close: '18:00' },
    '5': { open: '08:00', close: '18:00' },
    '6': { open: '08:00', close: '12:00' },
  },
};

/** Linhas da tela, na ordem de leitura (segunda → domingo). */
export const WEEK_ROWS = [
  { key: '1', label: 'Segunda' },
  { key: '2', label: 'Terça' },
  { key: '3', label: 'Quarta' },
  { key: '4', label: 'Quinta' },
  { key: '5', label: 'Sexta' },
  { key: '6', label: 'Sábado' },
  { key: '0', label: 'Domingo' },
] as const;
export type WeekDayKey = (typeof WEEK_ROWS)[number]['key'];

/** Como cada tamanho de resposta aparece na tela. */
export const REPLY_LENGTH_LABELS: Record<AiReplyLength, string> = {
  auto: 'Automático',
  curta: 'Curta',
  media: 'Média',
  longa: 'Longa',
};
