#!/bin/bash
# ============================================================================
# VPS Deploy — Anamnese: prova eletronica de preenchimento (2026-05-08)
# ============================================================================
# Uso na VPS (Swarm), sem precisar clonar o repo:
#
#   curl -fsSL https://raw.githubusercontent.com/odontopcfelipe-prog/chat-crm-juridico/master/scripts/vps-apply-anamnese-prova.sh | bash
#
# OU baixa primeiro:
#
#   curl -fsSLO https://raw.githubusercontent.com/odontopcfelipe-prog/chat-crm-juridico/master/scripts/vps-apply-anamnese-prova.sh
#   bash vps-apply-anamnese-prova.sh
#
# O que faz:
#   1) Detecta container postgres + credenciais
#   2) Backup rapido em /tmp
#   3) Baixa o SQL idempotente do GitHub raw
#   4) Aplica com ON_ERROR_STOP=1
#   5) Verifica colunas criadas em "Anamnesis"
#   6) Force-update services chatcrm_api/worker/web pra puxar imagens :latest
#   7) Aguarda e mostra status
#
# Idempotente — pode rodar quantas vezes precisar.
# ============================================================================

set -e

BRANCH="${BRANCH:-master}"
REPO="${REPO:-odontopcfelipe-prog/chat-crm-juridico}"
RAW="https://raw.githubusercontent.com/$REPO/$BRANCH/packages/shared/prisma/manual-sql"
SQL="2026-05-08-anamnesis-prova-eletronica.sql"

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
echo " 2/5  Backup rapido (so a tabela Anamnesis em /tmp)..."
echo "═══════════════════════════════════════════════════════════════"

BACKUP="/tmp/backup-anamnesis-$(date +%F-%H%M).sql.gz"
docker exec "$PG" pg_dump -U "$PGUSER" -d "$PGDB" -t '"Anamnesis"' | gzip > "$BACKUP" || true
ls -lh "$BACKUP" || echo "(backup vazio se a tabela ainda nao existir — ok)"

# ─── 3) Baixa e aplica SQL ──────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " 3/5  Baixando e aplicando $SQL..."
echo "═══════════════════════════════════════════════════════════════"

TMPDIR=$(mktemp -d)
curl -fsSL "$RAW/$SQL" -o "$TMPDIR/$SQL"
echo "   Baixado em $TMPDIR/$SQL"

docker exec -i "$PG" psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 < "$TMPDIR/$SQL"
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

# ─── 5) Force-update services pra puxar imagens novas ───────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " 5/5  Atualizando services (puxa imagens :latest do DockerHub)..."
echo "═══════════════════════════════════════════════════════════════"

for svc in chatcrm_api chatcrm_worker chatcrm_web; do
  if docker service ls --filter "name=$svc" --format "{{.Name}}" | grep -q "^$svc$"; then
    echo "   → docker service update --force $svc"
    docker service update --force --image "odontopassos/chat-crm-juridico-${svc#chatcrm_}:latest" "$svc" >/dev/null
  else
    echo "   ⚠ service $svc nao encontrado (ok se estiver em compose normal)"
  fi
done

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " ✅ Concluido. Aguarde 30-60s para os containers reiniciarem."
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Status dos services:"
docker service ls --filter "name=chatcrm_" 2>/dev/null || docker ps --filter "name=chatcrm" --format "table {{.Names}}\t{{.Status}}"
