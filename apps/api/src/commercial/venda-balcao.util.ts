/**
 * Fase 0 — regras PURAS da venda de BALCÃO recebida na clínica (rota
 * venda-rapida/balcao). Sem DI: o QuotesService importa direto, sem ciclo.
 * Os tokens de forma são os mesmos do caixa (receive-in-cash.payments).
 */
import { BadRequestException } from '@nestjs/common';

export const FORMAS_BALCAO = ['DINHEIRO', 'PIX', 'PIX_MAQUININHA', 'CARTAO'] as const;

/** Rótulo de cada forma nas notas do orçamento (o mesmo que a tela da venda rápida mostra). */
export const ROTULO_FORMA: Record<string, string> = {
  DINHEIRO: 'Espécie',
  PIX: 'PIX da clínica',
  PIX_MAQUININHA: 'PIX (Maquineta)',
  CARTAO: 'Maquineta',
};

/**
 * F5 — laboratório: o mesmo começo "Venda rapida" (marca de isVendaRapidaQuote, da
 * cópia em patients/dentist-links.ts e da tela do Financeiro), recebido no laboratório.
 */
export const LAB_NOTAS_BALCAO = Object.freeze({ base: 'Venda rapida — recebido no laboratorio' });

/** F5 — laboratório: rótulo da forma que muda (as outras ficam as de ROTULO_FORMA). */
export const LAB_ROTULO_FORMA: Readonly<Record<string, string>> = Object.freeze({ PIX: 'PIX do laboratório' });

export type FormaBalcao = { method: string; value: number; installments?: number; debit?: boolean };

const rotulo = (m: string, lab = false) => (lab ? LAB_ROTULO_FORMA[m] : undefined) ?? ROTULO_FORMA[m] ?? m;

/** Forma de MAIOR valor; empate fica com a que chegou primeiro. Lista vazia = ''. */
export function formaDominante(ps: FormaBalcao[]): string {
  let dom: FormaBalcao | null = null;
  for (const p of ps || []) {
    if (!dom || (Number(p.value) || 0) > (Number(dom.value) || 0)) dom = p;
  }
  return dom?.method ?? '';
}

/**
 * Notas do orçamento. SEMPRE começam com "Venda rapida": é a marca de
 * isVendaRapidaQuote (venda-rapida.util.ts e a cópia em patients/dentist-links.ts).
 * lab=true (conta de laboratório): "recebido no laboratorio" e o rótulo do PIX do laboratório.
 */
export function notasVendaBalcao(ps: FormaBalcao[], lab = false): string {
  const base = lab ? LAB_NOTAS_BALCAO.base : 'Venda rapida — recebido na clinica';
  const lista = ps || [];
  if (lista.length === 0) return base;
  if (lista.length === 1) return `${base}: ${rotulo(lista[0].method, lab)}`;
  if (lista.every((p) => p.method === 'CARTAO')) return `${base}: Maquineta (${lista.length} cartões)`;
  return `${base} (varias formas): ${lista.map((p) => `${rotulo(p.method, lab)} R$ ${(Number(p.value) || 0).toFixed(2)}`).join(' + ')}`;
}

/**
 * Como a venda entra no approve-and-bill / createManualReceipt (igual ao que a
 * tela da venda rápida monta hoje):
 *   - manualPaymentMethod: a forma única, ou a dominante quando há várias;
 *   - receivedMethod: a dominante (comprovante e aviso usam uma forma só);
 *   - installments: só no cartão único;
 *   - split: várias formas OU cartão (cada cartão vira uma receita no caixa).
 */
export function roteamentoBalcao(ps: FormaBalcao[]): {
  manualPaymentMethod: string;
  receivedMethod: string;
  installments?: number;
  split?: FormaBalcao[];
} {
  // Fase 0 — sem forma não há como rotear; barrar aqui evita cobrança sem método.
  if (!ps || ps.length === 0) throw new BadRequestException('Informe ao menos uma forma de pagamento.');
  const dominante = formaDominante(ps);
  const unica = ps.length === 1 ? ps[0] : null;
  return {
    manualPaymentMethod: unica ? unica.method : dominante,
    receivedMethod: dominante,
    installments: unica && unica.method === 'CARTAO' ? unica.installments : undefined,
    split: ps.length > 1 || ps[0].method === 'CARTAO' ? ps : undefined,
  };
}
