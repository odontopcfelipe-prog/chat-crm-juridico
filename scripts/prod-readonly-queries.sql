-- ============================================================================
-- prod-readonly-queries.sql — linha de base de produção, SÓ LEITURA
-- ============================================================================
-- Mede, sem alterar nada, o que as próximas fases vão mexer: registros com
-- tenant_id NULL, automatismos e flags ligados, chips por clínica (e o chip do
-- env), equipe escrevendo em chip de outra clínica, alertas de tarefa, tamanho
-- das tabelas novas e o volume diário de mensagens, IA e disparos (28 dias).
--
-- Cada seção roda numa transação READ ONLY que termina em ROLLBACK, com
-- statement_timeout. Um erro numa seção (ex.: tabela que ainda não subiu) não
-- impede as outras.
--
-- Nunca imprime valor de configuração sensível: das flags sai só a CHAVE e se o
-- valor é true/false/vazio; da chave Asaas da clínica, só se existe. Chave que
-- guarda id de tenant ou nome de chip (ASAAS_GLOBAL_OWNER_TENANT,
-- EVOLUTION_INSTANCE_NAME) sai como o tenant/chip a que aponta; valor que não
-- aponta para nada sai só com o tamanho. Telefone nunca sai (só contagens). A
-- coluna "data" do DisparoAnexo (o arquivo) não é lida.
--
-- Nomes conferidos contra packages/shared/prisma/schema.prisma: tabela = nome do
-- model entre aspas (o schema só tem um @@map, que não é usado aqui), coluna =
-- nome do campo. Datas do Prisma são timestamp sem fuso, gravadas em UTC; o "dia"
-- daqui é o dia de Maceió (UTC-3, sem horário de verão) = coluna - 3 horas.
--
-- Como rodar no servidor (bash, sem sudo). Não rode durante um deploy (a
-- leitura seguraria o db push do boot da API). Cole antes de tudo:
--
--   set +H
--
--   # 1) baixar este arquivo do sha publicado (o repositório é público)
--   curl -fsSL https://raw.githubusercontent.com/odontopcfelipe-prog/chat-crm-juridico/<sha40>/scripts/prod-readonly-queries.sql -o ~/prod-readonly-queries.sql
--
--   # 2) achar o container do Postgres e o usuário/banco pelo ambiente dele
--   #    (printenv só dessas duas variáveis: a senha não aparece)
--   PG=$(docker ps -q -f name=chatcrm_postgres | head -1)
--   docker exec "$PG" printenv POSTGRES_USER POSTGRES_DB
--
--   # 3) nome do chip do env EVOLUTION_INSTANCE_NAME do worker (é só um nome de
--   #    chip; vazio = o código usa 'whatsapp'). Vai para a seção 6 por -v evo.
--   EVO=$(docker exec $(docker ps -q -f name=chatcrm_worker | head -1) printenv EVOLUTION_INSTANCE_NAME)
--
--   # 4) rodar, trocando <usuario> e <banco> pelo que saiu no passo 2, e guardar a saída
--   docker exec -i "$PG" psql -U <usuario> -d <banco> -v evo="$EVO" -f - < ~/prod-readonly-queries.sql > ~/linha-de-base.txt 2>&1
--
--   #    (o mesmo sem copiar usuário/banco: o psql lê as variáveis dentro do container)
--   docker exec -i -e EVO="$EVO" "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v evo="$EVO" -f -' < ~/prod-readonly-queries.sql > ~/linha-de-base.txt 2>&1
--
--   #    Sem o -v evo, a seção 6 só pula o chip do env; o resto roda igual.
--
--   # 5) conferir se houve erro de alguma seção
--   grep -n 'ERROR' ~/linha-de-base.txt
--
-- Fora do banco, na mesma sessão (também só leitura):
--   docker service inspect chatcrm_postgres --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'
--   docker service logs --since 72h chatcrm_api 2>&1 | grep -E 'Schema aplicado|db push falhou'
--   docker exec $(docker ps -q -f name=chatcrm_api | head -1) du -sh /var/lib/crm-media/campanhas
-- ============================================================================

