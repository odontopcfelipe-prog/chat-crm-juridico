-- ============================================================================
-- Migration manual — 2026-05-02 — AiUsage com tenant_id + cost_usd Decimal
-- (Fase 25 Onda 2.2)
-- ============================================================================
-- ANTES (problema critico):
--   - AiUsage.tenant_id AUSENTE
--     => clinica A podia ler custos de IA da clinica B via query direta.
--        Vazamento entre tenants.
--   - AiUsage.cost_usd Float (precisao incorreta)
--     => SUM/AVG acumulam imprecisao em centavos.
--
-- DEPOIS (corrigido):
--   - tenant_id String OBRIGATORIO (registros existentes recebem tenant
--     dummy '00000000-0000-0000-0000-000000000000' como fallback)
--   - cost_usd Decimal(10, 6) — 6 casas decimais cobrem custos pequenos
--     (1 token Sonnet ~ $0.000003)
--   - novo index composto [tenant_id, created_at] pra dashboard
--
-- IDEMPOTENTE (IF NOT EXISTS / DO blocks).
-- ============================================================================

BEGIN;

-- 1) Adiciona coluna tenant_id com DEFAULT dummy pros existentes,
--    depois remove o DEFAULT pra forcar app code a passar valor real.
ALTER TABLE "AiUsage"
  ADD COLUMN IF NOT EXISTS "tenant_id" TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

ALTER TABLE "AiUsage"
  ALTER COLUMN "tenant_id" DROP DEFAULT;

-- 2) Migra cost_usd de Float (DOUBLE PRECISION) pra Decimal(10, 6)
--    USING cast preserva valores existentes (Float -> Decimal sem perda
--    significativa porque os valores ja sao pequenos < $1).
ALTER TABLE "AiUsage"
  ALTER COLUMN "cost_usd" TYPE DECIMAL(10, 6)
  USING "cost_usd"::DECIMAL(10, 6);

-- 3) Garante DEFAULT 0 (apos a conversao de tipo)
ALTER TABLE "AiUsage"
  ALTER COLUMN "cost_usd" SET DEFAULT 0;

-- 4) Index composto pra query rapida "custo IA por mes do tenant X"
CREATE INDEX IF NOT EXISTS "AiUsage_tenant_id_created_at_idx"
  ON "AiUsage"("tenant_id", "created_at");

COMMIT;

-- ============================================================================
-- Verificacao manual apos rodar:
--
--   SELECT column_name, data_type, numeric_precision, numeric_scale, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'AiUsage' AND column_name IN ('tenant_id', 'cost_usd');
--
-- Esperado:
--   tenant_id  | text    |      |   | NO
--   cost_usd   | numeric |  10  | 6 | NO
--
-- Indexes esperados:
--   SELECT indexname FROM pg_indexes WHERE tablename = 'AiUsage';
--   => AiUsage_pkey, AiUsage_created_at_idx, AiUsage_model_idx,
--      AiUsage_conversation_id_idx, AiUsage_tenant_id_created_at_idx
-- ============================================================================
