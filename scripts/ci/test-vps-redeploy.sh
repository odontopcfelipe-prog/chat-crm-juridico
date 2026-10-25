#!/usr/bin/env bash
# Testa o scripts/vps-redeploy.sh (v2) e o scripts/vps-backup.sh com STUBS de
# docker, curl e df num diretório na frente do PATH: nada toca Docker, rede ou
# banco de verdade.
#
# Cobre: CI verde × vermelho × --sem-ci (e a ÚLTIMA tentativa do run),
# 'latest', disco cheio, diff sem perigo, DROP COLUMN, troca de tipo, SET NOT
# NULL, RENAME, enum recriado, DROP INDEX de drift conhecido, diff tocando
# TeamMessage/ponto, diff que não dá para calcular (falha fechada), segredo que
# nunca aparece na saída, --dry-run sem nenhum "service update", API que não
# sobe (inclusive o Nest que cai depois do "Schema aplicado"; worker e web
# ficam), interrupção no meio da espera, variáveis numéricas fora do formato e
# o backup (espaço, /tmp, retenção, pg_dump que falha).
#
# O leitor de JSON do script aceita python3 (o do servidor) ou node: o teste
# roda com os dois quando existem. No CI o python3 é obrigatório.
#
# Uso: bash scripts/ci/test-vps-redeploy.sh
set -uo pipefail

RAIZ="$(cd "$(dirname "$0")/../.." && pwd)"
REDEPLOY="$RAIZ/scripts/vps-redeploy.sh"
BACKUP="$RAIZ/scripts/vps-backup.sh"

for F in "$REDEPLOY" "$BACKUP" "$0"; do
  bash -n "$F" || { echo "❌ bash -n falhou em $F"; exit 1; }
done

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"

# ── Stubs ───────────────────────────────────────────────────────────────────
cat > "$T/bin/docker" <<'STUB'
#!/usr/bin/env bash
# stub do docker: registra a chamada e responde como o Swarm do servidor
S="${STUB_DIR:?}"
printf '%s\n' "$*" >> "$S/docker.log"
ultimo="${*: -1}"
case "$1" in
  service)
    case "$2" in
      ls) printf '%s\n' chatcrm_api chatcrm_worker chatcrm_web chatcrm_postgres evolution_evolution_api ;;
      inspect)
        case "$*" in
          *ContainerSpec.Env*) cat "$S/env.$ultimo" 2>/dev/null || true ;;
          *ContainerSpec.Image*) cat "$S/img.$ultimo" ;;
        esac ;;
      update)
        [ "${STUB_UPDATE_FALHA:-}" = "$ultimo" ] && exit 1
        prev=""
        for a in "$@"; do [ "$prev" = "--image" ] && echo "$a" > "$S/img.$ultimo"; prev="$a"; done
        touch "$S/atualizado.$ultimo"
        [ "${STUB_MATA_NO_UPDATE:-}" = "$ultimo" ] && kill -TERM "$(cat "$S/pid")"
        exit 0 ;;
      ps)
        svc="$3"
        if [[ " $* " == *" -q "* ]]; then echo "task-velha-$svc"; exit 0; fi
        echo "task-velha-$svc|$(cat "$S/img0.$svc")|Running 2 days ago"
        if [ -f "$S/atualizado.$svc" ]; then
          nova="task-nova-$svc"
          if [ "${STUB_TASK_TROCA:-0}" = 1 ]; then
            # crash loop: o Swarm troca a task a cada consulta
            n=$(( $(cat "$S/ps.n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$S/ps.n"; nova="$nova-$n"
          fi
          echo "$nova|$(cat "$S/img.$svc")|${STUB_ESTADO_NOVA:-Running 5 seconds ago}"
        fi ;;
      logs)
        case "$ultimo" in
          task-velha-*) printf '%s\n' "[entrypoint] Schema aplicado com sucesso." "[Nest] 1  - LOG [Bootstrap] API rodando em http://localhost:3005" ;;
          *) # STUB_MATA_NO_LOG: o "Ctrl+C" chega enquanto o script espera a API
             [ "${STUB_MATA_NO_LOG:-0}" = 1 ] && kill -TERM "$(cat "$S/pid")"
             printf '%b\n' "${STUB_LOG_API-[entrypoint] Schema aplicado com sucesso.\n[Nest] 1  - LOG [Bootstrap] API rodando em http://localhost:3005}" ;;
        esac ;;
    esac ;;
  info) echo "/var/lib/docker" ;;
  pull) exit "${STUB_PULL_FALHA:-0}" ;;
  image)
    [ "$2" = "inspect" ] && echo "${STUB_LABELS:-null}"
    exit 0 ;;
  create) echo "cid-novo" ;;
  cp)
    case "$2" in
      cid-novo:*/schema.prisma) printf 'model Lead {\n  id String @id\n}\n' > "$3" ;;
      cid-novo:*/manual-sql)
        mkdir -p "$3"
        printf '%s\n' 'CREATE INDEX IF NOT EXISTS "Patient_tenant_name_idx" ON "Patient"(tenant_id, name);' \
          'CREATE UNIQUE INDEX IF NOT EXISTS "Influencer_patient_id_key" ON "Influencer"(patient_id);' > "$3/2026-01-01-x.sql" ;;
      *) [ -f "$2" ] || exit 1 ;;
    esac ;;
  rm) exit 0 ;;
  ps)
    case "$*" in
      *chatcrm_api*) [ "${STUB_API_FORA:-0}" = 1 ] || echo "cid-api" ;;
      *chatcrm_postgres*) [ "${STUB_PG_FORA:-0}" = 1 ] || echo "cid-pg" ;;
    esac ;;
  exec)
    case "$*" in
      *"migrate diff"*)
        if [ "${STUB_DIFF_FALHA:-0}" = 1 ]; then
          echo "Error: P1001: Can't reach database server at postgresql://crm:SEGREDO_DO_STUB@postgres:5432/lexcrm" >&2
          exit 1
        fi
        cat "$S/diff.sql" ;;
      *pg_dump*) [ "${STUB_DUMP_FALHA:-0}" = 1 ] && exit 1; printf 'PGDMP-dump-falso' ;;
      *pg_restore*) cat >/dev/null; printf '%s\n' ';' '; Archive created' '1; 1259 16386 TABLE public Lead crm' '2; 1259 16390 TABLE public Patient crm' ;;
      *psql*) cat >/dev/null; echo "${STUB_DB_BYTES:-1048576}|${STUB_ANEXO_BYTES:-2048}" ;;
      *printf*) echo "lexcrm" ;;
      *) : ;;
    esac ;;