\set ON_ERROR_STOP off
\set QUIET on
\pset pager off
\pset null '(null)'

-- ----------------------------------------------------------------------------
\echo ''
\echo '== 0. Tenants (legenda dos tenant_id das seções abaixo)'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
SELECT id AS tenant_id, name, status, plan, created_at
FROM "Tenant"
ORDER BY created_at;
ROLLBACK;

-- ----------------------------------------------------------------------------
\echo ''
\echo '== 1. tenant_id NULL nas tabelas principais (registro sem clínica)'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
SELECT 'Lead' AS tabela, count(*) AS total, count(*) FILTER (WHERE tenant_id IS NULL) AS sem_tenant FROM "Lead"
UNION ALL
SELECT 'Conversation', count(*), count(*) FILTER (WHERE tenant_id IS NULL) FROM "Conversation"
UNION ALL
SELECT 'Task', count(*), count(*) FILTER (WHERE tenant_id IS NULL) FROM "Task"
UNION ALL
SELECT 'Instance', count(*), count(*) FILTER (WHERE tenant_id IS NULL) FROM "Instance"
UNION ALL
SELECT 'PaymentGatewayCharge', count(*), count(*) FILTER (WHERE tenant_id IS NULL) FROM "PaymentGatewayCharge"
UNION ALL
SELECT 'FinancialTransaction', count(*), count(*) FILTER (WHERE tenant_id IS NULL) FROM "FinancialTransaction";

-- Cobranças sem tenant por status (o tamanho do legado no dinheiro)
SELECT status, count(*) AS cobrancas, sum(amount) AS valor, min(created_at) AS primeira, max(created_at) AS ultima
FROM "PaymentGatewayCharge"
WHERE tenant_id IS NULL
GROUP BY status
ORDER BY status;

-- Lançamentos sem tenant por tipo e status (source NULL = lançamento comum)
SELECT type, status, source, count(*) AS lancamentos, sum(amount) AS valor, min("date") AS primeira, max("date") AS ultima
FROM "FinancialTransaction"
WHERE tenant_id IS NULL
GROUP BY type, status, source
ORDER BY type, status, source NULLS FIRST;
ROLLBACK;

-- ----------------------------------------------------------------------------
\echo ''
\echo '== 2. Automatismos que inscrevem/agem sozinhos (com e sem tenant)'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
-- FollowupSequence com auto-enroll: inscreve o lead sozinho ao entrar na etapa
SELECT (tenant_id IS NOT NULL) AS tem_tenant, active,
       count(*) AS sequencias,
       count(*) FILTER (WHERE cardinality(auto_enroll_stages) > 0) AS com_auto_enroll
FROM "FollowupSequence"
GROUP BY 1, 2
ORDER BY 1, 2;

SELECT tenant_id, id, name, category, active, auto_enroll_stages
FROM "FollowupSequence"
WHERE cardinality(auto_enroll_stages) > 0
ORDER BY tenant_id NULLS FIRST, name;

-- AutomationRule do tipo "sem resposta" (NO_RESPONSE_24H / NO_RESPONSE_48H)
SELECT tenant_id, trigger, action, enabled, count(*) AS regras
FROM "AutomationRule"
WHERE trigger LIKE 'NO\_RESPONSE\_%'
GROUP BY tenant_id, trigger, action, enabled
ORDER BY tenant_id NULLS FIRST, trigger, action, enabled;
ROLLBACK;

