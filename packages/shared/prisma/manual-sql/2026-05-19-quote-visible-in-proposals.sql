-- Onda 14.21 — Adiciona visible_in_proposals pra esconder quotes da aba Propostas
-- sem deletar (continuam em Avaliacao/Orcamentos/Financeiro).
-- Idempotente: pode rodar varias vezes sem erro.

ALTER TABLE "Quote"
  ADD COLUMN IF NOT EXISTS "visible_in_proposals" BOOLEAN NOT NULL DEFAULT TRUE;
