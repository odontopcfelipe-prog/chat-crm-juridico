-- Adiciona EventReminder.last_error pra capturar motivo de falha.
--
-- Fase 25 (Onda 5e v24, Onda B) — operador precisa entender PORQUE um
-- lembrete falhou (telefone invalido, sem WhatsApp, Evolution offline, etc)
-- pra agir (corrigir cadastro, religar instancia, etc).
--
-- Antes: status FALHOU sem contexto = caixa-preta.
-- Agora: motivo legivel salvo no banco + exibido na aba Lembretes.
--
-- COMO RODAR (na VPS):
--   docker exec -i chatcrm_postgres psql -U chatcrm -d chatcrm < 2026-05-03-event-reminder-last-error.sql

ALTER TABLE "EventReminder" ADD COLUMN IF NOT EXISTS "last_error" TEXT;
