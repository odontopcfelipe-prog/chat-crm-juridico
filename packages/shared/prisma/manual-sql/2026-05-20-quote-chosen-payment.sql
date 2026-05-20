-- Onda 14.38 — Persiste forma de pagamento + entrada quando operador
-- "Salva proposta" no painel da aba Propostas. Permite PDF do orcamento
-- mostrar a oferta exata apresentada ao paciente.
-- Idempotente: pode rodar varias vezes sem erro.

ALTER TABLE "Quote"
  ADD COLUMN IF NOT EXISTS "chosen_payment_key" TEXT;

ALTER TABLE "Quote"
  ADD COLUMN IF NOT EXISTS "chosen_down_payment" DECIMAL(10,2) DEFAULT 0;
