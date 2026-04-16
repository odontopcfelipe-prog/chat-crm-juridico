@echo off
setlocal enabledelayedexpansion

echo =========================================================
echo  INICIANDO AMBIENTE LOCAL - LEXCRM
echo =========================================================

:: Mata processos node anteriores
echo [0/4] Limpando processos antigos...
taskkill /F /IM node.exe /T 2>nul
timeout /t 2 /nobreak >nul

echo [1/4] Instalando dependencias e gerando Prisma...
cmd /c "npm install"
cmd /c "npm run db:generate --workspace=@crm/shared"

echo [2/4] Compilando API e Worker...
cmd /c "npm run build --workspace=apps/api"
cmd /c "npm run build --workspace=apps/worker"

echo.

:: Inicia a API
echo [3/4] Iniciando API (porta 3001)...
start "LexCRM - API" cmd /c "title LexCRM - API && node apps/api/dist/main.js || pause"

:: Espera a API subir antes de iniciar o Worker
echo Aguardando API inicializar (5s)...
timeout /t 5 /nobreak >nul

:: Inicia o Worker
echo [4/4] Iniciando Worker (filas de midia e IA)...
start "LexCRM - Worker" cmd /c "title LexCRM - Worker && node apps/worker/dist/main.js || pause"

:: Aguarda um pouco para o worker subir
timeout /t 3 /nobreak >nul

:: Inicia o Web no terminal atual
echo.
echo =========================================================
echo  Painel CRM: http://localhost:3000
echo  API:        http://localhost:3001
echo  Worker:     (rodando em background)
echo =========================================================
echo.

npm run dev --workspace=apps/web
