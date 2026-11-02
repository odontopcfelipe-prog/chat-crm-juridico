#!/bin/bash
# ============================================================================
# ensaio-laboratorio.sh — conferência diária do ensaio do laboratório (F9)
# ============================================================================
# SÓ LEITURA. Mostra, para as últimas N horas (padrão 24):
#   1. as contas de laboratório;
#   2. mensagens que saíram das conversas do laboratório, por tipo e situação;
#   3. envios automáticos do laboratório (DispatchLog), por tipo e situação;
#   4. uso de IA nas contas de laboratório (o esperado é zero);
#   5. mensagens gravadas num chip de OUTRA conta, nos dois sentidos (esperado: zero);
#   6. eventos de agenda de tipo de clínica numa conta de laboratório (esperado: zero);
#   7. fichas do laboratório (perfil, ficha técnica, caso) em conta que não é
#      laboratório (esperado: zero);
#   8. dos logs da API: recusas [VERTICAL_DENIED] por rota e mensagens [LAB-VOCAB]
#      sem tradução (esperado: nenhuma vinda de tela liberada).
#
# Cada consulta roda numa transação READ ONLY com statement_timeout. Telefone e
# texto de mensagem nunca saem: só contagens. Usuário e banco vêm do ambiente do
# próprio container do Postgres (a senha nunca passa pelo host nem aparece).
#
# Uso no servidor (bash, sem sudo):
#   set +H
#   bash ~/ensaio-laboratorio.sh          # últimas 24 h
#   bash ~/ensaio-laboratorio.sh 72       # últimas 72 h
# Variáveis opcionais: STACK (padrão chatcrm).
set -euo pipefail

STACK="${STACK:-chatcrm}"
PG_SERVICE="${PG_SERVICE:-${STACK}_postgres}"
API_SERVICE="${API_SERVICE:-${STACK}_api}"
HORAS="${1:-24}"
if ! [[ "$HORAS" =~ ^[0-9]{1,3}$ ]] || [ "$HORAS" -lt 1 ]; then
  echo "❌ Horas inválidas: use um número de 1 a 999 (ex.: 24)."
  exit 1
fi

CID=$(docker ps -q --filter "label=com.docker.swarm.service.name=${PG_SERVICE}" --filter status=running 2>/dev/null | head -1 || true)
if [ -z "$CID" ]; then
  echo "❌ Nenhum container rodando do service ${PG_SERVICE}. O stack está no ar?"
  exit 1
fi

echo "== Ensaio do laboratório — últimas ${HORAS} h ($(date '+%d/%m/%Y %H:%M'))"

# Os comandos abaixo são expandidos DENTRO do container (aspas simples).
PG_ENV='U="${POSTGRES_USER:-postgres}"; D="${POSTGRES_DB:-$U}"; export PGPASSWORD="${POSTGRES_PASSWORD:-}"'
docker exec -i "$CID" sh -c "$PG_ENV"'; psql -X -q -U "$U" -d "$D" -P pager=off -v ON_ERROR_STOP=0 -v horas='"$HORAS" <<'SQL'
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';

\echo
\echo '-- 1. Contas de laboratório'
SELECT t.name AS laboratorio, t.status, t.id AS conta, b.created_at::date AS criada_em
FROM "TenantBusinessProfile" b JOIN "Tenant" t ON t.id = b.tenant_id
WHERE b.business_type = 'LABORATORIO' ORDER BY b.created_at;

\echo '-- 2. Mensagens que saíram das conversas do laboratório (por tipo e situação)'
SELECT m.type AS tipo, m.status AS situacao, count(*) AS qtd
FROM "Message" m JOIN "Conversation" c ON c.id = m.conversation_id
WHERE c.tenant_id IN (SELECT tenant_id FROM "TenantBusinessProfile" WHERE business_type = 'LABORATORIO') AND m.direction = 'out' AND m.created_at >= (now() AT TIME ZONE 'UTC') - make_interval(hours => :horas)
GROUP BY 1, 2 ORDER BY 3 DESC;