esac
exit 0
STUB

cat > "$T/bin/curl" <<'STUB'
#!/usr/bin/env bash
# stub do curl: Docker Hub e API do GitHub
S="${STUB_DIR:?}"
url="${*: -1}"
printf '%s\n' "$url" >> "$S/curl.log"
dig64() { local i s=""; for i in $(seq 64); do s="$s$1"; done; echo "$s"; }
case "$url" in
  https://hub.docker.com/v2/repositories/*/tags/\?*)
    printf '{"count":2,"results":[{"name":"latest"},{"name":"%s"}]}' "${STUB_SHA:?}" ;;
  https://hub.docker.com/v2/repositories/*/tags/*)
    repo="${url#*/repositories/}"; repo="${repo%%/tags/*}"
    case "$repo" in *-api) c=b ;; *-worker) c=c ;; *-web) c=d ;; *) exit 22 ;; esac
    printf '{"name":"x","digest":"sha256:%s"}' "$(dig64 "$c")" ;;
  https://api.github.com/*)
    [ "${STUB_GH_FALHA:-0}" = 1 ] && exit 22
    cat "$S/runs.json" ;;
  *) exit 22 ;;
esac
STUB

cat > "$T/bin/df" <<'STUB'
#!/usr/bin/env bash
# stub do df: uso em % (STUB_DF_USO) ou KB livres (STUB_DF_LIVRE_KB)
uso="${STUB_DF_USO:-40}"
total=100000000
livre="${STUB_DF_LIVRE_KB:-$(( (100 - uso) * total / 100 ))}"
if [[ " $* " == *" -h "* ]]; then
  echo "Filesystem      Size  Used Avail Use% Mounted on"
  for p in "$@"; do case "$p" in -*) ;; *) echo "/dev/stub        95G   38G   57G  ${uso}% $p" ;; esac; done
else
  echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
  for p in "$@"; do case "$p" in -*) ;; *) echo "/dev/stub $total $((total - livre)) $livre ${uso}% $p" ;; esac; done
fi
STUB
chmod +x "$T/bin/docker" "$T/bin/curl" "$T/bin/df"

# ── Utilitários do teste ────────────────────────────────────────────────────
SHA=0123456789abcdef0123456789abcdef01234567
rep() { local i s=""; for i in $(seq "$2"); do s="$s$1"; done; echo "$s"; }
DIG_API="sha256:$(rep b 64)"
IMG_NOVA_API="odontopassos/chat-crm-juridico-api@$DIG_API"
IMG_VELHA_API="odontopassos/chat-crm-juridico-api:latest@sha256:$(rep a 64)"

