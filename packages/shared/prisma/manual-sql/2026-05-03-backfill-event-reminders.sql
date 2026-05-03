-- Backfill de EventReminder pra eventos futuros que estao SEM lembretes.
--
-- Fase 25 (Onda 5e v19) — diagnostico revelou que CalendarEvents existentes
-- nao tem EventReminders associados. Sem isso, o worker nunca dispara
-- WhatsApp pro paciente nem pro dentista.
--
-- ESTRATEGIA:
--   - Cria 3 reminders default por evento futuro de CONSULTA/PROCEDIMENTO/RETORNO:
--     * 1440 min antes (1 dia)
--     * 60 min antes (1 hora)
--     * 15 min antes (faltam pouquinho) — v26: alinhado com UI/IA
--   - Canal: WHATSAPP
--   - sent_at: NULL (= pendente)
--   - So cria pra eventos com lead vinculado (sem lead, nao tem pra quem mandar)
--   - Idempotente: usa LEFT JOIN na tabela EventReminder pra nao duplicar
--     se ja existir reminder com mesma antecedencia pro evento
--
-- COMO RODAR (na VPS):
--   docker exec -i chatcrm_postgres psql -U chatcrm -d chatcrm < 2026-05-03-backfill-event-reminders.sql
--
-- IMPORTANTE: ROW_NUMBER + gen_random_uuid garantem ID unico por linha inserida.
-- A query so insere se NAO existir reminder com mesma minutes_before pro mesmo evento.

INSERT INTO "EventReminder" (id, event_id, minutes_before, channel, sent_at, created_at)
SELECT
  gen_random_uuid()::text,
  ce.id,
  defaults.minutes_before,
  'WHATSAPP',
  NULL,
  NOW()
FROM "CalendarEvent" ce
CROSS JOIN (VALUES (1440), (60), (15)) AS defaults(minutes_before)
WHERE ce.start_at >= NOW()
  AND ce.type IN ('CONSULTA', 'PROCEDIMENTO', 'RETORNO')
  AND ce.status NOT IN ('CANCELADO', 'CONCLUIDO')
  AND ce.lead_id IS NOT NULL
  -- Nao duplica: so insere se nao existe reminder com mesma antecedencia
  AND NOT EXISTS (
    SELECT 1 FROM "EventReminder" er
    WHERE er.event_id = ce.id
      AND er.minutes_before = defaults.minutes_before
  );

-- Verificacao
SELECT
  COUNT(*) AS reminders_criados_no_total,
  (SELECT COUNT(*) FROM "EventReminder" WHERE sent_at IS NULL) AS pendentes_total
FROM "EventReminder";

-- Lista preview do que ficou enfileirado
SELECT
  ce.title,
  l.name AS paciente,
  ce.start_at,
  er.minutes_before,
  er.channel
FROM "EventReminder" er
JOIN "CalendarEvent" ce ON er.event_id = ce.id
LEFT JOIN "Lead" l ON ce.lead_id = l.id
WHERE ce.start_at >= NOW()
  AND er.sent_at IS NULL
ORDER BY ce.start_at ASC, er.minutes_before DESC
LIMIT 30;
