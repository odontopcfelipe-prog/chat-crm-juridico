#!/bin/bash
# ============================================================================
# VPS Deploy — Pos-atendimento (pesquisa de satisfacao automatica) — 2026-05-09
# ============================================================================
# Standalone (SQL embutido). Uso na VPS:
#
#   bash scripts/vps-apply-post-care.sh
#
# O que faz:
#   1) Detecta postgres
#   2) Backup das tabelas afetadas
#   3) Cria tabela PostCareSurvey (idempotente)
#   4) Force-update services chatcrm_api/worker/web
# ============================================================================

set -e

PG=$(docker ps --filter "name=postgres" --format "{{.Names}}" | head -n1)
[ -z "$PG" ] && PG=$(docker ps --filter "ancestor=postgres:15-alpine" --format "{{.Names}}" | head -n1)
if [ -z "$PG" ]; then echo "❌ container postgres nao encontrado"; exit 1; fi
PGUSER=$(docker exec "$PG" sh -c 'echo "$POSTGRES_USER"' | tr -d '\r')
PGDB=$(docker exec "$PG" sh -c 'echo "$POSTGRES_DB"' | tr -d '\r')
PGUSER="${PGUSER:-crm_user}"; PGDB="${PGDB:-lexcrm}"
echo "📦 $PG · $PGDB"

echo "💾 Backup..."
docker exec "$PG" pg_dump -U "$PGUSER" -d "$PGDB" -t '"PostCareSurvey"' 2>/dev/null | gzip > "/tmp/backup-postcare-$(date +%F-%H%M).sql.gz" || true

echo "🔧 Criando tabela PostCareSurvey..."
docker exec -i "$PG" psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;

CREATE TABLE IF NOT EXISTS "PostCareSurvey" (
  "id"                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id"            TEXT NOT NULL,
  "patient_id"           TEXT NOT NULL,
  "appointment_id"       TEXT UNIQUE,
  "dentist_id"           TEXT,
  "procedure_summary"    TEXT,
  "trigger_at"           TIMESTAMP(3) NOT NULL,
  "sent_at"              TIMESTAMP(3),
  "status"               TEXT NOT NULL DEFAULT 'PENDING',
  "score"                INTEGER,
  "sentiment"            TEXT,
  "comment"              TEXT,
  "responded_at"         TIMESTAMP(3),
  "escalated_at"         TIMESTAMP(3),
  "evolution_message_id" TEXT,
  "last_error"           TEXT,
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PostCareSurvey_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PostCareSurvey_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PostCareSurvey_appointment_id_fkey"
    FOREIGN KEY ("appointment_id") REFERENCES "CalendarEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "PostCareSurvey_dentist_id_fkey"
    FOREIGN KEY ("dentist_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "PostCareSurvey_tenant_status_trigger_idx" ON "PostCareSurvey"("tenant_id", "status", "trigger_at");
CREATE INDEX IF NOT EXISTS "PostCareSurvey_tenant_sentiment_idx"      ON "PostCareSurvey"("tenant_id", "sentiment");
CREATE INDEX IF NOT EXISTS "PostCareSurvey_patient_sent_idx"          ON "PostCareSurvey"("patient_id", "sent_at");

COMMIT;
SQL

echo "   ✅ Tabela criada"

echo "🚀 Force-update services..."
for svc in chatcrm_api chatcrm_worker chatcrm_web; do
  if docker service ls --filter "name=$svc" --format "{{.Name}}" 2>/dev/null | grep -q "^$svc$"; then
    suf="${svc#chatcrm_}"
    docker service update --force --image "odontopassos/chat-crm-juridico-${suf}:latest" "$svc" >/dev/null
    echo "  ✓ $svc"
  fi
done

echo "✅ Pronto. Aguarde 30-60s pros containers reiniciarem."
docker service ls --filter "name=chatcrm_" 2>/dev/null || docker ps --filter "name=chatcrm" --format "table {{.Names}}\t{{.Status}}"
