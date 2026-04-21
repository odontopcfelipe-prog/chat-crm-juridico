-- ============================================================================
-- Migration manual — 2026-04-21 — Estetica facial avancada + Estoque (Fase 6)
-- ============================================================================
-- Cria 6 tabelas novas + 5 colunas novas em Procedure.
--
-- Cobre:
--   - Estoque com rastreabilidade ANVISA (Supplier, Product, StockMovement,
--     ProcedureConsumable)
--   - Aplicacao estetica facial em pontos faciais padronizados, com lote,
--     volume, tecnica, profundidade (EstheticApplication)
--   - Reacao adversa para potencial notificacao NOTIVISA (AdverseReaction)
--
-- Ordem de aplicacao:
--   1) Executar este SQL direto no Postgres da VPS:
--      psql "$DATABASE_URL" -f 2026-04-21-schema-estetica-facial.sql
--      OU
--      docker exec -i <pg_container> psql -U chatcrm -d chatcrm < 2026-04-21-schema-estetica-facial.sql
--
-- Todas as operacoes sao IDEMPOTENTES (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- Pode rodar multiplas vezes sem erro.
--
-- Nao afeta dados existentes — apenas adiciona estruturas. Nenhum DROP.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. ALTER TABLE existente — Procedure ganha 5 campos para estetica facial
-- ============================================================================

ALTER TABLE "Procedure" ADD COLUMN IF NOT EXISTS "category" TEXT;
ALTER TABLE "Procedure" ADD COLUMN IF NOT EXISTS "is_facial_application" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Procedure" ADD COLUMN IF NOT EXISTS "default_revisit_months" INTEGER;
ALTER TABLE "Procedure" ADD COLUMN IF NOT EXISTS "post_procedure_instructions" TEXT;

CREATE INDEX IF NOT EXISTS "Procedure_tenant_category_idx" ON "Procedure"("tenant_id", "category");

-- ============================================================================
-- 2. Supplier — fornecedor (laboratorio, distribuidora, etc.)
-- ============================================================================

CREATE TABLE IF NOT EXISTS "Supplier" (
  "id"           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"    TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "cnpj"         TEXT,
  "category"     TEXT,
  "contact_name" TEXT,
  "phone"        TEXT,
  "email"        TEXT,
  "address"      TEXT,
  "notes"        TEXT,
  "active"       BOOLEAN NOT NULL DEFAULT true,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Supplier_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "Supplier_tenant_active_idx" ON "Supplier"("tenant_id", "active");
CREATE INDEX IF NOT EXISTS "Supplier_tenant_name_idx" ON "Supplier"("tenant_id", "name");

-- ============================================================================
-- 3. Product — insumos com rastreabilidade ANVISA
-- ============================================================================

CREATE TABLE IF NOT EXISTS "Product" (
  "id"                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"             TEXT NOT NULL,
  "supplier_id"           TEXT,
  "name"                  TEXT NOT NULL,
  "brand"                 TEXT,
  "sku"                   TEXT,
  "barcode"               TEXT,
  "category"              TEXT,
  "unit"                  TEXT NOT NULL DEFAULT 'UN',
  "description"           TEXT,
  "anvisa_registration"   TEXT,
  "is_injectable"         BOOLEAN NOT NULL DEFAULT false,
  "is_controlled"         BOOLEAN NOT NULL DEFAULT false,
  "requires_lot_tracking" BOOLEAN NOT NULL DEFAULT false,
  "current_stock"         DECIMAL(10, 3) NOT NULL DEFAULT 0,
  "min_stock"             DECIMAL(10, 3),
  "max_stock"             DECIMAL(10, 3),
  "cost_price"            DECIMAL(10, 2),
  "sale_price"            DECIMAL(10, 2),
  "has_expiration"        BOOLEAN NOT NULL DEFAULT false,
  "active"                BOOLEAN NOT NULL DEFAULT true,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Product_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Product_supplier_id_fkey"
    FOREIGN KEY ("supplier_id") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Product_tenant_sku_unique" UNIQUE ("tenant_id", "sku")
);
CREATE INDEX IF NOT EXISTS "Product_tenant_name_idx"     ON "Product"("tenant_id", "name");
CREATE INDEX IF NOT EXISTS "Product_tenant_category_idx" ON "Product"("tenant_id", "category");
CREATE INDEX IF NOT EXISTS "Product_anvisa_idx"          ON "Product"("anvisa_registration");
CREATE INDEX IF NOT EXISTS "Product_active_idx"          ON "Product"("active");

-- ============================================================================
-- 4. StockMovement — entrada/saida/ajuste/descarte
-- ============================================================================

CREATE TABLE IF NOT EXISTS "StockMovement" (
  "id"                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"            TEXT NOT NULL,
  "product_id"           TEXT NOT NULL,
  "supplier_id"          TEXT,
  "type"                 TEXT NOT NULL,
  "quantity"             DECIMAL(10, 3) NOT NULL,
  "unit_cost"            DECIMAL(10, 2),
  "total_cost"           DECIMAL(10, 2),
  "batch_number"         TEXT,
  "expiration_date"      TIMESTAMP(3),
  "appointment_id"       TEXT,
  "notes"                TEXT,
  "performed_by_user_id" TEXT,
  "performed_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StockMovement_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "StockMovement_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "StockMovement_supplier_id_fkey"
    FOREIGN KEY ("supplier_id") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "StockMovement_appointment_id_fkey"
    FOREIGN KEY ("appointment_id") REFERENCES "CalendarEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "StockMovement_performed_by_fkey"
    FOREIGN KEY ("performed_by_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "StockMovement_tenant_product_idx" ON "StockMovement"("tenant_id", "product_id");
CREATE INDEX IF NOT EXISTS "StockMovement_type_date_idx"      ON "StockMovement"("type", "performed_at");
CREATE INDEX IF NOT EXISTS "StockMovement_batch_idx"          ON "StockMovement"("batch_number");
CREATE INDEX IF NOT EXISTS "StockMovement_expiration_idx"     ON "StockMovement"("expiration_date");

-- ============================================================================
-- 5. ProcedureConsumable — N:N procedimento <-> insumo
-- ============================================================================

CREATE TABLE IF NOT EXISTS "ProcedureConsumable" (
  "id"           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "procedure_id" TEXT NOT NULL,
  "product_id"   TEXT NOT NULL,
  "quantity"     DECIMAL(10, 3) NOT NULL,
  "notes"        TEXT,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProcedureConsumable_procedure_id_fkey"
    FOREIGN KEY ("procedure_id") REFERENCES "Procedure"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProcedureConsumable_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProcedureConsumable_unique" UNIQUE ("procedure_id", "product_id")
);
CREATE INDEX IF NOT EXISTS "ProcedureConsumable_product_idx" ON "ProcedureConsumable"("product_id");

-- ============================================================================
-- 6. EstheticApplication — aplicacao em ponto facial + lote ANVISA
-- ============================================================================

CREATE TABLE IF NOT EXISTS "EstheticApplication" (
  "id"                       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"                TEXT NOT NULL,
  "patient_id"               TEXT NOT NULL,
  "procedure_id"             TEXT,
  "clinical_note_id"         TEXT,
  "appointment_id"           TEXT,
  "treatment_plan_item_id"   TEXT,
  "application_point"        TEXT NOT NULL,
  "side"                     TEXT,
  "product_id"               TEXT,
  "product_name_snapshot"    TEXT,
  "brand_snapshot"           TEXT,
  "batch_number"             TEXT,
  "expiration_date"          TIMESTAMP(3),
  "volume"                   DECIMAL(10, 3),
  "unit"                     TEXT,
  "dilution"                 TEXT,
  "needle_gauge"             TEXT,
  "technique"                TEXT,
  "depth"                    TEXT,
  "notes"                    TEXT,
  "expected_duration_months" INTEGER,
  "expected_revisit_at"      TIMESTAMP(3),
  "applied_by_user_id"       TEXT NOT NULL,
  "applied_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EstheticApplication_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "EstheticApplication_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "EstheticApplication_procedure_id_fkey"
    FOREIGN KEY ("procedure_id") REFERENCES "Procedure"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "EstheticApplication_clinical_note_id_fkey"
    FOREIGN KEY ("clinical_note_id") REFERENCES "ClinicalNote"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "EstheticApplication_appointment_id_fkey"
    FOREIGN KEY ("appointment_id") REFERENCES "CalendarEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "EstheticApplication_treatment_plan_item_id_fkey"
    FOREIGN KEY ("treatment_plan_item_id") REFERENCES "TreatmentPlanItem"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "EstheticApplication_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "EstheticApplication_applied_by_user_id_fkey"
    FOREIGN KEY ("applied_by_user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "EstheticApplication_tenant_patient_idx"  ON "EstheticApplication"("tenant_id", "patient_id");
CREATE INDEX IF NOT EXISTS "EstheticApplication_patient_applied_idx" ON "EstheticApplication"("patient_id", "applied_at");
CREATE INDEX IF NOT EXISTS "EstheticApplication_batch_idx"           ON "EstheticApplication"("batch_number");
CREATE INDEX IF NOT EXISTS "EstheticApplication_product_idx"         ON "EstheticApplication"("product_id");
CREATE INDEX IF NOT EXISTS "EstheticApplication_revisit_idx"         ON "EstheticApplication"("expected_revisit_at");

-- ============================================================================
-- 7. AdverseReaction — registro clinico + base para NOTIVISA/ANVISA
-- ============================================================================

CREATE TABLE IF NOT EXISTS "AdverseReaction" (
  "id"                       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"                TEXT NOT NULL,
  "patient_id"               TEXT NOT NULL,
  "esthetic_application_id"  TEXT,
  "procedure_id"             TEXT,
  "severity"                 TEXT NOT NULL,
  "reaction_type"            TEXT NOT NULL,
  "description"              TEXT NOT NULL,
  "onset_at"                 TIMESTAMP(3) NOT NULL,
  "resolved_at"              TIMESTAMP(3),
  "resolution_notes"         TEXT,
  "treatment_given"          TEXT,
  "hospitalized"             BOOLEAN NOT NULL DEFAULT false,
  "notivisa_reported"        BOOLEAN NOT NULL DEFAULT false,
  "notivisa_reported_at"     TIMESTAMP(3),
  "notivisa_protocol"        TEXT,
  "reported_by_user_id"      TEXT NOT NULL,
  "reported_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdverseReaction_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AdverseReaction_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AdverseReaction_esthetic_application_id_fkey"
    FOREIGN KEY ("esthetic_application_id") REFERENCES "EstheticApplication"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "AdverseReaction_procedure_id_fkey"
    FOREIGN KEY ("procedure_id") REFERENCES "Procedure"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "AdverseReaction_reported_by_user_id_fkey"
    FOREIGN KEY ("reported_by_user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "AdverseReaction_tenant_patient_idx"  ON "AdverseReaction"("tenant_id", "patient_id");
CREATE INDEX IF NOT EXISTS "AdverseReaction_severity_idx"        ON "AdverseReaction"("severity");
CREATE INDEX IF NOT EXISTS "AdverseReaction_application_idx"     ON "AdverseReaction"("esthetic_application_id");
CREATE INDEX IF NOT EXISTS "AdverseReaction_reported_at_idx"     ON "AdverseReaction"("reported_at");

COMMIT;

-- ============================================================================
-- POS-INSTALACAO (manual, executar separadamente apos validar):
--
--   1. Rodar prisma generate para atualizar o cliente Prisma:
--      cd packages/shared && npx prisma generate
--
--   2. Rodar o seed de procedimentos esteticos (opcional):
--      cd packages/shared && npx ts-node prisma/seed-estetica-facial.ts
--
--   3. Verificar que tabelas foram criadas:
--      psql "$DATABASE_URL" -c "\dt Supplier|Product|StockMovement|ProcedureConsumable|EstheticApplication|AdverseReaction"
-- ============================================================================
