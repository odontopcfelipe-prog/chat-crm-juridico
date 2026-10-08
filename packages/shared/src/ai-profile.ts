// Perfil da IA — contrato ÚNICO entre API (grava), worker (lê no prompt/envio),
// webhook (tempo de resposta) e tela (Ajustes › IA).
//
// Tudo é POR CLÍNICA (TenantSetting), nunca global:
//   AI_PROFILE_<PURPOSE>  JSON AiChipProfile   — um por chip (COMERCIAL/CLINICA/FINANCEIRO)
//   AI_CLINIC_HOURS       JSON ClinicHours     — dias/horários de atendimento da clínica
//   AI_ENABLED_<PURPOSE>  'true' | 'false'     — liga/desliga a IA do chip (fallback: GlobalSetting)
// Nome/telefone/endereço da clínica vêm do Tenant; o resumo, do OrganizationProfile.

export const AI_CHIP_PURPOSES = ['COMERCIAL', 'CLINICA', 'FINANCEIRO'] as const;
export type AiChipPurpose = (typeof AI_CHIP_PURPOSES)[number];

export function isAiChipPurpose(v: unknown): v is AiChipPurpose {
  return typeof v === 'string' && (AI_CHIP_PURPOSES as readonly string[]).includes(v);
}

export const aiProfileKey = (purpose: AiChipPurpose) => `AI_PROFILE_${purpose}`;
export const aiEnabledKey = (purpose: AiChipPurpose) => `AI_ENABLED_${purpose}`;
export const AI_CLINIC_HOURS_KEY = 'AI_CLINIC_HOURS';

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
}

export const DEFAULT_ASSISTANT_NAME = 'Sophia';

export const DEFAULT_AI_CHIP_PROFILE: AiChipProfile = {
  assistantName: DEFAULT_ASSISTANT_NAME,
  signature: true,
  replyLength: 'auto',
  responseDelaySec: null,
  instructions: '',
};

/** Lê o JSON salvo (ou objeto vindo da tela) e devolve um perfil válido, com defaults. */
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
 * A clínica está aberta AGORA? `nowLocal` é o horário local da clínica em
 * "naive-UTC" (campos getUTC* = hora local; ex.: `new Date(Date.now() - 3*3600e3)`
 * pra Maceió). Sem grade cadastrada → null (quem chama usa a regra antiga).
 */
export function clinicStatusNow(
  h: ClinicHours | null | undefined,
  nowLocal: Date,
): { open: boolean; text: string } | null {
  if (!h || !Object.values(h.days).some(Boolean)) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const dow = nowLocal.getUTCDay();
  const hhmm = `${pad(nowLocal.getUTCHours())}:${pad(nowLocal.getUTCMinutes())}`;
  const today = h.days[String(dow) as '0'];
  const when = `${DAY_NAMES[dow]}, ${hhmm}`;
  if (today && hhmm >= today.open && hhmm < today.close) {
    return { open: true, text: `Agora (${when}) a clínica está ABERTA, até as ${today.close}.` };
  }
  // Próxima abertura: ainda hoje (antes de abrir) ou nos próximos 7 dias.
  let next = '';
  if (today && hhmm < today.open) next = `hoje, às ${today.open}`;
  for (let i = 1; !next && i <= 7; i++) {
    const d = (dow + i) % 7;
    const v = h.days[String(d) as '0'];
    if (v) next = `${i === 1 ? 'amanhã' : i === 7 ? `${DAY_NAMES[d]} que vem` : DAY_NAMES[d]}, às ${v.open}`;
  }
  return {
    open: false,
    text: `Agora (${when}) a clínica está FECHADA.${next ? ` Próximo atendimento: ${next}.` : ''} Você pode responder e agendar normalmente; só não prometa atendimento presencial agora.`,
  };
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
