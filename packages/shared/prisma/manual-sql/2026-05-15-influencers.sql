-- ============================================================================
-- Marketing — Influenciadores (cadastro de parcerias)
-- ============================================================================
-- Aditiva e idempotente: cria tabela "Influencer" + indexes se não existirem.
-- Não toca em nenhum model existente.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "Influencer" (
  "id"               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"        TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,

  "name"             TEXT NOT NULL,
  "handle"           TEXT,
  "phone"            TEXT,
  "email"            TEXT,

  "platform"         TEXT,
  "followers"        INTEGER,
  "niche"            TEXT,

  "commission_type"  TEXT,
  "commission_value" DECIMAL(10,2),
  "coupon_code"      TEXT,

  "status"           TEXT NOT NULL DEFAULT 'ATIVO',
  "notes"            TEXT,

  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "Influencer_tenant_id_coupon_code_key"
  ON "Influencer"("tenant_id", "coupon_code");

CREATE INDEX IF NOT EXISTS "Influencer_tenant_id_status_idx"
  ON "Influencer"("tenant_id", "status");

CREATE INDEX IF NOT EXISTS "Influencer_tenant_id_name_idx"
  ON "Influencer"("tenant_id", "name");
