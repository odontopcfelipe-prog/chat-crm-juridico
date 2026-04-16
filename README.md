# Chat + CRM Jurídico ⚖️

Um sistema moderno de CRM e atendimento ao cliente (focado em Whatsapp) projetado especificamente para escritórios de advocacia, com suporte total a multiusuário, caixa de entrada compartilhada (Inbox), funil de leads, gerenciador de tarefas e inteligência artificial plug-in (Google Gemini + Evolution API).

---

## 🏗 Arquitetura

Este é um Monorepo gerenciado via `npm workspaces`, contendo:

- **`apps/api`**: Backend Core (NestJS). Exposição dos endpoints REST, Autenticação, Webhooks para recebimento de conversas da Evolution API e Gateway WebSocket.
- **`apps/worker`**: Processador em Backgroud (NestJS + BullMQ). Faz o consumo de Filas para download de mídias do WhatsApp, upload para S3 e coordena interações com IA via Google Gemini.
- **`apps/web`**: Frontend Dashboard (Next.js App Router). Interface de usuário responsiva baseada em TailwindCSS com as telas de Chat, Inbox e Autenticação.
- **`packages/shared`**: Schema de banco de Dados (Prisma) e types reutilizáveis.
- **`infra`**: Arquivos do Docker Compose (PostgreSQL, Redis, SeaweedFS para Mídias S3).

---

## 🚀 Como Executar Localmente

### 1. Pré-Requisitos

- Node.js (v18+)
- Docker e Docker Compose
- Evolution API (Hospedada isoladamente ou configurada em docker separado)

### 2. Infraestrutura (Banco, Redis e Storage)

Navegue até o diretório `infra` e inicie os containers base. Copie antes o arquivo de ambiente.

```bash
cd infra
copy .env.example .env
docker-compose up -d
```

### 3. Instalação e Configuração

```bash
# Na raiz do Monorepo
npm install

# Instalar ts-node no shared para o script de seed
npm install ts-node typescript -w packages/shared --save-dev

# Compilar pacotes compartilhados (gera o Prisma Client)
npm run build -w packages/shared

# Sincronizar banco de dados e popular dados mockados (Seed)
npx prisma db push --schema=./packages/shared/prisma/schema.prisma
npx prisma db seed --schema=./packages/shared/prisma/schema.prisma
```

_(O seed gera o login: admin@lexcrm.com.br / senha: admin123)_

### 4. Iniciando os Aplicativos

Abra três terminais ou utilize algum gerenciador (como pm2, tmux, etc) e rode os três projetos:

```bash
# Terminal 1 - Inicia a API REST + Webhooks
npm run start:dev -w apps/api

# Terminal 2 - Inicia o Worker de Background (Mídia e IA)
npm run start:dev -w apps/worker

# Terminal 3 - Inicia a Interface Web Next.js
npm run dev -w apps/web
```

> A aplicação web ficará disponível em `http://localhost:3000`.

---

## 🛠 Features e Evolução Planejada

- [x] Ingestões de mensagens no WhatsApp com Idempotência via webhook
- [x] Gerenciador de Anexos (Worker) salvando num cluster S3-compatível
- [x] Filas com Redis (BullMQ)
- [x] Integração IA Google Gemini
- [x] Visualizador Frontend Real-time c/ WebSockets
- [ ] Presigned URLs de Mídia e Preview Visual (Pendente Fase 6 UI / Storage)

_Leia a documentação interna nos diretórios para mais destrinches de serviços._
