-- ============================================================================
-- Migration manual — 2026-05-02 — QuoteItem.dentist_id (Fase 25 Onda 3.2)
-- ============================================================================
-- Adiciona campo opcional dentist_id em QuoteItem pra registrar qual
-- profissional vai (ou foi) responsavel pelo procedimento. Permite:
--   - Calculo de comissao por dentista (quanto cada um gerou)
--   - Agenda inteligente (so agendar Botox com dentista certificado)
--   - Auditoria clinica (quem fez o que)
--
-- Opcional (NULL): orcamentos antigos ficam sem dentista atribuido.
-- Se User for deletado, ON DELETE SET NULL preserva o registro do orcamento.
--
-- IDEMPOTENTE.
-- ============================================================================

BEGIN;

-- 1) Coluna dentist_id (opcional)
ALTER TABLE "QuoteItem"
  ADD COLUMN IF NOT EXISTS "dentist_id" TEXT;

-- 2) FK pro User (SetNull se dentista for deletado)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'QuoteItem_dentist_id_fkey'
  ) THEN
    ALTER TABLE "QuoteItem"
      ADD CONSTRAINT "QuoteItem_dentist_id_fkey"
      FOREIGN KEY ("dentist_id")
      REFERENCES "User"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;

-- 3) Index pra query "todos os items do dentista X" (relatorio comissao)
CREATE INDEX IF NOT EXISTS "QuoteItem_dentist_id_idx" ON "QuoteItem"("dentist_id");

COMMIT;

-- ============================================================================
-- Verificacao manual:
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'QuoteItem' AND column_name = 'dentist_id';
--   Esperado: dentist_id | text | YES
--
--   SELECT indexname FROM pg_indexes WHERE tablename = 'QuoteItem';
--   Esperado: QuoteItem_pkey, _quote_id_idx, _dentist_id_idx
-- ============================================================================