N=0; OKS=0; FALHAS=0; CASO=""; S=""; RC=0; ENGINE=""
novo_caso() {
  N=$((N + 1)); CASO="$1"; S="$T/caso-$N"; mkdir -p "$S/home"
  for svc in api worker web; do
    echo "odontopassos/chat-crm-juridico-$svc:latest@sha256:$(rep a 64)" > "$S/img0.chatcrm_$svc"
    cp "$S/img0.chatcrm_$svc" "$S/img.chatcrm_$svc"
  done
  # segredo falso no ambiente da API: nunca pode aparecer na saída
  printf '%s\n' 'NODE_ENV=production' 'DATABASE_URL=postgresql://crm:SEGREDO_NAO_IMPRIMIR@postgres:5432/lexcrm' \
    'JWT_SECRET=SEGREDO_NAO_IMPRIMIR' > "$S/env.chatcrm_api"
  printf '%s\n' 'NODE_ENV=production' > "$S/env.chatcrm_worker"
  : > "$S/docker.log"
  runs_ci success
  echo '-- This is an empty migration.' > "$S/diff.sql"
}
falhou() {
  FALHAS=$((FALHAS + 1))
  echo "  ✗ [$ENGINE] $CASO — $1"
  sed 's/^/      | /' "$S/saida.txt" | tail -40
}
passou() { OKS=$((OKS + 1)); }
rodar() {  # rodar <script> [VAR=valor ...] -- <args>
  local alvo="$1" vars=(); shift
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do vars+=("$1"); shift; done
  [ "$#" -gt 0 ] && shift
  env -u TAG PATH="$T/bin:$PATH" HOME="$S/home" TMPDIR="$S" STUB_DIR="$S" STUB_SHA="$SHA" \
    JSON_ENGINE="$ENGINE" POLL_SEG=0 ESPERA_API_SEG=5 ESTAVEL_API_SEG=0 ${vars[@]+"${vars[@]}"} \
    bash -c 'echo $$ > "$STUB_DIR/pid"; exec bash "$@"' rodar "$alvo" "$@" > "$S/saida.txt" 2>&1
  RC=$?
  if grep -qE 'SEGREDO_NAO_IMPRIMIR|SEGREDO_DO_STUB' "$S/saida.txt"; then falhou "segredo apareceu na saída"; else passou; fi
}
redeploy() { rodar "$REDEPLOY" "$@"; }
# A pasta do teste fica no /tmp, que o backup recusa: aqui a lista de
# temporários fica sem o /tmp (o caso do /tmp chama o rodar direto).
backup() { rodar "$BACKUP" "DIRS_TEMPORARIOS=/var/tmp /dev/shm" "$@"; }
rc() { if [ "$RC" = "$1" ]; then passou; else falhou "saída $RC (esperado $1)"; fi; }
tem() { if grep -qF -- "$1" "$S/saida.txt"; then passou; else falhou "saída sem: $1"; fi; }
nao_tem() { if grep -qF -- "$1" "$S/saida.txt"; then falhou "saída não devia ter: $1"; else passou; fi; }
docker_tem() { if grep -qF -- "$1" "$S/docker.log"; then passou; else falhou "docker não recebeu: $1"; fi; }
docker_nao_tem() { if grep -qF -- "$1" "$S/docker.log"; then falhou "docker não devia receber: $1"; else passou; fi; }
ordem() {  # services atualizados, na ordem
  local u
  u=$(grep '^service update' "$S/docker.log" | awk '{ print $NF }' | tr '\n' ' ' | sed 's/ $//')
  if [ "$u" = "$1" ]; then passou; else falhou "updates '$u' (esperado '$1')"; fi
}
update_tem() {  # $1 service, $2 trecho
  if grep "^service update" "$S/docker.log" | grep " $1\$" | grep -qF -- "$2"; then passou
  else falhou "update de $1 sem: $2"; fi
}
update_nao_tem() {
  if grep "^service update" "$S/docker.log" | grep " $1\$" | grep -qF -- "$2"; then falhou "update de $1 não devia ter: $2"
  else passou; fi
}
runs_ci() {  # $1 conclusão (success|failure|null), $2 status (padrão completed)
  local conc="\"$1\""; [ "$1" = null ] && conc=null
  cat > "$S/runs.json" <<EOF
{"total_count":2,"workflow_runs":[
 {"id":900,"name":"Build and Push to Docker Hub","path":".github/workflows/deploy.yml","head_sha":"$SHA","run_attempt":1,"status":"completed","conclusion":"success","event":"push","run_started_at":"2026-10-25T10:00:00Z","html_url":"https://github.com/o/r/actions/runs/900"},
 {"id":901,"name":"CI — testes e checagens","path":".github/workflows/ci.yml","head_sha":"$SHA","run_attempt":1,"status":"${2:-completed}","conclusion":$conc,"event":"push","run_started_at":"2026-10-25T10:00:00Z","html_url":"https://github.com/o/r/actions/runs/901"}
]}
EOF
}
runs_tentativas() {  # $1 conclusão da tentativa 1, $2 da tentativa 2 (mesmo run; a 2ª vem primeiro no JSON)
  cat > "$S/runs.json" <<EOF
{"total_count":2,"workflow_runs":[
 {"id":901,"name":"CI — testes e checagens","path":".github/workflows/ci.yml","run_attempt":2,"status":"completed","conclusion":"$2","event":"push","run_started_at":"2026-10-25T10:30:00Z","html_url":"https://github.com/o/r/actions/runs/901/attempts/2"},
 {"id":901,"name":"CI — testes e checagens","path":".github/workflows/ci.yml","run_attempt":1,"status":"completed","conclusion":"$1","event":"push","run_started_at":"2026-10-25T10:00:00Z","html_url":"https://github.com/o/r/actions/runs/901/attempts/1"}
]}
EOF
}

