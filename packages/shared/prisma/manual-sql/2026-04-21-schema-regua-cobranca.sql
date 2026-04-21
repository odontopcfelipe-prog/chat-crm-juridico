-- ============================================================================
-- Migration manual — 2026-04-21 — Regua de Cobranca (Fase 11)
-- ============================================================================
-- Cria 2 tabelas: Installment + CollectionAttempt.
--
-- Aplicacao:
--   psql "$DATABASE_URL" -f 2026-04-21-schema-regua-cobranca.sql
--
-- IDEMPOTENTE (IF NOT EXISTS).
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Installment — parcela first-class
-- ============================================================================

CREATE TABLE IF NOT EXISTS "Installment" (
  "id"                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"          TEXT NOT NULL,
  "patient_id"         TEXT NOT NULL,
  "quote_id"           TEXT,
  "sequence"           INTEGER NOT NULL DEFAULT 1,
  "total_count"        INTEGER NOT NULL DEFAULT 1,
  "amount"             DECIMAL(10, 2) NOT NULL,
  "amount_paid"        DECIMAL(10, 2) NOT NULL DEFAULT 0,
  "discount_value"     DECIMAL(10, 2) NOT NULL DEFAULT 0,
  "fee_value"          DECIMAL(10, 2) NOT NULL DEFAULT 0,
  "due_date"           TIMESTAMP(3) NOT NULL,
  "paid_at"            TIMESTAMP(3),
  "payment_method"     TEXT,
  "status"             TEXT NOT NULL DEFAULT 'ABERTA',
  "gateway_charge_id"  TEXT UNIQUE,
  "nota_fiscal_id"     TEXT UNIQUE,
  "renegotiated_to_id" TEXT,
  "collection_stage"   TEXT,
  "last_collection_at" TIMESTAMP(3),
  "notes"              TEXT,
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Installment_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Installment_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Installment_quote_id_fkey"
    FOREIGN KEY ("quote_id") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Installment_renegotiated_to_id_fkey"
    FOREIGN KEY ("renegotiated_to_id") REFERENCES "Installment"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "Installment_tenant_due_date_idx" ON "Installment"("tenant_id", "due_date");
CREATE INDEX IF NOT EXISTS "Installment_patient_status_idx" ON "Installment"("patient_id", "status");
CREATE INDEX IF NOT EXISTS "Installment_status_due_date_idx" ON "Installment"("status", "due_date");
CREATE INDEX IF NOT EXISTS "Installment_quote_sequence_idx" ON "Installment"("quote_id", "sequence");
CREATE INDEX IF NOT EXISTS "Installment_gateway_charge_id_idx" ON "Installment"("gateway_charge_id");

-- ============================================================================
-- 2. CollectionAttempt — tentativa de cobranca por canal/etapa
-- ============================================================================

CREATE TABLE IF NOT EXISTS "CollectionAttempt" (
  "id"              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "installment_id"  TEXT NOT NULL,
  "stage"           TEXT NOT NULL,
  "channel"         TEXT NOT NULL,
  "message_text"    TEXT,
  "sent_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "delivery_status" TEXT,
  "response_at"     TIMESTAMP(3),
  "response_text"   TEXT,
  "message_id"      TEXT,
  CONSTRAINT "CollectionAttempt_installment_id_fkey"
    FOREIGN KEY ("installment_id") REFERENCES "Installment"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "CollectionAttempt_installment_stage_idx" ON "CollectionAttempt"("installment_id", "stage");
CREATE INDEX IF NOT EXISTS "CollectionAttempt_sent_at_idx" ON "CollectionAttempt"("sent_at");
CREATE INDEX IF NOT EXISTS "CollectionAttempt_delivery_status_idx" ON "CollectionAttempt"("delivery_status");

COMMIT;

-- ============================================================================
-- POS-INSTALACAO:
--   cd packages/shared && npx prisma generate
--
-- (Opcional) Gerar parcelas para Quotes ja ACCEPTED:
--   POST /quotes/:id/generate-installments — endpoint criado no PR backend
-- ============================================================================
