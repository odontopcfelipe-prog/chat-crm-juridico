/**
 * Ajustes IA › "Conectar a IA": o que é da PLATAFORMA e o que é DA CLÍNICA.
 *
 *  - Plataforma (só o administrador do sistema grava): chaves OpenAI, Admin Key
 *    e Anthropic, modelo padrão, campos DJEN e o liga/desliga geral antigo
 *    (WHATSAPP_AI_ENABLED). Vindos de outro usuário num salvamento misto, são
 *    IGNORADOS (a tela sempre mandou esses campos junto) — nunca 403.
 *  - Clínica (por conta, ver config-da-clinica.ts): tempo de resposta padrão
 *    (AI_COOLDOWN_SECONDS) e robô de comando pelo WhatsApp (ADMIN_BOT_ENABLED).
 *
 * Funções puras.
 */
import { BadRequestException } from '@nestjs/common';

export const AI_COOLDOWN_KEY = 'AI_COOLDOWN_SECONDS';
export const ADMIN_BOT_KEY = 'ADMIN_BOT_ENABLED';

/** Padrão do código: a IA espera 8 s o paciente parar de escrever. */
export const COOLDOWN_PADRAO = 8;
/** Faixa do controle deslizante da tela. */
export const COOLDOWN_MIN = 0;
export const COOLDOWN_MAX = 60;

/** Tempo de resposta guardado (texto) → segundos; vazio ou inválido = padrão (como antes). */
export function cooldownEfetivo(raw: string | null | undefined): number {
  const n = raw ? parseInt(raw, 10) : COOLDOWN_PADRAO;
  return Number.isNaN(n) ? COOLDOWN_PADRAO : n;
}

/** Robô de comando guardado (texto) → ligado, salvo 'false' (padrão: ligado). */
export function adminBotEfetivo(raw: string | null | undefined): boolean {
  return raw !== 'false';
}

/**
 * cooldownSeconds do corpo: número arredondado e limitado a 0..60 (o que a tela
 * devolve do GET nunca é recusado). Só o que não é número dá 400.
 */
export function normalizarCooldown(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) {
    throw new BadRequestException(`Tempo de resposta inválido: use de ${COOLDOWN_MIN} a ${COOLDOWN_MAX} segundos.`);
  }
  return Math.min(COOLDOWN_MAX, Math.max(COOLDOWN_MIN, Math.round(n)));
}

export type CorpoAiConfig = {
  apiKey?: string;
  adminKey?: string;
  anthropicApiKey?: string;
  defaultModel?: string;
  djenModel?: string;
  djenPrompt?: string;
  djenNotifyTemplate?: string;
  adminBotEnabled?: boolean;
  whatsappAiEnabled?: boolean;
  cooldownSeconds?: number;
};

/** Campos da PLATAFORMA e quando cada um seria gravado (a mesma regra de antes). */
const CAMPOS_PLATAFORMA: ReadonlyArray<[keyof CorpoAiConfig, (v: unknown) => boolean]> = [
  ['apiKey', (v) => !!v],
  ['adminKey', (v) => !!v],
  ['anthropicApiKey', (v) => !!v],
  ['defaultModel', (v) => !!v],
  ['djenModel', (v) => !!v],
  ['djenPrompt', (v) => v !== undefined],
  ['djenNotifyTemplate', (v) => v !== undefined],
  ['whatsappAiEnabled', (v) => v !== undefined],
];

/** Nomes dos campos de plataforma que este corpo gravaria. */
export function camposDePlataformaEnviados(corpo: CorpoAiConfig | null | undefined): string[] {
  const c = (corpo && typeof corpo === 'object' ? corpo : {}) as Record<string, unknown>;
  return CAMPOS_PLATAFORMA.filter(([campo, grava]) => grava(c[campo])).map(([campo]) => campo);
}
