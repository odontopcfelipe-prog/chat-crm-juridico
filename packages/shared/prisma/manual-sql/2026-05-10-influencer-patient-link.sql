-- ============================================================================
-- Migration manual — 2026-05-10 — Influencer.patient_id (Onda 5e v35, Fase 25)
-- ============================================================================
-- Liga Influencer ao Patient automaticamente: quando um influenciador é
-- cadastrado, o sistema cria um Patient junto e armazena patient_id aqui.
--
-- Isso permite:
--   - Influenciador também ter ficha clínica (agendamentos, anamnese, etc)
--   - Influenciador ser AFILIADO da clínica (is_affiliate=true no Patient)
--   - Acumular saldo de comissão + sacar (usa o programa de afiliado da v34)
--
-- Relação 1-pra-1 opcional: Patient pode existir sem Influencer (caso comum),
-- e Influencer pode existir sem Patient temporariamente se o create falhar
-- parcialmente (mas o normal é sempre ter Patient vinculado).
--
-- IDEMPOTENTE.
-- ============================================================================

BEGIN;

ALTER TABLE "Influencer"
  ADD COLUMN IF NOT EXISTS "patient_id" TEXT;

-- Unique constraint: 1 Influencer por Patient (e vice-versa)
CREATE UNIQUE INDEX IF NOT EXISTS "Influencer_patient_id_key"
  ON "Influencer" ("patient_id");

-- FK pra Patient (ON DELETE SET NULL — se o paciente for arquivado/deletado,
-- o influenciador continua existindo sem patient_id)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Influencer_patient_id_fkey') THEN
    ALTER TABLE "Influencer"
      ADD CONSTRAINT "Influencer_patient_id_fkey"
      FOREIGN KEY ("patient_id") REFERENCES "Patient"("id") ON DELETE SET NULL;
  END IF;
END $$;

COMMIT;
