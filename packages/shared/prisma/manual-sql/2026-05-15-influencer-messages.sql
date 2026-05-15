-- ============================================================================
-- Marketing — Mensagens automáticas pra influenciadores
-- ============================================================================
-- Aditiva e idempotente: cria 3 tabelas (template, schedule, log) se não existirem.
-- Não toca em "Influencer" nem em nenhum model existente.
-- Depende de 2026-05-15-influencers.sql (tabela "Influencer" precisa existir).
-- ============================================================================

CREATE TABLE IF NOT EXISTS "InfluencerMessageTemplate" (
  "id"          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"   TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "name"        TEXT NOT NULL,
  "body"        TEXT NOT NULL,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "InfluencerMessageTemplate_tenant_id_idx"
  ON "InfluencerMessageTemplate"("tenant_id");

CREATE TABLE IF NOT EXISTS "InfluencerSchedule" (
  "id"                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"             TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "name"                  TEXT NOT NULL,
  "template_id"           TEXT NOT NULL REFERENCES "InfluencerMessageTemplate"("id") ON DELETE RESTRICT,
  "active"                BOOLEAN NOT NULL DEFAULT TRUE,

  "schedule_type"         TEXT NOT NULL, -- ONCE | RECURRING

  "run_at"                TIMESTAMP(3),

  "recurrence"            TEXT,          -- DAILY | WEEKLY | MONTHLY
  "weekdays"              INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "day_of_month"          INTEGER,
  "hour"                  INTEGER,
  "minute"                INTEGER,

  "filter_status"         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "filter_platform"       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "filter_niche"          TEXT,
  "manual_recipient_ids"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  "last_run_at"           TIMESTAMP(3),
  "next_run_at"           TIMESTAMP(3),

  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "InfluencerSchedule_tenant_id_active_next_run_at_idx"
  ON "InfluencerSchedule"("tenant_id", "active", "next_run_at");

CREATE INDEX IF NOT EXISTS "InfluencerSchedule_template_id_idx"
  ON "InfluencerSchedule"("template_id");

CREATE TABLE IF NOT EXISTS "InfluencerMessageLog" (
  "id"            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"     TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "schedule_id"   TEXT NOT NULL REFERENCES "InfluencerSchedule"("id") ON DELETE CASCADE,
  "influencer_id" TEXT NOT NULL REFERENCES "Influencer"("id") ON DELETE CASCADE,

  "scheduled_for" TIMESTAMP(3) NOT NULL,

  "status"        TEXT NOT NULL, -- SENT | FAILED | SKIPPED
  "sent_at"       TIMESTAMP(3),
  "sent_text"     TEXT,
  "external_id"   TEXT,
  "error_message" TEXT,

  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "InfluencerMessageLog_unique_idem_idx"
  ON "InfluencerMessageLog"("schedule_id", "influencer_id", "scheduled_for");

CREATE INDEX IF NOT EXISTS "InfluencerMessageLog_tenant_id_sent_at_idx"
  ON "InfluencerMessageLog"("tenant_id", "sent_at");

CREATE INDEX IF NOT EXISTS "InfluencerMessageLog_schedule_id_idx"
  ON "InfluencerMessageLog"("schedule_id");
