-- ============================================================================
-- Migration manual — 2026-05-02 — SkillExecutionLog com tenant_id
-- (Fase 25 Onda 2.4)
-- ============================================================================
-- ANTES: SkillExecutionLog sem tenant_id.
--   Dashboard "qual skill IA mais usada na clinica X" exigia join via
--   Conversation -> Lead. Pesado em tabelas grandes.
--   Auditoria entre tenants poluida (logs de todos juntos).
--
-- DEPOIS: tenant_id String obrigatorio + index [tenant_id, created_at].
--   Query direta de uso por clinica.
--   Isolamento de auditoria.
--
-- DECISAO ARQUITETURAL (importante registrar): PromptSkill, SkillTool,
-- SkillAsset CONTINUAM SEM tenant_id. Sao GLOBAIS — produto compartilhado
-- entre todas as clinicas (catalogo de skills da plataforma). Apenas o
-- LOG de execucao eh per-tenant. Se no futuro quiser permitir skills
-- customizadas por tenant, adiciona tenant_id String? opcional nesses 3.
--
-- IDEMPOTENTE.
-- ============================================================================

BEGIN;

-- 1) Adiciona coluna tenant_id com DEFAULT dummy pros existentes,
--    depois remove o DEFAULT (forca app a passar valor real).
ALTER TABLE "SkillExecutionLog"
  ADD COLUMN IF NOT EXISTS "tenant_id" TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

ALTER TABLE "SkillExecutionLog"
  ALTER COLUMN "tenant_id" DROP DEFAULT;

-- 2) Index composto pra dashboard de uso por tenant
CREATE INDEX IF NOT EXISTS "SkillExecutionLog_tenant_id_created_at_idx"
  ON "SkillExecutionLog"("tenant_id", "created_at");

COMMIT;

-- ============================================================================
-- Verificacao manual:
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'SkillExecutionLog' AND column_name = 'tenant_id';
--   Esperado: tenant_id | text | NO
--
--   SELECT indexname FROM pg_indexes WHERE tablename = 'SkillExecutionLog';
--   Esperado: SkillExecutionLog_pkey, _conversation_id_created_at_idx,
--             _skill_id_idx, _tenant_id_created_at_idx
-- ============================================================================
