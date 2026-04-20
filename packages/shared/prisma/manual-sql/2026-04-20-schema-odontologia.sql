-- ============================================================================
-- Migration manual — 2026-04-20 — Schema odontologico (Fase 2)
-- ============================================================================
-- Cria 15 tabelas clinicas novas + 1 coluna nova em CalendarEvent + 1 tabela
-- implicita M:N (_UserSpecialties).
--
-- Ordem de aplicacao:
--   1) Executar este SQL direto no Postgres da VPS:
--      psql "$DATABASE_URL" -f 2026-04-20-schema-odontologia.sql
--      OU
--      docker exec -i <pg_container> psql -U chatcrm -d chatcrm < 2026-04-20-schema-odontologia.sql
--
-- Todas as operacoes sao IDEMPOTENTES (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- Pode rodar multiplas vezes sem erro.
--
-- Nao afeta dados existentes — apenas adiciona estruturas. Nenhum DROP.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. ALTER TABLE existente — CalendarEvent ganha patient_id
-- ============================================================================

ALTER TABLE "CalendarEvent" ADD COLUMN IF NOT EXISTS "patient_id" TEXT;
CREATE INDEX IF NOT EXISTS "CalendarEvent_patient_id_idx" ON "CalendarEvent"("patient_id");

-- ============================================================================
-- 2. Specialty — catalogo de especialidades odontologicas
-- ============================================================================

CREATE TABLE IF NOT EXISTS "Specialty" (
  "id"          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"   TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "icon"        TEXT,
  "active"      BOOLEAN NOT NULL DEFAULT true,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Specialty_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Specialty_tenant_name_unique" UNIQUE ("tenant_id", "name")
);
CREATE INDEX IF NOT EXISTS "Specialty_tenant_active_idx" ON "Specialty"("tenant_id", "active");

-- ============================================================================
-- 3. Procedure — catalogo de procedimentos
-- ============================================================================

CREATE TABLE IF NOT EXISTS "Procedure" (
  "id"                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"           TEXT NOT NULL,
  "specialty_id"        TEXT,
  "name"                TEXT NOT NULL,
  "code_tuss"           TEXT,
  "internal_code"       TEXT,
  "description"         TEXT,
  "duration_minutes"    INTEGER NOT NULL DEFAULT 30,
  "base_price"          DECIMAL(10, 2) NOT NULL DEFAULT 0,
  "requires_x_ray"      BOOLEAN NOT NULL DEFAULT false,
  "requires_anesthesia" BOOLEAN NOT NULL DEFAULT false,
  "active"              BOOLEAN NOT NULL DEFAULT true,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Procedure_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Procedure_specialty_id_fkey"
    FOREIGN KEY ("specialty_id") REFERENCES "Specialty"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Procedure_tenant_name_unique" UNIQUE ("tenant_id", "name")
);
CREATE INDEX IF NOT EXISTS "Procedure_tenant_active_idx" ON "Procedure"("tenant_id", "active");
CREATE INDEX IF NOT EXISTS "Procedure_specialty_id_idx" ON "Procedure"("specialty_id");

-- ============================================================================
-- 4. AnamnesisTemplate — template versionado de perguntas
-- ============================================================================

CREATE TABLE IF NOT EXISTS "AnamnesisTemplate" (
  "id"         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"  TEXT NOT NULL,
  "version"    INTEGER NOT NULL DEFAULT 1,
  "schema"     JSONB NOT NULL,
  "active"     BOOLEAN NOT NULL DEFAULT true,
  "notes"      TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnamnesisTemplate_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AnamnesisTemplate_tenant_version_unique" UNIQUE ("tenant_id", "version")
);
CREATE INDEX IF NOT EXISTS "AnamnesisTemplate_tenant_active_idx" ON "AnamnesisTemplate"("tenant_id", "active");

-- ============================================================================
-- 5. Patient — paciente da clinica
-- ============================================================================

CREATE TABLE IF NOT EXISTS "Patient" (
  "id"                      TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"               TEXT NOT NULL,
  "lead_id"                 TEXT UNIQUE,
  "name"                    TEXT NOT NULL,
  "cpf"                     TEXT,
  "rg"                      TEXT,
  "birth_date"              TIMESTAMP(3),
  "gender"                  TEXT,
  "phone"                   TEXT,
  "email"                   TEXT,
  "address"                 TEXT,
  "address_number"          TEXT,
  "address_complement"      TEXT,
  "neighborhood"            TEXT,
  "city"                    TEXT,
  "state"                   TEXT,
  "zip_code"                TEXT,
  "blood_type"              TEXT,
  "emergency_contact_name"  TEXT,
  "emergency_contact_phone" TEXT,
  "primary_dentist_id"      TEXT,
  "referred_by"             TEXT,
  "status"                  TEXT NOT NULL DEFAULT 'ACTIVE',
  "first_visit_at"          TIMESTAMP(3),
  "last_visit_at"           TIMESTAMP(3),
  "notes"                   TEXT,
  "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Patient_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Patient_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Patient_primary_dentist_id_fkey"
    FOREIGN KEY ("primary_dentist_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Patient_tenant_cpf_unique" UNIQUE ("tenant_id", "cpf")
);
CREATE INDEX IF NOT EXISTS "Patient_tenant_name_idx" ON "Patient"("tenant_id", "name");
CREATE INDEX IF NOT EXISTS "Patient_tenant_phone_idx" ON "Patient"("tenant_id", "phone");
CREATE INDEX IF NOT EXISTS "Patient_primary_dentist_id_idx" ON "Patient"("primary_dentist_id");

-- FK para CalendarEvent.patient_id (agora que Patient existe)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CalendarEvent_patient_id_fkey') THEN
    ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_patient_id_fkey"
      FOREIGN KEY ("patient_id") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ============================================================================
-- 6. PatientAllergy / PatientMedication
-- ============================================================================

CREATE TABLE IF NOT EXISTS "PatientAllergy" (
  "id"         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "patient_id" TEXT NOT NULL,
  "allergen"   TEXT NOT NULL,
  "severity"   TEXT,
  "notes"      TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PatientAllergy_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "PatientAllergy_patient_id_idx" ON "PatientAllergy"("patient_id");

CREATE TABLE IF NOT EXISTS "PatientMedication" (
  "id"         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "patient_id" TEXT NOT NULL,
  "medication" TEXT NOT NULL,
  "dosage"     TEXT,
  "frequency"  TEXT,
  "reason"     TEXT,
  "started_at" TIMESTAMP(3),
  "ended_at"   TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PatientMedication_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "PatientMedication_patient_id_idx" ON "PatientMedication"("patient_id");

-- ============================================================================
-- 7. Anamnesis
-- ============================================================================

CREATE TABLE IF NOT EXISTS "Anamnesis" (
  "id"                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "patient_id"        TEXT NOT NULL,
  "template_id"       TEXT NOT NULL,
  "answers"           JSONB NOT NULL DEFAULT '{}'::jsonb,
  "template_schema"   JSONB NOT NULL,
  "filled_by_user_id" TEXT,
  "filled_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Anamnesis_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Anamnesis_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "AnamnesisTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "Anamnesis_patient_filled_idx" ON "Anamnesis"("patient_id", "filled_at");

-- ============================================================================
-- 8. MedicalRecord + ClinicalNote (prontuario)
-- ============================================================================

CREATE TABLE IF NOT EXISTS "MedicalRecord" (
  "id"              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "patient_id"      TEXT NOT NULL UNIQUE,
  "chief_complaint" TEXT,
  "history"         TEXT,
  "opened_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closed_at"       TIMESTAMP(3),
  "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MedicalRecord_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "MedicalRecord_patient_id_idx" ON "MedicalRecord"("patient_id");

CREATE TABLE IF NOT EXISTS "ClinicalNote" (
  "id"                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "medical_record_id" TEXT NOT NULL,
  "appointment_id"    TEXT,
  "author_user_id"    TEXT NOT NULL,
  "subjective"        TEXT,
  "objective"         TEXT,
  "assessment"        TEXT,
  "plan"              TEXT,
  "executed_items"    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "is_finalized"      BOOLEAN NOT NULL DEFAULT false,
  "finalized_at"      TIMESTAMP(3),
  "addendum"          TEXT,
  "addendum_at"       TIMESTAMP(3),
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClinicalNote_medical_record_id_fkey"
    FOREIGN KEY ("medical_record_id") REFERENCES "MedicalRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ClinicalNote_author_user_id_fkey"
    FOREIGN KEY ("author_user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ClinicalNote_appointment_id_fkey"
    FOREIGN KEY ("appointment_id") REFERENCES "CalendarEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ClinicalNote_record_created_idx" ON "ClinicalNote"("medical_record_id", "created_at");
CREATE INDEX IF NOT EXISTS "ClinicalNote_author_idx" ON "ClinicalNote"("author_user_id");
CREATE INDEX IF NOT EXISTS "ClinicalNote_appointment_idx" ON "ClinicalNote"("appointment_id");

-- ============================================================================
-- 9. Odontogram + ToothRecord
-- ============================================================================

CREATE TABLE IF NOT EXISTS "Odontogram" (
  "id"                       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "patient_id"               TEXT NOT NULL UNIQUE,
  "meta"                     JSONB NOT NULL DEFAULT '{}'::jsonb,
  "last_updated_by_user_id"  TEXT,
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Odontogram_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "ToothRecord" (
  "id"            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "odontogram_id" TEXT NOT NULL,
  "tooth_fdi"     TEXT NOT NULL,
  "face"          TEXT,
  "state"         TEXT NOT NULL,
  "material"      TEXT,
  "notes"         TEXT,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ToothRecord_odontogram_id_fkey"
    FOREIGN KEY ("odontogram_id") REFERENCES "Odontogram"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ToothRecord_odontogram_fdi_idx" ON "ToothRecord"("odontogram_id", "tooth_fdi");

-- ============================================================================
-- 10. ClinicalImage
-- ============================================================================

CREATE TABLE IF NOT EXISTS "ClinicalImage" (
  "id"                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "patient_id"          TEXT NOT NULL,
  "media_id"            TEXT,
  "clinical_note_id"    TEXT,
  "kind"                TEXT NOT NULL,
  "tooth_fdi"           TEXT,
  "description"         TEXT,
  "date_taken"          TIMESTAMP(3) NOT NULL,
  "uploaded_by_user_id" TEXT,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClinicalImage_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ClinicalImage_clinical_note_id_fkey"
    FOREIGN KEY ("clinical_note_id") REFERENCES "ClinicalNote"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ClinicalImage_patient_date_idx" ON "ClinicalImage"("patient_id", "date_taken");
CREATE INDEX IF NOT EXISTS "ClinicalImage_note_idx" ON "ClinicalImage"("clinical_note_id");

-- ============================================================================
-- 11. Quote + QuoteItem
-- ============================================================================

CREATE TABLE IF NOT EXISTS "Quote" (
  "id"                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "patient_id"         TEXT NOT NULL,
  "created_by_user_id" TEXT NOT NULL,
  "status"             TEXT NOT NULL DEFAULT 'DRAFT',
  "valid_until"        TIMESTAMP(3),
  "subtotal"           DECIMAL(10, 2) NOT NULL DEFAULT 0,
  "discount_percent"   DECIMAL(5, 2) NOT NULL DEFAULT 0,
  "discount_value"     DECIMAL(10, 2) NOT NULL DEFAULT 0,
  "total_value"        DECIMAL(10, 2) NOT NULL DEFAULT 0,
  "payment_terms"      TEXT,
  "notes"              TEXT,
  "sent_at"            TIMESTAMP(3),
  "accepted_at"        TIMESTAMP(3),
  "rejected_at"        TIMESTAMP(3),
  "rejection_reason"   TEXT,
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Quote_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Quote_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "Quote_patient_status_idx" ON "Quote"("patient_id", "status");
CREATE INDEX IF NOT EXISTS "Quote_status_valid_idx" ON "Quote"("status", "valid_until");

CREATE TABLE IF NOT EXISTS "QuoteItem" (
  "id"           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "quote_id"     TEXT NOT NULL,
  "procedure_id" TEXT NOT NULL,
  "tooth_fdi"    TEXT,
  "quantity"     INTEGER NOT NULL DEFAULT 1,
  "unit_price"   DECIMAL(10, 2) NOT NULL,
  "total_price"  DECIMAL(10, 2) NOT NULL,
  "notes"        TEXT,
  "order_index"  INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "QuoteItem_quote_id_fkey"
    FOREIGN KEY ("quote_id") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "QuoteItem_procedure_id_fkey"
    FOREIGN KEY ("procedure_id") REFERENCES "Procedure"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "QuoteItem_quote_idx" ON "QuoteItem"("quote_id");

-- ============================================================================
-- 12. TreatmentPlan + TreatmentPlanItem
-- ============================================================================

CREATE TABLE IF NOT EXISTS "TreatmentPlan" (
  "id"                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "patient_id"            TEXT NOT NULL,
  "quote_id"              TEXT UNIQUE,
  "status"                TEXT NOT NULL DEFAULT 'PENDING_SIGNATURE',
  "start_date"            TIMESTAMP(3),
  "end_date"              TIMESTAMP(3),
  "estimated_sessions"    INTEGER,
  "total_value"           DECIMAL(10, 2) NOT NULL DEFAULT 0,
  "contract_signature_id" TEXT UNIQUE,
  "notes"                 TEXT,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TreatmentPlan_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TreatmentPlan_quote_id_fkey"
    FOREIGN KEY ("quote_id") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "TreatmentPlan_contract_signature_id_fkey"
    FOREIGN KEY ("contract_signature_id") REFERENCES "ContractSignature"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "TreatmentPlan_patient_status_idx" ON "TreatmentPlan"("patient_id", "status");
CREATE INDEX IF NOT EXISTS "TreatmentPlan_status_idx" ON "TreatmentPlan"("status");

CREATE TABLE IF NOT EXISTS "TreatmentPlanItem" (
  "id"                       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "treatment_plan_id"        TEXT NOT NULL,
  "procedure_id"             TEXT NOT NULL,
  "tooth_fdi"                TEXT,
  "quantity"                 INTEGER NOT NULL DEFAULT 1,
  "unit_price"               DECIMAL(10, 2) NOT NULL,
  "total_price"              DECIMAL(10, 2) NOT NULL,
  "status"                   TEXT NOT NULL DEFAULT 'PENDING',
  "scheduled_at"             TIMESTAMP(3),
  "scheduled_appointment_id" TEXT,
  "executed_at"              TIMESTAMP(3),
  "executed_by_user_id"      TEXT,
  "notes"                    TEXT,
  "order_index"              INTEGER NOT NULL DEFAULT 0,
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TreatmentPlanItem_treatment_plan_id_fkey"
    FOREIGN KEY ("treatment_plan_id") REFERENCES "TreatmentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TreatmentPlanItem_procedure_id_fkey"
    FOREIGN KEY ("procedure_id") REFERENCES "Procedure"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TreatmentPlanItem_scheduled_appointment_id_fkey"
    FOREIGN KEY ("scheduled_appointment_id") REFERENCES "CalendarEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "TreatmentPlanItem_executed_by_user_id_fkey"
    FOREIGN KEY ("executed_by_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "TreatmentPlanItem_plan_status_idx" ON "TreatmentPlanItem"("treatment_plan_id", "status");
CREATE INDEX IF NOT EXISTS "TreatmentPlanItem_appointment_idx" ON "TreatmentPlanItem"("scheduled_appointment_id");
CREATE INDEX IF NOT EXISTS "TreatmentPlanItem_executor_idx" ON "TreatmentPlanItem"("executed_by_user_id");

-- ============================================================================
-- 13. ConsentRecord (LGPD + TCLE + Imagem)
-- ============================================================================

CREATE TABLE IF NOT EXISTS "ConsentRecord" (
  "id"                     TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "patient_id"             TEXT NOT NULL,
  "treatment_plan_id"      TEXT,
  "type"                   TEXT NOT NULL,
  "version_text"           TEXT NOT NULL,
  "consented_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consented_by_user_id"   TEXT,
  "ip_address"             TEXT,
  "user_agent"             TEXT,
  "clicksign_document_key" TEXT,
  "clicksign_signed_at"    TIMESTAMP(3),
  "signed_document_s3_key" TEXT,
  "revoked_at"             TIMESTAMP(3),
  "revoked_reason"         TEXT,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConsentRecord_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ConsentRecord_treatment_plan_id_fkey"
    FOREIGN KEY ("treatment_plan_id") REFERENCES "TreatmentPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ConsentRecord_patient_type_idx" ON "ConsentRecord"("patient_id", "type");
CREATE INDEX IF NOT EXISTS "ConsentRecord_plan_idx" ON "ConsentRecord"("treatment_plan_id");

-- ============================================================================
-- 14. _UserSpecialties — tabela implicita M:N (User <-> Specialty)
-- ============================================================================
-- Prisma gera esta tabela com 2 colunas "A" (User.id) e "B" (Specialty.id).

CREATE TABLE IF NOT EXISTS "_UserSpecialties" (
  "A" TEXT NOT NULL,
  "B" TEXT NOT NULL,
  CONSTRAINT "_UserSpecialties_A_fkey"
    FOREIGN KEY ("A") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "_UserSpecialties_B_fkey"
    FOREIGN KEY ("B") REFERENCES "Specialty"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "_UserSpecialties_AB_unique" ON "_UserSpecialties"("A", "B");
CREATE INDEX IF NOT EXISTS "_UserSpecialties_B_index" ON "_UserSpecialties"("B");

COMMIT;

-- ============================================================================
-- VERIFICACAO POS-MIGRATION (executar separadamente pra confirmar)
-- ============================================================================

-- Tabelas criadas (esperadas 15 + _UserSpecialties):
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public'
--   AND table_name IN (
--     'Patient','PatientAllergy','PatientMedication',
--     'Specialty','Procedure',
--     'AnamnesisTemplate','Anamnesis',
--     'MedicalRecord','ClinicalNote',
--     'Odontogram','ToothRecord',
--     'ClinicalImage',
--     'Quote','QuoteItem',
--     'TreatmentPlan','TreatmentPlanItem',
--     'ConsentRecord',
--     '_UserSpecialties'
--   )
-- ORDER BY table_name;

-- Coluna nova em CalendarEvent:
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'CalendarEvent' AND column_name = 'patient_id';
