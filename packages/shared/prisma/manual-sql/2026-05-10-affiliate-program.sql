-- ============================================================================
-- Migration manual — 2026-05-10 — Programa de Afiliado (Onda 5e v34, Fase 25)
-- ============================================================================
-- Implementa o programa de afiliado: pacientes que indicam outros pacientes
-- e recebem 3% (configurável) do valor de cada tratamento fechado. Saldo
-- acumula automaticamente e pode ser sacado (PIX/dinheiro) ou usado como
-- crédito em tratamentos próprios.
--
-- Mudanças:
--   1. Patient ganha 4 colunas: is_affiliate, affiliate_code,
--      affiliate_commission_pct, affiliate_notes
--   2. UNIQUE (tenant_id, affiliate_code) — não permite código duplicado
--   3. Index (tenant_id, is_affiliate) — listar afiliados rápido
--   4. Tabela nova: AffiliateReferral (1 linha por indicação que gerou comissão)
--   5. Tabela nova: AffiliateWithdrawal (solicitações de saque)
--
-- Hooks de domínio que mexem nessas tabelas (implementados em apps/api):
--   - QuotesService.markAccepted → cria AffiliateReferral se o paciente da
--     Quote tem referred_by_id apontando pra um Patient afiliado
--   - AffiliateService.requestWithdrawal → cria AffiliateWithdrawal status=solicitado
--   - AffiliateService.confirmWithdrawalPaid → marca paid_at + paid_by_user_id
--
-- Saldo do afiliado é CALCULADO em runtime (não persistido):
--   saldo_disponivel = sum(referral.commission_value WHERE status='creditado')
--                    - sum(withdrawal.amount WHERE status IN ('pago','solicitado'))
--
-- IDEMPOTENTE.
-- ============================================================================

BEGIN;

-- ─── 1. Colunas em Patient ──────────────────────────────────────────────────

ALTER TABLE "Patient"
  ADD COLUMN IF NOT EXISTS "is_affiliate" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "Patient"
  ADD COLUMN IF NOT EXISTS "affiliate_code" TEXT;

ALTER TABLE "Patient"
  ADD COLUMN IF NOT EXISTS "affiliate_commission_pct" DECIMAL(5, 2) NOT NULL DEFAULT 3;

ALTER TABLE "Patient"
  ADD COLUMN IF NOT EXISTS "affiliate_notes" TEXT;

-- Index pra listar afiliados rápido
CREATE INDEX IF NOT EXISTS "Patient_tenant_id_is_affiliate_idx"
  ON "Patient" ("tenant_id", "is_affiliate");

-- Unique composto: código de afiliado é único por tenant
-- (permite NULL múltiplo — apenas afiliados precisam de código)
CREATE UNIQUE INDEX IF NOT EXISTS "Patient_tenant_id_affiliate_code_key"
  ON "Patient" ("tenant_id", "affiliate_code")
  WHERE "affiliate_code" IS NOT NULL;

-- ─── 2. Tabela AffiliateReferral ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "AffiliateReferral" (
  "id"               TEXT NOT NULL,
  "tenant_id"        TEXT NOT NULL,
  "referrer_id"      TEXT NOT NULL,
  "referred_id"      TEXT NOT NULL,
  "quote_id"         TEXT,

  "treatment_value"  DECIMAL(10, 2) NOT NULL,
  "commission_pct"   DECIMAL(5, 2)  NOT NULL,
  "commission_value" DECIMAL(10, 2) NOT NULL,

  "status"           TEXT NOT NULL DEFAULT 'creditado',
  "closed_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notes"            TEXT,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AffiliateReferral_pkey" PRIMARY KEY ("id")
);

-- FKs
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AffiliateReferral_tenant_id_fkey') THEN
    ALTER TABLE "AffiliateReferral"
      ADD CONSTRAINT "AffiliateReferral_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AffiliateReferral_referrer_id_fkey') THEN
    ALTER TABLE "AffiliateReferral"
      ADD CONSTRAINT "AffiliateReferral_referrer_id_fkey"
      FOREIGN KEY ("referrer_id") REFERENCES "Patient"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AffiliateReferral_referred_id_fkey') THEN
    ALTER TABLE "AffiliateReferral"
      ADD CONSTRAINT "AffiliateReferral_referred_id_fkey"
      FOREIGN KEY ("referred_id") REFERENCES "Patient"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "AffiliateReferral_tenant_id_referrer_id_status_idx"
  ON "AffiliateReferral" ("tenant_id", "referrer_id", "status");

CREATE INDEX IF NOT EXISTS "AffiliateReferral_referred_id_idx"
  ON "AffiliateReferral" ("referred_id");

CREATE INDEX IF NOT EXISTS "AffiliateReferral_quote_id_idx"
  ON "AffiliateReferral" ("quote_id");

-- ─── 3. Tabela AffiliateWithdrawal ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "AffiliateWithdrawal" (
  "id"              TEXT NOT NULL,
  "tenant_id"       TEXT NOT NULL,
  "patient_id"      TEXT NOT NULL,

  "amount"          DECIMAL(10, 2) NOT NULL,
  "method"          TEXT NOT NULL,
  "pix_key"         TEXT,
  "status"          TEXT NOT NULL DEFAULT 'solicitado',

  "requested_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paid_at"         TIMESTAMP(3),
  "paid_by_user_id" TEXT,

  "notes"           TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AffiliateWithdrawal_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AffiliateWithdrawal_tenant_id_fkey') THEN
    ALTER TABLE "AffiliateWithdrawal"
      ADD CONSTRAINT "AffiliateWithdrawal_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AffiliateWithdrawal_patient_id_fkey') THEN
    ALTER TABLE "AffiliateWithdrawal"
      ADD CONSTRAINT "AffiliateWithdrawal_patient_id_fkey"
      FOREIGN KEY ("patient_id") REFERENCES "Patient"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AffiliateWithdrawal_paid_by_user_id_fkey') THEN
    ALTER TABLE "AffiliateWithdrawal"
      ADD CONSTRAINT "AffiliateWithdrawal_paid_by_user_id_fkey"
      FOREIGN KEY ("paid_by_user_id") REFERENCES "User"("id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "AffiliateWithdrawal_tenant_id_patient_id_status_idx"
  ON "AffiliateWithdrawal" ("tenant_id", "patient_id", "status");

CREATE INDEX IF NOT EXISTS "AffiliateWithdrawal_status_idx"
  ON "AffiliateWithdrawal" ("status");

COMMIT;