\echo '-- 3. Envios automáticos do laboratório (DispatchLog)'
SELECT d.type AS envio, d.status AS situacao, count(*) AS qtd
FROM "DispatchLog" d
WHERE d.tenant_id IN (SELECT tenant_id FROM "TenantBusinessProfile" WHERE business_type = 'LABORATORIO') AND d.created_at >= (now() AT TIME ZONE 'UTC') - make_interval(hours => :horas)
GROUP BY 1, 2 ORDER BY 1, 2;

\echo '-- 4. Uso de IA nas contas de laboratório (esperado: 0)'
SELECT count(*) AS ia_no_laboratorio
FROM "AiUsage" a WHERE a.tenant_id IN (SELECT tenant_id FROM "TenantBusinessProfile" WHERE business_type = 'LABORATORIO') AND a.created_at >= (now() AT TIME ZONE 'UTC') - make_interval(hours => :horas);

\echo '-- 5. Mensagens gravadas num chip de OUTRA conta, nos dois sentidos (esperado: nenhuma linha)'
SELECT m.direction AS sentido, count(*) AS qtd
FROM "Message" m
JOIN "Conversation" c ON c.id = m.conversation_id
JOIN "Instance" i ON i.name = m.instance_name
WHERE m.created_at >= (now() AT TIME ZONE 'UTC') - make_interval(hours => :horas) AND c.tenant_id IS NOT NULL AND i.tenant_id IS NOT NULL AND i.tenant_id <> c.tenant_id
GROUP BY 1;

\echo '-- 6. Agenda do laboratório com tipo de clínica (esperado: 0)'
SELECT count(*) AS eventos_de_clinica_no_laboratorio
FROM "CalendarEvent" e
WHERE e.tenant_id IN (SELECT tenant_id FROM "TenantBusinessProfile" WHERE business_type = 'LABORATORIO')
  AND e.type NOT IN ('TAREFA', 'OUTRO', 'BLOQUEIO', 'COLETA', 'PROVA', 'ENTREGA');

\echo '-- 7. Fichas do laboratório em conta que não é laboratório (esperado: 0 nas três)'
SELECT
  (SELECT count(*) FROM "PatientLabProfile" WHERE tenant_id NOT IN (SELECT tenant_id FROM "TenantBusinessProfile" WHERE business_type = 'LABORATORIO')) AS perfis,
  (SELECT count(*) FROM "ProcedureLabSpec" WHERE tenant_id NOT IN (SELECT tenant_id FROM "TenantBusinessProfile" WHERE business_type = 'LABORATORIO')) AS fichas_tecnicas,
  (SELECT count(*) FROM "QuoteLabCase" WHERE tenant_id NOT IN (SELECT tenant_id FROM "TenantBusinessProfile" WHERE business_type = 'LABORATORIO')) AS casos;

ROLLBACK;
SQL

echo
echo "-- 8a. Recusas [VERTICAL_DENIED] da API por rota (Classe.metodo)"
# sem_cor: tira os códigos de cor do log do Nest antes de recortar a rota.
sem_cor() { sed -E $'s/\x1b\\[[0-9;]*m//g'; }
docker service logs --since "${HORAS}h" "$API_SERVICE" 2>&1 | sem_cor \
  | grep -F '[VERTICAL_DENIED]' \
  | sed -E 's/.*\[VERTICAL_DENIED\] [^ ]+ ([^ ]+).*/\1/' \
  | sort | uniq -c | sort -rn | head -40 || true
echo "-- 8b. Mensagens [LAB-VOCAB] sem tradução (rota, situação)"
docker service logs --since "${HORAS}h" "$API_SERVICE" 2>&1 | sem_cor \
  | grep -F '[LAB-VOCAB]' \
  | sed -E 's/.*\[LAB-VOCAB\] ([^ ]+) ([^ ]+).*/\1 \2/' \
  | sort | uniq -c | sort -rn | head -40 || true
echo
echo "Fim. Esperado no ensaio: 4, 5, 6 e 7 zerados; 8a só com rota de tela que o laboratório não abre."
