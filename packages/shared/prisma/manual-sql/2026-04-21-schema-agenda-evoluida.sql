-- ============================================================================
-- Migration manual — 2026-04-21 — Agenda evoluida (Fase 7)
-- ============================================================================
-- Cria 4 tabelas novas + 1 coluna nova em CalendarEvent + 2 indices novos.
--
-- Cobre:
--   - Room: salas/cadeiras (recurso fisico reservavel na agenda)
--   - AppointmentMarker + AppointmentMarkerAssignment: tags N:N
--   - AppointmentConfirmation: tentativas de confirmacao auditaveis por canal
--   - ReturnAlert: alerta de retorno programado (carro-chefe Clinicorp)
--
-- Ordem de aplicacao:
--   psql "$DATABASE_URL" -f 2026-04-21-schema-agenda-evoluida.sql
--   OU
--   docker exec -i <pg_container> psql -U chatcrm -d chatcrm \
--     < 2026-04-21-schema-agenda-evoluida.sql
--
-- IDEMPOTENTE (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- Pode rodar multiplas vezes sem erro. Nao afeta dados existentes.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. ALTER TABLE CalendarEvent — ganha room_id
-- ============================================================================

ALTER TABLE "CalendarEvent" ADD COLUMN IF NOT EXISTS "room_id" TEXT;
CREATE INDEX IF NOT EXISTS "CalendarEvent_room_id_start_idx" ON "CalendarEvent"("room_id", "start_at");
CREATE INDEX IF NOT EXISTS "CalendarEvent_patient_id_start_idx" ON "CalendarEvent"("patient_id", "start_at");

-- ============================================================================
-- 2. Room — sala/cadeira
-- ============================================================================

CREATE TABLE IF NOT EXISTS "Room" (
  "id"          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"   TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "color"       TEXT,
  "capacity"    INTEGER NOT NULL DEFAULT 1,
  "active"      BOOLEAN NOT NULL DEFAULT true,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Room_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Room_tenant_name_unique" UNIQUE ("tenant_id", "name")
);
CREATE INDEX IF NOT EXISTS "Room_tenant_active_idx" ON "Room"("tenant_id", "active");

-- FK CalendarEvent.room_id -> Room.id (criada apos a tabela Room existir)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'CalendarEvent_room_id_fkey'
  ) THEN
    ALTER TABLE "CalendarEvent"
      ADD CONSTRAINT "CalendarEvent_room_id_fkey"
      FOREIGN KEY ("room_id") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ============================================================================
-- 3. AppointmentMarker — tags reutilizaveis
-- ============================================================================

CREATE TABLE IF NOT EXISTS "AppointmentMarker" (
  "id"         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"  TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "color"      TEXT,
  "active"     BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppointmentMarker_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AppointmentMarker_tenant_name_unique" UNIQUE ("tenant_id", "name")
);
CREATE INDEX IF NOT EXISTS "AppointmentMarker_tenant_active_idx" ON "AppointmentMarker"("tenant_id", "active");

-- ============================================================================
-- 4. AppointmentMarkerAssignment — pivot N:N
-- ============================================================================

CREATE TABLE IF NOT EXISTS "AppointmentMarkerAssignment" (
  "id"             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "appointment_id" TEXT NOT NULL,
  "marker_id"      TEXT NOT NULL,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppointmentMarkerAssignment_appointment_fkey"
    FOREIGN KEY ("appointment_id") REFERENCES "CalendarEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AppointmentMarkerAssignment_marker_fkey"
    FOREIGN KEY ("marker_id") REFERENCES "AppointmentMarker"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AppointmentMarkerAssignment_unique" UNIQUE ("appointment_id", "marker_id")
);
CREATE INDEX IF NOT EXISTS "AppointmentMarkerAssignment_marker_idx" ON "AppointmentMarkerAssignment"("marker_id");

-- ============================================================================
-- 5. AppointmentConfirmation — tentativas auditaveis por canal
-- ============================================================================

