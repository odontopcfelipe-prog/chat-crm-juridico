-- Onda 14.26 — Adiciona requires_credit_check pra parcelados desta venda.
-- Default true (rigoroso) pra preservar comportamento atual. Operador pode
-- setar false em vendas pra clientes VIP / valores baixos.
-- Idempotente: pode rodar varias vezes sem erro.

ALTER TABLE "Quote"
  ADD COLUMN IF NOT EXISTS "requires_credit_check" BOOLEAN NOT NULL DEFAULT TRUE;
