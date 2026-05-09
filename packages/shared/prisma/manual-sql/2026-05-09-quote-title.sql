-- ============================================================================
-- Migration manual — 2026-05-09 — Quote.title (Onda 3.9)
-- ============================================================================
-- Adiciona nome customizavel pra cada orcamento (ex: "Reabilitacao superior",
-- "Canal + coroa 36"). Independente da closing_category derivada do
-- procedimento — eh o nome livre que o operador da pra organizar.
--
-- Frontend mostra como titulo do card expansivel no Odontograma. Mesma
-- entidade tambem aparece na aba Orcamentos com title visivel na lista.
--
-- IDEMPOTENTE — pode ser rodada multiplas vezes sem efeito colateral.
-- ============================================================================

BEGIN;

ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "title" TEXT;

COMMIT;

-- ============================================================================
-- POS-INSTALACAO:
--   cd packages/shared && npx prisma generate
-- ============================================================================
