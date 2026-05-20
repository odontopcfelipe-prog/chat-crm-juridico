-- Onda 14.33 — Adiciona is_chosen_proposal pra marcar a proposta escolhida
-- pelo operador como "aguardando decisao do paciente". Visualmente destaca
-- o card e esmaece os demais na aba Propostas.
-- Idempotente: pode rodar varias vezes sem erro.

ALTER TABLE "Quote"
  ADD COLUMN IF NOT EXISTS "is_chosen_proposal" BOOLEAN NOT NULL DEFAULT FALSE;

-- Onda 14.33 — Index pra busca rapida da proposta escolhida do paciente
-- (so uma quote pode estar marcada por paciente por vez). PARTIAL index
-- pra economizar espaco (so registra rows com is_chosen_proposal=true).
CREATE INDEX IF NOT EXISTS "Quote_is_chosen_proposal_idx"
  ON "Quote" ("patient_id")
  WHERE "is_chosen_proposal" = TRUE;
