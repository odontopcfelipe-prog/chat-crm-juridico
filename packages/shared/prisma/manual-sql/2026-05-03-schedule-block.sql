-- Cria tabela ScheduleBlock — bloqueia agenda do dentista por periodo.
--
-- Fase 25 (Onda 5e v9) — IA respeita esses bloqueios em check_availability
-- e book_appointment, garantindo que ferias/doenca/curso impedem agendamento.
--
-- COMO RODAR (na VPS):
--   docker exec -i chatcrm_postgres psql -U chatcrm -d chatcrm < 2026-05-03-schedule-block.sql

CREATE TABLE IF NOT EXISTS "ScheduleBlock" (
  "id"         TEXT PRIMARY KEY,
  "tenant_id"  TEXT,
  "user_id"    TEXT NOT NULL,
  "start_at"   TIMESTAMP(3) NOT NULL,
  "end_at"     TIMESTAMP(3) NOT NULL,
  "all_day"    BOOLEAN NOT NULL DEFAULT false,
  "reason"     TEXT NOT NULL,
  "notes"      TEXT,
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ScheduleBlock_user_id_fkey"    FOREIGN KEY ("user_id")    REFERENCES "User"("id")   ON DELETE CASCADE  ON UPDATE CASCADE,
  CONSTRAINT "ScheduleBlock_creator_fkey"    FOREIGN KEY ("created_by") REFERENCES "User"("id")   ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ScheduleBlock_tenant_id_fkey"  FOREIGN KEY ("tenant_id")  REFERENCES "Tenant"("id") ON DELETE CASCADE  ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ScheduleBlock_user_id_start_at_end_at_idx" ON "ScheduleBlock" ("user_id", "start_at", "end_at");
CREATE INDEX IF NOT EXISTS "ScheduleBlock_tenant_id_start_at_idx"      ON "ScheduleBlock" ("tenant_id", "start_at");
