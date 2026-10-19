/**
 * Fase 0 — regras PURAS da baixa manual (recebido na clínica / confirmar cartão /
 * espécie). Sem DI: o service e o controller importam direto, sem ciclo.
 *   D) cobrança cancelada/estornada não recebe baixa;
 *   C) a soma das formas de pagamento tem que bater com o valor da cobrança.
 */

/** Status (local ou do Asaas) em que a cobrança não pode mais receber baixa. */
export const STATUS_SEM_BAIXA = [
  'DELETED', 'CANCELLED', 'REFUNDED', 'REFUND_REQUESTED', 'REFUND_IN_PROGRESS',
  'CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE', 'AWAITING_CHARGEBACK_REVERSAL',
] as const;

export const MSG_COBRANCA_CANCELADA = 'Esta cobrança está cancelada/estornada — não pode receber baixa.';

/** D) null = pode dar baixa; string = mensagem do 400. Cobrança não encontrada (null) segue o fluxo atual. */
export function motivoBloqueioBaixa(
  c: { status?: string | null; cancelled_at?: Date | null; deleted?: boolean | null } | null,
): string | null {
  if (!c) return null;
  if (c.deleted === true || c.cancelled_at || (c.status && (STATUS_SEM_BAIXA as readonly string[]).includes(c.status))) {
    return MSG_COBRANCA_CANCELADA;
  }
  return null;
}

export const round2 = (v: number) => Math.round(v * 100) / 100;

const brl = (v: number) => `R$ ${v.toFixed(2).replace('.', ',')}`;

/** C) null = ok; string = mensagem do 400. Tolerância 1 centavo. Sem formas (lista vazia) = ok. */
export function erroSomaFormas(payments: Array<{ value: number }> | null | undefined, total: number): string | null {
  const ps = (payments || []).filter((p) => p && Number(p.value) > 0);
  if (ps.length === 0) return null;
  // Fase 0 — compara em centavos inteiros: 0,1 + 0,2 em float não fecha com 0,3.
  const somaC = ps.reduce((s, p) => s + Math.round(Number(p.value) * 100), 0);
  const totalC = Math.round(Number(total) * 100);
  if (Math.abs(somaC - totalC) <= 1) return null;
  return `A soma das formas de pagamento (${brl(somaC / 100)}) tem que ser igual ao valor da cobrança (${brl(totalC / 100)}).`;
}
