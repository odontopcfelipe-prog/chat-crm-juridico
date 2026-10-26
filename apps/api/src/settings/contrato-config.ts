/**
 * Configurações > Contratos & Assinatura.
 *
 *  - Dados fixos dos contratos (dentista responsável e CRO, endereço, foro):
 *    DA CLÍNICA, em `CONTRACT_CONFIG_<conta>` (ver config-da-clinica.ts). Só os 8
 *    campos conhecidos; campo a mais, nulo ou de outro tipo é IGNORADO/convertido
 *    (a tela devolve o objeto inteiro que recebeu do GET) — nunca 400.
 *  - URL pública da API (publicApiUrl, base dos arquivos mandados ao paciente) e
 *    ClickSign: da PLATAFORMA, só o administrador do sistema grava.
 *
 * Funções puras.
 */
import { BadRequestException } from '@nestjs/common';

export const CONTRACT_CONFIG_KEY = 'CONTRACT_CONFIG';

export const CONTRACT_CONFIG_CAMPOS = [
  'advogado1_nome',
  'advogado1_oab',
  'advogado2_nome',
  'advogado2_oab',
  'escritorio_logradouro',
  'escritorio_cidade',
  'escritorio_cep',
  'foro',
] as const;
export type CampoContrato = (typeof CONTRACT_CONFIG_CAMPOS)[number];
export type DadosContrato = Record<CampoContrato, string>;

/** Tamanho máximo de cada campo (o excesso é cortado, não recusado). */
export const CONTRATO_CAMPO_MAX = 1000;

export function dadosContratoEmBranco(): DadosContrato {
  return Object.fromEntries(CONTRACT_CONFIG_CAMPOS.map((c) => [c, ''])) as DadosContrato;
}

/** Texto do campo: texto como veio (cortado no limite), número/booleano em texto, nulo vazio. */
function textoDoCampo(v: unknown): string | undefined {
  if (v === null) return '';
  if (typeof v === 'string') return v.slice(0, CONTRATO_CAMPO_MAX);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined; // objeto, lista, undefined: ignorado
}

/** Só os campos de clínica que vieram no corpo (os outros ficam como estão). */
export function escolherCamposContrato(corpo: unknown): Partial<DadosContrato> {
  const fonte = corpo && typeof corpo === 'object' ? (corpo as Record<string, unknown>) : {};
  const saida: Partial<DadosContrato> = {};
  for (const campo of CONTRACT_CONFIG_CAMPOS) {
    if (!Object.prototype.hasOwnProperty.call(fonte, campo)) continue;
    const v = textoDoCampo(fonte[campo]);
    if (v !== undefined) saida[campo] = v;
  }
  return saida;
}

/** Os 8 campos de um JSON guardado (inválido ou ausente = em branco). */
export function lerDadosContrato(raw: string | null | undefined): DadosContrato {
  const dados = dadosContratoEmBranco();
  if (!raw) return dados;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return dados;
    return { ...dados, ...escolherCamposContrato(obj) };
  } catch {
    return dados;
  }
}

/** URL pública da API aceita: vazia (volta a valer a do servidor) ou http(s) válida. */
export function urlPublicaAceita(v: string): boolean {
  if (v === '') return true;
  if (!/^https?:\/\/\S+$/i.test(v)) return false;
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}

// ─── ClickSign (plataforma) ──────────────────────────────────────────────────

/** Os dois ambientes que a tela oferece. */
export const CLICKSIGN_URLS: readonly string[] = ['https://app.clicksign.com', 'https://sandbox.clicksign.com'];

/**
 * baseUrl do ClickSign: só os dois ambientes (barra final é tolerada). Vazio =
 * manter o atual (undefined). Outro endereço: 400.
 */
export function normalizarClicksignBaseUrl(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim().replace(/\/+$/, '');
  if (s === '') return undefined;
  if (!CLICKSIGN_URLS.includes(s)) {
    throw new BadRequestException('Ambiente do ClickSign inválido: use produção ou sandbox.');
  }
  return s;
}

/** Token do ClickSign para gravar: vazio ou mascarado = manter o atual (null). */
export function tokenClicksignParaGravar(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.includes('****')) return null;
  return s;
}
