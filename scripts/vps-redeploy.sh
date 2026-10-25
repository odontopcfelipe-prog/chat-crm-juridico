#!/bin/bash
# ============================================================================
# vps-redeploy.sh v2 — Redeploy correto das imagens no Docker Swarm, com travas
# ============================================================================
# Resolve o "deploy fantasma": `docker service update --image X:latest` sozinho
# NÃO baixa a imagem nova — o Swarm resolve `:latest` pelo digest em cache local
# (o antigo). Os containers reiniciam, mas rodam o código velho.
#
# A correção: baixar a imagem e fixar o DIGEST exato (@sha256:...) no service
# update — assim o Swarm é obrigado a rodar exatamente a imagem baixada.
#
# ⚠ NESTE SERVIDOR, `docker pull` por TAG trava (fica parado sem saída) e por
# DIGEST funciona — visto em 01/out/2026, e reiniciar o Docker NÃO resolve.
# Por isso o digest de cada tag vem da API do Docker Hub e o download/pin é
# SEMPRE por digest. E as 3 imagens são baixadas ANTES de mexer em qualquer
# service (uma falha de download não deixa API nova com web/worker velhos).
#
# v2 (F0a da rede de proteção) — tudo que o v1 fazia, mais:
#   - Portão do CI: o sha só sobe com o workflow "CI — testes e checagens"
#     verde na ÚLTIMA tentativa (API pública do GitHub, sem token). Escape
#     explícito: --sem-ci (fica registrado).
#   - Disco: mostra o df da raiz e do diretório do Docker; com menos de 10%
#     livre recusa (escape: --forcar-disco).
#   - Schema: a API aplica o schema no boot com `prisma db push
#     --accept-data-loss` (infra/entrypoint.sh). Voltar para uma imagem antiga
#     APAGA as tabelas/colunas criadas depois dela. Antes de mexer, o v2 lê o
#     schema.prisma da imagem NOVA sem rodá-la (docker create + docker cp) e
#     roda `prisma migrate diff` dentro da API que já está no ar, contra o
#     banco vivo. Se o diff apagaria algo, a API sobe com RUN_MIGRATIONS=false
#     (só com --confirmo-sem-migracao); sem perigo, religa a migração se um
#     deploy anterior tinha desligado. Diff que não dá para calcular = PERIGO.
#   - Ordem: API primeiro; espera, com limite de tempo, uma task nova com o
#     "[entrypoint] Schema aplicado com sucesso." (ou "pulando auto-migração"),
#     a linha do Nest depois do listen e a task de pé por 30s; só então
#     worker e web.
#   - --dry-run: mostra tudo isso e não mexe em nenhum service.
#
# Uso na VPS (deploy é MANUAL, a pedido do dono — docs/deploy.md):
#   bash ~/scripts/vps-redeploy.sh --dry-run <SHA_COMPLETO_40>
#   bash ~/scripts/vps-redeploy.sh <SHA_COMPLETO_40>
# Sem sha usa :latest — aí não há como conferir o CI e o --sem-ci é exigido.
# ============================================================================
set -euo pipefail

VERSAO="v2"

uso() {
  cat <<'EOF'
Uso: bash ~/scripts/vps-redeploy.sh [opções] <sha40>

Opções:
  --dry-run                mostra CI, disco, digests, diff do schema, decisão de
                           RUN_MIGRATIONS e a ordem dos updates; NÃO mexe em service
  --sem-ci                 aceita sha sem CI verde (ou 'latest'); fica registrado
  --forcar-disco           aceita menos de 10% de disco livre
  --confirmo-sem-migracao  aceita subir a API com RUN_MIGRATIONS=false quando o
                           schema novo apagaria algo no banco
  -h, --help               esta ajuda

Saída: 0 = feito (no --dry-run: o deploy real seguiria); 1 = recusado ou falhou
(nada é alterado antes do primeiro service update); 2 = uso errado.
EOF
}

# ── Argumentos ──────────────────────────────────────────────────────────────
DRY_RUN=0; SEM_CI=0; FORCAR_DISCO=0; CONFIRMO_SEM_MIG=0; TAG_ARG=""
for ARG in "$@"; do
  case "$ARG" in
    --dry-run) DRY_RUN=1 ;;
    --sem-ci) SEM_CI=1 ;;
    --forcar-disco) FORCAR_DISCO=1 ;;
    --confirmo-sem-migracao) CONFIRMO_SEM_MIG=1 ;;
    -h|--help) uso; exit 0 ;;
    -*) echo "❌ Opção desconhecida: $ARG"; uso; exit 2 ;;
    *)
      if [ -n "$TAG_ARG" ]; then echo "❌ Dois shas na linha: '$TAG_ARG' e '$ARG'."; exit 2; fi
      TAG_ARG="$ARG" ;;
  esac
