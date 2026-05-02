-- ============================================================================
-- Migration manual — 2026-05-02 — MaintenanceTask (Fase 25 Onda 5)
-- ============================================================================
-- Cria tabela de tasks de manutencao/recall pos-procedimento.
--
-- Origens (3 caminhos pra criar):
--   1. AUTO via EstheticApplication: ao registrar aplicacao com
--      expected_revisit_at, gera task pra essa data
--   2. AUTO via TreatmentPlanItem DONE: se procedure.default_revisit_months
--      definido, cria task pra applied_at + N meses
--   3. MANUAL: operadora cria via UI sem vincular a procedimento especifico
--
-- Worker BullMQ (cron diario) processa tasks com due_date em 7 dias e
-- reminder_sent_at NULL: envia WhatsApp pro paciente "Sua revisao de Botox
-- esta chegando! Posso agendar?".
--
-- Status workflow:
--   PENDING (criada) -> SCHEDULED (operadora agendou consulta)
--                    -> DONE (revisita realizada)
--                    -> MISSED (data passou sem agendamento)
--                    -> CANCELLED (paciente cancelou explicitamente)
--
-- IDEMPOTENTE.
-- ============================================================================

BEGIN;

-- 1) Tabela
CREATE TABLE IF NOT EXISTS "MaintenanceTask" (
  "id"                       TEXT NOT NULL,
  "tenant_id"                TEXT NOT NULL,
  "patient_id"               TEXT NOT NULL,
  "procedure_id"             TEXT,
  "treatment_plan_item_id"   TEXT,
  "esthetic_application_id"  TEXT,
  "scheduled_event_id"       TEXT,
  "due_date"                 TIMESTAMP(3) NOT NULL,
  "completed_at"             TIMESTAMP(3),
  "status"                   TEXT NOT NULL DEFAULT 'PENDING',
  "title"                    TEXT NOT NULL,
  "notes"                    TEXT,
  "reminder_sent_at"         TIMESTAMP(3),
  "reminder_message_id"      TEXT,
  "completed_by_user_id"     TEXT,
  "created_by_user_id"       TEXT,
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MaintenanceTask_pkey" PRIMARY KEY ("id")
);

-- 2) Foreign Keys (idempotentes)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MaintenanceTask_tenant_id_fkey') THEN
    ALTER TABLE "MaintenanceTask"
      ADD CONSTRAINT "MaintenanceTask_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MaintenanceTask_patient_id_fkey') THEN
    ALTER TABLE "MaintenanceTask"
      ADD CONSTRAINT "MaintenanceTask_patient_id_fkey"
      FOREIGN KEY ("patient_id") REFERENCES "Patient"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MaintenanceTask_procedure_id_fkey') THEN
    ALTER TABLE "MaintenanceTask"
      ADD CONSTRAINT "MaintenanceTask_procedure_id_fkey"
      FOREIGN KEY ("procedure_id") REFERENCES "Procedure"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MaintenanceTask_treatment_plan_item_id_fkey') THEN
    ALTER TABLE "MaintenanceTask"
      ADD CONSTRAINT "MaintenanceTask_treatment_plan_item_id_fkey"
      FOREIGN KEY ("treatment_plan_item_id") REFERENCES "TreatmentPlanItem"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MaintenanceTask_esthetic_application_id_fkey') THEN
    ALTER TABLE "MaintenanceTask"
      ADD CONSTRAINT "MaintenanceTask_esthetic_application_id_fkey"
      FOREIGN KEY ("esthetic_application_id") REFERENCES "EstheticApplication"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MaintenanceTask_scheduled_event_id_fkey') THEN
    ALTER TABLE "MaintenanceTask"
      ADD CONSTRAINT "MaintenanceTask_scheduled_event_id_fkey"
      FOREIGN KEY ("scheduled_event_id") REFERENCES "CalendarEvent"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MaintenanceTask_completed_by_user_id_fkey') THEN
    ALTER TABLE "MaintenanceTask"
      ADD CONSTRAINT "MaintenanceTask_completed_by_user_id_fkey"
      FOREIGN KEY ("completed_by_user_id") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MaintenanceTask_created_by_user_id_fkey') THEN
    ALTER TABLE "MaintenanceTask"
      ADD CONSTRAINT "MaintenanceTask_created_by_user_id_fkey"
      FOREIGN KEY ("created_by_user_id") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- 3) Indexes pra queries comuns
CREATE INDEX IF NOT EXISTS "MaintenanceTask_tenant_id_due_date_idx"
  ON "MaintenanceTask"("tenant_id", "due_date");
CREATE INDEX IF NOT EXISTS "MaintenanceTask_patient_id_status_idx"
  ON "MaintenanceTask"("patient_id", "status");
CREATE INDEX IF NOT EXISTS "MaintenanceTask_status_due_date_idx"
  ON "MaintenanceTask"("status", "due_date");
CREATE INDEX IF NOT EXISTS "MaintenanceTask_reminder_sent_at_idx"
  ON "MaintenanceTask"("reminder_sent_at");
CREATE INDEX IF NOT EXISTS "MaintenanceTask_esthetic_application_id_idx"
  ON "MaintenanceTask"("esthetic_application_id");
CREATE INDEX IF NOT EXISTS "MaintenanceTask_treatment_plan_item_id_idx"
  ON "MaintenanceTask"("treatment_plan_item_id");

COMMIT;

-- ============================================================================
-- Verificacao manual:
--   SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'MaintenanceTask';
--   Esperado: 1
--
--   SELECT indexname FROM pg_indexes WHERE tablename = 'MaintenanceTask';
--   Esperado: 7 indexes (1 pkey + 6 secundarios)
-- ============================================================================
