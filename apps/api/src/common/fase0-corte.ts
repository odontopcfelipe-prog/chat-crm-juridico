/**
 * Fase 0 — antifraude: as regras novas de execução valem só para planos/vendas
 * criados a partir daqui (nada retroativo). 19/10/2026 00:00 em Maceió (UTC-3).
 * TreatmentPlan.created_at é instante REAL (@default(now())), não "naive" da agenda.
 * Único lugar da data de corte: NÃO mude o valor depois do deploy.
 */
export const CONCILIACAO_DESDE = new Date('2026-10-19T03:00:00.000Z');

/** Criado no corte ou depois? Sem data (ou data inválida) = antigo (false). */
export function criadoAposCorte(createdAt: Date | string | null | undefined): boolean {
  if (!createdAt) return false;
  const t = new Date(createdAt).getTime();
  // Fase 0 — data ilegível conta como antiga: a regra nova não vale no escuro.
  if (Number.isNaN(t)) return false;
  return t >= CONCILIACAO_DESDE.getTime();
}
