#!/bin/sh
set -e

# Auto-migrar o banco na API (apenas no container da API, nao no worker)
if [ "$RUN_MIGRATIONS" = "true" ]; then
  echo "[entrypoint] Aplicando schema do banco (prisma db push)..."
  cd /app/packages/shared

  # Tenta ate 15 vezes com intervalo de 3s
  # Isso aguarda o postgres ficar disponivel sem precisar de nc/netcat
  ATTEMPT=0
  while [ $ATTEMPT -lt 15 ]; do
    if npx prisma db push --skip-generate --accept-data-loss 2>&1; then
      echo "[entrypoint] Schema aplicado com sucesso."
      break
    fi
    ATTEMPT=$((ATTEMPT + 1))
    echo "[entrypoint] prisma db push falhou (tentativa $ATTEMPT/15). Aguardando 3s..."
    sleep 3
  done

  cd /app/apps/${APP}
fi

exec node dist/main.js