-- ----------------------------------------------------------------------------
\echo ''
\echo '== 3. Flags de IA, bots e resumo diário (só a chave e true/false/vazio)'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
-- Chave ausente = vale o padrão do código. Valor que não é true/false sai só
-- com o tamanho, nunca o conteúdo.
WITH s AS (
  SELECT 'GlobalSetting' AS origem, NULL::text AS tenant_id, key, value FROM "GlobalSetting"
  UNION ALL
  SELECT 'TenantSetting', tenant_id, key, value FROM "TenantSetting"
)
SELECT key, origem, tenant_id,
       CASE
         WHEN btrim(value) = '' THEN '(vazio)'
         WHEN value IN ('true', 'false') THEN value
         WHEN lower(btrim(value)) IN ('true', 'false', '1', '0') THEN 'parecido: ' || lower(btrim(value))
         ELSE '(outro valor, ' || length(value) || ' caracteres)'
       END AS valor
FROM s
WHERE key IN ('WHATSAPP_AI_ENABLED', 'AFTER_HOURS_AI_ENABLED', 'ADMIN_BOT_ENABLED')
   OR key LIKE 'AI\_ENABLED\_%'
ORDER BY key, origem, tenant_id NULLS FIRST;

-- DENTIST_DAILY_SUMMARY: GlobalSetting DENTIST_DAILY_SUMMARY_<tenant> com JSON;
-- sai só o "enabled" de dentro dele.
WITH s AS (
  SELECT 'GlobalSetting' AS origem, NULL::text AS tenant_id, key, value FROM "GlobalSetting"
  UNION ALL
  SELECT 'TenantSetting', tenant_id, key, value FROM "TenantSetting"
)
SELECT key, origem, tenant_id,
       CASE
         WHEN value ~ '"enabled"\s*:\s*true' THEN 'enabled: true'
         WHEN value ~ '"enabled"\s*:\s*false' THEN 'enabled: false'
         WHEN btrim(value) = '' THEN '(vazio)'
         ELSE '(sem "enabled")'
       END AS valor
FROM s
WHERE key LIKE 'DENTIST\_DAILY\_SUMMARY%'
ORDER BY key, origem, tenant_id NULLS FIRST;

-- Só se existe: POST_CARE_CONFIG, ASAAS_GLOBAL_OWNER_TENANT e GDRIVE_ROOT_FOLDER_ID.
SELECT k.key,
       EXISTS (SELECT 1 FROM "GlobalSetting" g WHERE g.key = k.key AND btrim(g.value) <> '') AS em_global,
       (SELECT count(*) FROM "TenantSetting" t WHERE t.key = k.key AND btrim(t.value) <> '') AS tenants_com_a_chave
FROM (VALUES ('POST_CARE_CONFIG'), ('ASAAS_GLOBAL_OWNER_TENANT'), ('GDRIVE_ROOT_FOLDER_ID')) AS k(key)
ORDER BY k.key;

-- Confirmação do dono da chave Asaas global: o valor é um id de tenant, e sai a
-- clínica para onde ele aponta (comparação exata, como no asaas-client.ts).
SELECT CASE
         WHEN g.key IS NULL THEN '(ausente)'
         WHEN tn.id IS NOT NULL THEN 'aponta para o tenant ao lado'
         WHEN btrim(g.value) = '' THEN '(vazio)'
         ELSE '(não é id de tenant, ' || length(g.value) || ' caracteres)'
       END AS asaas_global_owner_tenant,
       tn.id AS tenant_id, tn.name AS tenant, tn.status
FROM (VALUES ('ASAAS_GLOBAL_OWNER_TENANT')) AS k(key)
LEFT JOIN "GlobalSetting" g ON g.key = k.key
LEFT JOIN "Tenant" tn ON tn.id = g.value;
ROLLBACK;

-- ----------------------------------------------------------------------------
\echo ''
\echo '== 4. Chave Asaas própria por clínica (só existência, nunca o valor)'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
SELECT t.id AS tenant_id, t.name,
       EXISTS (
         SELECT 1 FROM "TenantSetting" s
         WHERE s.tenant_id = t.id AND s.key = 'ASAAS_API_KEY' AND btrim(s.value) <> ''
       ) AS tem_asaas_api_key
