-- ============================================================================
-- Migration manual — 2026-04-22 — Smile/Face Design Studio (Fase 16)
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS "SmileSimulation" (
  "id"                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"           TEXT NOT NULL,
  "patient_id"          TEXT NOT NULL,
  "created_by_user_id"  TEXT NOT NULL,
  "simulation_type"     TEXT NOT NULL,
  "before_s3_key"       TEXT NOT NULL,
  "before_url"          TEXT,
  "after_s3_key"        TEXT,
  "after_url"           TEXT,
  "provider"            TEXT NOT NULL DEFAULT 'mock',
  "prompt"              TEXT,
  "provider_metadata"   JSONB,
  "status"              TEXT NOT NULL DEFAULT 'PROCESSING',
  "error_message"       TEXT,
  "patient_consent"     BOOLEAN NOT NULL DEFAULT false,
  "patient_consent_at"  TIMESTAMP(3),
  "notes"               TEXT,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SmileSimulation_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SmileSimulation_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SmileSimulation_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "User"("id") ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "SmileSimulation_tenant_patient_idx" ON "SmileSimulation"("tenant_id", "patient_id");
CREATE INDEX IF NOT EXISTS "SmileSimulation_patient_created_idx" ON "SmileSimulation"("patient_id", "created_at");
CREATE INDEX IF NOT EXISTS "SmileSimulation_status_idx" ON "SmileSimulation"("status");

COMMIT;
