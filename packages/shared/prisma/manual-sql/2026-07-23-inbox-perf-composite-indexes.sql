-- ============================================================================
-- Migration manual — 2026-07-23 — Índices compostos p/ perf do inbox (Onda 18.35)
-- ============================================================================
-- Suporta a query paginada da lista de conversas (ConversationsService.findAll):
--   WHERE tenant_id = ? [AND inbox_id = ?]  ORDER BY last_message_at DESC  LIMIT n
-- e o include de tasks abertas por conversa (WHERE conversation_id = ? AND status = ?).
--
-- ⚠️  CREATE INDEX CONCURRENTLY — NÃO PODE rodar dentro de transação.
--     NÃO envolver em BEGIN/COMMIT. Cada statement roda isolado e NÃO trava a
--     tabela para escrita (build online) — seguro em produção com tráfego.
--     Por isso este arquivo NÃO deve ser aplicado via `prisma migrate`
--     (que roda tudo numa transação e travaria). Aplicar manualmente na VPS.
--
-- Nomes idênticos aos que o Prisma gera (@@index no schema.prisma) → `prisma
-- migrate`/introspection consideram os índices já existentes, sem recriar.
--
-- IDEMPOTENTE (IF NOT EXISTS). Reexecutável.
-- ============================================================================

-- Conversation: tenant + ordenação por última mensagem (aba "Tudo"/setor sem inbox fixo)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Conversation_tenant_id_last_message_at_idx"
  ON "Conversation" ("tenant_id", "last_message_at" DESC);

-- Conversation: tenant + inbox + ordenação (filtro por setor/inbox específico)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Conversation_tenant_id_inbox_id_last_message_at_idx"
  ON "Conversation" ("tenant_id", "inbox_id", "last_message_at" DESC);

-- Task: include de tarefa aberta por conversa (conversation_id + status = 'A_FAZER')
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Task_conversation_id_status_idx"
  ON "Task" ("conversation_id", "status");

-- ============================================================================
-- Verificação manual:
--   SELECT indexname FROM pg_indexes
--    WHERE indexname IN (
--      'Conversation_tenant_id_last_message_at_idx',
--      'Conversation_tenant_id_inbox_id_last_message_at_idx',
--      'Task_conversation_id_status_idx'
--    );
--   Esperado: 3 linhas.
--
-- Se algum build CONCURRENTLY falhar no meio, o índice fica INVÁLIDO. Detectar:
--   SELECT c.relname FROM pg_index i
--     JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE NOT i.indisvalid
--      AND c.relname IN (
--        'Conversation_tenant_id_last_message_at_idx',
--        'Conversation_tenant_id_inbox_id_last_message_at_idx',
--        'Task_conversation_id_status_idx'
--      );
--   Se aparecer algum: DROP INDEX CONCURRENTLY "<nome>"; e reexecutar este arquivo.
-- ============================================================================