FROM "Tenant" t
ORDER BY t.created_at;

SELECT count(*) AS linhas_asaas_api_key, count(DISTINCT tenant_id) AS tenants
FROM "TenantSetting"
WHERE key = 'ASAAS_API_KEY';
ROLLBACK;

-- ----------------------------------------------------------------------------
\echo ''
\echo '== 5. Usuários ADMIN / DENTIST por tenant e mensagens deles em chip de outro tenant'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
SELECT u.tenant_id, t.name AS tenant,
       count(*) AS usuarios,
       count(*) FILTER (WHERE 'ADMIN' = ANY (u.roles)) AS admin,
       count(*) FILTER (WHERE 'DENTIST' = ANY (u.roles)) AS dentist,
       count(*) FILTER (WHERE 'SUPER_ADMIN' = ANY (u.roles)) AS super_admin
FROM "User" u
LEFT JOIN "Tenant" t ON t.id = u.tenant_id
GROUP BY u.tenant_id, t.name
ORDER BY t.name NULLS FIRST;
ROLLBACK;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
-- Mensagens recebidas (60 dias) do telefone de um ADMIN/DENTIST num chip de OUTRO
-- tenant. Tenant do chip = Instance de Message.instance_name (ou da conversa);
-- sem Instance, vale o tenant da conversa. O telefone casa por DDD + 8 dígitos
-- finais, com ou sem 55 e o 9 (a mesma equivalência do brazilPhoneMatchVariants).
-- tambem_e_equipe_no_chip = o mesmo número também é ADMIN/DENTIST no tenant do chip.
WITH equipe AS (
  SELECT u.id AS user_id, u.tenant_id,
         CASE WHEN 'ADMIN' = ANY (u.roles) THEN 'ADMIN' ELSE 'DENTIST' END AS papel,
         regexp_replace(u.phone, '\D', '', 'g') AS d
  FROM "User" u
  WHERE u.tenant_id IS NOT NULL AND u.phone IS NOT NULL
    AND ('ADMIN' = ANY (u.roles) OR 'DENTIST' = ANY (u.roles))
),
equipe_tel AS (
  SELECT user_id, tenant_id, papel,
         CASE WHEN length(d) IN (12, 13) AND left(d, 2) = '55' THEN substr(d, 3) ELSE d END AS n
  FROM equipe
),
equipe_chave AS (
  SELECT user_id, tenant_id, papel, left(n, 2) || right(n, 8) AS chave
  FROM equipe_tel
  WHERE length(n) IN (10, 11)
),
lead_tel AS (
  SELECT l.id AS lead_id, regexp_replace(l.phone, '\D', '', 'g') AS d
  FROM "Lead" l
),
lead_chave AS (
  SELECT lead_id, left(n, 2) || right(n, 8) AS chave
  FROM (SELECT lead_id,
               CASE WHEN length(d) IN (12, 13) AND left(d, 2) = '55' THEN substr(d, 3) ELSE d END AS n
        FROM lead_tel) x
  WHERE length(n) IN (10, 11)
    AND left(n, 2) || right(n, 8) IN (SELECT chave FROM equipe_chave)
),
recebidas AS (
  SELECT e.user_id, e.tenant_id AS tenant_do_usuario, e.papel,
         coalesce(i.tenant_id, c.tenant_id) AS tenant_do_chip,
         EXISTS (SELECT 1 FROM equipe_chave e2
                 WHERE e2.chave = e.chave AND e2.tenant_id = coalesce(i.tenant_id, c.tenant_id)) AS tambem_e_equipe_no_chip,
         c.id AS conversation_id, m.created_at
  FROM equipe_chave e
  JOIN lead_chave lc ON lc.chave = e.chave
  JOIN "Conversation" c ON c.lead_id = lc.lead_id
  JOIN "Message" m ON m.conversation_id = c.id
  LEFT JOIN "Instance" i ON i.name = coalesce(m.instance_name, c.instance_name)
  WHERE m.direction = 'in'
    AND m.created_at >= (now() AT TIME ZONE 'UTC') - interval '60 days'
    AND coalesce(i.tenant_id, c.tenant_id) IS DISTINCT FROM e.tenant_id
)
SELECT tenant_do_usuario, papel, tenant_do_chip, tambem_e_equipe_no_chip,
       count(DISTINCT user_id) AS usuarios, count(DISTINCT conversation_id) AS conversas,
       count(*) AS mensagens, max(created_at) AS ultima
