-- Onda 14.58 — Entrada dividida em Sinal + Entrada + data de inicio das parcelas
--
-- Adiciona 4 campos opcionais ao Quote pra modelar o cenario comum em odontologia:
--  - Sinal (R$ X paga HOJE via PIX/Boleto a vista) — pra fechar a venda na hora
--  - Entrada (R$ Y, boleto com vencimento configuravel) — geralmente fim do mes
--  - Parcelas (N boletos, primeira parcela na data configurada) — meses seguintes
--
-- Backwards-compat: todos os campos sao nullable. Quando chosen_signal_value=0
-- e datas nulas, o comportamento legado eh preservado (entrada unica paga junto
-- com a 1a parcela).

ALTER TABLE "Quote"
  ADD COLUMN IF NOT EXISTS "chosen_signal_value" DECIMAL(10, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "chosen_signal_method" TEXT,
  ADD COLUMN IF NOT EXISTS "chosen_entrada_due_date" DATE,
  ADD COLUMN IF NOT EXISTS "chosen_installments_start_date" DATE;

-- Comentarios pra documentar no banco
COMMENT ON COLUMN "Quote"."chosen_signal_value" IS 'Onda 14.58 — Parte da entrada paga no fechamento (R$). 0 = sem sinal (entrada unica).';
COMMENT ON COLUMN "Quote"."chosen_signal_method" IS 'Onda 14.58 — Metodo do sinal: PIX ou BOLETO.';
COMMENT ON COLUMN "Quote"."chosen_entrada_due_date" IS 'Onda 14.58 — Data de vencimento do boleto da entrada (R$ restante apos sinal).';
COMMENT ON COLUMN "Quote"."chosen_installments_start_date" IS 'Onda 14.58 — Data de vencimento da 1a parcela (parcelas seguem mensais).';
