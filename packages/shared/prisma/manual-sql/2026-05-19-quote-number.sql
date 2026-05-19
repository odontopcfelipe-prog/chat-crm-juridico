-- Onda 14.18 — Adiciona quote_number sequencial por tenant
-- Idempotente: pode rodar varias vezes sem erro.

ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "quote_number" INTEGER NOT NULL DEFAULT 0;

-- Popula quotes existentes:
-- Numera sequencialmente por tenant_id (via Patient), ordenado por created_at asc.
-- ROW_NUMBER() garante 1, 2, 3... dentro de cada tenant.
WITH numbered AS (
  SELECT
    q.id,
    ROW_NUMBER() OVER (
      PARTITION BY p."tenant_id"
      ORDER BY q."created_at" ASC
    ) AS rn
  FROM "Quote" q
  JOIN "Patient" p ON p.id = q."patient_id"
  WHERE q."quote_number" = 0
)
UPDATE "Quote" q
SET "quote_number" = numbered.rn
FROM numbered
WHERE q.id = numbered.id;

-- Indice pra performance do MAX() na criacao
CREATE INDEX IF NOT EXISTS "Quote_quote_number_idx" ON "Quote" ("quote_number");
