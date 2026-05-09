-- ============================================================================
-- Migration manual — 2026-05-09 — StateProcedureSuggestion (Onda 3.2)
-- ============================================================================
-- Cria a tabela de mapping de estado clinico -> procedimento sugerido.
-- Quando dentista anota um estado num dente (CARIE, EXTRACAO_INDICADA, etc.),
-- sistema sugere automaticamente um procedimento configurado pelo tenant.
--
-- IDEMPOTENTE — pode ser rodada multiplas vezes sem efeito colateral.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS "StateProcedureSuggestion" (
    "id"           TEXT NOT NULL,
    "tenant_id"    TEXT NOT NULL,
    "state"        TEXT NOT NULL,
    "procedure_id" TEXT NOT NULL,
    "priority"     INTEGER NOT NULL DEFAULT 0,
    "active"       BOOLEAN NOT NULL DEFAULT true,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StateProcedureSuggestion_pkey" PRIMARY KEY ("id")
);

-- Garantia de FK + cascade. Idempotente (DROP IF EXISTS antes pra evitar duplicar).
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'StateProcedureSuggestion_tenant_id_fkey'
    ) THEN
        ALTER TABLE "StateProcedureSuggestion"
            ADD CONSTRAINT "StateProcedureSuggestion_tenant_id_fkey"
            FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'StateProcedureSuggestion_procedure_id_fkey'
    ) THEN
        ALTER TABLE "StateProcedureSuggestion"
            ADD CONSTRAINT "StateProcedureSuggestion_procedure_id_fkey"
            FOREIGN KEY ("procedure_id") REFERENCES "Procedure"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- Unique: mesmo (tenant, estado, procedimento) so pode existir uma vez.
-- Permite multiplas sugestoes pro mesmo estado (ex: CARIE pode sugerir
-- "Restauracao resina" E "Restauracao amalgama" — priority decide ordem).
CREATE UNIQUE INDEX IF NOT EXISTS "StateProcedureSuggestion_tenant_id_state_procedure_id_key"
    ON "StateProcedureSuggestion" ("tenant_id", "state", "procedure_id");

CREATE INDEX IF NOT EXISTS "StateProcedureSuggestion_tenant_id_state_active_idx"
    ON "StateProcedureSuggestion" ("tenant_id", "state", "active");

COMMIT;

-- ============================================================================
-- POS-INSTALACAO:
--   cd packages/shared && npx prisma generate
-- ============================================================================
