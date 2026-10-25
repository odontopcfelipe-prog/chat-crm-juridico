#!/bin/bash
# ============================================================================
# vps-backup.sh — Backup do Postgres do stack (pg_dump -Fc), antes de deploy
# ============================================================================
# Por que existe: a API aplica o schema no boot com
# `prisma db push --accept-data-loss` (infra/entrypoint.sh). Um deploy com
# schema errado apaga tabela/coluna sem pergunta; o dump é o caminho de volta.
#
# O que faz:
#   - acha o container do service ${STACK}_postgres (padrão chatcrm_postgres);
#   - mede o banco (pg_database_size) e confere o espaço livre no destino:
#     recusa se houver menos que 2× o tamanho do banco;
#   - pg_dump -Fc via docker exec. Usuário e banco vêm do ambiente do próprio
#     container (POSTGRES_USER/POSTGRES_DB): a senha nunca passa pelo host nem
#     aparece na tela;
#   - grava em ~/backups/chatcrm-<data>-<rótulo>.dump (nunca em /tmp, que some
#     no reboot), confere o arquivo com pg_restore -l, mostra o tamanho e
#     mantém só os 5 mais recentes.
#
# Uso no servidor (docs/deploy.md):
#   bash ~/scripts/vps-backup.sh [rótulo]            # rótulo padrão: manual
#   bash ~/scripts/vps-backup.sh antes-deploy && bash ~/scripts/vps-redeploy.sh <sha40>
# Não rode junto de um deploy em andamento: rode antes, encadeado com &&.
# ============================================================================
set -euo pipefail
umask 077   # o dump tem dado de paciente: só o dono do arquivo lê

STACK="${STACK:-chatcrm}"
PG_SERVICE="${PG_SERVICE:-${STACK}_postgres}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
MANTER="${BACKUP_MANTER:-5}"
ROTULO=$(printf '%s' "${1:-manual}" | tr -c 'A-Za-z0-9._-' '-' | cut -c1-40)
[ -n "$ROTULO" ] || ROTULO="manual"

if ! [[ "$MANTER" =~ ^[0-9]+$ ]] || [ "$MANTER" -lt 1 ]; then
  echo "❌ BACKUP_MANTER precisa ser um número >= 1 (veio '$MANTER')."; exit 2
fi

humano() {  # bytes → "1.2 GB"
  awk -v b="$1" 'BEGIN { split("B KB MB GB TB", u, " "); i = 1
    while (b >= 1024 && i < 5) { b /= 1024; i++ }
    if (i == 1) printf "%d %s", b, u[i]; else printf "%.1f %s", b, u[i] }'
}

echo "═══════════════════════════════════════════════════════════════"
echo " Backup do Postgres — ${PG_SERVICE} — rótulo: ${ROTULO}"
echo "═══════════════════════════════════════════════════════════════"

