-- ============================================================================
-- Migration manual — 2026-05-08 — Anamnese: prova eletronica de preenchimento
-- ============================================================================
-- Adiciona colunas opcionais a tabela Anamnesis para registrar:
--   - origem do preenchimento (equipe ou portal do paciente)
--   - IP, user-agent, timestamp de aceite
--   - texto do consentimento aceito (snapshot)
--   - assinatura (nome digitado ou data-url da assinatura desenhada)
--   - audit_hash (SHA-256 das respostas + metadata) para detectar adulteracao
--
-- IDEMPOTENTE — pode ser rodada multiplas vezes sem efeito colateral.
-- ============================================================================

BEGIN;

ALTER TABLE "Anamnesis" ADD COLUMN IF NOT EXISTS "submitted_via"        TEXT;
ALTER TABLE "Anamnesis" ADD COLUMN IF NOT EXISTS "submitted_ip"         TEXT;
ALTER TABLE "Anamnesis" ADD COLUMN IF NOT EXISTS "submitted_user_agent" TEXT;
ALTER TABLE "Anamnesis" ADD COLUMN IF NOT EXISTS "consent_text"         TEXT;
ALTER TABLE "Anamnesis" ADD COLUMN IF NOT EXISTS "consent_accepted_at"  TIMESTAMP(3);
ALTER TABLE "Anamnesis" ADD COLUMN IF NOT EXISTS "signature_method"     TEXT;
ALTER TABLE "Anamnesis" ADD COLUMN IF NOT EXISTS "signature_data"       TEXT;
ALTER TABLE "Anamnesis" ADD COLUMN IF NOT EXISTS "audit_hash"           TEXT;

-- Anamneses pre-existentes ficam com submitted_via NULL (preenchidas pela equipe
-- antes da prova eletronica entrar em vigor). Apos esta migration, todo
-- preenchimento novo vai gravar submitted_via='STAFF' ou 'PATIENT_PORTAL'.

COMMIT;

-- ============================================================================
-- POS-INSTALACAO:
--   cd packages/shared && npx prisma generate
-- ============================================================================