FROM recebidas
GROUP BY tenant_do_usuario, papel, tenant_do_chip, tambem_e_equipe_no_chip
ORDER BY tenant_do_usuario, tenant_do_chip NULLS FIRST, papel, tambem_e_equipe_no_chip;
ROLLBACK;

-- ----------------------------------------------------------------------------
\echo ''
\echo '== 6. Chips (Instance) por tenant e função; chips sem inbox; chip do env'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
-- purpose NULL = chip legado "geral"
SELECT i.tenant_id, t.name AS tenant, i.purpose, count(*) AS chips, count(i.inbox_id) AS com_inbox
FROM "Instance" i
LEFT JOIN "Tenant" t ON t.id = i.tenant_id
GROUP BY i.tenant_id, t.name, i.purpose
ORDER BY t.name NULLS FIRST, i.purpose NULLS FIRST;

-- Chips sem inbox (a entrada não cai em setor nenhum)
SELECT i.name, i.tenant_id, i.purpose, i.type, i.connection, i.created_at
FROM "Instance" i
WHERE i.inbox_id IS NULL
ORDER BY i.tenant_id NULLS FIRST, i.name;

-- Chips cujo inbox é de outro tenant (deve dar 0 linhas)
SELECT i.name, i.tenant_id AS tenant_do_chip, b.tenant_id AS tenant_do_inbox, i.purpose, b.purpose AS purpose_do_inbox
FROM "Instance" i
JOIN "Inbox" b ON b.id = i.inbox_id
WHERE b.tenant_id IS DISTINCT FROM i.tenant_id
ORDER BY i.name;
ROLLBACK;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
-- Override legado do chip por clínica (TenantSetting EVOLUTION_INSTANCE_NAME) e o
-- global: o valor é nome de chip; sai o chip a que aponta e o tenant dono dele.
WITH s AS (
  SELECT 'GlobalSetting' AS origem, NULL::text AS tenant_id, key, value FROM "GlobalSetting"
  UNION ALL
  SELECT 'TenantSetting', tenant_id, key, value FROM "TenantSetting"
)
SELECT s.origem, s.tenant_id AS tenant_da_config,
       CASE
         WHEN i.id IS NOT NULL THEN i.name
         WHEN btrim(s.value) = '' THEN '(vazio)'
         ELSE '(não é Instance, ' || length(s.value) || ' caracteres)'
       END AS chip,
       i.tenant_id AS tenant_do_chip, i.purpose, i.inbox_id,
       CASE WHEN s.origem = 'TenantSetting' AND i.id IS NOT NULL
            THEN i.tenant_id IS DISTINCT FROM s.tenant_id END AS chip_de_outro_tenant
FROM s
LEFT JOIN "Instance" i ON i.name = s.value
WHERE s.key = 'EVOLUTION_INSTANCE_NAME'
ORDER BY s.origem, s.tenant_id NULLS FIRST;
ROLLBACK;

