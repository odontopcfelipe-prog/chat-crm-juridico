/**
 * FREIO AO VIVO da régua de cobrança — última checagem ANTES de mandar qualquer
 * cobrança ao paciente. Regra do dono: cobrar quem já pagou NÃO PODE acontecer.
 *
 * Por que existe: a régua escolhe pelo status LOCAL (PaymentGatewayCharge PENDING/
 * OVERDUE). Esse status fica velho quando o webhook de pagamento do Asaas se perde ou
 * atrasa, e o reconcile automático só alcançava cobranças JÁ VENCIDAS — então um
 * "vence amanhã" de cobrança já paga saía (caso real out/2026: paciente pagou, recebeu
 * o lembrete com o PIX). Este módulo decide, por cobrança, se ainda pode cobrar.
 *
 * Fail-CLOSED: na dúvida, NÃO cobra. Asaas fora do ar / sem resposta → 'indisponivel'
 * (o envio espera e tenta depois); status desconhecido ou cobrança sumida → não cobra.
 */

/** Status LOCAIS em que a cobrança ainda está em aberto (únicos que a régua cobra). */
export const LOCAL_EM_ABERTO = new Set(['PENDING', 'OVERDUE']);

/** Status do ASAAS em que ainda dá pra cobrar. Qualquer outro (pago, recebido em
 *  dinheiro, estornado, chargeback, negativação, removido…) → não cobra. */
export const ASAAS_EM_ABERTO = new Set(['PENDING', 'OVERDUE']);

export type Veredicto = 'cobrar' | 'nao_cobrar' | 'indisponivel';

/** Linha local relida do banco no momento do envio (null = a cobrança sumiu). */
export function veredictoLocal(row: { status: string; received_in_cash: boolean } | null | undefined): Veredicto {
  if (!row) return 'nao_cobrar';
  if (row.received_in_cash) return 'nao_cobrar';
  return LOCAL_EM_ABERTO.has(String(row.status || '').toUpperCase()) ? 'cobrar' : 'nao_cobrar';
}

/** Resultado da consulta GET /payments/{id} no Asaas. */
export type ConsultaAsaas =
  | { ok: true; status?: string | null; deleted?: boolean | null }
  | { ok: false; httpStatus?: number | null };

export function veredictoAsaas(r: ConsultaAsaas): Veredicto {
  if (!r.ok) {
    // 404 = a cobrança não existe (mais) nessa conta Asaas → não cobra.
    // Qualquer outra falha (timeout, 5xx, rede, 401) = não deu pra conferir → espera.
    return r.httpStatus === 404 ? 'nao_cobrar' : 'indisponivel';
  }
  if (r.deleted) return 'nao_cobrar';
  const s = String(r.status || '').toUpperCase();
  if (!s) return 'indisponivel'; // resposta sem status: não confia
  return ASAAS_EM_ABERTO.has(s) ? 'cobrar' : 'nao_cobrar';
}

/** Junta os veredictos de UMA cobrança (local + Asaas, quando houver). Basta um
 *  "não cobrar" pra não cobrar; senão, qualquer "indisponível" segura o envio. */
export function combinar(...vs: Veredicto[]): Veredicto {
  if (vs.includes('nao_cobrar')) return 'nao_cobrar';
  if (vs.includes('indisponivel')) return 'indisponivel';
  return 'cobrar';
}
