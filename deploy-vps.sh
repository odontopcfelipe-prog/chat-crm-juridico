#!/bin/bash
set -e

echo "============================================"
echo "   LexCRM - Deploy para VPS (Ubuntu/Debian)"
echo "============================================"

# 1. Instalar Docker se nao existir
if ! command -v docker &> /dev/null; then
    echo "[1/5] Instalando Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker $USER
    rm get-docker.sh
    echo "Docker instalado. Faca logout e login para aplicar permissoes do grupo docker."
fi

# 2. Verificar Docker Compose (v2 vem embutido no Docker moderno)
if ! docker compose version &> /dev/null; then
    echo "[ERRO] docker compose nao encontrado. Atualize o Docker para uma versao recente."
    exit 1
fi

echo "[1/5] Docker OK"

# 3. Verificar arquivo .env
if [ ! -f .env ]; then
    echo ""
    echo "[2/5] Arquivo .env nao encontrado. Criando a partir do template..."
    cp infra/.env.example .env
    echo ""
    echo "==> IMPORTANTE: Edite o arquivo .env antes de continuar!"
    echo "    Substitua os valores placeholder pelas suas credenciais reais."
    echo ""
    echo "    Variaveis obrigatorias:"
    echo "      - VPS_IP            (IP publico da sua VPS)"
    echo "      - JWT_SECRET        (chave secreta forte para JWT)"
    echo "      - POSTGRES_PASSWORD (senha do banco)"
    echo ""
    echo "    Variaveis opcionais (para integracao):"
    echo "      - EVOLUTION_API_URL / EVOLUTION_GLOBAL_APIKEY"
    echo "      - GEMINI_API_KEY"
    echo ""
    echo "    Depois de editar, execute este script novamente."
    exit 1
fi

echo "[2/5] Arquivo .env encontrado"

# Carregar variaveis do .env
set -a
source .env
set +a

# 4. Build e subir os containers
echo "[3/5] Buildando e subindo containers (pode demorar na primeira vez)..."
docker compose -f docker-compose.prod.yml up -d --build

# 5. Aguardar Postgres ficar pronto
echo "[4/5] Aguardando banco de dados ficar pronto..."
for i in $(seq 1 30); do
    if docker compose -f docker-compose.prod.yml exec -T postgres pg_isready -U "${POSTGRES_USER:-crm_user}" &> /dev/null; then
        break
    fi
    sleep 2
done

# 6. Executar migration do Prisma
echo "[5/5] Aplicando schema do banco de dados..."
docker compose -f docker-compose.prod.yml exec -T crm-api sh -c "cd /app/packages/shared && npx prisma db push --accept-data-loss"

echo ""
echo "============================================"
echo "   LexCRM instalado com sucesso!"
echo "============================================"
echo ""
VPS_IP="${VPS_IP:-SEU_IP}"
API_PORT="${API_PORT:-3001}"
WEB_PORT="${WEB_PORT:-3000}"
echo "   Frontend:  http://${VPS_IP}:${WEB_PORT}"
echo "   API:       http://${VPS_IP}:${API_PORT}"
echo ""
echo "   Postgres:  porta ${VPS_IP}:45432"
echo "   Redis:     porta ${VPS_IP}:46379"
echo ""
echo "   Comandos uteis:"
echo "     Ver logs:     docker compose -f docker-compose.prod.yml logs -f"
echo "     Parar tudo:   docker compose -f docker-compose.prod.yml down"
echo "     Restartar:    docker compose -f docker-compose.prod.yml restart"
echo ""
