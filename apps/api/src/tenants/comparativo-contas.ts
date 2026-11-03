/**
 * Comparativo das contas (Admin SaaS → Clínicas): as contas que o dono do
 * sistema marcar, lado a lado, num mês. Cada número é da conta dele, nunca
 * somado com outra. Funções puras (mês, ids); a consulta fica no service.
 */
export const MAX_CONTAS_NO_COMPARATIVO = 20;

const MES_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** 'AAAA-MM' válido, ou o mês corrente de Maceió (UTC-3). */
export function mesDoComparativo(mes: unknown, agora: Date = new Date()): string {
  if (typeof mes === 'string' && MES_RE.test(mes)) return mes;
  return new Date(agora.getTime() - 3 * 3600_000).toISOString().slice(0, 7);
}

/**
 * Bordas do mês:
 *  - real: instante de verdade (created_at, pagamento) — dia 1 00:00 Maceió = 03:00Z,
 *    igual à janela do Financeiro (contas-a-pagar monthRange);
 *  - agenda: naive-UTC (hora de Maceió gravada como UTC) — dia 1 00:00Z.
 * `fim` é exclusivo, menos em `fimInclusivo` (o Financeiro usa lte).
 */
export function bordasDoMes(mes: string) {
  const [y, m] = mes.split('-').map(Number);
  return {
    real: { inicio: new Date(Date.UTC(y, m - 1, 1, 3)), fim: new Date(Date.UTC(y, m, 1, 3)) },
    fimInclusivo: new Date(Date.UTC(y, m, 1, 2, 59, 59, 999)),
    agenda: { inicio: new Date(Date.UTC(y, m - 1, 1)), fim: new Date(Date.UTC(y, m, 1)) },
  };
}

/** Ids da query (?ids=a,b,c): sem vazios nem repetidos, no máximo MAX_CONTAS_NO_COMPARATIVO. */
export function idsDoComparativo(ids: unknown): string[] {
  const lista = (typeof ids === 'string' ? ids.split(',') : Array.isArray(ids) ? ids : [])
    .map((v) => String(v ?? '').trim())
    .filter((v) => v !== '' && v.length <= 64);
  return Array.from(new Set(lista)).slice(0, MAX_CONTAS_NO_COMPARATIVO);
}
