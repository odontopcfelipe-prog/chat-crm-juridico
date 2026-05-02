-- ============================================================================
-- Migration manual — 2026-05-02 — Metricas de engajamento Quote (Fase 25 Onda 4.3)
-- ============================================================================
-- Adiciona campos de tracking de envelope/engajamento WhatsApp + portal:
--
-- Cenario: operadora envia orcamento via WhatsApp, depois quer saber:
--   "O paciente leu? Entrou no portal? Quantas vezes? Quando foi ultima vez?"
--   pra decidir se faz follow-up ou nao.
--
-- Antes: zero visibilidade pos-envio. Operadora ligava sem saber se cliente
-- ja viu o link.
--
-- Agora 4 campos novos:
--   whatsapp_message_id: id retornado pela Evolution API ao enviar — usado
--                        pra cruzar com webhook messages.update (read=true)
--                        e popular read_at (TODO: webhook handler — Onda 4.3b)
--   whatsapp_read_at: momento que paciente leu o WhatsApp (do double check
--                     azul) — populado por webhook (TODO Onda 4.3b)
--   portal_view_count: quantas vezes o magic link foi aberto (proxy de
--                      interesse; cliente que abre 5x ta considerando)
--   portal_last_viewed_at: ultimo acesso (UI mostra "ha 3h" pra ajudar
--                          recepcao decidir momento de follow-up)
--
-- Populacao automatica:
--   - whatsapp_message_id: ja implementado em quotes.service.sendByWhatsapp()
--   - portal_view_count + portal_last_viewed_at: endpoint publico
--     POST /quotes/:id/track-view (chamado pelo frontend do portal ao abrir)
--   - whatsapp_read_at: PENDENTE (precisa webhook handler em messages.update)
--
-- IDEMPOTENTE.
-- ============================================================================

BEGIN;

ALTER TABLE "Quote"
  ADD COLUMN IF NOT EXISTS "whatsapp_message_id"   TEXT,
  ADD COLUMN IF NOT EXISTS "whatsapp_read_at"      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "portal_view_count"     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "portal_last_viewed_at" TIMESTAMP(3);

-- Sem index pra portal_view_count (cardinalidade alta + queries normais
-- vao por id direto). whatsapp_message_id eventualmente precisa de index
-- pro webhook lookup, mas adicionamos quando implementar o handler.

COMMIT;

-- ============================================================================
-- Verificacao manual:
--   SELECT column_name, data_type, column_default, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'Quote' AND column_name IN (
--     'whatsapp_message_id','whatsapp_read_at','portal_view_count','portal_last_viewed_at'
--   );
--   Esperado:
--     whatsapp_message_id  | text                           | NULL | YES
--     whatsapp_read_at     | timestamp without time zone    | NULL | YES
--     portal_view_count    | integer                        | 0    | NO
--     portal_last_viewed_at| timestamp without time zone    | NULL | YES
-- ============================================================================
