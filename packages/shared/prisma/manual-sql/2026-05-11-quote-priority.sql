-- ============================================================================
-- Migration manual — 2026-05-11 — Quote.priority
-- ============================================================================
-- Adiciona coluna priority (TEXT, opcional) ao Quote.
-- Valores: "COMPLETO" | "ESSENCIAL" | "URGENTE" | NULL.
-- Dentista escolhe na aba Avaliacao; recepcao usa pra priorizar.
-- IDEMPOTENTE.
-- ============================================================================

BEGIN;

ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "priority" TEXT;

COMMIT;
