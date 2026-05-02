-- ============================================================================
-- Migration manual — 2026-05-02 — Quote.accepted_from_id (Fase 25 Onda 4.1)
-- ============================================================================
-- Adiciona campo accepted_from_id em Quote pra suportar APROVACAO PARCIAL.
--
-- Cenario: paciente recebe orcamento com 5 procedimentos, topa fechar 3.
-- Backend cria 2 quotes:
--   - ORIGINAL: vira REJECTED com motivo automatico (preserva historico
--     de o que foi proposto vs nao aceito)
--   - NOVO ACCEPTED: contem so os items selecionados, gera TreatmentPlan,
--     aponta accepted_from_id pro original (rastreio)
--
-- Items NAO selecionados ficam preservados no quote ORIGINAL (REJECTED).
-- Operadora pode usar "Renegociar" (Onda 3b) pra criar DRAFT com so os
-- rejeitados se quiser tentar fechar depois.
--
-- Antes (sem aprovacao parcial): 60% das vendas perdiam porque paciente
-- nao topava tudo-ou-nada.
--
-- IDEMPOTENTE.
-- ============================================================================

BEGIN;

-- 1) Coluna accepted_from_id (opcional, nullable)
ALTER TABLE "Quote"
  ADD COLUMN IF NOT EXISTS "accepted_from_id" TEXT;

-- 2) FK pro Quote pai (SetNull se for deletado/restaurado)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Quote_accepted_from_id_fkey'
  ) THEN
    ALTER TABLE "Quote"
      ADD CONSTRAINT "Quote_accepted_from_id_fkey"
      FOREIGN KEY ("accepted_from_id")
      REFERENCES "Quote"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;

-- 3) Index pra query "todos os quotes derivados deste original"
CREATE INDEX IF NOT EXISTS "Quote_accepted_from_id_idx" ON "Quote"("accepted_from_id");

COMMIT;

-- ============================================================================
-- Verificacao manual:
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'Quote' AND column_name = 'accepted_from_id';
--   Esperado: accepted_from_id | text | YES
--
--   SELECT indexname FROM pg_indexes WHERE tablename = 'Quote';
--   Esperado: ..., Quote_accepted_from_id_idx
-- ============================================================================
