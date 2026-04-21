-- ============================================================================
-- Migration manual — 2026-04-21 — Multi-unidade / Franquias (Fase 15)
-- ============================================================================
-- Cria 2 tabelas: Clinic + UserClinic.
-- IDEMPOTENTE.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS "Clinic" (
  "id"                       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"                TEXT NOT NULL,
  "name"                     TEXT NOT NULL,
  "short_name"               TEXT,
  "address"                  TEXT,
  "city"                     TEXT,
  "state"                    TEXT,
  "phone"                    TEXT,
  "email"                    TEXT,
  "cnpj"                     TEXT,
  "type"                     TEXT NOT NULL DEFAULT 'MIXED',
  "working_hours"            JSONB,
  "logo_url"                 TEXT,
  "brand_color"              TEXT,
  "active"                   BOOLEAN NOT NULL DEFAULT true,
  "is_franchise"             BOOLEAN NOT NULL DEFAULT false,
  "franchisee_owner_user_id" TEXT,
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Clinic_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Clinic_tenant_name_unique" UNIQUE ("tenant_id", "name")
);
CREATE INDEX IF NOT EXISTS "Clinic_tenant_active_idx" ON "Clinic"("tenant_id", "active");
CREATE INDEX IF NOT EXISTS "Clinic_franchise_idx" ON "Clinic"("is_franchise");

CREATE TABLE IF NOT EXISTS "UserClinic" (
  "id"         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "user_id"    TEXT NOT NULL,
  "clinic_id"  TEXT NOT NULL,
  "role"       TEXT,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserClinic_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "UserClinic_clinic_id_fkey"
    FOREIGN KEY ("clinic_id") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "UserClinic_user_clinic_unique" UNIQUE ("user_id", "clinic_id")
);
CREATE INDEX IF NOT EXISTS "UserClinic_user_idx" ON "UserClinic"("user_id");
CREATE INDEX IF NOT EXISTS "UserClinic_clinic_idx" ON "UserClinic"("clinic_id");

COMMIT;
