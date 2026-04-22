#!/bin/bash
# ============================================================================
# Apply all pending migrations — Fases 6 a 17 (Clinicorp parity completa)
# ============================================================================
#
# Uso na VPS:
#   cd /caminho/para/chat-crm-juridico
#   bash packages/shared/prisma/manual-sql/apply-all-pending.sh
#
# Variaveis necessarias (set no .env ou export antes de rodar):
#   POSTGRES_CONTAINER  — nome do container postgres (default: detecta do compose)
#   POSTGRES_USER       — usuario do banco (default: chatcrm)
#   POSTGRES_DB         — nome do banco (default: chatcrm)
#
# Todas migrations sao IDEMPOTENTES (IF NOT EXISTS). Pode rodar varias
# vezes sem efeito colateral.
# ============================================================================

set -e  # aborta no primeiro erro

# ─── Config ─────────────────────────────────────────────────────────────────
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-}"
POSTGRES_USER="${POSTGRES_USER:-chatcrm}"
POSTGRES_DB="${POSTGRES_DB:-chatcrm}"

# Detecta container postgres se nao especificado
if [ -z "$POSTGRES_CONTAINER" ]; then
  POSTGRES_CONTAINER=$(docker ps --filter "ancestor=postgres" --format "{{.Names}}" | head -n1)
  if [ -z "$POSTGRES_CONTAINER" ]; then
    POSTGRES_CONTAINER=$(docker ps --filter "name=postgres" --format "{{.Names}}" | head -n1)
  fi
fi

if [ -z "$POSTGRES_CONTAINER" ]; then
  echo "❌ Container postgres nao encontrado. Set POSTGRES_CONTAINER=<nome>"
  exit 1
fi

echo "================================================================"
echo " Aplicando migrations Fases 6-17"
echo "  Container: $POSTGRES_CONTAINER"
echo "  Banco:     $POSTGRES_DB (user: $POSTGRES_USER)"
echo "================================================================"

# ─── Lista de migrations em ORDEM ───────────────────────────────────────────
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

SQL_DIR="$(dirname "$0")"

# ─── Aplica em sequencia ────────────────────────────────────────────────────
for migration in "${MIGRATIONS[@]}"; do
  echo ""
  echo "▶ Aplicando $migration..."
  if [ ! -f "$SQL_DIR/$migration" ]; then
    echo "  ⚠️  Arquivo nao encontrado, pulando."
    continue
  fi
  docker exec -i "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 < "$SQL_DIR/$migration" \
    && echo "  ✅ OK" \
    || { echo "  ❌ FALHOU em $migration"; exit 1; }
done

echo ""
echo "================================================================"
echo " ✅ Todas as migrations aplicadas com sucesso"
echo "================================================================"
echo ""
echo " Proximos passos:"
echo "   1. Regenerar Prisma client:"
echo "      cd packages/shared && npx prisma generate"
echo ""
echo "   2. Restartar containers:"
echo "      docker compose restart api worker web"
echo ""
echo "   3. (Opcional) Seed de procedimentos esteticos faciais:"
echo "      cd packages/shared && npx ts-node prisma/seed-estetica-facial.ts"
echo ""