done
TAG="${TAG_ARG:-${TAG:-latest}}"
if [ "$TAG" != "latest" ] && ! [[ "$TAG" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "❌ '$TAG' não parece um sha do git (7 a 40 caracteres 0-9a-f) nem 'latest'."
  exit 2
fi
OPCOES=""
[ "$DRY_RUN" = 1 ] && OPCOES="$OPCOES --dry-run"
[ "$SEM_CI" = 1 ] && OPCOES="$OPCOES --sem-ci"
[ "$FORCAR_DISCO" = 1 ] && OPCOES="$OPCOES --forcar-disco"
[ "$CONFIRMO_SEM_MIG" = 1 ] && OPCOES="$OPCOES --confirmo-sem-migracao"

REPO="${REPO:-odontopassos/chat-crm-juridico}"
STACK="${STACK:-chatcrm}"
GH_REPO="${GH_REPO:-odontopcfelipe-prog/chat-crm-juridico}"
CI_WORKFLOW="${CI_WORKFLOW:-CI — testes e checagens}"
CI_WORKFLOW_PATH="${CI_WORKFLOW_PATH:-.github/workflows/ci.yml}"
DISCO_MIN_LIVRE="${DISCO_MIN_LIVRE:-10}"        # % livre mínimo
ESPERA_API_SEG="${ESPERA_API_SEG:-300}"         # limite para a API nova subir
ESTAVEL_API_SEG="${ESTAVEL_API_SEG:-30}"        # a task nova tem de ficar de pé esse tempo
POLL_SEG="${POLL_SEG:-5}"
REDEPLOY_LOG="${REDEPLOY_LOG:-$HOME/vps-redeploy.log}"
# Número fora do formato quebrava a trava em silêncio: o `[ -lt ]` do disco dava
# erro e passava (falha aberta), e a espera da API morria por `set -u` DEPOIS do
# update dela. Confere aqui, antes de qualquer docker.
for V in DISCO_MIN_LIVRE ESPERA_API_SEG ESTAVEL_API_SEG POLL_SEG; do
  if ! [[ "${!V}" =~ ^[0-9]+$ ]]; then
    echo "❌ $V='${!V}' precisa ser um número inteiro (sem %, sem unidade). NADA foi alterado."
    exit 2
  fi
done
if [ "$DISCO_MIN_LIVRE" -gt 100 ]; then
  echo "❌ DISCO_MIN_LIVRE=$DISCO_MIN_LIVRE passa de 100 (%). NADA foi alterado."; exit 2
fi

# Tabelas que NUNCA entram no drift aceito: ponto (registro legal), anexos dos
# disparos e conversa da equipe. Qualquer DROP/ALTER nelas é PERIGO. A lista só
# cresce (PROTEGIDAS_EXTRA acrescenta, nada tira).
PROTEGIDAS="TimeClockPunch TimeClockMember TimeClockSchedule DisparoAnexo TeamMessage TeamChannelRead ${PROTEGIDAS_EXTRA:-}"

# ── Leitor de JSON (Docker Hub e GitHub) ────────────────────────────────────
# python3 no servidor (o v1 já exigia). node é aceito como alternativa só para
# o teste rodar em máquina sem python; as duas versões fazem a MESMA extração,
# e toda decisão fica no bash/awk abaixo.
PY_JSON=$(cat <<'PY'
import json, os, re, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if not isinstance(d, dict):
    sys.exit(0)
def limpa(v):
    s = "" if v is None else re.sub(r"[\t\r\n]+", " ", str(v))
    return s if s else "-"
modo = os.environ.get("JSON_MODO", "")
if modo == "hub_digest":
    g = d.get("digest") or ""
    if not g:
        for i in d.get("images") or []:
            if isinstance(i, dict) and i.get("os") == "linux" and i.get("architecture") == "amd64":
                g = i.get("digest") or ""
                break
    print(g)
elif modo == "hub_tags":
    for t in d.get("results") or []:
        if isinstance(t, dict):
            print(limpa(t.get("name")))
elif modo == "gh_runs":
    for r in d.get("workflow_runs") or []:
        if isinstance(r, dict):
            ini = r.get("run_started_at") or r.get("created_at")
            print("\t".join(limpa(v) for v in (r.get("id"), r.get("run_attempt"), ini, r.get("status"),
                  r.get("conclusion"), r.get("event"), r.get("path"), r.get("html_url"), r.get("name"))))
PY
)
JS_JSON=$(cat <<'JS'
let d; try { d = JSON.parse(require('fs').readFileSync(0, 'utf8')); } catch (e) { process.exit(0); }
if (!d || typeof d !== 'object' || Array.isArray(d)) process.exit(0);
const limpa = (v) => { const s = (v === null || v === undefined) ? '' : String(v).replace(/[\t\r\n]+/g, ' '); return s || '-'; };
const modo = process.env.JSON_MODO || ''; const out = [];
if (modo === 'hub_digest') {
  let g = d.digest || '';
  if (!g) for (const i of d.images || []) { if (i && i.os === 'linux' && i.architecture === 'amd64') { g = i.digest || ''; break; } }
  out.push(g);
} else if (modo === 'hub_tags') {
  for (const t of d.results || []) if (t && typeof t === 'object') out.push(limpa(t.name));
} else if (modo === 'gh_runs') {
  for (const r of d.workflow_runs || []) if (r && typeof r === 'object') {
    out.push([r.id, r.run_attempt, r.run_started_at || r.created_at, r.status, r.conclusion, r.event, r.path, r.html_url, r.name].map(limpa).join('\t'));
  }
}
if (out.length) process.stdout.write(out.join('\n') + '\n');
JS
)
JSON_ENGINE="${JSON_ENGINE:-}"
if [ -z "$JSON_ENGINE" ]; then
  if python3 -c 'import json' >/dev/null 2>&1; then JSON_ENGINE=python3
  elif node -e '' >/dev/null 2>&1; then JSON_ENGINE=node
  else echo "❌ Precisa de python3 (pra ler as APIs do Docker Hub e do GitHub)."; exit 1
  fi
fi
json_tool() {  # $1 = hub_digest | hub_tags | gh_runs ; JSON na entrada padrão
  if [ "$JSON_ENGINE" = node ]; then
    JSON_MODO="$1" node -e "$JS_JSON"
  else
    JSON_MODO="$1" PYTHONIOENCODING=utf-8 python3 -c "$PY_JSON"
  fi
}

# ── Classificador do diff de schema (awk puro: igual em mawk e gawk) ───────
# Entrada: SQL do `prisma migrate diff --script`. Saída: "<CLASSE>\t<comando>":
#   PERIGO — apaga ou troca dado (DROP TABLE/COLUMN, troca de tipo, SET NOT
#            NULL, RENAME, DROP TYPE...) ou remove/altera algo numa tabela
#            protegida;
#   DRIFT  — DROP INDEX de índice que só existe no banco (criado no boot ou
#            pelos manual-sql): o db push recria/ignora, não conta;
#   AVISO  — remove índice/constraint/default desconhecido, ou ADD COLUMN NOT
#            NULL sem DEFAULT (o db push pode falhar em tabela com linhas);
#   OK     — acréscimo (CREATE TABLE/INDEX, ADD COLUMN, ADD CONSTRAINT...).
AWK_CLASSIFICA=$(cat <<'AWK'
BEGIN {
  NP = split(protegidas, P, " ")
  if (driftfile != "") {
    while ((getline l < driftfile) > 0) { sub(/\r$/, "", l); if (l != "") DRIFT[l] = 1 }
    close(driftfile)
  }
  em_bloco = 0; buf = ""
}
function protegida_por_nome(nome,   i) {
  for (i = 1; i <= NP; i++) if (nome == P[i] || index(nome, P[i] "_") == 1) return 1
  return 0
}
function toca_protegida(s,   r, id, i) {
  r = s
  while (match(r, /"[^"]+"/)) {
    id = substr(r, RSTART + 1, RLENGTH - 2)
    for (i = 1; i <= NP; i++) if (id == P[i]) return 1
    r = substr(r, RSTART + RLENGTH)
  }
  return 0
}
function ultimo_ident(s,   r, id, n, w) {
  r = s; id = ""
  while (match(r, /"[^"]+"/)) { id = substr(r, RSTART + 1, RLENGTH - 2); r = substr(r, RSTART + RLENGTH) }
  if (id != "") return id
  n = split(s, w, /[ \t\n]+/); id = w[n]; gsub(/[;"]/, "", id)
  return id
}
function add_not_null_sem_default(k,   n, c, i) {
  if (k !~ /^ALTER TABLE/) return 0
  n = split(k, c, "\n")
  for (i = 1; i <= n; i++) if (c[i] ~ /ADD COLUMN/ && c[i] ~ /NOT NULL/ && c[i] !~ /DEFAULT/) return 1
  return 0
}
function classifica(s,   k, um, cl, nome) {
  k = toupper(s); gsub(/"[^"]*"/, "\"_\"", k)   # palavras-chave, sem os nomes
  um = s; gsub(/[ \t\n]+/, " ", um)
  if (k ~ /^(BEGIN|COMMIT)[ \t]*;?[ \t]*$/) return
  if (k ~ /^(DROP|ALTER) INDEX/) {
    # índice: o nome começa pelo da tabela (padrão do Prisma)
    if (k ~ /^DROP INDEX/) nome = ultimo_ident(s)
    else if (match(s, /"[^"]+"/)) nome = substr(s, RSTART + 1, RLENGTH - 2)
    else nome = ""
    if (protegida_por_nome(nome)) cl = "PERIGO"
    else if (k ~ /^DROP INDEX/ && (nome in DRIFT)) cl = "DRIFT"
    else cl = "AVISO"
  } else if (toca_protegida(s)) {
    # tabela protegida: só acréscimo passa; remover/alterar qualquer coisa é PERIGO
    if (k ~ /^CREATE (TABLE|INDEX|UNIQUE INDEX)/) cl = "OK"
    else if (k ~ /^ALTER TABLE/ && k !~ /DROP|ALTER COLUMN|RENAME|TYPE/) cl = (add_not_null_sem_default(k) ? "AVISO" : "OK")
    else cl = "PERIGO"
  } else if (k ~ /DROP TABLE|DROP COLUMN|SET DATA TYPE|ALTER COLUMN "_" TYPE|SET NOT NULL|RENAME COLUMN|DROP TYPE|DROP EXTENSION|DROP SCHEMA|DROP VIEW|DROP SEQUENCE|TRUNCATE|DELETE FROM/ ||
             k ~ /^ALTER TABLE ("_"\.)?"_" RENAME TO/ || k ~ /^ALTER TYPE .*RENAME/) {
    cl = "PERIGO"
  } else if (k ~ /DROP|RENAME/ || add_not_null_sem_default(k)) {
    # DROP INDEX/CONSTRAINT/DEFAULT/NOT NULL, RENAME CONSTRAINT: não perde dado
    cl = "AVISO"
  } else {
    cl = "OK"
  }
  print cl "\t" um
}
{
  linha = $0; sub(/\r$/, "", linha)
  if (em_bloco) { if (index(linha, "*/")) em_bloco = 0; next }
  t = linha; sub(/^[ \t]+/, "", t)
  if (substr(t, 1, 2) == "/*") { if (!index(substr(t, 3), "*/")) em_bloco = 1; next }
  if (substr(t, 1, 2) == "--" || t == "") next
  buf = (buf == "" ? t : buf "\n" t)
  if (t ~ /;[ \t]*$/) { classifica(buf); buf = "" }
}
END { if (buf != "") classifica(buf) }
AWK
)

# ── Utilitários ─────────────────────────────────────────────────────────────
RECUSAS=()
AVISOS=()
recusar() {  # no deploy real para aqui; no --dry-run anota e segue mostrando
  if [ "$DRY_RUN" = 1 ]; then
    RECUSAS+=("$1")
    echo "  ⛔ o deploy real PARARIA aqui: $1"
  else
    echo ""
    echo "❌ $1"
    echo "   NADA foi alterado."
    exit 1
  fi
}
avisar() { AVISOS+=("$1"); echo "  ⚠ $1"; }

# Valor de UMA variável do service. Nunca imprime o resto do ambiente (tem senha).
env_do_service() {  # $1 = service, $2 = variável
  docker service inspect --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' "$1" 2>/dev/null \
    | sed -n "s/^$2=//p" | tail -1 || true
}
imagem_do_service() {
  docker service inspect --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' "$1" 2>/dev/null || true
}
digest_de() { local d="${1##*@}"; [[ "$d" == sha256:* ]] && echo "${d:0:19}…" || echo "${1:-?}"; }
redigir() { sed -E 's#(postgres(ql)?://)[^[:space:]"'"'"'`]+#\1***#g'; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/vps-redeploy.XXXXXX")
NEW_CID=""; API_CID=""; REMOTE_SCHEMA=""
# "api" do update da API até ela ser dada como no ar; "resto" durante worker e
# web. Se o script sair no meio (Ctrl+C, erro inesperado), o trap mostra a
# volta (ou o que falta) e grava o 'falhou', em vez de sair calado com a API
# nova e worker/web velhos.
FASE=""
limpar() {
  if [ "$FASE" = "api" ]; then
    FASE=""
    echo ""
    echo "  ❌ Saiu no meio da espera da API (interrompido ou erro inesperado)."
    mostrar_volta
    registrar "falhou: interrompido depois do update da api"
  elif [ "$FASE" = "resto" ]; then
    FASE=""
    echo ""
    echo "  ❌ Saiu no meio do update de worker/web: a API já está na versão nova."
    echo "     Confira com 'docker service ls' e rode o mesmo comando de novo (o mesmo sha é seguro)."
    registrar "falhou: interrompido no update de worker/web"
  fi
  if [ -n "$NEW_CID" ]; then docker rm -f "$NEW_CID" >/dev/null 2>&1 || true; fi
  if [ -n "$API_CID" ] && [ -n "$REMOTE_SCHEMA" ]; then docker exec "$API_CID" rm -f "$REMOTE_SCHEMA" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap limpar EXIT
trap 'exit 130' INT    # o EXIT acima roda também no Ctrl+C, no kill e na
trap 'exit 143' TERM   # queda da sessão (aí só o registro fica)
trap 'exit 129' HUP

echo "═══════════════════════════════════════════════════════════════"
echo " Redeploy chatcrm ($VERSAO) — tag: $TAG"
[ "$DRY_RUN" = 1 ] && echo " DRY-RUN: só mostra o que faria; nenhum service é alterado."
echo "═══════════════════════════════════════════════════════════════"

# Detecta SÓ os services do stack chatcrm. Ancorado em "^chatcrm_" de
# propósito: o regex genérico "_(api|worker|web)$" pegava também services de
# OUTROS stacks que terminam em _api (ex.: o service da Evolution
# "evolution_evolution_api") e os sobrescrevia com a imagem do CRM. Override
# do nome do stack via env STACK=.
SERVICES=$(docker service ls --format '{{.Name}}' | grep -E "^${STACK}_(api|worker|web)\$" || true)
if [ -z "$SERVICES" ]; then
  echo "❌ Nenhum service ${STACK}_(api|worker|web) encontrado. É Swarm? O stack está no ar?"
  docker service ls --format '   - {{.Name}}'
  exit 1
fi
# Ordem fixa: API (aplica o schema) → worker → web.
ORDEM=()
for S in api worker web; do
  if grep -qx "${STACK}_${S}" <<<"$SERVICES"; then ORDEM+=("$S"); fi
done
if [ "${ORDEM[0]}" != "api" ]; then
  echo "❌ ${STACK}_api não está no ar: sem ela o v2 não confere o schema. NADA foi alterado."
  exit 1
fi

# ── SHA curto → completo ────────────────────────────────────────────────────
# O CI publica as imagens com o SHA de 40 chars (e :latest). Rodar este script
# com um SHA CURTO (7-12 chars) dava "not found" no pull — só o hook, que usa
# :latest, funcionava. Se o TAG não for 'latest' e tiver menos de 40 chars,
# resolve o SHA completo consultando o Docker Hub (a tag que COMEÇA com o curto).
# Falha graciosa: se não resolver (sem rede ou tag ausente), segue com o TAG
# original (e o portão do CI recusa, porque não há sha para conferir).
if [ "$TAG" != "latest" ] && [ "${#TAG}" -lt 40 ]; then
  echo "▶ Resolvendo SHA curto '$TAG' → completo (Docker Hub)..."
  RESOLVED=$(curl -fsSL -m 20 "https://hub.docker.com/v2/repositories/${REPO}-api/tags/?page_size=100&ordering=last_updated" 2>/dev/null \
    | json_tool hub_tags 2>/dev/null | grep -E "^${TAG}[0-9a-f]*\$" | head -1 || true)
  if [ "${#RESOLVED}" -eq 40 ]; then
    echo "  → $RESOLVED"
    TAG="$RESOLVED"
  else
    echo "  ⚠ Não resolvi (sem rede ou tag ausente) — tento com '$TAG' mesmo."
  fi
fi

# ── 1. Portão do CI ─────────────────────────────────────────────────────────
# Lê os runs do workflow do CI para o sha na API pública do GitHub (sem token:
# 60 consultas/hora por IP). Vale a ÚLTIMA tentativa: dentro de um run, o maior
# run_attempt (um "re-run" que passou libera sem commit vazio); entre runs
# diferentes do mesmo sha, o que começou por último.
CI_STATUS="nao-conferido"
ci_falhou() {
  CI_STATUS="sem-ci"
  if [ "$SEM_CI" = 1 ]; then
    avisar "--sem-ci: seguindo sem CI verde ($1)"
  else
    recusar "$1. Se for hotfix consciente, rode de novo com --sem-ci."
  fi
}
echo ""
echo "▶ CI ($CI_WORKFLOW)"
if [ "$TAG" = "latest" ]; then
  echo "  'latest' não é um sha: não dá para conferir o CI."
  ci_falhou "deploy de 'latest' sem conferir o CI"
elif [ "${#TAG}" -ne 40 ]; then
  ci_falhou "sha '$TAG' não virou um sha de 40 caracteres: não dá para conferir o CI"
else
  RUNS_JSON=""
  if ! RUNS_JSON=$(curl -fsSL -m 20 -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/${GH_REPO}/actions/runs?head_sha=${TAG}&per_page=100" 2>/dev/null); then
    RUNS_JSON=""
  fi
  if [ -z "$RUNS_JSON" ]; then
    ci_falhou "não consegui consultar o GitHub (rede ou limite de consultas sem token)"
  else
    ESC=$(printf '%s' "$RUNS_JSON" | json_tool gh_runs | awk -F'\t' -v wf="$CI_WORKFLOW" -v wfpath="$CI_WORKFLOW_PATH" '
      ($9 == wf || $7 == wfpath) {
        at = $2 + 0
        if (!($1 in tent) || at > tent[$1]) { tent[$1] = at; linha[$1] = $0; ini[$1] = $3 }
      }
      END {
        esc = ""
        for (id in linha)
          if (esc == "" || ini[id] > ini[esc] || (ini[id] == ini[esc] && tent[id] > tent[esc])) esc = id
        if (esc != "") print linha[esc]
      }' || true)
    if [ -z "$ESC" ]; then
      ci_falhou "nenhum run do CI para ${TAG:0:12} (o CI ainda não começou, ou o sha não passou pela master)"
    else
      IFS=$'\t' read -r R_ID R_ATT R_INI R_STATUS R_CONC R_EVENT R_PATH R_URL R_NAME <<<"$ESC"
      echo "  run $R_ID · tentativa $R_ATT · $R_EVENT · início $R_INI · $R_STATUS/$R_CONC"
      echo "  $R_URL"
      if [ "$R_STATUS" != "completed" ]; then
        ci_falhou "o CI de ${TAG:0:12} ainda não terminou (status: $R_STATUS) — espere e rode de novo"
      elif [ "$R_CONC" != "success" ]; then
        ci_falhou "o CI de ${TAG:0:12} terminou '$R_CONC' na tentativa $R_ATT"
      else
        CI_STATUS="verde"
        echo "  ✅ CI verde na última tentativa ($R_ATT)."
      fi
    fi
  fi
fi

# ── 2. Disco ────────────────────────────────────────────────────────────────
echo ""
echo "▶ Disco"
DOCKER_ROOT=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
[ -n "$DOCKER_ROOT" ] || DOCKER_ROOT=/var/lib/docker
df -h / "$DOCKER_ROOT" 2>/dev/null | sed 's/^/   /' || true
DISCO_OK=1
for P in / "$DOCKER_ROOT"; do
  USO=$(df -P "$P" 2>/dev/null | awk 'NR==2 { gsub("%", "", $5); print $5 }' || true)
  if ! [[ "$USO" =~ ^[0-9]+$ ]]; then
    if [ "$P" = "/" ]; then
      DISCO_OK=0
      if [ "$FORCAR_DISCO" = 1 ]; then avisar "--forcar-disco: não consegui ler o df de /"
      else recusar "não consegui ler o df de / (escape: --forcar-disco)"; fi
    else
      avisar "não consegui ler o df de $P (diretório do Docker) — conferido só a raiz"
    fi
    continue
  fi
  LIVRE=$((100 - USO))
  if [ "$LIVRE" -lt "$DISCO_MIN_LIVRE" ]; then
    DISCO_OK=0
    if [ "$FORCAR_DISCO" = 1 ]; then
      avisar "--forcar-disco: $P com só ${LIVRE}% livre (mínimo ${DISCO_MIN_LIVRE}%)"
    else
      recusar "$P com só ${LIVRE}% livre (mínimo ${DISCO_MIN_LIVRE}%). Limpe imagens antigas (docker image prune) ou use --forcar-disco"
    fi
  else
    echo "  ✅ $P: ${LIVRE}% livre"
  fi
done

# ── 3. Digests no Docker Hub ────────────────────────────────────────────────
hub_digest() {  # $1 = api|worker|web
  local d
  d=$(curl -fsSL -m 20 "https://hub.docker.com/v2/repositories/${REPO}-$1/tags/${TAG}" 2>/dev/null \
    | json_tool hub_digest 2>/dev/null || true)
  [[ "$d" =~ ^sha256:[0-9a-f]{64}$ ]] && echo "$d" || true
}
echo ""
echo "▶ Imagens (digest no Docker Hub)"
declare -A PIN DIG ANTES
for S in "${ORDEM[@]}"; do
  HD=$(hub_digest "$S")
  if [ -z "$HD" ]; then
    echo "❌ Não achei ${REPO}-${S}:${TAG} no Docker Hub (CI terminou? SHA certo?). NADA foi alterado."
    exit 1
  fi
  DIG[$S]="$HD"
  PIN[$S]="${REPO}-${S}@${HD}"
  ANTES[$S]=$(imagem_do_service "${STACK}_${S}")
  echo "  ${STACK}_${S}: $(digest_de "${ANTES[$S]}")  →  ${HD:0:19}… (${REPO}-${S}:${TAG:0:12})"
done

# ── 4. Download por digest ──────────────────────────────────────────────────
# Deploy real: as 3 antes de mexer em qualquer service. --dry-run: só a da API
# (precisa dela para ler o schema novo); com disco recusado, nenhuma.
BAIXADAS=()
if [ "$DRY_RUN" = 1 ]; then
  if [ "$DISCO_OK" = 1 ] || [ "$FORCAR_DISCO" = 1 ]; then BAIXAR=(api); else BAIXAR=(); fi
else
  BAIXAR=("${ORDEM[@]}")
fi
for S in ${BAIXAR[@]+"${BAIXAR[@]}"}; do
  echo ""
  echo "▶ pull ${PIN[$S]:0:60}…"
  if ! timeout 900 docker pull -q "${PIN[$S]}" >/dev/null; then
    echo "  ❌ Falha/travamento no pull de ${PIN[$S]}. NADA foi alterado."
    exit 1
  fi
  BAIXADAS+=("$S")
  echo "  ✅ baixada"
done
API_BAIXADA=0
for S in ${BAIXADAS[@]+"${BAIXADAS[@]}"}; do [ "$S" = api ] && API_BAIXADA=1; done

# Rótulo crm.lab_aware (só informativo até a F2a, quando vira trava).
if [ "$API_BAIXADA" = 1 ]; then
  LABEL=$(docker image inspect --format '{{json .Config.Labels}}' "${PIN[api]}" 2>/dev/null \
    | grep -oE '"crm\.lab_aware":"[^"]*"' | sed -E 's/.*:"([^"]*)"/\1/' || true)
  echo "  ⓘ rótulo crm.lab_aware da imagem da API: ${LABEL:-ausente} (informativo; vira trava na F2a)"
fi

# ── 5. Schema: imagem nova × banco vivo ─────────────────────────────────────
SCHEMA_RESULT="DESCONHECIDO"; SCHEMA_MOTIVO=""
API_SCHEMA_VIVO="/app/packages/shared/prisma/schema.prisma"   # dentro da API no ar
schema_desconhecido() {
  SCHEMA_RESULT="DESCONHECIDO"; SCHEMA_MOTIVO="$1"
  echo "  ⛔ Não calculei o diff: $1."
  echo "     Falha fechada: tratado como PERIGO (a API subiria com RUN_MIGRATIONS=false)."
}
calcular_diff() {
  if [ "$API_BAIXADA" != 1 ]; then schema_desconhecido "a imagem nova da API não foi baixada"; return; fi
  API_CID=$(docker ps -q --filter "label=com.docker.swarm.service.name=${STACK}_api" --filter status=running 2>/dev/null | head -1 || true)
  if [ -z "$API_CID" ]; then
    schema_desconhecido "nenhum container da ${STACK}_api rodando — o diff roda dentro dela, contra o banco vivo"
    return
  fi
  # Lê o schema da imagem nova SEM rodá-la: container criado e nunca iniciado.
  if ! NEW_CID=$(docker create --network none --entrypoint sh "${PIN[api]}" 2>/dev/null) || [ -z "$NEW_CID" ]; then
    NEW_CID=""; schema_desconhecido "docker create da imagem nova falhou"; return
  fi
  if ! docker cp "$NEW_CID:/app/packages/shared/prisma/schema.prisma" "$WORK/schema.novo.prisma" >/dev/null 2>&1 \
      || [ ! -s "$WORK/schema.novo.prisma" ]; then
    schema_desconhecido "não achei o schema.prisma na imagem nova"; return
  fi
  if ! docker cp "$NEW_CID:/app/packages/shared/prisma/manual-sql" "$WORK/manual-sql" >/dev/null 2>&1; then
    echo "  ⓘ imagem sem prisma/manual-sql: o drift conhecido fica só com os índices do boot."
  fi
  docker rm -f "$NEW_CID" >/dev/null 2>&1 || true
  NEW_CID=""

  # Drift conhecido: índices criados fora do schema (no boot da API e pelos
  # manual-sql). O DROP deles no diff não conta. Tabela protegida nunca entra.
  {
    echo "Conversation_lead_inbox_active_uq"
    for X in ${DRIFT_EXTRA:-}; do echo "$X"; done
    if [ -d "$WORK/manual-sql" ]; then
      cat "$WORK/manual-sql"/*.sql 2>/dev/null \
        | grep -oiE 'CREATE[[:space:]]+(UNIQUE[[:space:]]+)?INDEX[[:space:]]+(CONCURRENTLY[[:space:]]+)?(IF[[:space:]]+NOT[[:space:]]+EXISTS[[:space:]]+)?"?[A-Za-z0-9_]+' \
        | sed -E 's/.*[[:space:]]"?([A-Za-z0-9_]+)$/\1/' || true
    fi
  } | sort -u > "$WORK/drift.txt"

  REMOTE_SCHEMA="/tmp/vps-redeploy-schema-${TAG:0:12}-$$.prisma"
  if ! docker cp "$WORK/schema.novo.prisma" "$API_CID:$REMOTE_SCHEMA" >/dev/null 2>&1; then
    REMOTE_SCHEMA=""; schema_desconhecido "docker cp do schema para o container da API falhou"; return
  fi
  # Origem = o datasource do schema da PRÓPRIA API no ar (url = env("DATABASE_URL")):
  # o prisma lê a URL do ambiente do container, como o `db push` do entrypoint.
  # Ela não vira argumento de processo (que o `ps` do host mostra) nem passa
  # pelo host; erros passam pelo redigir().
  if ! timeout 180 docker exec -w /app/packages/shared "$API_CID" sh -c \
      'PRISMA_HIDE_UPDATE_MESSAGE=1 npx --no-install prisma migrate diff --from-schema-datasource "$1" --to-schema-datamodel "$2" --script' \
      sh "$API_SCHEMA_VIVO" "$REMOTE_SCHEMA" > "$WORK/diff.sql" 2> "$WORK/diff.err"; then
    echo "  saída do prisma (redigida):"
    redigir < "$WORK/diff.err" | tail -15 | sed 's/^/     | /'
    schema_desconhecido "prisma migrate diff falhou dentro da API (banco fora? prisma da API velha não entende o schema novo?)"
    return
  fi
  docker exec "$API_CID" rm -f "$REMOTE_SCHEMA" >/dev/null 2>&1 || true
  REMOTE_SCHEMA=""

  awk -v protegidas="$PROTEGIDAS" -v driftfile="$WORK/drift.txt" "$AWK_CLASSIFICA" "$WORK/diff.sql" > "$WORK/classes.tsv"
  local N_P N_A N_D N_O
  N_P=$(grep -c '^PERIGO' "$WORK/classes.tsv" || true)
  N_A=$(grep -c '^AVISO' "$WORK/classes.tsv" || true)
  N_D=$(grep -c '^DRIFT' "$WORK/classes.tsv" || true)
  N_O=$(grep -c '^OK' "$WORK/classes.tsv" || true)
  if [ $((N_P + N_A + N_D + N_O)) -eq 0 ]; then
    echo "  ✅ Sem diferença: o banco vivo já está no schema da imagem nova."
  else
    echo "  $N_P PERIGO · $N_A aviso · $N_D drift conhecido (ignorado) · $N_O acréscimo"
    grep '^PERIGO' "$WORK/classes.tsv" | cut -f2- | cut -c1-200 | sed 's/^/   PERIGO  /' || true
    grep '^AVISO' "$WORK/classes.tsv" | cut -f2- | cut -c1-200 | head -30 | sed 's/^/   aviso   /' || true
    grep '^OK' "$WORK/classes.tsv" | cut -f2- | cut -c1-160 | head -40 | sed 's/^/   +       /' || true
    [ "$N_O" -gt 40 ] && echo "   + ... e mais $((N_O - 40)) acréscimo(s)"
    if [ "$N_D" -gt 0 ]; then
      echo "   drift:  $(grep '^DRIFT' "$WORK/classes.tsv" | cut -f2- | sed -E 's/.*"([^"]+)".*/\1/' | head -12 | tr '\n' ' ')"
    fi
  fi
  for T in $PROTEGIDAS; do
    if grep -q "^OK"$'\t'"CREATE TABLE \"$T\"" "$WORK/classes.tsv"; then
      echo "  ⓘ $T ainda não existe no banco vivo (a imagem nova cria)."
    fi
  done
  if [ "$N_P" -gt 0 ]; then
    SCHEMA_RESULT="PERIGO"; SCHEMA_MOTIVO="$N_P comando(s) que apagam ou trocam dado"
  else
    SCHEMA_RESULT="OK"
  fi
}
echo ""
echo "▶ Schema da imagem nova × banco vivo (prisma migrate diff dentro da API no ar)"
calcular_diff

# ── 6. Decisão de RUN_MIGRATIONS ────────────────────────────────────────────
API_RM_ATUAL=$(env_do_service "${STACK}_api" RUN_MIGRATIONS)
WK_RM_ATUAL=""
for S in "${ORDEM[@]}"; do [ "$S" = worker ] && WK_RM_ATUAL=$(env_do_service "${STACK}_worker" RUN_MIGRATIONS); done
MIG_API=(); MIG_WK=()
echo ""
echo "▶ Migração no boot da API (RUN_MIGRATIONS hoje: ${API_RM_ATUAL:-não definido = aplica})"
if [ "$SCHEMA_RESULT" != "OK" ]; then
  MIG_API=(--env-add RUN_MIGRATIONS=false)
  MIG_TXT="RUN_MIGRATIONS=false — o schema novo NÃO será aplicado"
  echo "  ⛔ PERIGO: ${SCHEMA_MOTIVO}."
  echo "     A API vai subir com $MIG_TXT (o db push --accept-data-loss apagaria dado)."
  if [ "$WK_RM_ATUAL" = "true" ]; then
    MIG_WK=(--env-add RUN_MIGRATIONS=false)
    echo "     O worker tem RUN_MIGRATIONS=true (também aplicaria o schema): sobe com RUN_MIGRATIONS=false."
  fi
  if [ "$CONFIRMO_SEM_MIG" = 1 ]; then
    avisar "--confirmo-sem-migracao: API sobe com RUN_MIGRATIONS=false (schema não aplicado)"
  else
    recusar "schema com PERIGO (${SCHEMA_MOTIVO}). Para subir com RUN_MIGRATIONS=false, rode de novo com --confirmo-sem-migracao (e faça o backup antes: bash ~/scripts/vps-backup.sh)"
  fi
elif [ "$API_RM_ATUAL" = "false" ]; then
  MIG_API=(--env-rm RUN_MIGRATIONS)
  MIG_TXT="migração religada (tira o RUN_MIGRATIONS=false de um deploy anterior)"
  echo "  ✅ Sem perigo: $MIG_TXT."
else
  MIG_TXT="migração ligada, como já estava"
  echo "  ✅ Sem perigo: $MIG_TXT."
fi
if [ "$SCHEMA_RESULT" = "OK" ] && [ "$WK_RM_ATUAL" = "true" ]; then
  avisar "o worker tem RUN_MIGRATIONS=true: ele também roda o db push no boot, junto com a API"
fi

# ── 7. Plano ────────────────────────────────────────────────────────────────
echo ""
echo "▶ Ordem dos updates"
N=0
for S in "${ORDEM[@]}"; do
  N=$((N + 1))
  EXTRA=""
  [ "$S" = api ] && [ "${#MIG_API[@]}" -gt 0 ] && EXTRA="  ${MIG_API[*]}"
  [ "$S" = worker ] && [ "${#MIG_WK[@]}" -gt 0 ] && EXTRA="  ${MIG_WK[*]}"
  echo "  $N. ${STACK}_${S} → ${REPO}-${S}@${DIG[$S]:0:19}…${EXTRA}"
  if [ "$S" = api ]; then
    echo "     espera até ${ESPERA_API_SEG}s: task nova Running + log \"[entrypoint] Schema aplicado com sucesso.\" (ou \"pulando auto-migração\")"
    echo "     + \"API rodando em\" do Nest + a mesma task de pé por ${ESTAVEL_API_SEG}s"
  fi
done

if [ "$DRY_RUN" = 1 ]; then
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo " DRY-RUN — nada foi alterado (nenhum service update, nenhum env-add)."
  if [ "${#RECUSAS[@]}" -eq 0 ]; then
    echo " O mesmo comando sem --dry-run SEGUIRIA, na ordem acima."
    for A in ${AVISOS[@]+"${AVISOS[@]}"}; do echo "   ⚠ $A"; done
    echo "═══════════════════════════════════════════════════════════════"
    exit 0
  fi
  echo " O mesmo comando sem --dry-run PARARIA antes de mexer em qualquer coisa:"
  for R in "${RECUSAS[@]}"; do echo "   ⛔ $R"; done
  echo "═══════════════════════════════════════════════════════════════"
  exit 1
fi

# ── 8. Aplica (só chega aqui com tudo conferido e as imagens no host) ──────
registrar() {
  printf '%s %s tag=%s ci=%s schema=%s migracao=%s opcoes=%s %s\n' "$(date '+%F %T')" "$VERSAO" "$TAG" "$CI_STATUS" \
    "$SCHEMA_RESULT" "${MIG_API[*]:-sem-mudanca}" "${OPCOES# }" "$1" >> "$REDEPLOY_LOG" 2>/dev/null || true
}
mostrar_volta() {
  echo ""
  echo "   Worker e web NÃO foram atualizados (continuam na versão anterior)."
  echo "   Para voltar a API à imagem anterior — NÃO executado, cole só se quiser:"
  echo "     docker service update --force --image ${ANTES[api]} --env-add RUN_MIGRATIONS=false ${STACK}_api"
  echo "   (sem migração de propósito: a imagem anterior com db push apagaria o que a nova criou)"
  echo "   Logs: docker service logs --tail=80 ${STACK}_api"
}
esperar_api() {
  # Só vale task NOVA: as que já existiam antes do update ficam de fora (num
  # redeploy do mesmo sha a task velha tem o mesmo digest e o log antigo).
  #
  # A linha do entrypoint ("Schema aplicado"/"pulando auto-migração") sai ANTES
  # do `exec node` (infra/entrypoint.sh): sozinha não prova nada. Um Nest que
  # cai no boot (ciclo de DI, env faltando, Redis) imprime a mesma linha em
  # cada restart, e cada restart do Swarm é uma task nova com o digest novo.
  # Por isso exige também, na MESMA task:
  #   - a linha do Nest depois do app.listen ("API rodando em", de
  #     apps/api/src/main.ts, ou a padrão "Nest application successfully started");
  #   - a task continuar Running, sem ser trocada, por ESTAVEL_API_SEG (pega o
  #     que cai logo depois do listen, como o adapter do Socket.IO).
  # Limite: ESPERA_API_SEG para chegar ao Nest no ar, + ESTAVEL_API_SEG de pé.
  local agora fim duro linha tid estado logs marca_tid="" marca_t=0 schema_txt
  agora=$(date +%s); fim=$((agora + ESPERA_API_SEG)); duro=$((fim + ESTAVEL_API_SEG))
  while :; do
    agora=$(date +%s)
    linha=$(docker service ps "${STACK}_api" --filter desired-state=running --no-trunc \
      --format '{{.ID}}|{{.Image}}|{{.CurrentState}}' 2>/dev/null | grep -F "${DIG[api]}" \
      | grep -vF -f "$WORK/tasks-antes.txt" | head -1 || true)
    tid=""; estado=""
    if [ -n "$linha" ]; then tid="${linha%%|*}"; estado="${linha##*|}"; fi
    if [ -n "$tid" ] && [[ "$estado" == Running* ]]; then
      logs=$(docker service logs --raw "$tid" 2>&1 \
        | grep -E 'Schema aplicado com sucesso|pulando auto-migra|db push falhou \(tentativa 15/15\)|API rodando em|Nest application successfully started' || true)
      if grep -q 'tentativa 15/15' <<<"$logs"; then
        echo "  ❌ O db push da API falhou 15 vezes (log da task $tid)."; return 1
      fi
      if grep -qE 'Schema aplicado com sucesso|pulando auto-migra' <<<"$logs" \
          && grep -qE 'API rodando em|Nest application successfully started' <<<"$logs"; then
        if [ "$marca_tid" != "$tid" ]; then
          marca_tid="$tid"; marca_t="$agora"
          echo "  ⏳ Nest escutando na task $tid; conferindo se ela fica de pé por ${ESTAVEL_API_SEG}s"
        fi
        if [ $((agora - marca_t)) -ge "$ESTAVEL_API_SEG" ]; then
          if grep -q 'pulando auto-migra' <<<"$logs"; then schema_txt='"pulando auto-migração" (RUN_MIGRATIONS=false)'
          else schema_txt='"[entrypoint] Schema aplicado com sucesso."'; fi
          echo "  ✅ API no ar: $schema_txt, Nest escutando e a task de pé há ${ESTAVEL_API_SEG}s"
          return 0
        fi
      else
        marca_tid=""
      fi
    else
      marca_tid=""   # a task marcada caiu ou foi trocada: a janela recomeça na próxima
    fi
    if { [ -z "$marca_tid" ] && [ "$agora" -ge "$fim" ]; } || [ "$agora" -ge "$duro" ]; then
      echo "  ❌ A API não ficou no ar em ${ESPERA_API_SEG}s (último estado: ${estado:-sem task nova Running com o digest novo}${tid:+, task $tid})."
      echo "     Pedido: linha do entrypoint + \"API rodando em\" do Nest + a mesma task de pé por ${ESTAVEL_API_SEG}s."
      return 1
    fi
    sleep "$POLL_SEG"
  done
}

registrar "inicio"
# Tasks da API que já existem (o esperar_api ignora). Sem linha vazia: no
# grep -f, padrão vazio casa com tudo e esconderia a task nova.
{ echo "-nenhuma-task-"; docker service ps "${STACK}_api" -q --no-trunc 2>/dev/null || true; } \
  | sed '/^[[:space:]]*$/d' > "$WORK/tasks-antes.txt"
echo ""
echo "▶ ${STACK}_api → ${PIN[api]}"
FASE="api"
if ! docker service update --force --detach --quiet --image "${PIN[api]}" ${MIG_API[@]+"${MIG_API[@]}"} "${STACK}_api" >/dev/null; then
  FASE=""
  echo "  ❌ docker service update da API falhou."
  mostrar_volta
  registrar "falhou: update da api"
  exit 1
fi
echo "  ⏳ esperando a task nova (até ${ESPERA_API_SEG}s + ${ESTAVEL_API_SEG}s de pé)..."
if ! esperar_api; then
  FASE=""
  mostrar_volta
  registrar "falhou: api nao subiu"
  exit 1
fi
FASE="resto"

FALHAS=()
for S in "${ORDEM[@]}"; do
  [ "$S" = api ] && continue
  echo ""
  echo "▶ ${STACK}_${S} → ${PIN[$S]}"
  EXTRA_FLAGS=()
  [ "$S" = worker ] && EXTRA_FLAGS=(${MIG_WK[@]+"${MIG_WK[@]}"})
  if docker service update --force --quiet --image "${PIN[$S]}" ${EXTRA_FLAGS[@]+"${EXTRA_FLAGS[@]}"} "${STACK}_${S}" >/dev/null; then
    echo "  ✅ atualizado"
  else
    echo "  ❌ update de ${STACK}_${S} falhou"
    FALHAS+=("${STACK}_${S}")
  fi
done

echo ""
echo "▶ Limpando imagens órfãs (>72h) para não encher o disco..."
docker image prune -af --filter 'until=72h' >/dev/null 2>&1 || true

FASE=""
if [ "${#FALHAS[@]}" -gt 0 ]; then registrar "falhou: ${FALHAS[*]}"; else registrar "ok"; fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
if [ "${#FALHAS[@]}" -gt 0 ]; then
  echo " ⚠ Redeploy INCOMPLETO — falhou: ${FALHAS[*]}"
else
  echo " ✅ Redeploy completo — ${TAG:0:12} ($VERSAO)"
fi
echo "═══════════════════════════════════════════════════════════════"
case "$CI_STATUS" in
  verde) echo " CI:      verde (run ${R_ID:-?}, tentativa ${R_ATT:-?})" ;;
  *)     echo " CI:      ⚠ NÃO conferido/verde — seguiu com --sem-ci" ;;
esac
echo " Schema:  $SCHEMA_RESULT — $MIG_TXT"
if [ "${MIG_API[*]:-}" = "--env-add RUN_MIGRATIONS=false" ]; then
  echo "          ⚠ A API ficou com RUN_MIGRATIONS=false. O próximo deploy sem perigo religa sozinho."
fi
echo " Digests (antes → depois):"
for S in "${ORDEM[@]}"; do
  echo "   ${STACK}_${S}: $(digest_de "${ANTES[$S]}") → $(digest_de "$(imagem_do_service "${STACK}_${S}")")"
done
for A in ${AVISOS[@]+"${AVISOS[@]}"}; do echo " ⚠ $A"; done
echo " Registro: $REDEPLOY_LOG"
echo ""
echo " Confira (aguarde ~30s):"
echo "   docker service ls"
echo "   docker service logs --tail=30 ${STACK}_api | grep -iE 'rodando em|started|error'"
echo "   curl -i https://sistema.institutoodontopassos.com.br/api/health"
[ "${#FALHAS[@]}" -gt 0 ] && exit 1
exit 0
