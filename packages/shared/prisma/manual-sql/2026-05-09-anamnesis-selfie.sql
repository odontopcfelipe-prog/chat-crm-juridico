-- ============================================================================
-- Migration manual — 2026-05-09 — Anamnese: selfie de confirmacao
-- ============================================================================
-- Adiciona coluna selfie_data (TEXT, data-url JPEG comprimido).
-- Compoe prova eletronica junto com signature_data + audit_hash.
-- IDEMPOTENTE.
-- ============================================================================

BEGIN;

ALTER TABLE "Anamnesis" ADD COLUMN IF NOT EXISTS "selfie_data" TEXT;

COMMIT;
