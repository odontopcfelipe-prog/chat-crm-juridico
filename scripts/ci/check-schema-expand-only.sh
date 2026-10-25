#!/usr/bin/env bash
# Confere se a mudança do schema.prisma só ACRESCENTA.
#
# Por que existe: a API aplica o schema no boot com
# `prisma db push --accept-data-loss` (infra/entrypoint.sh). Um DROP, uma troca
# de tipo ou um NOT NULL novo vai direto para o banco de produção e apaga ou
# trava dados das clínicas, sem pergunta.
#
# Compara o schema de BASE (padrão: o commit anterior) com o do HEAD, sem banco
# (prisma migrate diff entre dois arquivos), e:
#   - BLOQUEIA: DROP TABLE, DROP COLUMN, troca de tipo de coluna, SET NOT NULL,
#     RENAME, DROP TYPE;
#   - AVISA (passa): ADD COLUMN, CREATE INDEX, DROP INDEX, DROP CONSTRAINT e
#     qualquer ALTER em tabela que já existia.
#
# Escape consciente: uma linha `schema-destrutivo: <motivo>` na mensagem do
# commit libera o bloqueio (fica registrada no resumo do job).
#
# Uso: scripts/ci/check-schema-expand-only.sh [<sha-base>]
set -euo pipefail

SCHEMA_PATH="packages/shared/prisma/schema.prisma"
BASE="${1:-}"
ZERO="0000000000000000000000000000000000000000"

if [ -z "$BASE" ] || [ "$BASE" = "$ZERO" ]; then
  BASE="$(git merge-base HEAD origin/master 2>/dev/null || git rev-parse HEAD~1)"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! git cat-file -e "$BASE:$SCHEMA_PATH" 2>/dev/null; then
  echo "[schema] base $BASE não tem $SCHEMA_PATH — nada a comparar."
  exit 0
fi

git show "$BASE:$SCHEMA_PATH" > "$TMP/base.prisma"
cp "$SCHEMA_PATH" "$TMP/head.prisma"

if cmp -s "$TMP/base.prisma" "$TMP/head.prisma"; then
  echo "[schema] sem mudança no schema desde $BASE."
  exit 0
fi

# migrate diff offline (sem banco): entre dois datamodels.
if ! ( cd packages/shared && PRISMA_HIDE_UPDATE_MESSAGE=1 npx --no-install prisma migrate diff \
    --from-schema-datamodel "$TMP/base.prisma" \
    --to-schema-datamodel "$TMP/head.prisma" \
    --script ) > "$TMP/diff.sql" 2> "$TMP/prisma.err"; then
  echo "[schema] prisma migrate diff falhou:"
  cat "$TMP/prisma.err"
  exit 1
fi

SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"
{
  echo "### Schema: mudança desde \`${BASE:0:8}\`"
  echo '```sql'
  cat "$TMP/diff.sql"
  echo '```'
} >> "$SUMMARY"

# Linhas que perdem ou travam dado.
BLOCK_RE='DROP TABLE|DROP COLUMN|SET DATA TYPE|ALTER COLUMN [^ ]+ TYPE|SET NOT NULL|RENAME (TO|COLUMN|CONSTRAINT)|DROP TYPE'
# Linhas que não perdem dado mas mexem em tabela existente.
WARN_RE='ADD COLUMN|CREATE (UNIQUE )?INDEX|DROP INDEX|DROP CONSTRAINT|ADD CONSTRAINT'

BLOCKED="$(grep -E "$BLOCK_RE" "$TMP/diff.sql" || true)"
# Índice e FK de tabela criada NESTE diff não mexem em tabela existente.
NEW_TABLES="$(grep -oE '^CREATE TABLE "[^"]+"' "$TMP/diff.sql" | sed -E 's/^CREATE TABLE "([^"]+)"/\1/' || true)"
WARNED="$(grep -E "$WARN_RE" "$TMP/diff.sql" || true)"
for t in $NEW_TABLES; do
  WARNED="$(printf '%s\n' "$WARNED" | grep -vE "(ON|ALTER TABLE) \"$t\"" || true)"
done
WARNED="$(printf '%s\n' "$WARNED" | sed '/^$/d')"
if [ -n "$NEW_TABLES" ]; then
  echo "[schema] tabelas novas: $(echo $NEW_TABLES | tr '\n' ' ')"
fi

if [ -n "$WARNED" ]; then
  echo "[schema] AVISO — mexe em tabela existente (não perde dado):"
  echo "$WARNED" | sed 's/^/  /'
  { echo "**Aviso:** mudanças em tabela existente (não perdem dado)."; } >> "$SUMMARY"
fi

if [ -n "$BLOCKED" ]; then
  ESCAPE="$(git log --format=%B "$BASE..HEAD" 2>/dev/null | grep -E '^schema-destrutivo: .{3,}' | head -1 || true)"
  if [ -n "$ESCAPE" ]; then
    echo "[schema] mudança DESTRUTIVA liberada pelo commit: $ESCAPE"
    echo "$BLOCKED" | sed 's/^/  /'
    { echo "**Destrutivo liberado** — $ESCAPE"; } >> "$SUMMARY"
    exit 0
  fi
  echo "[schema] BLOQUEADO — esta mudança apagaria ou travaria dado em produção (db push --accept-data-loss):"
  echo "$BLOCKED" | sed 's/^/  /'
  echo
  echo "Se for de propósito, ponha no commit uma linha:  schema-destrutivo: <motivo>"
  { echo "**BLOQUEADO:** mudança destrutiva no schema."; } >> "$SUMMARY"
  exit 1
fi

echo "[schema] OK — só acréscimos."