mkdir -p "$BACKUP_DIR"
DESTINO=$(cd "$BACKUP_DIR" && pwd -P)
# Diretórios que somem no reboot. O teste (scripts/ci/test-vps-redeploy.sh)
# troca a lista porque a pasta dele fica no /tmp.
DIRS_TEMPORARIOS="${DIRS_TEMPORARIOS-/tmp /var/tmp /dev/shm}"
for D in $DIRS_TEMPORARIOS; do
  case "$DESTINO/" in
    "$D"/*) echo "❌ Destino $DESTINO é temporário (some no reboot). Use ~/backups (padrão)."; exit 1 ;;
  esac
done

CID=$(docker ps -q --filter "label=com.docker.swarm.service.name=${PG_SERVICE}" --filter status=running 2>/dev/null | head -1 || true)
if [ -z "$CID" ]; then
  echo "❌ Nenhum container rodando do service ${PG_SERVICE}. O stack está no ar?"
  exit 1
fi

# Os comandos abaixo são expandidos DENTRO do container (aspas simples).
PG_ENV='U="${POSTGRES_USER:-postgres}"; D="${POSTGRES_DB:-$U}"; export PGPASSWORD="${POSTGRES_PASSWORD:-}"'
BANCO=$(docker exec "$CID" sh -c 'printf "%s\n" "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"' 2>/dev/null | head -1 || true)

# Tamanho do banco e da tabela de anexos dos disparos (vídeo em bytea).
TAM=$(docker exec -i "$CID" sh -c "$PG_ENV"'; psql -X -q -tA -U "$U" -d "$D"' 2>/dev/null <<'SQL' | head -1 || true
SELECT pg_database_size(current_database()) || '|' || coalesce(pg_total_relation_size(to_regclass('public."DisparoAnexo"')), 0);
SQL
)
DB_BYTES="${TAM%%|*}"; ANEXO_BYTES="${TAM##*|}"
if ! [[ "$DB_BYTES" =~ ^[0-9]+$ ]]; then
  echo "❌ Não consegui medir o banco (pg_database_size). NADA foi gravado."
  exit 1
fi
[[ "$ANEXO_BYTES" =~ ^[0-9]+$ ]] || ANEXO_BYTES=0

LIVRE_KB=$(df -Pk "$DESTINO" 2>/dev/null | awk 'NR==2 { print $4 }' || true)
if ! [[ "$LIVRE_KB" =~ ^[0-9]+$ ]]; then
  echo "❌ Não consegui ler o espaço livre de $DESTINO (df). NADA foi gravado."
  exit 1
fi
LIVRE=$((LIVRE_KB * 1024))
PRECISA=$((DB_BYTES * 2))

echo "  banco:        ${BANCO:-?} — $(humano "$DB_BYTES") (DisparoAnexo: $(humano "$ANEXO_BYTES"))"
echo "  destino:      $DESTINO — livre $(humano "$LIVRE") (precisa de 2× o banco: $(humano "$PRECISA"))"
if [ "$LIVRE" -lt "$PRECISA" ]; then
  echo ""
  echo "❌ Espaço insuficiente em $DESTINO. NADA foi gravado."
  echo "   Libere espaço (docker image prune -af --filter until=72h; dumps antigos em $DESTINO) e rode de novo."
  exit 1
fi

ARQ="$DESTINO/${STACK}-$(date +%Y%m%d-%H%M%S)-${ROTULO}.dump"
PARCIAL="$ARQ.parcial"
trap 'rm -f "$PARCIAL" "$PARCIAL.lista"' EXIT

echo ""
echo "▶ pg_dump -Fc → $ARQ"
INICIO=$(date +%s)
if ! docker exec "$CID" sh -c "$PG_ENV"'; pg_dump -U "$U" -d "$D" -Fc' > "$PARCIAL"; then
  echo "❌ pg_dump falhou. Nenhum backup novo foi guardado."
  exit 1
fi
if [ ! -s "$PARCIAL" ]; then
  echo "❌ pg_dump terminou mas o arquivo ficou vazio. Nenhum backup novo foi guardado."
  exit 1
fi

# Confere se o arquivo abre (lê o índice do dump, não restaura nada).
if ! docker exec -i "$CID" pg_restore -l < "$PARCIAL" > "$PARCIAL.lista" 2>/dev/null; then
  echo "❌ pg_restore -l não leu o dump (arquivo corrompido?). Nenhum backup novo foi guardado."
  exit 1
fi
OBJETOS=$(grep -c '^[0-9]' "$PARCIAL.lista" || true)
mv -f "$PARCIAL" "$ARQ"
chmod 600 "$ARQ" 2>/dev/null || true
TAM_ARQ=$(wc -c < "$ARQ" | tr -d ' ')
echo "  ✅ $(humano "$TAM_ARQ") em $(( $(date +%s) - INICIO ))s — $OBJETOS objeto(s) no índice (pg_restore -l)"

# Retenção: só os arquivos deste script (${STACK}-*.dump), os mais novos ficam.
mapfile -t TODOS < <(ls -1t "$DESTINO/${STACK}-"*.dump 2>/dev/null || true)
if [ "${#TODOS[@]}" -gt "$MANTER" ]; then
  for F in "${TODOS[@]:$MANTER}"; do
    rm -f -- "$F"
    echo "  🗑 $(basename "$F") (retenção: ficam os $MANTER mais recentes)"
  done
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " ✅ Backup pronto: $ARQ ($(humano "$TAM_ARQ"))"
echo "═══════════════════════════════════════════════════════════════"
echo " Backups guardados:"
ls -1t "$DESTINO/${STACK}-"*.dump 2>/dev/null | while read -r F; do
  echo "   $(basename "$F")  $(humano "$(wc -c < "$F" | tr -d ' ')")"
done
