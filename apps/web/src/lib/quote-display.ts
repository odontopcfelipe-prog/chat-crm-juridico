/**
 * Onda 14.18 — Identificacao unificada de orcamentos entre as 4 abas
 * (Avaliacao / Orcamentos / Propostas / Financeiro).
 *
 * Antes: cada aba mostrava um nome diferente (procedure name, OUTROS, title raw)
 * deixando o operador perdido quando precisava encontrar o "mesmo orcamento"
 * em outra aba.
 *
 * Agora: TODAS as abas usam getQuoteDisplayName() e getQuoteNumberBadge()
 * pra renderizar o mesmo identificador:
 *   "#001 · Aparelho ortodontico"  (com title)
 *   "#001 · Orcamento"               (sem title)
 *
 * Source of truth: campo `title` no Quote (editado em Avaliacao ou Orcamentos
 * via botao Renomear). Numero sequencial GLOBAL por tenant via campo
 * quote_number, auto-incrementado no backend.
 */

/**
 * Quote minimo que o helper precisa. Os tipos completos das abas (QuoteListItem,
 * QuoteDetail, etc) sao supersets disso — basta o campo existir, mesmo opcional.
 */
export interface QuoteDisplayable {
  title?: string | null;
  quote_number?: number | null;
}

/**
 * Formata o numero do orcamento como badge "#NNN" (3 digitos, pad com zeros).
 * Ex: 1 → "#001", 42 → "#042", 999 → "#999", 1000 → "#1000".
 *
 * Retorna string vazia se quote_number for 0/null/undefined (orcamentos
 * legados que nao foram migrados ainda, ou erro de fetch). Nesse caso o
 * caller deve renderizar so o nome (fallback).
 */
export function getQuoteNumberBadge(quote: QuoteDisplayable): string {
  const n = quote.quote_number;
  if (!n || n <= 0) return '';
  return `#${String(n).padStart(3, '0')}`;
}

/**
 * Nome do orcamento. Title se existir, senao "Orcamento" generico.
 * NAO inclui o numero — combine com getQuoteNumberBadge() pra exibicao
 * completa, ou use getQuoteFullName().
 */
export function getQuoteDisplayName(quote: QuoteDisplayable): string {
  const title = (quote.title ?? '').trim();
  if (title) return title;
  return 'Orcamento';
}

/**
 * Identificador completo "#001 · Aparelho ortodontico".
 * Quando quote_number == 0 (legado), retorna so o nome sem o "#NNN · ".
 *
 * Usar em headers de cards, listagens, modais de detalhe. Pra layouts onde
 * o numero e o nome ficam em elementos separados (ex: badge colorido + h3),
 * chame getQuoteNumberBadge() e getQuoteDisplayName() separadamente.
 */
export function getQuoteFullName(quote: QuoteDisplayable): string {
  const badge = getQuoteNumberBadge(quote);
  const name = getQuoteDisplayName(quote);
  if (!badge) return name;
  return `${badge} · ${name}`;
}
