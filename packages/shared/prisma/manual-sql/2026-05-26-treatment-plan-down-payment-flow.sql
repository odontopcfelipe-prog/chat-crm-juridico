-- Onda 14.59 — Fluxo de cobranca da entrada (sinal + restante + auto-trigger)
--
-- Adiciona campos pra orquestrar:
--   1. Operador clica "emitir cobranca da entrada" -> grava down_payment_emitted_at
--   2. Asaas webhook ou marcar-em-especie confirma sinal+entrada
--   3. Trigger gera as parcelas + atualiza proposal_status pra APPROVED
--   4. installments_generated_at evita gerar 2x (idempotencia)
--
-- Compativel com proposals legados: proposal_status default DRAFT,
-- kind default null em charges existentes (sao installments comuns).

-- ─── TreatmentPlan ──────────────────────────────────────────────
ALTER TABLE "TreatmentPlan"
  ADD COLUMN IF NOT EXISTS "proposal_status" TEXT NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN IF NOT EXISTS "clicksign_send_timing" TEXT,
  ADD COLUMN IF NOT EXISTS "down_payment_emitted_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "installments_generated_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "TreatmentPlan_proposal_status_idx"
  ON "TreatmentPlan"("proposal_status");

-- ─── PaymentGatewayCharge ────────────────────────────────────────
ALTER TABLE "PaymentGatewayCharge"
  ADD COLUMN IF NOT EXISTS "treatment_plan_id" TEXT,
  ADD COLUMN IF NOT EXISTS "kind" TEXT,
  ADD COLUMN IF NOT EXISTS "received_in_cash" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "received_by_user_id" TEXT,
  ADD COLUMN IF NOT EXISTS "received_at" TIMESTAMP(3);

-- FK pro TreatmentPlan (SetNull se plan apagado, charges historicas continuam)
ALTER TABLE "PaymentGatewayCharge"
  DROP CONSTRAINT IF EXISTS "PaymentGatewayCharge_treatment_plan_id_fkey";

ALTER TABLE "PaymentGatewayCharge"
  ADD CONSTRAINT "PaymentGatewayCharge_treatment_plan_id_fkey"
  FOREIGN KEY ("treatment_plan_id")
  REFERENCES "TreatmentPlan"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "PaymentGatewayCharge_treatment_plan_id_kind_idx"
  ON "PaymentGatewayCharge"("treatment_plan_id", "kind");