-- Chip do env EVOLUTION_INSTANCE_NAME (alertas de tarefa e fallbacks do worker/API).
-- O valor vem de fora do banco, pelo -v evo do topo; vazio = o código usa 'whatsapp'.
\if :{?evo}
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
-- Comparação exata, como o process.env.EVOLUTION_INSTANCE_NAME || 'whatsapp' do código.
SELECT CASE
         WHEN i.id IS NOT NULL THEN i.name
         ELSE '(não é Instance, ' || length(v.nome) || ' caracteres)'
       END AS chip_do_env,
       CASE WHEN :'evo' = '' THEN 'env vazio: padrão do código' ELSE 'do env' END AS origem,
       (i.id IS NOT NULL) AS existe, i.tenant_id, t.name AS tenant, i.purpose,
       i.inbox_id, b.tenant_id AS tenant_do_inbox, i.connection, i.created_at
FROM (VALUES (coalesce(nullif(:'evo', ''), 'whatsapp'))) AS v(nome)
LEFT JOIN "Instance" i ON i.name = v.nome
LEFT JOIN "Tenant" t ON t.id = i.tenant_id
LEFT JOIN "Inbox" b ON b.id = i.inbox_id;
ROLLBACK;
\else
\echo '   (sem -v evo: pulei o chip do env EVOLUTION_INSTANCE_NAME; ver o passo 3 do topo)'
\endif

-- ----------------------------------------------------------------------------
\echo ''
\echo '== 7. Feriados globais (Holiday com tenant_id NULL)'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
SELECT (tenant_id IS NULL) AS global, count(*) AS feriados,
       count(*) FILTER (WHERE recurring_yearly) AS anuais,
       min("date") AS primeiro, max("date") AS ultimo
FROM "Holiday"
GROUP BY 1
ORDER BY 1;
ROLLBACK;

-- ----------------------------------------------------------------------------
\echo ''
\echo '== 8. Tarefas com prazo e sem evento na agenda, por tenant'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
SELECT k.tenant_id, t.name AS tenant, k.status, count(*) AS tarefas,
       count(*) FILTER (WHERE k.due_at >= (now() AT TIME ZONE 'UTC')) AS prazo_no_futuro,
       min(k.due_at) AS primeiro_prazo, max(k.due_at) AS ultimo_prazo
FROM "Task" k
LEFT JOIN "Tenant" t ON t.id = k.tenant_id
WHERE k.due_at IS NOT NULL AND k.calendar_event_id IS NULL
GROUP BY k.tenant_id, t.name, k.status
ORDER BY t.name NULLS FIRST, k.status;
ROLLBACK;

-- ----------------------------------------------------------------------------
\echo ''
\echo '== 9. Ponto (TimeClockPunch) por tenant e tamanho das tabelas novas'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
SELECT p.tenant_id, t.name AS tenant, count(*) AS batidas,
       count(*) FILTER (WHERE p.voided_at IS NOT NULL) AS anuladas,
       min(p.punched_at) AS primeira, max(p.punched_at) AS ultima
FROM "TimeClockPunch" p
LEFT JOIN "Tenant" t ON t.id = p.tenant_id
GROUP BY p.tenant_id, t.name
ORDER BY t.name;
ROLLBACK;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
-- to_regclass devolve NULL se a tabela ainda não existe (não dá erro)
SELECT n AS tabela,
       to_regclass(format('%I', n)) IS NOT NULL AS existe,
       pg_total_relation_size(to_regclass(format('%I', n))) AS bytes,
       pg_size_pretty(pg_total_relation_size(to_regclass(format('%I', n)))) AS tamanho
FROM unnest(ARRAY['TimeClockPunch', 'TimeClockMember', 'TimeClockSchedule',
                  'TeamMessage', 'TeamChannelRead', 'DisparoAnexo']) AS n
ORDER BY n;
ROLLBACK;

-- ----------------------------------------------------------------------------
\echo ''
\echo '== 10. Anexos dos disparos, mídia das campanhas e conversa da equipe'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
SELECT a.tenant_id, t.name AS tenant, a.kind, count(*) AS anexos,
       sum(a.size) AS bytes, pg_size_pretty(sum(a.size)::bigint) AS tamanho
