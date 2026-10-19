/**
 * Fase 0 — helper ÚNICO de auditoria (AuditLog). Função pura (sem DI): quem chama
 * passa o próprio prisma (ou o `tx` da transação), então não cria ciclo entre módulos.
 *
 * Regras:
 *   - `tenant_id` vai na COLUNA (a aba Log do Financeiro filtra por ela), nunca só no meta;
 *   - `actor_user_id` é um User.id real ou null — nunca 'system' (quebra a FK);
 *   - linha de dinheiro usa entity 'FINANCEIRO' e traz meta.descricao + meta.valor,
 *     assim aparece na aba Log sem mexer no front.
 */

export interface AuditInput {
  tenantId: string | null;
  /** User.id real ou null. */
  actorUserId?: string | null;
  /** 'FINANCEIRO' | 'CAIXA' | 'AGENDA_EVENTO' | 'TREATMENT_PLAN' | 'TREATMENT_PLAN_ITEM' | 'VENDA_BALCAO' */
  entity: string;
  entityId: string;
  action: string;
  before?: unknown;
  after?: unknown;
  /** FINANCEIRO: inclua descricao + valor. */
  meta?: Record<string, unknown>;
}

/** Fase 0 — JSON round-trip: Date/Decimal viram string; BigInt vira string em vez de lançar. */
function paraJson(v: unknown): any {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
}

/** Dados do `auditLog.create` (use direto dentro de $transaction: tx.auditLog.create({ data: auditData(...) })). */
export function auditData(a: AuditInput) {
  const meta = a.meta ?? {};
  return {
    tenant_id: a.tenantId ?? null,
    actor_user_id: a.actorUserId ?? null,
    entity: a.entity,
    entity_id: a.entityId,
    action: a.action,
    // Fase 0 — quem já manda o "antes" dentro do meta (ex.: log do caixa) não o perde.
    meta_json: paraJson({
      ...meta,
      before: a.before ?? meta.before ?? null,
      after: a.after ?? meta.after ?? null,
    }),
  };
}

/** Best-effort: nunca lança. Use FORA de transação. Dentro de $transaction use tx.auditLog.create({ data: auditData(...) }). */
export async function registrarAuditoria(
  db: { auditLog: { create: (args: any) => Promise<any> } },
  a: AuditInput,
  logger?: { warn: (m: string) => void },
): Promise<boolean> {
  try {
    await db.auditLog.create({ data: auditData(a) });
    return true;
  } catch (e: any) {
    logger?.warn(`[AUDIT] ${a.entity}/${a.action} ${a.entityId}: ${e?.message}`);
    return false;
  }
}
