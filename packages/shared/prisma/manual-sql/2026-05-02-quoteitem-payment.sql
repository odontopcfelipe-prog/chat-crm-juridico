-- ============================================================================
-- Migration manual — 2026-05-02 — QuoteItem.payment_method (Fase 25 Onda 4.2)
-- ============================================================================
-- Adiciona payment_method + installments_count em QuoteItem pra permitir
-- PAGAMENTO POR PROCEDIMENTO no MESMO orcamento.
--
-- Cenario real (estetica facial): paciente quer fechar:
--   - Botox (R$ 1200) -> pagar a vista no PIX (5% off, recebe na hora)
--   - Implante (R$ 4500) -> parcelar em 12x cartao (fluxo de caixa do cliente)
--
-- Antes: orcamento tinha 1 unico payment_terms (string) — paciente tinha
-- que escolher 1 metodo pra TUDO. Forçava a perder uma das vendas.
--
-- Agora: cada item pode ter seu metodo. NULL = usa default do quote.
--
-- Valores aceitos no payment_method (validado no DTO via @IsIn):
--   PIX | CASH | CARD | INSTALLMENTS | BOLETO | TRANSFER
--
-- installments_count: 1-24 (validado @Min(1) @Max(24)). So faz sentido
-- se payment_method = INSTALLMENTS.
--
-- IDEMPOTENTE.
-- ============================================================================

BEGIN;

-- 1) Coluna payment_method (opcional, nullable)
ALTER TABLE "QuoteItem"
  ADD COLUMN IF NOT EXISTS "payment_method" TEXT;

-- 2) Coluna installments_count (opcional, nullable)
ALTER TABLE "QuoteItem"
  ADD COLUMN IF NOT EXISTS "installments_count" INTEGER;

-- Sem index porque queries tipicas filtram por quote_id (que ja tem index)
-- e payment_method tem cardinalidade baixa (6 valores possiveis).

COMMIT;

-- ============================================================================
-- Verificacao manual:
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'QuoteItem' AND column_name IN ('payment_method', 'installments_count');
--   Esperado: payment_method | text | YES; installments_count | integer | YES
-- ============================================================================