diff_drop_column() {  # como o prisma escreve: aviso em /* */ + ALTER de várias linhas
  cat > "$S/diff.sql" <<'SQL'
/*
  Warnings:

  - You are about to drop the column `legacy_note` on the `Lead` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Lead" DROP COLUMN "legacy_note",
ADD COLUMN     "origem" TEXT;
SQL
}

# ── vps-redeploy.sh ─────────────────────────────────────────────────────────
suite_redeploy() {
  novo_caso "CI verde, schema igual: API → worker → web"
  redeploy -- "$SHA"
  rc 0; ordem "chatcrm_api chatcrm_worker chatcrm_web"
  tem "CI verde"; tem "Sem diferença"; docker_nao_tem "RUN_MIGRATIONS"
  update_tem chatcrm_api "--image $IMG_NOVA_API"
  docker_tem "create --network none --entrypoint sh $IMG_NOVA_API"
  docker_tem "pull -q odontopassos/chat-crm-juridico-web@sha256:$(rep d 64)"
  # o diff lê a URL do banco do ambiente da API (datasource do schema dela),
  # nunca como argumento de processo
  docker_tem "--from-schema-datasource \"\$1\" --to-schema-datamodel \"\$2\" --script sh /app/packages/shared/prisma/schema.prisma /tmp/"
  docker_nao_tem "--from-url"; docker_nao_tem "DATABASE_URL"
  tem "de pé há 0s"
  # as 3 imagens baixadas antes do 1º update
  local ult_pull pri_upd
  ult_pull=$(grep -n '^pull ' "$S/docker.log" | tail -1 | cut -d: -f1)
  pri_upd=$(grep -n '^service update' "$S/docker.log" | head -1 | cut -d: -f1)
  if [ -n "$ult_pull" ] && [ -n "$pri_upd" ] && [ "$ult_pull" -lt "$pri_upd" ]; then passou; else falhou "pull depois do update"; fi
  if grep -q ' ok$' "$S/home/vps-redeploy.log" 2>/dev/null; then passou; else falhou "registro sem 'ok'"; fi

  novo_caso "CI vermelho: recusa sem tocar em nada"
  runs_ci failure
  redeploy -- "$SHA"
  rc 1; tem "terminou 'failure'"; tem "--sem-ci"; tem "NADA foi alterado"
  docker_nao_tem "service update"; docker_nao_tem "pull "

  novo_caso "CI vermelho + --sem-ci: segue e registra"
  runs_ci failure
  redeploy -- --sem-ci "$SHA"
  rc 0; ordem "chatcrm_api chatcrm_worker chatcrm_web"; tem "--sem-ci"
  if grep -q 'ci=sem-ci.*--sem-ci' "$S/home/vps-redeploy.log" 2>/dev/null; then passou; else falhou "registro sem o --sem-ci"; fi

  novo_caso "CI ainda rodando: recusa"
  runs_ci null in_progress
  redeploy -- "$SHA"
  rc 1; tem "ainda não terminou"; docker_nao_tem "service update"

  novo_caso "re-run verde na 2ª tentativa: vale a última"
  runs_tentativas failure success
  redeploy -- "$SHA"
  rc 0; tem "tentativa 2"; ordem "chatcrm_api chatcrm_worker chatcrm_web"

  novo_caso "2ª tentativa vermelha depois de uma verde: recusa"
  runs_tentativas success failure
  redeploy -- "$SHA"
  rc 1; tem "na tentativa 2"; docker_nao_tem "service update"

  novo_caso "nenhum run do CI para o sha: recusa"
  cat > "$S/runs.json" <<EOF
{"total_count":1,"workflow_runs":[
 {"id":900,"name":"Build and Push to Docker Hub","path":".github/workflows/deploy.yml","run_attempt":1,"status":"completed","conclusion":"success","event":"push","run_started_at":"2026-10-25T10:00:00Z","html_url":"https://github.com/o/r/actions/runs/900"}
]}
EOF
  redeploy -- "$SHA"
  rc 1; tem "nenhum run do CI"; docker_nao_tem "service update"

  novo_caso "GitHub fora do ar: recusa (falha fechada)"
  redeploy STUB_GH_FALHA=1 -- "$SHA"
  rc 1; tem "não consegui consultar o GitHub"; docker_nao_tem "service update"

  novo_caso "'latest' sem --sem-ci: recusa"
  redeploy --
  rc 1; tem "'latest' não é um sha"; docker_nao_tem "service update"

  novo_caso "'latest' com --sem-ci: segue"
  redeploy -- --sem-ci latest
  rc 0; ordem "chatcrm_api chatcrm_worker chatcrm_web"; update_tem chatcrm_api "--image $IMG_NOVA_API"

  novo_caso "sha curto vira o de 40"
  redeploy -- "${SHA:0:8}"
  rc 0; tem "→ $SHA"; ordem "chatcrm_api chatcrm_worker chatcrm_web"

  novo_caso "disco com 5% livre: recusa"
  redeploy STUB_DF_USO=95 -- "$SHA"
  rc 1; tem "só 5% livre"; docker_nao_tem "service update"; docker_nao_tem "pull "

  novo_caso "disco com 5% livre + --forcar-disco: segue"
  redeploy STUB_DF_USO=95 -- --forcar-disco "$SHA"
  rc 0; tem "--forcar-disco"; ordem "chatcrm_api chatcrm_worker chatcrm_web"

  novo_caso "DROP COLUMN: PERIGO, para sem a confirmação"
  diff_drop_column
  redeploy -- "$SHA"
  rc 1; tem "1 PERIGO"; tem 'PERIGO  ALTER TABLE "Lead" DROP COLUMN "legacy_note"'; tem "--confirmo-sem-migracao"
  docker_nao_tem "service update"

  novo_caso "DROP COLUMN + --confirmo-sem-migracao: API sobe com RUN_MIGRATIONS=false"
  diff_drop_column
  redeploy STUB_LOG_API="[entrypoint] APP=api RUN_MIGRATIONS=false — pulando auto-migração.\n[Nest] 1  - LOG [NestApplication] Nest application successfully started" -- --confirmo-sem-migracao "$SHA"
  rc 0; ordem "chatcrm_api chatcrm_worker chatcrm_web"
  update_tem chatcrm_api "--env-add RUN_MIGRATIONS=false"; update_nao_tem chatcrm_worker "RUN_MIGRATIONS"
  tem "pulando auto-migração"; tem "ficou com RUN_MIGRATIONS=false"

  novo_caso "worker com RUN_MIGRATIONS=true também desliga no PERIGO"
  diff_drop_column
  echo 'RUN_MIGRATIONS=true' >> "$S/env.chatcrm_worker"
  redeploy -- --confirmo-sem-migracao "$SHA"
  rc 0; update_tem chatcrm_worker "--env-add RUN_MIGRATIONS=false"

  novo_caso "DROP INDEX de drift conhecido: sem perigo, religa a migração"
  echo 'RUN_MIGRATIONS=false' >> "$S/env.chatcrm_api"
  cat > "$S/diff.sql" <<'SQL'
-- DropIndex
DROP INDEX "Conversation_lead_inbox_active_uq";

-- DropIndex
DROP INDEX "Patient_tenant_name_idx";

-- CreateTable
CREATE TABLE "LabOrder" (
    "id" TEXT NOT NULL,
    CONSTRAINT "LabOrder_pkey" PRIMARY KEY ("id")
);
SQL
  redeploy -- "$SHA"
  rc 0; tem "0 PERIGO"; tem "2 drift conhecido"; tem "Conversation_lead_inbox_active_uq"
  update_tem chatcrm_api "--env-rm RUN_MIGRATIONS"; ordem "chatcrm_api chatcrm_worker chatcrm_web"

  novo_caso "DROP INDEX desconhecido e ADD COLUMN NOT NULL sem DEFAULT: só aviso"
  cat > "$S/diff.sql" <<'SQL'
DROP INDEX "Lead_algum_idx";
ALTER TABLE "Lead" ADD COLUMN "lab_flag" BOOLEAN NOT NULL;
ALTER TYPE "Role" ADD VALUE 'LAB';
SQL
  redeploy -- "$SHA"
  rc 0; tem "0 PERIGO · 2 aviso"; tem 'aviso   DROP INDEX "Lead_algum_idx"'; docker_nao_tem "RUN_MIGRATIONS"

  novo_caso "diff tocando TeamMessage/ponto: PERIGO mesmo em DROP INDEX"
  cat > "$S/diff.sql" <<'SQL'
-- DropIndex
DROP INDEX "TeamMessage_tenant_id_channel_created_at_idx";
-- DropForeignKey
ALTER TABLE "TeamMessage" DROP CONSTRAINT "TeamMessage_tenant_id_fkey";
-- AlterTable
ALTER TABLE "TimeClockPunch" ALTER COLUMN "note" DROP DEFAULT;
-- DropTable
DROP TABLE "TeamChannelRead";
SQL
  redeploy DRIFT_EXTRA=TeamMessage_tenant_id_channel_created_at_idx -- "$SHA"
  rc 1; tem "4 PERIGO"; tem 'PERIGO  DROP INDEX "TeamMessage_tenant_id_channel_created_at_idx"'
  docker_nao_tem "service update"

  novo_caso "troca de tipo, SET NOT NULL, RENAME e enum recriado (sem tabela protegida): PERIGO"
  # o bloco AlterEnum é o que o prisma escreve quando um valor sai do enum
  cat > "$S/diff.sql" <<'SQL'
/*
  Warnings:

  - The values [LEGACY] on the enum `Role` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "Role_new" AS ENUM ('ADMIN', 'OPERADOR');
ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "role" TYPE "Role_new" USING ("role"::text::"Role_new");
ALTER TYPE "Role" RENAME TO "Role_old";
ALTER TYPE "Role_new" RENAME TO "Role";
DROP TYPE "Role_old";
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'OPERADOR';
COMMIT;

-- AlterTable
ALTER TABLE "Lead" ALTER COLUMN "name" SET DATA TYPE VARCHAR(100);

-- AlterTable
ALTER TABLE "Lead" ALTER COLUMN "email" SET NOT NULL;

ALTER TABLE "Lead" RENAME COLUMN "obs" TO "observacao";

ALTER TABLE "LeadVelho" RENAME TO "LeadArquivo";
SQL
  redeploy -- "$SHA"
  rc 1; tem "8 PERIGO · 1 aviso"; docker_nao_tem "service update"
  tem 'PERIGO  ALTER TABLE "User" ALTER COLUMN "role" TYPE "Role_new"'
  tem 'PERIGO  ALTER TYPE "Role" RENAME TO "Role_old"'
  tem 'PERIGO  ALTER TYPE "Role_new" RENAME TO "Role"'
  tem 'PERIGO  DROP TYPE "Role_old"'
  tem 'PERIGO  ALTER TABLE "Lead" ALTER COLUMN "name" SET DATA TYPE VARCHAR(100)'
  tem 'PERIGO  ALTER TABLE "Lead" ALTER COLUMN "email" SET NOT NULL'
  tem 'PERIGO  ALTER TABLE "Lead" RENAME COLUMN "obs" TO "observacao"'
  tem 'PERIGO  ALTER TABLE "LeadVelho" RENAME TO "LeadArquivo"'
  tem 'aviso   ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT'

  novo_caso "CREATE TABLE de tabela protegida: acréscimo, com aviso de que ainda não existe"
  cat > "$S/diff.sql" <<'SQL'
-- CreateTable
CREATE TABLE "TeamMessage" (
    "id" TEXT NOT NULL,
    CONSTRAINT "TeamMessage_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "TeamMessage_tenant_id_idx" ON "TeamMessage"("tenant_id");
-- AddForeignKey
ALTER TABLE "TeamMessage" ADD CONSTRAINT "TeamMessage_author_fkey" FOREIGN KEY ("author_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
SQL
  redeploy -- "$SHA"
  rc 0; tem "0 PERIGO"; tem "TeamMessage ainda não existe no banco vivo"; docker_nao_tem "RUN_MIGRATIONS"

  novo_caso "API fora do ar: diff não calculado = PERIGO (falha fechada)"
  redeploy STUB_API_FORA=1 -- "$SHA"
  rc 1; tem "Falha fechada"; docker_nao_tem "service update"

  novo_caso "erro do prisma não vaza a URL do banco"
  redeploy STUB_DIFF_FALHA=1 -- "$SHA"
  rc 1; tem "postgresql://***"; tem "Falha fechada"; docker_nao_tem "service update"

  novo_caso "--dry-run com CI vermelho e DROP COLUMN: mostra tudo, não muda nada"
  runs_ci failure
  diff_drop_column
  redeploy -- --dry-run "$SHA"
  rc 1; tem "DRY-RUN"; tem "PARARIA"; tem "terminou 'failure'"; tem "▶ Disco"; tem "sha256:bbbbbbbbbbbb"
  tem "PERIGO  ALTER TABLE"; tem "RUN_MIGRATIONS=false"; tem "1. chatcrm_api"; tem "3. chatcrm_web"
  docker_nao_tem "service update"; docker_nao_tem "image prune"
  docker_nao_tem "pull -q odontopassos/chat-crm-juridico-worker"
  if [ -e "$S/home/vps-redeploy.log" ]; then falhou "--dry-run escreveu o registro"; else passou; fi

  novo_caso "--dry-run tudo verde: diz que seguiria"
  redeploy -- --dry-run "$SHA"
  rc 0; tem "SEGUIRIA"; docker_nao_tem "service update"

  novo_caso "API não sobe no limite: para, worker/web ficam, mostra a volta"
  redeploy STUB_LOG_API= ESPERA_API_SEG=2 POLL_SEG=1 -- "$SHA"
  rc 1; ordem "chatcrm_api"; tem "NÃO executado"
  tem "docker service update --force --image $IMG_VELHA_API --env-add RUN_MIGRATIONS=false chatcrm_api"

  novo_caso "redeploy do mesmo sha: a task velha (mesmo digest) não conta"
  echo "$IMG_NOVA_API" > "$S/img0.chatcrm_api"; cp "$S/img0.chatcrm_api" "$S/img.chatcrm_api"
  redeploy STUB_LOG_API= ESPERA_API_SEG=2 POLL_SEG=1 -- "$SHA"
  rc 1; ordem "chatcrm_api"

  novo_caso "db push falhou 15 vezes: para na hora"
  redeploy "STUB_LOG_API=[entrypoint] prisma db push falhou (tentativa 15/15). Aguardando 3s...\n[Nest] 1  - LOG [Bootstrap] API rodando em http://localhost:3005" ESPERA_API_SEG=60 -- "$SHA"
  rc 1; ordem "chatcrm_api"; tem "falhou 15 vezes"

  novo_caso "Nest cai no boot depois do 'Schema aplicado' (ciclo de DI): para, worker/web ficam"
  redeploy "STUB_LOG_API=[entrypoint] Schema aplicado com sucesso.\n[Nest] 1  - ERROR [ExceptionHandler] Nest can't resolve dependencies of the X (?)" \
    ESPERA_API_SEG=2 POLL_SEG=1 -- "$SHA"
  rc 1; ordem "chatcrm_api"; tem "NÃO executado"; nao_tem "✅ API no ar"; nao_tem "Redeploy completo"
  if grep -q 'falhou: api nao subiu' "$S/home/vps-redeploy.log" 2>/dev/null; then passou; else falhou "registro sem o 'falhou'"; fi

  novo_caso "Nest escuta mas a task é trocada a cada consulta (cai depois do listen): para"
  redeploy STUB_TASK_TROCA=1 ESTAVEL_API_SEG=2 ESPERA_API_SEG=2 POLL_SEG=1 -- "$SHA"
  rc 1; ordem "chatcrm_api"; tem "Nest escutando na task"; nao_tem "✅ API no ar"; tem "NÃO executado"

  novo_caso "Nest escuta e a mesma task fica de pé pela janela: segue"
  redeploy ESTAVEL_API_SEG=1 ESPERA_API_SEG=5 POLL_SEG=1 -- "$SHA"
  rc 0; tem "de pé há 1s"; ordem "chatcrm_api chatcrm_worker chatcrm_web"

  novo_caso "interrompido durante a espera da API: mostra a volta e registra"
  # kill no próprio script quando ele consulta os logs da task nova
  redeploy "STUB_LOG_API=[entrypoint] Schema aplicado com sucesso." STUB_MATA_NO_LOG=1 ESPERA_API_SEG=30 POLL_SEG=1 -- "$SHA"
  rc 143; ordem "chatcrm_api"; tem "Saiu no meio da espera da API"; tem "NÃO executado"
  if grep -q 'falhou: interrompido depois do update da api' "$S/home/vps-redeploy.log" 2>/dev/null; then passou; else falhou "registro sem o 'interrompido'"; fi

  novo_caso "interrompido no update do worker: avisa que a API já subiu e registra"
  redeploy STUB_MATA_NO_UPDATE=chatcrm_worker -- "$SHA"
  rc 143; ordem "chatcrm_api chatcrm_worker"; tem "Saiu no meio do update de worker/web"; nao_tem "Redeploy completo"
  if grep -q 'falhou: interrompido no update de worker/web' "$S/home/vps-redeploy.log" 2>/dev/null; then passou; else falhou "registro sem o 'interrompido'"; fi

  for V in DISCO_MIN_LIVRE ESPERA_API_SEG ESTAVEL_API_SEG POLL_SEG; do
    novo_caso "$V fora do formato: uso errado antes de qualquer docker"
    redeploy STUB_DF_USO=99 "$V=15%" -- "$SHA"
    rc 2; tem "$V='15%' precisa ser um número"
    if [ -s "$S/docker.log" ]; then falhou "chamou o docker: $(head -1 "$S/docker.log")"; else passou; fi
  done
  novo_caso "DISCO_MIN_LIVRE acima de 100: uso errado"
  redeploy DISCO_MIN_LIVRE=101 -- "$SHA"
  rc 2; docker_nao_tem "service"

  novo_caso "opção desconhecida: uso errado"
  redeploy -- --sem-cii "$SHA"
  rc 2; docker_nao_tem "service update"
}

# ── vps-backup.sh ───────────────────────────────────────────────────────────
suite_backup() {
  novo_caso "backup: grava, confere e mantém os 5 mais recentes"
  mkdir -p "$S/home/backups"
  for d in 1 2 3 4 5 6; do
    touch -d "2026-01-0$d 03:00" "$S/home/backups/chatcrm-2026010$d-030000-velho.dump"
  done
  touch "$S/home/backups/outro-arquivo.dump"
  backup -- antes-deploy
  rc 0; tem "objeto(s) no índice"; tem "Backup pronto"
  local n novo
  n=$(ls -1 "$S/home/backups"/chatcrm-*.dump 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" = 5 ]; then passou; else falhou "ficaram $n dumps (esperado 5)"; fi
  novo=$(ls -1t "$S/home/backups"/chatcrm-*-antes-deploy.dump 2>/dev/null | head -1)
  if [ -n "$novo" ] && grep -q 'PGDMP-dump-falso' "$novo"; then passou; else falhou "dump novo ausente ou vazio"; fi
  if [ -e "$S/home/backups/chatcrm-20260101-030000-velho.dump" ]; then falhou "o mais velho não saiu"; else passou; fi
  if [ -e "$S/home/backups/outro-arquivo.dump" ]; then passou; else falhou "apagou arquivo que não é dele"; fi
  if ls "$S/home/backups"/*.parcial >/dev/null 2>&1; then falhou "sobrou .parcial"; else passou; fi

  novo_caso "backup: espaço menor que 2× o banco, recusa"
  backup STUB_DB_BYTES=10737418240 STUB_DF_LIVRE_KB=1048576 -- teste
  rc 1; tem "Espaço insuficiente"; docker_nao_tem "pg_dump"
  if ls "$S/home/backups"/chatcrm-*.dump >/dev/null 2>&1; then falhou "gravou dump sem espaço"; else passou; fi

  novo_caso "backup: pg_dump falha, nada fica"
  backup STUB_DUMP_FALHA=1 -- teste
  rc 1; tem "pg_dump falhou"
  if ls "$S/home/backups"/chatcrm-* >/dev/null 2>&1; then falhou "sobrou arquivo do dump que falhou"; else passou; fi

  novo_caso "backup: Postgres fora do ar"
  backup STUB_PG_FORA=1 -- teste
  rc 1; tem "Nenhum container rodando"

  novo_caso "backup: destino em /tmp é recusado"
  local tmpdest="/tmp/vps-backup-teste-$$"
  rodar "$BACKUP" "BACKUP_DIR=$tmpdest" -- teste
  rm -rf "$tmpdest"
  rc 1; tem "temporário"; docker_nao_tem "pg_dump"
}

# ── Execução ────────────────────────────────────────────────────────────────
ENGINES=()
if python3 -c 'import json' >/dev/null 2>&1; then ENGINES+=(python3)
elif [ -n "${CI:-}" ]; then echo "❌ No CI o python3 é obrigatório (é o leitor de JSON do servidor)."; exit 1
fi
if node -e '' >/dev/null 2>&1; then ENGINES+=(node); fi
if [ "${#ENGINES[@]}" -eq 0 ]; then echo "❌ Precisa de python3 ou node."; exit 1; fi

for ENGINE in "${ENGINES[@]}"; do
  echo "▶ vps-redeploy.sh com o leitor de JSON: $ENGINE"
  suite_redeploy
done
ENGINE="${ENGINES[0]}"
echo "▶ vps-backup.sh"
suite_backup

echo ""
if [ "$FALHAS" -gt 0 ]; then
  echo "❌ $FALHAS verificação(ões) falharam ($OKS ok, $N casos, leitores: ${ENGINES[*]})."
  exit 1
fi
echo "✅ $OKS verificações ok em $N casos (leitores de JSON: ${ENGINES[*]})."
