-- ============================================================================
-- Migration manual — 2026-04-22 — Cobranca via gateway para Installment (Fase 18)
-- ============================================================================
-- Adiciona installment_id em PaymentGatewayCharge para vincular cobrancas
-- Asaas/Iugu a parcelas odontologicas (Installment).
--
-- IDEMPOTENTE (IF NOT EXISTS / CONSTRAINT IF NOT EXISTS via DO block).
-- ============================================================================

BEGIN;

-- 1) Coluna nova
ALTER TABLE "PaymentGatewayCharge"
  ADD COLUMN IF NOT EXISTS "installment_id" TEXT;

-- 2) Constraint UNIQUE (1:1 — uma Installment so pode ter UMA cobranca ativa)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'PaymentGatewayCharge_installment_id_key'
  ) THEN
    ALTER TABLE "PaymentGatewayCharge"
      ADD CONSTRAINT "PaymentGatewayCharge_installment_id_key"
      UNIQUE ("installment_id");
  END IF;
END $$;

-- 3) Foreign key para Installment (SET NULL se a parcela for deletada)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'PaymentGatewayCharge_installment_id_fkey'
  ) THEN
    ALTER TABLE "PaymentGatewayCharge"
      ADD CONSTRAINT "PaymentGatewayCharge_installment_id_fkey"
      FOREIGN KEY ("installment_id") REFERENCES "Installment"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- 4) Indice para queries de listagem por status/parcela
CREATE INDEX IF NOT EXISTS "PaymentGatewayCharge_installment_id_idx"
  ON "PaymentGatewayCharge"("installment_id");

COMMIT;

-- ============================================================================
-- POS-INSTALACAO:
--   1. Regenerar Prisma Client: cd packages/shared && npx prisma generate
--   2. Restartar containers api+worker: docker service update --force chatcrm_api chatcrm_worker
-- ============================================================================
