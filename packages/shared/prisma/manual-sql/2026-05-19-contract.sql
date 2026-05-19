-- Onda 14.24 — Cria Contract e ContractEvent vinculados ao Quote.
-- Gate entre proposta aceita e geracao de cobranca. Fase 1 (manual);
-- Fase 2 vai integrar com ClickSign.
-- Idempotente: pode rodar varias vezes sem erro.

CREATE TABLE IF NOT EXISTS "Contract" (
  "id"                    TEXT PRIMARY KEY,
  "quote_id"              TEXT NOT NULL UNIQUE,
  "template_type"         TEXT NOT NULL,
  "status"                TEXT NOT NULL DEFAULT 'DRAFT',
  "skipped"               BOOLEAN NOT NULL DEFAULT FALSE,
  "skipped_reason"        TEXT,
  "skipped_at"            TIMESTAMP(3),
  "clicksign_document_id" TEXT,
  "signing_url"           TEXT,
  "pdf_url"               TEXT,
  "sent_at"               TIMESTAMP(3),
  "opened_at"             TIMESTAMP(3),
  "patient_signed_at"     TIMESTAMP(3),
  "clinic_signed_at"      TIMESTAMP(3),
  "signed_at"             TIMESTAMP(3),
  "expires_at"            TIMESTAMP(3),
  "cancelled_at"          TIMESTAMP(3),
  "cancellation_reason"   TEXT,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by_user_id"    TEXT NOT NULL,

  CONSTRAINT "Contract_quote_id_fkey"
    FOREIGN KEY ("quote_id") REFERENCES "Quote"("id") ON DELETE CASCADE,
  CONSTRAINT "Contract_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "User"("id") ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS "Contract_status_idx" ON "Contract" ("status");
CREATE INDEX IF NOT EXISTS "Contract_clicksign_document_id_idx"
  ON "Contract" ("clicksign_document_id");

CREATE TABLE IF NOT EXISTS "ContractEvent" (
  "id"                   TEXT PRIMARY KEY,
  "contract_id"          TEXT NOT NULL,
  "event_type"           TEXT NOT NULL,
  "description"          TEXT,
  "triggered_by_user_id" TEXT,
  "occurred_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ContractEvent_contract_id_fkey"
    FOREIGN KEY ("contract_id") REFERENCES "Contract"("id") ON DELETE CASCADE,
  CONSTRAINT "ContractEvent_triggered_by_user_id_fkey"
    FOREIGN KEY ("triggered_by_user_id") REFERENCES "User"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "ContractEvent_contract_id_occurred_at_idx"
  ON "ContractEvent" ("contract_id", "occurred_at");
