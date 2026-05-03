-- EventReminder: tracking de delivery via webhook Evolution.
--
-- Fase 25 (Onda 5e v25, Onda C) — antes do v25 so sabiamos se o reminder
-- foi DISPATCH (sent_at preenchido). Agora rastreamos entrega real:
--   - external_message_id: id da mensagem no Evolution (mesmo que Message)
--   - delivered_at: webhook DELIVERY_ACK (paciente recebeu no celular)
--   - read_at: webhook READ (paciente leu)
--
-- COMO RODAR (na VPS):
--   docker exec -i chatcrm_postgres psql -U chatcrm -d chatcrm < 2026-05-03-event-reminder-delivery-tracking.sql

ALTER TABLE "EventReminder" ADD COLUMN IF NOT EXISTS "external_message_id" TEXT;
ALTER TABLE "EventReminder" ADD COLUMN IF NOT EXISTS "delivered_at"        TIMESTAMP(3);
ALTER TABLE "EventReminder" ADD COLUMN IF NOT EXISTS "read_at"             TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "EventReminder_external_message_id_idx"
  ON "EventReminder" ("external_message_id");