CREATE TABLE IF NOT EXISTS "AppointmentConfirmation" (
  "id"              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "appointment_id"  TEXT NOT NULL,
  "channel"         TEXT NOT NULL,
  "scheduled_for"   TIMESTAMP(3),
  "sent_at"         TIMESTAMP(3),
  "message_text"    TEXT,
  "response_status" TEXT NOT NULL DEFAULT 'PENDENTE',
  "response_at"     TIMESTAMP(3),
  "response_text"   TEXT,
  "message_id"      TEXT,
  "delivery_status" TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppointmentConfirmation_appointment_fkey"
    FOREIGN KEY ("appointment_id") REFERENCES "CalendarEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "AppointmentConfirmation_appointment_channel_idx" ON "AppointmentConfirmation"("appointment_id", "channel");
CREATE INDEX IF NOT EXISTS "AppointmentConfirmation_response_status_idx" ON "AppointmentConfirmation"("response_status");
CREATE INDEX IF NOT EXISTS "AppointmentConfirmation_scheduled_for_idx" ON "AppointmentConfirmation"("scheduled_for");

-- ============================================================================
-- 6. ReturnAlert — alerta de retorno programado
-- ============================================================================

CREATE TABLE IF NOT EXISTS "ReturnAlert" (
  "id"                       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"                TEXT NOT NULL,
  "patient_id"               TEXT NOT NULL,
  "professional_user_id"     TEXT,
  "source_appointment_id"    TEXT,
  "scheduled_for"            TIMESTAMP(3) NOT NULL,
  "reason"                   TEXT,
  "notes"                    TEXT,
  "status"                   TEXT NOT NULL DEFAULT 'PENDENTE',
  "contacted_at"             TIMESTAMP(3),
  "contacted_by_user_id"     TEXT,
  "scheduled_appointment_id" TEXT,
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReturnAlert_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ReturnAlert_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ReturnAlert_professional_fkey"
    FOREIGN KEY ("professional_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ReturnAlert_contacted_by_fkey"
    FOREIGN KEY ("contacted_by_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ReturnAlert_source_appointment_fkey"
    FOREIGN KEY ("source_appointment_id") REFERENCES "CalendarEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ReturnAlert_scheduled_appointment_fkey"
    FOREIGN KEY ("scheduled_appointment_id") REFERENCES "CalendarEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ReturnAlert_tenant_scheduled_idx" ON "ReturnAlert"("tenant_id", "scheduled_for");
CREATE INDEX IF NOT EXISTS "ReturnAlert_patient_idx" ON "ReturnAlert"("patient_id");
CREATE INDEX IF NOT EXISTS "ReturnAlert_status_scheduled_idx" ON "ReturnAlert"("status", "scheduled_for");
CREATE INDEX IF NOT EXISTS "ReturnAlert_professional_idx" ON "ReturnAlert"("professional_user_id");

COMMIT;

-- ============================================================================
-- POS-INSTALACAO (manual):
--
--   1. Atualizar Prisma Client:
--      cd packages/shared && npx prisma generate
--
--   2. (Opcional) Criar Rooms iniciais via SQL:
--      INSERT INTO "Room" (tenant_id, name, description) VALUES
--        ('<tenant>', 'Cadeira 1', 'Atendimento geral'),
--        ('<tenant>', 'Cadeira 2', 'Atendimento geral'),
--        ('<tenant>', 'Sala HOF',  'Estetica facial'),
--        ('<tenant>', 'Sala Cirurgia', 'Cirurgias e implantes')
--      ON CONFLICT DO NOTHING;
--
--   3. (Opcional) Criar AppointmentMarkers padroes:
--      INSERT INTO "AppointmentMarker" (tenant_id, name, color) VALUES
--        ('<tenant>', 'Primeira consulta', '#28A745'),
--        ('<tenant>', 'Indicacao',         '#2196F3'),
--        ('<tenant>', 'VIP',               '#FFC107'),
--        ('<tenant>', 'Retorno 6m',        '#9C27B0'),
--        ('<tenant>', 'Estetica facial',   '#F58220')
--      ON CONFLICT DO NOTHING;
-- ============================================================================
