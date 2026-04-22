# 🚀 Aplicar Fases 6 a 17 em Produção

Guia passo-a-passo para aplicar todas as 12 fases do roadmap Clinicorp em produção.

---

## Pré-requisitos

- Acesso SSH à VPS
- Container postgres em execução (default: detectado automaticamente)
- Containers `api`, `worker` e `web` em execução
- Backup do banco antes de começar (recomendado)

---

## Passo 1 — Backup do banco

```bash
docker exec <postgres_container> pg_dump -U chatcrm -d chatcrm \
  | gzip > backup-$(date +%F-%H%M).sql.gz
```

---

## Passo 2 — Pull do código mais recente

```bash
cd /caminho/para/chat-crm-juridico
git pull origin master
```

Deve baixar até o commit `2a9238c` (Fase 17).

---

## Passo 3 — Aplicar todas as migrations

**Opção A — Script automatizado (recomendado):**

```bash
bash packages/shared/prisma/manual-sql/apply-all-pending.sh
```

O script:
- Detecta o container postgres automaticamente
- Aplica as 11 migrations em ordem
- Para no primeiro erro (`-v ON_ERROR_STOP=1`)
- Todas idempotentes (`IF NOT EXISTS`) — pode rodar de novo se interromper

**Opção B — Manual (uma a uma):**

```bash
PG_CONTAINER=$(docker ps --filter "name=postgres" --format "{{.Names}}" | head -n1)

for f in packages/shared/prisma/manual-sql/2026-*.sql; do
  echo "▶ $f"
  docker exec -i "$PG_CONTAINER" psql -U chatcrm -d chatcrm -v ON_ERROR_STOP=1 < "$f"
done
```

---

## Passo 4 — Regenerar Prisma client

```bash
cd packages/shared
npx prisma generate
cd ../..
```

> Necessário para o NestJS reconhecer os 26 novos modelos (Patient, Anamnese, Odontograma, EstheticApplication, Installment, Goal, Clinic, SmileSimulation, RadiographyExam, etc.)

---

## Passo 5 — Build + restart dos containers

```bash
# Recompila se necessário
docker compose build api worker web

# Restart
docker compose restart api worker web
```

Aguarde ~30s e confirme:

```bash
docker compose logs --tail=50 api    | grep -i "started\|listening"
docker compose logs --tail=50 worker | grep -i "started"
docker compose logs --tail=50 web    | grep -i "ready"
```

---

## Passo 6 — Verificações pós-deploy

### 6.1 Confirmar tabelas criadas

```bash
docker exec <pg_container> psql -U chatcrm -d chatcrm -c "\dt" | grep -i -E \
  "EstheticApplication|Installment|Goal|Clinic|SmileSimulation|RadiographyExam"
```

Devem aparecer: `EstheticApplication`, `Installment`, `Goal`, `Clinic`, `UserClinic`, `SmileSimulation`, `RadiographyExam`, `RadiographyProvider`, `Room`, `AppointmentMarker`, `AppointmentConfirmation`, `ReturnAlert`, `CommissionRule`, `Commission`, `CollectionAttempt`, `PortalToken`, `Supplier`, `Product`, `StockMovement`, `ProcedureConsumable`, `AdverseReaction`.

### 6.2 Confirmar API expondo novos endpoints

```bash
curl -i https://sistema.institutoodontopassos.com.br/api/health
# Deve retornar 200

# Endpoints novos (precisa de JWT — apenas confirma que existe rota):
curl -i https://sistema.institutoodontopassos.com.br/api/reports/catalog
# Esperado: 401 (sem token) — confirma que endpoint EXISTE
```

### 6.3 Confirmar UI

Acesse e verifique no Sidebar os itens novos:
- ✅ Retornos
- ✅ Estoque
- ✅ Parcelas
- ✅ Comissões
- ✅ Metas
- ✅ Relatórios
- ✅ Minha rede

Na ficha de um paciente, abas:
- ✅ Estética facial
- ✅ Smile Design
- ✅ Radiografias

Em Settings:
- ✅ Salas & Cadeiras
- ✅ Marcadores de Agenda
- ✅ Unidades / Franquias
- ✅ Regras de Comissão

---

## Passo 7 — (Opcional) Seeds adicionais

### Seed de procedimentos estéticos faciais (31 procedimentos)

```bash
cd packages/shared
npx ts-node prisma/seed-estetica-facial.ts
```

Cria: Botox glabela/frontal/masseter, AH labial/olheiras/nasolabial, bioestimuladores Sculptra/Radiesse, fios PDO/PLLA, peelings, microagulhamento, skinbooster, laser, lipo enzimática, etc.

---

## 🆘 Rollback

Se algo der errado:

```bash
# 1. Para os containers
docker compose stop api worker web

# 2. Restaura o backup
gunzip < backup-YYYY-MM-DD-HHMM.sql.gz | docker exec -i <pg_container> psql -U chatcrm -d chatcrm

# 3. Volta o código pra versao anterior
git reset --hard <commit_anterior>

# 4. Restart
docker compose up -d api worker web
```

---

## 📋 Checklist final

- [ ] Backup feito
- [ ] `git pull` ate commit `2a9238c`
- [ ] Script `apply-all-pending.sh` executado sem erro
- [ ] `prisma generate` rodou
- [ ] Containers restartados (api + worker + web)
- [ ] Health endpoint respondendo
- [ ] Sidebar mostra Retornos / Estoque / Parcelas / Comissões / Metas / Relatórios / Minha rede
- [ ] Ficha do paciente mostra Estética facial / Smile Design / Radiografias
- [ ] (Opcional) Seed de procedimentos estéticos rodado

---

## Resumo do que foi entregue

| Fase | Modelos novos | Endpoints | Telas |
|---|---|---|---|
| 6 Estética facial + Estoque | 7 | 30+ | aba ficha + /estoque |
| 7 Agenda evoluída | 4 | 22 | /return-alerts + 2 settings |
| 8 Comissões + Metas | 3 | 22 | /comissoes + /metas + 1 setting |
| 10 Workers | — | — | 4 cron jobs |
| 11 Régua de cobrança | 2 | 10 | /financeiro/parcelas |
| 12 Agenda multi-coluna | — | — | aba toggle DayPilot |
| 13 PWA Portal | 1 | 8 | /area-paciente/* |
| 14 Hub Relatórios | — | 2 | /relatorios |
| 15 Multi-unidade | 2 | 9 | /minha-rede + 1 setting |
| 16 Smile Design | 1 | 5 | aba ficha |
| 17 Radiografia | 2 | 9 | aba ficha |
| **Total** | **22 modelos** | **117+ endpoints** | **15+ telas** |

Em conformidade: ANVISA RDC 751/2022, CFO Resolução 118/2012, CFO Resolução 230/2020, CFM 1.821/2007.
