# ============================================================
# deploy.ps1 — Build e push das imagens para o Docker Hub
# Executar na raiz do projeto: .\deploy.ps1
# ============================================================

$ErrorActionPreference = "Stop"

$DOCKERHUB_USER  = "andreflustosa"
$API_URL         = "https://andrelustosaadvogados.com.br/api"
$WS_URL          = "wss://andrelustosaadvogados.com.br"
$PORTAINER_HOOK  = ""   # cole aqui o webhook do Portainer se quiser redeploy automático

Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  LexCRM — Deploy para Docker Hub" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# Login no Docker Hub
Write-Host "[1/4] Login no Docker Hub..." -ForegroundColor Yellow
docker login -u $DOCKERHUB_USER
if ($LASTEXITCODE -ne 0) { Write-Host "Falha no login." -ForegroundColor Red; exit 1 }

# Build + push API
Write-Host ""
Write-Host "[2/4] Buildando API..." -ForegroundColor Yellow
docker build --build-arg APP=api `
  -t "$DOCKERHUB_USER/chat-crm-juridico-api:latest" `
  -f infra/Dockerfile.backend .
if ($LASTEXITCODE -ne 0) { Write-Host "Falha no build da API." -ForegroundColor Red; exit 1 }
docker push "$DOCKERHUB_USER/chat-crm-juridico-api:latest"

# Build + push Worker
Write-Host ""
Write-Host "[3/4] Buildando Worker..." -ForegroundColor Yellow
docker build --build-arg APP=worker `
  -t "$DOCKERHUB_USER/chat-crm-juridico-worker:latest" `
  -f infra/Dockerfile.backend .
if ($LASTEXITCODE -ne 0) { Write-Host "Falha no build do Worker." -ForegroundColor Red; exit 1 }
docker push "$DOCKERHUB_USER/chat-crm-juridico-worker:latest"

# Build + push Web
Write-Host ""
Write-Host "[4/4] Buildando Web..." -ForegroundColor Yellow
docker build `
  --build-arg NEXT_PUBLIC_API_URL=$API_URL `
  --build-arg NEXT_PUBLIC_WS_URL=$WS_URL `
  -t "$DOCKERHUB_USER/chat-crm-juridico-web:latest" `
  -f infra/Dockerfile.web .
if ($LASTEXITCODE -ne 0) { Write-Host "Falha no build do Web." -ForegroundColor Red; exit 1 }
docker push "$DOCKERHUB_USER/chat-crm-juridico-web:latest"

# Trigger Portainer (opcional)
if ($PORTAINER_HOOK -ne "") {
  Write-Host ""
  Write-Host "Disparando redeploy no Portainer..." -ForegroundColor Yellow
  Invoke-RestMethod -Method Post -Uri $PORTAINER_HOOK | Out-Null
  Write-Host "Portainer notificado." -ForegroundColor Green
}

Write-Host ""
Write-Host "======================================" -ForegroundColor Green
Write-Host "  Deploy concluido com sucesso!" -ForegroundColor Green
Write-Host "======================================" -ForegroundColor Green
Write-Host ""
Write-Host "Imagens publicadas:" -ForegroundColor White
Write-Host "  $DOCKERHUB_USER/chat-crm-juridico-api:latest" -ForegroundColor Gray
Write-Host "  $DOCKERHUB_USER/chat-crm-juridico-worker:latest" -ForegroundColor Gray
Write-Host "  $DOCKERHUB_USER/chat-crm-juridico-web:latest" -ForegroundColor Gray
Write-Host ""
Write-Host "Atualize o Portainer para usar as novas imagens." -ForegroundColor Yellow