FROM "DisparoAnexo" a
LEFT JOIN "Tenant" t ON t.id = a.tenant_id
GROUP BY a.tenant_id, t.name, a.kind
ORDER BY t.name, a.kind;
ROLLBACK;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
-- ManualCampaignMedia não tem tenant_id: o tenant vem da ManualCampaign
SELECT c.tenant_id, m.kind, count(*) AS arquivos,
       sum(m.size) AS bytes, pg_size_pretty(sum(m.size)::bigint) AS tamanho
FROM "ManualCampaignMedia" m
JOIN "ManualCampaign" c ON c.id = m.campaign_id
GROUP BY c.tenant_id, m.kind
ORDER BY c.tenant_id, m.kind;
ROLLBACK;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
-- patient_id preenchido = mensagem da equipe com ficha de paciente anexada
SELECT tenant_id, count(*) AS mensagens, count(patient_id) AS com_ficha_de_paciente
FROM "TeamMessage"
GROUP BY tenant_id
ORDER BY tenant_id;
ROLLBACK;

-- ----------------------------------------------------------------------------
\echo ''
\echo '== 11. Banco: versão, extensões, tamanho e índice de conversa única'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
SELECT current_database() AS banco,
       pg_size_pretty(pg_database_size(current_database())) AS tamanho,
       version() AS versao;

SELECT extname, extversion
FROM pg_extension
ORDER BY extname;

-- Índice único parcial criado no boot da API (1 conversa ativa por lead+inbox)
SELECT EXISTS (
  SELECT 1 FROM pg_indexes
  WHERE schemaname = 'public' AND indexname = 'Conversation_lead_inbox_active_uq'
) AS indice_existe;

SELECT c.relname AS indice, i.indisvalid AS valido, i.indisunique AS unico,
       pg_get_indexdef(i.indexrelid) AS definicao
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE c.relname = 'Conversation_lead_inbox_active_uq';
ROLLBACK;

-- ----------------------------------------------------------------------------
\echo ''
\echo '== 12. Linha de base de 28 dias (dia de Maceió)'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
-- Conferência: direções de Message no período (a linha de base usa 'out')
SELECT direction, count(*) AS mensagens
FROM "Message"
WHERE created_at >= (now() AT TIME ZONE 'UTC') - interval '28 days'
GROUP BY direction
ORDER BY direction;

-- Mensagens de saída por tenant e dia; com skill_id = resposta gerada pela IA.
-- Message não tem tenant_id: o tenant vem da Conversation.
SELECT c.tenant_id, (m.created_at - interval '3 hours')::date AS dia,
       count(*) AS saidas,
       count(m.skill_id) AS com_skill_id,
       count(*) - count(m.skill_id) AS sem_skill_id
FROM "Message" m
JOIN "Conversation" c ON c.id = m.conversation_id
WHERE m.direction = 'out'
  AND m.created_at >= (now() AT TIME ZONE 'UTC') - interval '28 days'
GROUP BY c.tenant_id, dia
ORDER BY c.tenant_id NULLS FIRST, dia;
ROLLBACK;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
-- Uso de IA por tenant e dia
SELECT tenant_id, (created_at - interval '3 hours')::date AS dia,
       count(*) AS chamadas, sum(total_tokens) AS tokens, round(sum(cost_usd), 4) AS custo_usd
FROM "AiUsage"
WHERE created_at >= (now() AT TIME ZONE 'UTC') - interval '28 days'
GROUP BY tenant_id, dia
ORDER BY tenant_id, dia;
ROLLBACK;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
-- Disparos (DispatchLog): total de 28 dias por tenant × tipo e, depois, por dia
SELECT tenant_id, type, count(*) AS total,
       count(*) FILTER (WHERE status = 'FAILED') AS falhas
FROM "DispatchLog"
WHERE sent_at >= (now() AT TIME ZONE 'UTC') - interval '28 days'
GROUP BY tenant_id, type
ORDER BY tenant_id NULLS FIRST, type;

