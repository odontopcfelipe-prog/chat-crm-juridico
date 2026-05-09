-- ============================================================================
-- Migration manual — 2026-05-09 — Pesquisa de Satisfacao Pos-Atendimento
-- ============================================================================
-- Cria tabela PostCareSurvey: 1 survey por consulta concluida.
-- Disparada automaticamente apos N horas (default 2h) via Evolution.
-- Resposta classificada por sentiment (POSITIVE | NEGATIVE | NEUTRAL).
-- Respostas NEGATIVE notificam admins via tabela Notification existente.
--
-- IDEMPOTENTE.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS "PostCareSurvey" (
  "id"                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"            TEXT NOT NULL,
  "patient_id"           TEXT NOT NULL,
  "appointment_id"       TEXT UNIQUE,
  "dentist_id"           TEXT,
  "procedure_summary"    TEXT,

  "trigger_at"           TIMESTAMP(3) NOT NULL,
  "sent_at"              TIMESTAMP(3),
  "status"               TEXT NOT NULL DEFAULT 'PENDING',

  "score"                INTEGER,
  "sentiment"            TEXT,
  "comment"              TEXT,
  "responded_at"         TIMESTAMP(3),
  "escalated_at"         TIMESTAMP(3),

  "evolution_message_id" TEXT,
  "last_error"           TEXT,

  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PostCareSurvey_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PostCareSurvey_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PostCareSurvey_appointment_id_fkey"
    FOREIGN KEY ("appointment_id") REFERENCES "CalendarEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "PostCareSurvey_dentist_id_fkey"
    FOREIGN KEY ("dentist_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "PostCareSurvey_tenant_status_trigger_idx" ON "PostCareSurvey"("tenant_id", "status", "trigger_at");
CREATE INDEX IF NOT EXISTS "PostCareSurvey_tenant_sentiment_idx"      ON "PostCareSurvey"("tenant_id", "sentiment");
CREATE INDEX IF NOT EXISTS "PostCareSurvey_patient_sent_idx"          ON "PostCareSurvey"("patient_id", "sent_at");

COMMIT;

-- ============================================================================
-- POS-INSTALACAO:
--   cd packages/shared && npx prisma generate
-- ============================================================================
