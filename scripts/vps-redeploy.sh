#!/bin/bash
# ============================================================================
# vps-redeploy.sh — Redeploy correto das imagens no Docker Swarm
# ============================================================================
# Resolve o "deploy fantasma": `docker service update --image X:latest` sozinho
# NÃO baixa a imagem nova — o Swarm resolve `:latest` pelo digest em cache local
# (o antigo). Os containers reiniciam, mas rodam o código velho.
#
# A correção: `docker pull` primeiro e fixar o DIGEST exato (@sha256:...) no
# service update — assim o Swarm é obrigado a rodar exatamente a imagem baixada.
#
# Uso na VPS (Swarm):
#   curl -fsSL https://raw.githubusercontent.com/odontopcfelipe-prog/chat-crm-juridico/master/scripts/vps-redeploy.sh | bash
#
# Deploy de um commit específico (determinístico, recomendado p/ rollback):
#   curl -fsSL .../vps-redeploy.sh | bash -s -- <git_sha>
# ============================================================================
set -euo pipefail

TAG="${1:-${TAG:-latest}}"
REPO="${REPO:-odontopassos/chat-crm-juridico}"

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

for SVC in $SERVICES; do
  SUFFIX="${SVC##*_}"            # chatcrm_api -> api
  IMG="$REPO-$SUFFIX:$TAG"
  echo ""
  echo "▶ $SVC"
  echo "  pull $IMG"
  if ! docker pull "$IMG"; then
    echo "  ❌ Falha no pull de $IMG (tag existe no Docker Hub? CI terminou?)."
    exit 1
  fi
  # Digest exato recém-baixado — à prova do cache local do Swarm.
  DIGEST=$(docker inspect --format '{{index .RepoDigests 0}}' "$IMG")
  echo "  -> $DIGEST"
  docker service update --force --image "$DIGEST" "$SVC" --quiet
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
