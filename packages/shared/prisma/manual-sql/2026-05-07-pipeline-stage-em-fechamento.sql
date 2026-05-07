-- ============================================================================
-- Migration manual — 2026-05-07 — Funil 2 (Em Fechamento) + is_hidden_from_kanban
-- ============================================================================
-- Reestrutura o funil CRM pra graduar leads quando o orcamento eh criado.
--
-- Antes:
--   ... -> Avaliacao Aceita -> Avaliacao Realizada -> Assinatura do Contrato
--          -> Contrato Assinado (won) | Perdido (lost)
--
-- Depois:
--   ... -> Avaliacao Aceita -> [Em Fechamento (hidden)] -> Contrato Assinado (won) | Perdido (lost)
--
-- A coluna "Em Fechamento" eh oculta do Kanban CRM (`is_hidden_from_kanban=true`).
-- O lead vai pra la automaticamente quando a dra cria orcamento via
-- /atendimento/pacientes/[id] (hook em QuotesService.create). Ele continua
-- visivel em /atendimento/fechamentos pelo Quote vinculado.
--
-- Templates afetados (slugs do Pipeline): estetica-facial, implantes,
-- ortodontia, protese, facetas-resina, clareamento, lentes-porcelana.
-- Os funis 'odonto-clinico' e 'b2b' tem fluxo proprio (sem Aval Realizada/
-- Assinatura) e nao sao afetados.
--
-- Migracao de dados:
--   - Leads em 'avaliacao-realizada' OU 'assinatura-contrato' -> 'em-fechamento'
--   - Stages antigos sao removidos APOS migrar os leads (sem orfaos)
--
-- IDEMPOTENTE — pode rodar varias vezes sem efeito colateral.
-- ============================================================================

BEGIN;

-- ─── Schema: nova flag is_hidden_from_kanban ────────────────────────────────

ALTER TABLE "PipelineStage"
  ADD COLUMN IF NOT EXISTS "is_hidden_from_kanban" BOOLEAN NOT NULL DEFAULT false;

-- ─── Cria stage 'em-fechamento' nos pipelines afetados ──────────────────────
-- Position 7 (entre Avaliacao Aceita @ 6 e Contrato Assinado @ 8/9).
-- Eh oculto do Kanban (is_hidden_from_kanban=true) — vive so no Fechamentos.

INSERT INTO "PipelineStage" (
  id, pipeline_id, name, slug, color, emoji, description,
  position, is_initial, is_won, is_lost, is_hidden_from_kanban,
  auto_actions, created_at, updated_at
)
SELECT
  gen_random_uuid()::text,
  p.id,
  'Em Fechamento',
  'em-fechamento',
  '#0d9488',
  '📝',
  'Orcamento criado pela dra. Lead saiu do funil de captacao e vive em /atendimento/fechamentos. Quando o ClickSign assinar, vai pra Contrato Assinado.',
  7,
  false, false, false, true,
  NULL,
  NOW(), NOW()
FROM "Pipeline" p
WHERE p.slug IN (
  'estetica-facial', 'implantes', 'ortodontia', 'protese',
  'facetas-resina', 'clareamento', 'lentes-porcelana'
)
AND NOT EXISTS (
  SELECT 1 FROM "PipelineStage" s
  WHERE s.pipeline_id = p.id AND s.slug = 'em-fechamento'
);

-- ─── Migra leads existentes ─────────────────────────────────────────────────
-- Leads em 'avaliacao-realizada' OU 'assinatura-contrato' viram 'em-fechamento'.
-- Atualiza tanto `stage_id` (pipeline dinamico) quanto `stage` (legado String).

UPDATE "Lead" l
SET
  stage_id = ef.id,
  stage = 'EM_FECHAMENTO',
  stage_entered_at = NOW()
FROM "PipelineStage" old, "PipelineStage" ef
WHERE l.stage_id = old.id
  AND old.slug IN ('avaliacao-realizada', 'assinatura-contrato')
  AND ef.pipeline_id = old.pipeline_id
  AND ef.slug = 'em-fechamento';

-- ─── Remove stages antigos vazios (depois de migrar) ────────────────────────
-- Soft check: so remove se nao houver lead apontando.

DELETE FROM "PipelineStage" s
WHERE s.slug IN ('avaliacao-realizada', 'assinatura-contrato')
  AND NOT EXISTS (
    SELECT 1 FROM "Lead" l WHERE l.stage_id = s.id
  );

-- ─── Reposiciona Contrato Assinado e Perdido apos remocao ───────────────────
-- Antes: Contrato Assinado @ 9, Perdido @ 10
-- Depois: Contrato Assinado @ 8, Perdido @ 9
-- Idempotente: so atualiza se a position atual for a antiga.

UPDATE "PipelineStage" s
SET position = 8
FROM "Pipeline" p
WHERE s.pipeline_id = p.id
  AND p.slug IN (
    'estetica-facial', 'implantes', 'ortodontia', 'protese',
    'facetas-resina', 'clareamento', 'lentes-porcelana'
  )
  AND s.slug = 'contrato-assinado'
  AND s.position = 9;

UPDATE "PipelineStage" s
SET position = 9
FROM "Pipeline" p
WHERE s.pipeline_id = p.id
  AND p.slug IN (
    'estetica-facial', 'implantes', 'ortodontia', 'protese',
    'facetas-resina', 'clareamento', 'lentes-porcelana'
  )
  AND s.slug = 'perdido'
  AND s.position = 10;

COMMIT;

-- ============================================================================
-- Verificacao manual:
--
-- 1) Coluna nova existe:
--    SELECT column_name, data_type, column_default
--    FROM information_schema.columns
--    WHERE table_name = 'PipelineStage' AND column_name = 'is_hidden_from_kanban';
--    Esperado: is_hidden_from_kanban | boolean | false
--
-- 2) Stage 'em-fechamento' criado em todos os 7 pipelines afetados:
--    SELECT p.slug AS pipeline, s.name, s.position, s.is_hidden_from_kanban
--    FROM "PipelineStage" s
--    JOIN "Pipeline" p ON p.id = s.pipeline_id
--    WHERE s.slug = 'em-fechamento'
--    ORDER BY p.slug;
--    Esperado: 7 linhas, todas com is_hidden_from_kanban=true
--
-- 3) Stages antigos removidos (sem leads vinculados):
--    SELECT slug, COUNT(*) FROM "PipelineStage"
--    WHERE slug IN ('avaliacao-realizada', 'assinatura-contrato')
--    GROUP BY slug;
--    Esperado: 0 linhas (se ainda houver, e' porque algum lead ficou la')
--
-- 4) Leads movidos:
--    SELECT s.slug, COUNT(l.id)
--    FROM "Lead" l
--    JOIN "PipelineStage" s ON s.id = l.stage_id
--    WHERE s.slug IN ('em-fechamento', 'avaliacao-realizada', 'assinatura-contrato')
--    GROUP BY s.slug;
--    Esperado: so 'em-fechamento' deve aparecer (com a soma dos que estavam antes)
-- ============================================================================
