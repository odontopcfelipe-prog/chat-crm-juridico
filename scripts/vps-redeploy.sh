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
