-- ============================================================================
-- Migration manual — 2026-04-21 — Comissoes + Metas (Fase 8)
-- ============================================================================
-- Cria 3 tabelas novas: CommissionRule, Commission, Goal.
-- Sem ALTER TABLE em tabelas existentes — apenas adiciona estruturas.
--
-- Aplicacao:
--   psql "$DATABASE_URL" -f 2026-04-21-schema-comissoes-metas.sql
--   OU
--   docker exec -i <pg_container> psql -U chatcrm -d chatcrm \
--     < 2026-04-21-schema-comissoes-metas.sql
--
-- IDEMPOTENTE (IF NOT EXISTS). Pode rodar varias vezes.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. CommissionRule — regra de comissao por profissional/procedimento
-- ============================================================================

CREATE TABLE IF NOT EXISTS "CommissionRule" (
  "id"                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"            TEXT NOT NULL,
  "professional_user_id" TEXT NOT NULL,
  "procedure_id"         TEXT,
  "procedure_category"   TEXT,
  "percentage"           DECIMAL(5, 2),
  "fixed_value"          DECIMAL(10, 2),
  "trigger"              TEXT NOT NULL DEFAULT 'ON_PAYMENT',
  "active"               BOOLEAN NOT NULL DEFAULT true,
  "starts_at"            TIMESTAMP(3),
  "ends_at"              TIMESTAMP(3),
  "notes"                TEXT,
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommissionRule_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CommissionRule_professional_fkey"
    FOREIGN KEY ("professional_user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "CommissionRule_tenant_professional_idx" ON "CommissionRule"("tenant_id", "professional_user_id");
CREATE INDEX IF NOT EXISTS "CommissionRule_active_idx" ON "CommissionRule"("active");

-- ============================================================================
-- 2. Commission — comissao gerada por execucao
-- ============================================================================

CREATE TABLE IF NOT EXISTS "Commission" (
  "id"                     TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"              TEXT NOT NULL,
  "professional_user_id"   TEXT NOT NULL,
  "patient_id"             TEXT NOT NULL,
  "procedure_id"           TEXT,
  "treatment_plan_item_id" TEXT,
  "quote_id"               TEXT,
  "base_value"             DECIMAL(10, 2) NOT NULL,
  "percentage"             DECIMAL(5, 2),
  "fixed_value"            DECIMAL(10, 2),
  "amount"                 DECIMAL(10, 2) NOT NULL,
  "status"                 TEXT NOT NULL DEFAULT 'DEVIDA',
  "available_at"           TIMESTAMP(3),
  "paid_at"                TIMESTAMP(3),
  "payment_method"         TEXT,
  "reference_month"        TEXT,
  "notes"                  TEXT,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Commission_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Commission_professional_fkey"
    FOREIGN KEY ("professional_user_id") REFERENCES "User"("id") ON UPDATE CASCADE,
  CONSTRAINT "Commission_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Commission_procedure_id_fkey"
    FOREIGN KEY ("procedure_id") REFERENCES "Procedure"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Commission_treatment_plan_item_id_fkey"
    FOREIGN KEY ("treatment_plan_item_id") REFERENCES "TreatmentPlanItem"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Commission_quote_id_fkey"
    FOREIGN KEY ("quote_id") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "Commission_tenant_pro_month_idx" ON "Commission"("tenant_id", "professional_user_id", "reference_month");
CREATE INDEX IF NOT EXISTS "Commission_status_idx" ON "Commission"("status");
CREATE INDEX IF NOT EXISTS "Commission_available_at_idx" ON "Commission"("available_at");

-- ============================================================================
-- 3. Goal — meta com projecao
-- ============================================================================

CREATE TABLE IF NOT EXISTS "Goal" (
  "id"                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"            TEXT NOT NULL,
  "metric"               TEXT NOT NULL,
  "scope"                TEXT NOT NULL DEFAULT 'CLINIC',
  "professional_user_id" TEXT,
  "direction"            TEXT NOT NULL DEFAULT 'ACHIEVE',
  "target_value"         DECIMAL(12, 2) NOT NULL,
  "period_type"          TEXT NOT NULL DEFAULT 'MONTHLY',
  "period_start"         TIMESTAMP(3) NOT NULL,
  "period_end"           TIMESTAMP(3) NOT NULL,
  "current_value"        DECIMAL(12, 2) DEFAULT 0,
  "projected_value"      DECIMAL(12, 2),
  "last_calculated_at"   TIMESTAMP(3),
  "active"               BOOLEAN NOT NULL DEFAULT true,
  "notes"                TEXT,
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Goal_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Goal_professional_fkey"
    FOREIGN KEY ("professional_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "Goal_tenant_period_idx" ON "Goal"("tenant_id", "period_start");
CREATE INDEX IF NOT EXISTS "Goal_metric_active_idx" ON "Goal"("metric", "active");
CREATE INDEX IF NOT EXISTS "Goal_professional_idx" ON "Goal"("professional_user_id");

COMMIT;

-- ============================================================================
-- POS-INSTALACAO (manual):
--   1. Atualizar Prisma Client:
--      cd packages/shared && npx prisma generate
--
--   2. (Opcional) Criar regra de comissao para um profissional:
--      INSERT INTO "CommissionRule" (tenant_id, professional_user_id, percentage, trigger)
--      VALUES ('<tenant>', '<user>', 30.00, 'ON_PAYMENT');
--
--   3. (Opcional) Criar meta de vendas mensal da clinica:
--      INSERT INTO "Goal" (tenant_id, metric, scope, target_value, period_type, period_start, period_end)
--      VALUES ('<tenant>', 'SALES_VALUE', 'CLINIC', 100000.00, 'MONTHLY',
--              date_trunc('month', CURRENT_DATE),
--              (date_trunc('month', CURRENT_DATE) + interval '1 month - 1 day'));
-- ============================================================================
