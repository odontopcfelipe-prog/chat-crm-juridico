#!/bin/bash
# ============================================================================
# vps-redeploy.sh — Redeploy correto das imagens no Docker Swarm
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
# Uso na VPS (deploy é MANUAL, pela IA do servidor, a pedido do dono):
#   bash ~/scripts/vps-redeploy.sh <SHA_COMPLETO_40>
# Sem argumento usa :latest (o digest dele, resolvido no Hub).
# ============================================================================
set -euo pipefail

TAG="${1:-${TAG:-latest}}"
REPO="${REPO:-odontopassos/chat-crm-juridico}"

command -v python3 >/dev/null 2>&1 || { echo "❌ Precisa de python3 (pra ler a API do Docker Hub)."; exit 1; }

echo "═══════════════════════════════════════════════════════════════"
echo " Redeploy chatcrm — tag: $TAG"
echo "═══════════════════════════════════════════════════════════════"

# Detecta SÓ os services do stack chatcrm. Ancorado em "^chatcrm_" de
# propósito: o regex genérico "_(api|worker|web)$" pegava também services de
# OUTROS stacks que terminam em _api (ex.: o service da Evolution
# "evolution_evolution_api") e os sobrescrevia com a imagem do CRM. Override
# do nome do stack via env STACK=.
STACK="${STACK:-chatcrm}"
SERVICES=$(docker service ls --format '{{.Name}}' | grep -E "^${STACK}_(api|worker|web)\$" || true)
if [ -z "$SERVICES" ]; then
  echo "❌ Nenhum service ${STACK}_(api|worker|web) encontrado. É Swarm? O stack está no ar?"
  docker service ls --format '   - {{.Name}}'
  exit 1
fi

# ── SHA curto → completo ────────────────────────────────────────────────────
# O CI publica as imagens com o SHA de 40 chars (e :latest). Rodar este script
# com um SHA CURTO (7-12 chars) dava "not found" no pull — só o hook, que usa
# :latest, funcionava. Se o TAG não for 'latest' e tiver menos de 40 chars,
# resolve o SHA completo consultando o Docker Hub (a tag que COMEÇA com o curto).
# Falha graciosa: se não resolver (sem python3/rede), segue com o TAG original.
if [ "$TAG" != "latest" ] && [ "${#TAG}" -lt 40 ]; then
  echo "▶ Resolvendo SHA curto '$TAG' → completo (Docker Hub)..."
  RESOLVED=$(curl -fsSL "https://hub.docker.com/v2/repositories/${REPO}-api/tags/?page_size=100&ordering=last_updated" 2>/dev/null \
    | python3 -c "import sys,json
tags=[t.get('name','') for t in json.load(sys.stdin).get('results',[])]
m=[t for t in tags if t.startswith('$TAG')]
print(m[0] if m else '')" 2>/dev/null || true)
  if [ -n "$RESOLVED" ]; then
    echo "  → $RESOLVED"
    TAG="$RESOLVED"
  else
    echo "  ⚠ Não resolvi (sem python3/rede ou tag ausente) — tento com '$TAG' mesmo."
  fi
fi

# Digest da tag no Docker Hub (sha256:...; vazio se não achar).
hub_digest() {  # $1 = api|worker|web
  curl -fsSL -m 20 "https://hub.docker.com/v2/repositories/${REPO}-$1/tags/${TAG}" 2>/dev/null \
    | python3 -c '
import json, re, sys
try:
    t = json.load(sys.stdin)
except Exception:
    sys.exit()
d = t.get("digest") or ""
if not d:
    for i in t.get("images") or []:
        if i.get("os") == "linux" and i.get("architecture") == "amd64":
            d = i.get("digest") or ""
            break
print(d if re.fullmatch(r"sha256:[0-9a-f]{64}", d) else "")
' 2>/dev/null || true
}

# 1ª passada: resolve e BAIXA as 3 imagens por digest. Nada é alterado se
# qualquer uma falhar.
declare -A PIN
for SVC in $SERVICES; do
  SUFFIX="${SVC##*_}"            # chatcrm_api -> api
  HD=$(hub_digest "$SUFFIX")
  if [ -z "$HD" ]; then
    echo "❌ Não achei ${REPO}-${SUFFIX}:${TAG} no Docker Hub (CI terminou? SHA certo?). NADA foi alterado."
    exit 1
  fi
  IMG="${REPO}-${SUFFIX}@${HD}"
  echo ""
  echo "▶ $SVC"
  echo "  pull ${REPO}-${SUFFIX}:${TAG:0:12}  →  ${HD:0:19}…"
  if ! timeout 900 docker pull -q "$IMG"; then
    echo "  ❌ Falha/travamento no pull de $IMG. NADA foi alterado."
    exit 1
  fi
  PIN[$SVC]="$IMG"
done

# 2ª passada: aplica (só chega aqui com as 3 imagens no host).
echo ""
for SVC in $SERVICES; do
  echo "▶ $SVC → ${PIN[$SVC]}"
  docker service update --force --image "${PIN[$SVC]}" "$SVC" --quiet
  echo "  ✅ atualizado"
done

echo ""
echo "▶ Limpando imagens órfãs (>72h) para não encher o disco..."
docker image prune -af --filter 'until=72h' >/dev/null 2>&1 || true

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " ✅ Redeploy completo. Confira (aguarde ~30s):"
echo "═══════════════════════════════════════════════════════════════"
echo "   docker service ls"
echo "   docker service logs --tail=30 chatcrm_api | grep -iE 'started|listening|error'"
echo "   curl -i https://sistema.institutoodontopassos.com.br/api/health"
