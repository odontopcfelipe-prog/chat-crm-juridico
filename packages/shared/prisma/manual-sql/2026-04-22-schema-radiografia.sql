-- ============================================================================
-- Migration manual — 2026-04-22 — Integracao Radiologia (Fase 17)
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS "RadiographyProvider" (
  "id"               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"        TEXT NOT NULL,
  "name"             TEXT NOT NULL,
  "source_slug"      TEXT NOT NULL,
  "api_key_hash"     TEXT NOT NULL,
  "active"           BOOLEAN NOT NULL DEFAULT true,
  "webhook_count"    INTEGER NOT NULL DEFAULT 0,
  "last_received_at" TIMESTAMP(3),
  "notes"            TEXT,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RadiographyProvider_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RadiographyProvider_tenant_slug_unique" UNIQUE ("tenant_id", "source_slug")
);
CREATE INDEX IF NOT EXISTS "RadiographyProvider_tenant_active_idx" ON "RadiographyProvider"("tenant_id", "active");

CREATE TABLE IF NOT EXISTS "RadiographyExam" (
  "id"                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"             TEXT NOT NULL,
  "patient_id"            TEXT,
  "provider_id"           TEXT,
  "source"                TEXT NOT NULL,
  "source_external_id"    TEXT,
  "exam_type"             TEXT NOT NULL,
  "tooth_fdi"             TEXT,
  "image_s3_key"          TEXT NOT NULL,
  "thumbnail_s3_key"      TEXT,
  "mime_type"             TEXT NOT NULL DEFAULT 'image/jpeg',
  "report_text"           TEXT,
  "report_html"           TEXT,
  "performed_at"          TIMESTAMP(3),
  "received_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status"                TEXT NOT NULL DEFAULT 'RECEIVED',
  "linked_at"             TIMESTAMP(3),
  "linked_by_user_id"     TEXT,
  "external_patient_cpf"  TEXT,
  "external_patient_name" TEXT,
  "notes"                 TEXT,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RadiographyExam_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RadiographyExam_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "RadiographyExam_provider_id_fkey"
    FOREIGN KEY ("provider_id") REFERENCES "RadiographyProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "RadiographyExam_linked_by_fkey"
    FOREIGN KEY ("linked_by_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "RadiographyExam_source_external_unique" UNIQUE ("source", "source_external_id")
);
CREATE INDEX IF NOT EXISTS "RadiographyExam_tenant_patient_idx" ON "RadiographyExam"("tenant_id", "patient_id");
CREATE INDEX IF NOT EXISTS "RadiographyExam_patient_performed_idx" ON "RadiographyExam"("patient_id", "performed_at");
CREATE INDEX IF NOT EXISTS "RadiographyExam_status_received_idx" ON "RadiographyExam"("status", "received_at");
CREATE INDEX IF NOT EXISTS "RadiographyExam_external_cpf_idx" ON "RadiographyExam"("external_patient_cpf");

COMMIT;
