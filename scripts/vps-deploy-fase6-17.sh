#!/bin/bash
# ============================================================================
# VPS Deploy — Fases 6 a 17 (Clinicorp parity completa)
# ============================================================================
# Uso na VPS (Swarm), sem precisar clonar o repo:
#
#   curl -fsSL https://raw.githubusercontent.com/odontopcfelipe-prog/chat-crm-juridico/master/scripts/vps-deploy-fase6-17.sh | bash
#
# OU baixa primeiro pra inspecionar:
#
#   curl -fsSLO https://raw.githubusercontent.com/odontopcfelipe-prog/chat-crm-juridico/master/scripts/vps-deploy-fase6-17.sh
#   bash vps-deploy-fase6-17.sh
#
# O que faz, em ordem:
#   1) Backup do banco (pg_dump | gzip em /tmp)
#   2) Detecta container postgres e credenciais (POSTGRES_USER/DB do env do container)
#   3) Baixa os 11 SQLs idempotentes do GitHub raw em /tmp
#   4) Aplica em ordem (-v ON_ERROR_STOP=1) — abortando no primeiro erro
#   5) Verifica tabelas criadas
#   6) Faz docker service update --force nas services (api/worker/web) pra
#      puxar a imagem :latest mais recente do DockerHub
#   7) Aguarda e mostra status final
#
# Idempotente: pode rodar de novo se interromper (todos SQLs usam IF NOT EXISTS).
# ============================================================================

set -e

BRANCH="${BRANCH:-master}"
REPO="${REPO:-odontopcfelipe-prog/chat-crm-juridico}"
RAW="https://raw.githubusercontent.com/$REPO/$BRANCH/packages/shared/prisma/manual-sql"

# ─── 1) Detecta postgres ────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════════"
echo " 1/6  Detectando container postgres..."
echo "═══════════════════════════════════════════════════════════════"

PG=$(docker ps --filter "name=postgres" --format "{{.Names}}" | head -n1)
if [ -z "$PG" ]; then
  PG=$(docker ps --filter "ancestor=postgres:15-alpine" --format "{{.Names}}" | head -n1)
fi
if [ -z "$PG" ]; then
  echo "❌ Container postgres não encontrado. Set PG=<nome> manualmente."
  exit 1
fi

# Pega credenciais do env do container
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
echo " 2/6  Backup do banco (em /tmp)..."
echo "═══════════════════════════════════════════════════════════════"

BACKUP="/tmp/backup-pre-fase6-17-$(date +%F-%H%M).sql.gz"
docker exec "$PG" pg_dump -U "$PGUSER" -d "$PGDB" | gzip > "$BACKUP"
ls -lh "$BACKUP"

# ─── 3) Baixa SQLs ──────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " 3/6  Baixando SQLs do GitHub raw..."
echo "═══════════════════════════════════════════════════════════════"

TMPDIR=$(mktemp -d)
cd "$TMPDIR"
echo "   Working dir: $TMPDIR"

MIGRATIONS=(
  "2026-04-18-after-hours-ai.sql"
  "2026-04-18-memory-system.sql"
  "2026-04-20-schema-odontologia.sql"
  "2026-04-21-schema-estetica-facial.sql"
  "2026-04-21-schema-agenda-evoluida.sql"
  "2026-04-21-schema-comissoes-metas.sql"
  "2026-04-21-schema-portal-paciente.sql"
  "2026-04-21-schema-regua-cobranca.sql"
  "2026-04-21-schema-multi-unidade.sql"
  "2026-04-22-schema-radiografia.sql"
  "2026-04-22-schema-smile-design.sql"
)

for f in "${MIGRATIONS[@]}"; do
  echo "   ▼ $f"
  if ! curl -fsSL "$RAW/$f" -o "$f"; then
    echo "❌ Falhou baixar $f. Repo privado? Set REPO=usuario/repo ou usa token."
    echo "   URL tentada: $RAW/$f"
    exit 1
  fi
done

# ─── 4) Aplica migrations ───────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " 4/6  Aplicando migrations (idempotentes, ON_ERROR_STOP=1)..."
echo "═══════════════════════════════════════════════════════════════"

for f in "${MIGRATIONS[@]}"; do
  echo ""
  echo "▶ $f"
  if docker exec -i "$PG" psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 < "$f"; then
    echo "  ✅ OK"
  else
    echo "  ❌ FALHOU em $f"
    echo ""
    echo "  Backup disponível em $BACKUP"
    exit 1
  fi
done

# ─── 5) Verifica tabelas criadas ────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " 5/6  Verificando tabelas criadas..."
echo "═══════════════════════════════════════════════════════════════"

EXPECTED="EstheticApplication|Installment|Goal|Clinic|UserClinic|SmileSimulation|RadiographyExam|RadiographyProvider|Room|AppointmentMarker|AppointmentConfirmation|ReturnAlert|CommissionRule|Commission|CollectionAttempt|PortalToken|Supplier|Product|StockMovement|ProcedureConsumable|AdverseReaction"

FOUND=$(docker exec "$PG" psql -U "$PGUSER" -d "$PGDB" -tA -c "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;" \
  | grep -iE "^($EXPECTED)$" || true)

if [ -z "$FOUND" ]; then
  echo "⚠️  Nenhuma das tabelas esperadas encontrada — algo deu errado."
  exit 1
fi

echo "$FOUND" | sed 's/^/   ✅ /'

# ─── 6) Force-update das services (puxa imagem :latest) ─────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " 6/6  Forçando swap das imagens (api/worker/web)..."
echo "═══════════════════════════════════════════════════════════════"

# Detecta services do stack chatcrm que precisam atualizar
SERVICES=$(docker service ls --format "{{.Name}}" | grep -E "^chatcrm_(api|worker|web)$" || true)

if [ -z "$SERVICES" ]; then
  echo "⚠️  Nenhum service chatcrm_(api|worker|web) encontrado. Stack name diferente?"
  echo "   Lista atual:"
  docker service ls --format "   - {{.Name}}"
  echo ""
  echo "   ⚠️  Migrations já aplicadas. Faça o swap manual:"
  echo "       docker service update --force <nome_do_service>"
else
  for SVC in $SERVICES; do
    IMG=$(docker service inspect --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' "$SVC" | sed 's/@sha256.*//')
    echo "▶ $SVC  ($IMG)"
    docker service update --force --image "$IMG" "$SVC" --quiet
    echo "  ✅ atualizado"
  done
fi

# ─── Resumo ─────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " ✅ DEPLOY COMPLETO"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo " Backup:   $BACKUP"
echo " SQLs em:  $TMPDIR"
echo ""
echo " Próximos checks (aguarde ~30s pros containers):"
echo "   docker service ls"
echo "   docker service logs --tail=30 chatcrm_api    | grep -iE 'started|listening|error'"
echo "   docker service logs --tail=30 chatcrm_worker | grep -iE 'started|error'"
echo "   docker service logs --tail=30 chatcrm_web    | grep -iE 'ready|error'"
echo ""
echo "   curl -i https://sistema.institutoodontopassos.com.br/api/health"
echo "   curl -i https://sistema.institutoodontopassos.com.br/api/reports/catalog  # esperado 401"
echo ""
