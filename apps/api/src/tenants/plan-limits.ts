/**
 * Onda 17.32.79 — SaaS Fase 4: limites por plano.
 *
 * Mapeia cada plan a quotas. -1 = ilimitado. Aplicado via
 * PlanLimitGuard nos endpoints de criacao (users, patients).
 *
 * Valores podem ser sobrescritos por GlobalSetting tipo
 * PLAN_LIMITS_<plan> (JSON) no banco. Default eh este aqui.
 */
export interface PlanLimits {
  max_users: number;
  max_patients: number;
  max_inboxes: number; // WhatsApp instances
  max_charges_per_month: number;
}

export const PLAN_LIMITS: Record<string, PlanLimits> = {
  STARTER: {
    max_users: 5,
    max_patients: 300,
    max_inboxes: 1,
    max_charges_per_month: 100,
  },
  PRO: {
    max_users: 20,
    max_patients: 3000,
    max_inboxes: 3,
    max_charges_per_month: 1000,
  },
  ENTERPRISE: {
    max_users: -1, // ilimitado
    max_patients: -1,
    max_inboxes: 10,
    max_charges_per_month: -1,
  },
  CUSTOM: {
    max_users: -1,
    max_patients: -1,
    max_inboxes: -1,
    max_charges_per_month: -1,
  },
};

export function getLimitsForPlan(plan: string | null | undefined): PlanLimits {
  if (!plan) return PLAN_LIMITS.STARTER;
  return PLAN_LIMITS[plan] || PLAN_LIMITS.STARTER;
}

/** True se o uso atual esta dentro do limite (ou ilimitado). */
export function isWithinLimit(current: number, max: number): boolean {
  if (max < 0) return true; // -1 = ilimitado
  return current < max;
}
