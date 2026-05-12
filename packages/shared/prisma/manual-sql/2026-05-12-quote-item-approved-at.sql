-- ============================================================================
-- Migration manual — 2026-05-12 — QuoteItem.approved_at
-- ============================================================================
-- Adiciona coluna approved_at (TIMESTAMP, opcional) ao QuoteItem.
-- NULL = pendente (paciente ainda nao fechou esse procedimento).
-- Com data = aprovado naquele momento.
--
-- Substitui o fluxo antigo de "aprovacao parcial" que dividia em 2 quotes
-- (um ACEITO + um "Procedimento restante" RASCUNHO). Agora tudo fica no
-- MESMO quote: items aprovados ficam visualmente inativos + pendentes
-- podem ser aprovados depois (paciente volta proxima consulta).
--
-- IDEMPOTENTE.
-- ============================================================================

BEGIN;

ALTER TABLE "QuoteItem" ADD COLUMN IF NOT EXISTS "approved_at" TIMESTAMP(3);

COMMIT;
