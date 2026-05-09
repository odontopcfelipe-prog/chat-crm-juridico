#!/bin/bash
# ============================================================================
# VPS Deploy — Anamnese: prova eletronica de preenchimento (2026-05-08)
# ============================================================================
# Script STANDALONE: nao depende de GitHub raw (repo privado).
# O SQL esta embutido inline neste arquivo.
#
# Uso na VPS:
#
#   # Se voce ja tem o repo clonado na VPS:
#   bash scripts/vps-apply-anamnese-prova.sh
#
#   # Ou copie o conteudo deste arquivo para um arquivo na VPS e rode:
#   bash vps-apply-anamnese-prova.sh
#
# O que faz:
#   1) Detecta container postgres + credenciais
#   2) Backup rapido da tabela Anamnesis
#   3) Aplica o SQL (embutido)
#   4) Verifica colunas criadas
#   5) Force-update services chatcrm_api/worker/web pra puxar :latest
#
# Idempotente.
# ============================================================================

set -e

# ─── 1) Detecta postgres ────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════════"
echo " 1/5  Detectando container postgres..."
echo "═══════════════════════════════════════════════════════════════"

PG=$(docker ps --filter "name=postgres" --format "{{.Names}}" | head -n1)
if [ -z "$PG" ]; then
  PG=$(docker ps --filter "ancestor=postgres:15-alpine" --format "{{.Names}}" | head -n1)
fi
if [ -z "$PG" ]; then
  echo "❌ Container postgres não encontrado. Set PG=<nome> manualmente:  PG=meu-postgres bash $0"
  exit 1
fi

PGUSER=$(docker exec "$PG" sh -c 'echo "$POSTGRES_USER"' | tr -d '\r')
PGDB=$(docker exec "$PG" sh -c 'echo "$POSTGRES_DB"' | tr -d '\r')
PGUSER="${PGUSER:-crm_user}"
PGDB="${PGDB:-lexcrm}"

echo "   Container: $PG"
echo "   User:      $PGUSER"
echo "   DB:        $PGDB"

# ─── 2) Backup ──────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " 2/5  Backup da tabela Anamnesis..."
echo "═══════════════════════════════════════════════════════════════"

BACKUP="/tmp/backup-anamnesis-$(date +%F-%H%M).sql.gz"
docker exec "$PG" pg_dump -U "$PGUSER" -d "$PGDB" -t '"Anamnesis"' 2>/dev/null | gzip > "$BACKUP" || true
ls -lh "$BACKUP" 2>/dev/null || echo "(backup vazio se a tabela ainda nao existir — ok)"

# ─── 3) Aplica SQL embutido ─────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " 3/5  Aplicando migration..."
echo "═══════════════════════════════════════════════════════════════"

docker exec -i "$PG" psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;

ALTER TABLE "Anamnesis" ADD COLUMN IF NOT EXISTS "submitted_via"        TEXT;
ALTER TABLE "Anamnesis" ADD COLUMN IF NOT EXISTS "submitted_ip"         TEXT;
ALTER TABLE "Anamnesis" ADD COLUMN IF NOT EXISTS "submitted_user_agent" TEXT;
ALTER TABLE "Anamnesis" ADD COLUMN IF NOT EXISTS "consent_text"         TEXT;
ALTER TABLE "Anamnesis" ADD COLUMN IF NOT EXISTS "consent_accepted_at"  TIMESTAMP(3);
ALTER TABLE "Anamnesis" ADD COLUMN IF NOT EXISTS "signature_method"     TEXT;
ALTER TABLE "Anamnesis" ADD COLUMN IF NOT EXISTS "signature_data"       TEXT;
ALTER TABLE "Anamnesis" ADD COLUMN IF NOT EXISTS "audit_hash"           TEXT;

COMMIT;
SQL

echo "   ✅ SQL aplicado"

# ─── 4) Verifica colunas ────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " 4/5  Verificando colunas em Anamnesis..."
echo "═══════════════════════════════════════════════════════════════"

docker exec "$PG" psql -U "$PGUSER" -d "$PGDB" -c "
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'Anamnesis' AND column_name IN (
    'submitted_via','submitted_ip','submitted_user_agent',
    'consent_text','consent_accepted_at',
    'signature_method','signature_data','audit_hash'
  )
  ORDER BY column_name;
"

# ─── 5) Force-update services ───────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " 5/5  Atualizando services (puxa imagens :latest do DockerHub)..."
echo "═══════════════════════════════════════════════════════════════"

UPDATED=0
for svc in chatcrm_api chatcrm_worker chatcrm_web; do
  if docker service ls --filter "name=$svc" --format "{{.Name}}" 2>/dev/null | grep -q "^$svc$"; then
    suffix="${svc#chatcrm_}"
    echo "   → docker service update --force $svc (imagem odontopassos/chat-crm-juridico-${suffix}:latest)"
    docker service update --force --image "odontopassos/chat-crm-juridico-${suffix}:latest" "$svc" >/dev/null
    UPDATED=$((UPDATED + 1))
  fi
done

if [ "$UPDATED" -eq 0 ]; then
  echo "   ⚠ Nenhum service Swarm encontrado (chatcrm_*)."
  echo "   Se voce usa docker compose normal, rode manualmente:"
  echo "     docker compose -f docker-compose.prod.yml pull"
  echo "     docker compose -f docker-compose.prod.yml up -d"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " ✅ Concluido. Aguarde 30-60s para os containers reiniciarem."
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Status:"
docker service ls --filter "name=chatcrm_" 2>/dev/null || docker ps --filter "name=chatcrm" --format "table {{.Names}}\t{{.Status}}"