SELECT tenant_id, type, (sent_at - interval '3 hours')::date AS dia,
       count(*) AS total,
       count(*) FILTER (WHERE status = 'FAILED') AS falhas
FROM "DispatchLog"
WHERE sent_at >= (now() AT TIME ZONE 'UTC') - interval '28 days'
GROUP BY tenant_id, type, dia
ORDER BY tenant_id NULLS FIRST, type, dia;
ROLLBACK;

-- ----------------------------------------------------------------------------
\echo ''
\echo '== 13. Alertas de tarefa (TASK_ALERT): enviados em 28 dias e vencidos à espera do cron'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
-- Enviados: o task-alerts-cron grava AuditLog entity='TASK_ALERT' sem tenant_id;
-- o tenant vem do usuário em meta_json.user_id. Saem pelo chip do env (seção 6).
SELECT u.tenant_id, a.action, count(*) AS alertas, max(a.created_at) AS ultimo
FROM "AuditLog" a
LEFT JOIN "User" u ON u.id = a.meta_json ->> 'user_id'
WHERE a.entity = 'TASK_ALERT'
  AND a.created_at >= (now() AT TIME ZONE 'UTC') - interval '28 days'
GROUP BY u.tenant_id, a.action
ORDER BY u.tenant_id NULLS FIRST, a.action;
ROLLBACK;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
-- Pendentes: o que o resumo de vencidas (8h e 14h) pegaria agora. Mesmo filtro do
-- cron: Task A_FAZER/EM_PROGRESSO e CalendarEvent TAREFA/PRAZO AGENDADO/CONFIRMADO
-- vencidos; recebe quem tem telefone e não desligou 'task_alerts'. O toggle da
-- Central (TASK_ALERTS_ENABLED_<tenant>) só desliga com 'false'; sem a chave, ligado.
-- O cron pega no máximo 30 de cada tipo por rodada.
WITH vencidos AS (
  SELECT k.tenant_id, k.assigned_user_id AS user_id, 'Task' AS origem
  FROM "Task" k
  WHERE k.status IN ('A_FAZER', 'EM_PROGRESSO')
    AND k.due_at < (now() AT TIME ZONE 'UTC')
  UNION ALL
  SELECT e.tenant_id, e.assigned_user_id, 'CalendarEvent'
  FROM "CalendarEvent" e
  WHERE e.type IN ('TAREFA', 'PRAZO') AND e.status IN ('AGENDADO', 'CONFIRMADO')
    AND e.start_at < (now() AT TIME ZONE 'UTC')
)
SELECT v.tenant_id, t.name AS tenant,
       CASE WHEN g.key IS NULL THEN 'ligado (sem a chave)'
            WHEN g.value = 'false' THEN 'desligado'
            ELSE 'ligado' END AS toggle_da_central,
       count(*) FILTER (WHERE v.origem = 'Task') AS tarefas_vencidas,
       count(*) FILTER (WHERE v.origem = 'CalendarEvent') AS eventos_vencidos,
       count(*) FILTER (WHERE btrim(coalesce(u.phone, '')) <> ''
                          AND NOT ('task_alerts' = ANY (u.disparos_off))) AS com_destinatario,
       count(DISTINCT u.id) FILTER (WHERE btrim(coalesce(u.phone, '')) <> ''
                                      AND NOT ('task_alerts' = ANY (u.disparos_off))) AS destinatarios
FROM vencidos v
LEFT JOIN "User" u ON u.id = v.user_id
LEFT JOIN "Tenant" t ON t.id = v.tenant_id
LEFT JOIN "GlobalSetting" g ON g.key = 'TASK_ALERTS_ENABLED_' || v.tenant_id
GROUP BY v.tenant_id, t.name, g.key, g.value
ORDER BY t.name NULLS FIRST;
ROLLBACK;

\echo ''
\echo '== fim (nada foi alterado: todas as seções terminaram em ROLLBACK)'
