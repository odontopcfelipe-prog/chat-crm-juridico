-- ============================================================================
-- Migration manual — 2026-04-30 — Soft delete em Quote (Fase 25 Onda 1.6)
-- ============================================================================
-- Adiciona deleted_at + deleted_by_user_id no Quote pra permitir recuperacao
-- de orcamentos deletados acidentalmente. Janela de 30 dias antes de hard
-- delete via job (a ser implementado).
--
-- Comportamento:
--  - quotes.service.remove() agora marca deleted_at em vez de DELETE fisico
--  - findByPatient() filtra deleted_at IS NULL (orcamentos deletados nao
--    aparecem na ficha do paciente)
--  - listDeleted() retorna orcamentos com deleted_at >= 30 dias atras
--    (tela admin /atendimento/settings/quotes-trash)
--  - restore() limpa deleted_at, volta orcamento pra listagem normal
--
-- IDEMPOTENTE (IF NOT EXISTS).
-- ============================================================================

BEGIN;

-- 1) Coluna deleted_at (timestamp)
ALTER TABLE "Quote"
  ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);

-- 2) Coluna deleted_by_user_id (FK opcional pro User)
ALTER TABLE "Quote"
  ADD COLUMN IF NOT EXISTS "deleted_by_user_id" TEXT;

-- 3) FK + onDelete SetNull (se user for deletado, registro do orcamento mantido)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Quote_deleted_by_user_id_fkey'
  ) THEN
    ALTER TABLE "Quote"
      ADD CONSTRAINT "Quote_deleted_by_user_id_fkey"
      FOREIGN KEY ("deleted_by_user_id")
      REFERENCES "User"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;

-- 4) Index pra query rapida de "orcamentos deletados nos ultimos 30 dias"
CREATE INDEX IF NOT EXISTS "Quote_deleted_at_idx" ON "Quote"("deleted_at");

COMMIT;

-- ============================================================================
-- Verificacao manual apos rodar:
--
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'Quote' AND column_name LIKE 'deleted%';
--
-- Esperado: 2 linhas (deleted_at TIMESTAMP, deleted_by_user_id TEXT)
-- ============================================================================
