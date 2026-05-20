-- Onda 14.30 — Adiciona selected_documents array no Contract pra operador
-- escolher quais documentos extras vao ser incluidos junto com o contrato
-- principal pra assinatura (TCLE/Termo de imagem/LGPD/Garantia/etc).
-- Idempotente: pode rodar varias vezes sem erro.

ALTER TABLE "Contract"
  ADD COLUMN IF NOT EXISTS "selected_documents" JSONB NOT NULL DEFAULT '[]'::jsonb;
