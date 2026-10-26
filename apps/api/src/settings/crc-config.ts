/**
 * Respostas rápidas do inbox (CANNED_RESPONSES) e dias de "lead parado" do CRM
 * (CRM_CONFIG): configuração DA CLÍNICA, por conta (ver config-da-clinica.ts).
 *
 * Funções puras: validam o que a tela manda e saneiam o que volta para ela.
 */
import { BadRequestException } from '@nestjs/common';

export const CANNED_RESPONSES_KEY = 'CANNED_RESPONSES';
export const CRM_CONFIG_KEY = 'CRM_CONFIG';

export type RespostaRapida = { id: string; label: string; text: string };

/** Limites generosos: só barram abuso (a tela nunca chega perto). */
export const RESPOSTAS_MAX_ITENS = 2000;
export const RESPOSTA_LABEL_MAX = 1000;
export const RESPOSTA_TEXTO_MAX = 50_000;

/** Padrão do código para os dias de lead parado. */
export const STAGNATION_PADRAO = 3;
/** Faixa aceita na gravação (a mesma da tela). */
export const STAGNATION_MIN = 1;
export const STAGNATION_MAX = 90;

function idDoItem(v: unknown, i: number): string {
  if (typeof v === 'string' && v !== '') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return `r${i + 1}`;
}

/**
 * Lista do jeito que o inbox e a tela usam: só itens com label e text em texto.
 * Valor guardado que não é lista (ou JSON inválido) vira [] — o inbox nunca cai
 * por causa de um valor malformado.
 */
export function sanearRespostasRapidas(valor: unknown): RespostaRapida[] {
  let lista: unknown = valor;
  if (typeof valor === 'string') {
    try {
      lista = JSON.parse(valor);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(lista)) return [];
  const saida: RespostaRapida[] = [];
  lista.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const { id, label, text } = item as Record<string, unknown>;
    if (typeof label !== 'string' || typeof text !== 'string') return;
    saida.push({ id: idDoItem(id, i), label, text });
  });
  return saida;
}

/**
 * Corpo do PATCH: `responses` precisa ser lista (senão 400 — sem ela a lista
 * inteira seria apagada). Item com label/text vazios é aceito (a tela pode mandar
 * um recém-criado em branco); item com tipo errado é descartado; acima dos
 * limites, 400.
 */
export function validarRespostasRapidas(responses: unknown): RespostaRapida[] {
  if (!Array.isArray(responses)) {
    throw new BadRequestException('Respostas rápidas: envie a lista de respostas.');
  }
  if (responses.length > RESPOSTAS_MAX_ITENS) {
    throw new BadRequestException(`Respostas rápidas: no máximo ${RESPOSTAS_MAX_ITENS} respostas.`);
  }
  const lista = sanearRespostasRapidas(responses);
  for (const r of lista) {
    if (r.label.length > RESPOSTA_LABEL_MAX) {
      throw new BadRequestException(`Respostas rápidas: o atalho deve ter até ${RESPOSTA_LABEL_MAX} caracteres.`);
    }
    if (r.text.length > RESPOSTA_TEXTO_MAX) {
      throw new BadRequestException(`Respostas rápidas: cada texto deve ter até ${RESPOSTA_TEXTO_MAX} caracteres.`);
    }
  }
  return lista;
}

/** Dias de lead parado guardados (JSON {stagnationDays}): número >= 1, senão o padrão. */
export function stagnationDaysEfetivo(raw: string | null | undefined): number {
  if (!raw) return STAGNATION_PADRAO;
  try {
    const n = Number(JSON.parse(raw)?.stagnationDays);
    return Number.isFinite(n) && n >= STAGNATION_MIN ? Math.round(n) : STAGNATION_PADRAO;
  } catch {
    return STAGNATION_PADRAO;
  }
}

/**
 * stagnationDays do corpo do PATCH: número arredondado e limitado a 1..90.
 * Inválido ou ausente → null (mantém o valor atual; nunca 400: a tela salva no
 * onBlur do campo).
 */
export function normalizarStagnationDays(v: unknown): number | null {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(STAGNATION_MAX, Math.max(STAGNATION_MIN, Math.round(n)));
}
