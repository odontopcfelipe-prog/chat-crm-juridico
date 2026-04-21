-- ============================================================================
-- Migration manual — 2026-04-21 — Portal do Paciente (Fase 13)
-- ============================================================================
-- Cria tabela PortalToken para magic links de acesso ao portal do paciente.
-- IDEMPOTENTE.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS "PortalToken" (
  "id"          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"   TEXT NOT NULL,
  "patient_id"  TEXT NOT NULL,
  "token"       TEXT NOT NULL UNIQUE,
  "consumed_at" TIMESTAMP(3),
  "expires_at"  TIMESTAMP(3) NOT NULL,
  "ip_address"  TEXT,
  "user_agent"  TEXT,
  "channel"     TEXT NOT NULL DEFAULT 'WHATSAPP',
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PortalToken_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PortalToken_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "PortalToken_tenant_patient_idx" ON "PortalToken"("tenant_id", "patient_id");
CREATE INDEX IF NOT EXISTS "PortalToken_token_idx" ON "PortalToken"("token");
CREATE INDEX IF NOT EXISTS "PortalToken_expires_at_idx" ON "PortalToken"("expires_at");

COMMIT;

-- ============================================================================
-- POS-INSTALACAO:
--   cd packages/shared && npx prisma generate
-- ============================================================================
