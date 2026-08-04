-- Cria a tabela PaymentNotifyDedup (dedup do "Pagamento Confirmado" por payment.id).
-- Normalmente o `prisma db push` do deploy cria sozinho; use ISTO só se ele não rodou
-- (o handleWebhook é fail-open: sem a tabela, a dedup não trava e volta o duplo).
--
-- Rodar no container da API:
--   docker exec -i <api_container> psql "$DATABASE_URL" < scripts/create-payment-notify-dedup.sql
-- (ou docker cp o arquivo e psql -f)

CREATE TABLE IF NOT EXISTS "PaymentNotifyDedup" (
  "external_id" TEXT PRIMARY KEY,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
