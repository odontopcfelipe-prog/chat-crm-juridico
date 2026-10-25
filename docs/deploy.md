# Deploy no servidor — `vps-redeploy.sh` v2 e `vps-backup.sh`

O servidor é local (Docker Swarm, 1 réplica por service, sem sudo) e **não tem
o repositório**: só as imagens do Docker Hub. Os dois scripts moram em
`~/scripts/` e são instalados por `curl` do GitHub, sempre fixados num sha.
Cole os comandos no bash com `set +H`, como sempre.

Por que o v2 existe: a API aplica o schema no boot com
`prisma db push --accept-data-loss` (`infra/entrypoint.sh`). Subir uma imagem
mais velha que o banco **apaga** as tabelas e colunas criadas depois dela (o
ponto, a conversa da equipe, os anexos dos disparos). O v2 confere isso antes
de mexer em qualquer coisa.

## Instalar ou atualizar

```bash
set +H
mkdir -p ~/scripts
# só na primeira vez: guarda o v1 para poder voltar
[ -f ~/scripts/vps-redeploy.v1.sh ] || cp ~/scripts/vps-redeploy.sh ~/scripts/vps-redeploy.v1.sh
SHA=<sha40 do commit com a versão desejada>
curl -fsSL "https://raw.githubusercontent.com/odontopcfelipe-prog/chat-crm-juridico/$SHA/scripts/vps-redeploy.sh" -o ~/scripts/vps-redeploy.sh
curl -fsSL "https://raw.githubusercontent.com/odontopcfelipe-prog/chat-crm-juridico/$SHA/scripts/vps-backup.sh" -o ~/scripts/vps-backup.sh
bash -n ~/scripts/vps-redeploy.sh && bash -n ~/scripts/vps-backup.sh && grep -m1 'vps-redeploy.sh v2' ~/scripts/vps-redeploy.sh
```

Sempre pelo sha de 40 caracteres, nunca por `master`: o arquivo de um branch
muda (e fica em cache), o de um sha não.

## Deploy do dia a dia

```bash
set +H
# 1. ver o que vai acontecer (não mexe em nenhum service)
bash ~/scripts/vps-redeploy.sh --dry-run <sha40> 2>&1 | tee ~/redeploy-dryrun-<sha12>.txt

# 2a. release que mexe no schema: backup antes, no mesmo comando
bash ~/scripts/vps-backup.sh antes-<sha12> && bash ~/scripts/vps-redeploy.sh <sha40>

# 2b. release sem schema
bash ~/scripts/vps-redeploy.sh <sha40>
```

O `--dry-run` baixa só a imagem da API (precisa dela para ler o schema novo) e
cria e apaga um container parado dela; nenhum `service update`, nenhum
`env-add`. Saída 0 = o deploy real seguiria; 1 = pararia (o motivo aparece no
fim).

## O que o v2 faz, na ordem

| Passo | O que confere | Se falhar |
|---|---|---|
| CI | Runs do workflow **"CI — testes e checagens"** do sha na API pública do GitHub (sem token). Vale a **última tentativa**: o maior `run_attempt` do run (um re-run que passou libera, sem commit vazio); entre runs diferentes do mesmo sha, o que começou por último. Precisa `completed` + `success`. | Recusa. Escape: `--sem-ci` (aviso na tela e no registro). Com `latest` não há sha para conferir: exige `--sem-ci`. |
| Disco | `df -h` da raiz e do diretório de dados do Docker. | Menos de 10% livre: recusa. Escape: `--forcar-disco`. |
| Imagens | Digest de cada tag no Docker Hub e `docker pull` **por digest** das 3 antes de mexer (pull por tag trava neste servidor). | Para; nada foi alterado. |
| Schema | `docker create` da imagem nova (sem rodar) → `docker cp` do `schema.prisma` dela → `docker cp` para o `/tmp` da API que está no ar → `docker exec` com `prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel ... --script`. O `DATABASE_URL` só existe dentro do container e nunca é impresso. | Diff que não dá para calcular (API fora, erro do prisma) conta como **PERIGO** (falha fechada). |
| Migração | PERIGO → a API sobe com `--env-add RUN_MIGRATIONS=false`, **só** com `--confirmo-sem-migracao`. Sem perigo e a API com `RUN_MIGRATIONS=false` de antes → `--env-rm RUN_MIGRATIONS` (religa). | Sem a confirmação, para antes de mexer. |
| Ordem | API primeiro; espera (até 300s) a task nova ficar Running e o log mostrar `[entrypoint] Schema aplicado com sucesso.` ou `pulando auto-migração`. Só então worker e web. | API não subiu: para, worker e web ficam na versão anterior e o script **mostra** (não executa) o comando de volta. |
| Fim | Limpa imagens órfãs (>72h), mostra os digests antes → depois, o CI e a decisão de migração, e grava uma linha em `~/vps-redeploy.log`. | — |

### Como o diff é lido

- **PERIGO** — `DROP TABLE`, `DROP COLUMN`, troca de tipo, `SET NOT NULL`,
  `RENAME COLUMN`/tabela, troca de enum (`DROP TYPE`/`ALTER TYPE ... RENAME`).
  E **qualquer** remoção ou alteração (até `DROP INDEX`) em `TimeClockPunch`,
  `TimeClockMember`, `TimeClockSchedule`, `DisparoAnexo`, `TeamMessage` e
  `TeamChannelRead`: elas nunca entram no drift aceito.
- **drift conhecido** (não conta) — `DROP INDEX` de índice que só existe no
  banco: o `Conversation_lead_inbox_active_uq` (criado no boot da API) e os
  índices de `packages/shared/prisma/manual-sql` (a lista é lida da própria
  imagem nova).
- **aviso** (não bloqueia) — outro `DROP INDEX`, `DROP CONSTRAINT`,
  `DROP DEFAULT`, `RENAME CONSTRAINT`, e `ADD COLUMN ... NOT NULL` sem
  `DEFAULT` (o db push falha se a tabela tiver linhas).
- **acréscimo** — `CREATE TABLE`, `CREATE INDEX`, `ADD COLUMN`,
  `ADD CONSTRAINT`, `ALTER TYPE ... ADD VALUE`.

Se o diff mostrar `CREATE TABLE "TeamMessage"` (ou outra protegida), o script
avisa que ela ainda não existe no banco vivo — ou seja, a versão que a criou
ainda não subiu.

## Opções

| Opção | Para quê |
|---|---|
| `--dry-run` | Mostra CI, disco, digests, diff, decisão de `RUN_MIGRATIONS` e a ordem; não mexe em service. |
| `--sem-ci` | Hotfix consciente com CI vermelho, rodando ou fora do ar (ou deploy de `latest`). |
| `--forcar-disco` | Seguir com menos de 10% de disco livre. |
| `--confirmo-sem-migracao` | Aceitar subir a API com `RUN_MIGRATIONS=false` quando o diff tem PERIGO. |

Variáveis (raramente): `STACK` (padrão `chatcrm`), `ESPERA_API_SEG` (300),
`DISCO_MIN_LIVRE` (10), `REDEPLOY_LOG` (`~/vps-redeploy.log`), `DRIFT_EXTRA`
(nomes de índice a mais no drift), `PROTEGIDAS_EXTRA` (tabelas a mais na
lista protegida; não dá para tirar nenhuma).

Saída: 0 = feito; 1 = recusado ou falhou; 2 = uso errado.

## Quando aparece PERIGO

- **Voltando para uma versão mais velha** (o caso normal): é esperado. Faça o
  backup e suba com `--confirmo-sem-migracao`. A API velha roda sem mexer no
  banco; as tabelas e colunas novas continuam lá, intactas. No próximo deploy
  para frente sem perigo, o v2 religa a migração sozinho.
- **Deploy para frente com PERIGO**: pare. A mudança apaga dado; confira o
  commit (o passo "Schema só-aditivo" do CI deveria ter barrado).
- **Diff não calculado**: veja o motivo impresso. Se a API está fora do ar,
  dá para subir com `--confirmo-sem-migracao` e depois **rodar o mesmo sha de
  novo**: com a API no ar o v2 calcula o diff e, sem perigo, religa a migração.

## Quando a API não sobe

O script para sem tocar no worker e no web e mostra o comando de volta, que
**não** é executado:

```bash
docker service update --force --image <imagem anterior da API> --env-add RUN_MIGRATIONS=false chatcrm_api
```

A volta é sem migração de propósito: a imagem anterior com db push apagaria o
que a nova acabou de criar. Antes de colar, olhe
`docker service logs --tail=80 chatcrm_api`.

## `vps-backup.sh`

```bash
bash ~/scripts/vps-backup.sh [rótulo]     # rótulo padrão: manual
```

- `pg_dump -Fc` via `docker exec` no container do service `chatcrm_postgres`.
  Usuário e banco vêm do ambiente do próprio container
  (`POSTGRES_USER`/`POSTGRES_DB`); a senha nunca passa pelo host.
- Grava em `~/backups/chatcrm-<data>-<rótulo>.dump` (nunca em `/tmp`, que some
  no reboot), com permissão só do dono.
- Antes, mede o banco (`pg_database_size`, e o tamanho de `DisparoAnexo`) e
  recusa se o espaço livre for menor que **2× o banco**.
- Depois, confere o arquivo com `pg_restore -l`, mostra o tamanho e mantém os
  **5 mais recentes** (`BACKUP_MANTER` muda; só apaga `chatcrm-*.dump`).
- Não rode durante um deploy: rode antes, encadeado com `&&`.

Conferir ou restaurar num banco **novo** (nunca por cima do de produção sem
decidir com o dono; o Postgres precisa da extensão `vector`):

```bash
PG=$(docker ps -q --filter label=com.docker.swarm.service.name=chatcrm_postgres)
docker exec -i "$PG" pg_restore -l < ~/backups/<arquivo>.dump | head
docker exec "$PG" sh -c 'createdb -U "$POSTGRES_USER" restaurado_teste'
docker exec -i "$PG" sh -c 'pg_restore -U "$POSTGRES_USER" -d restaurado_teste --no-owner' < ~/backups/<arquivo>.dump
```

## Voltar para o v1

```bash
set +H
cp ~/scripts/vps-redeploy.v1.sh ~/scripts/vps-redeploy.sh
# sem a cópia: o v1 pelo sha (último master antes do v2)
curl -fsSL "https://raw.githubusercontent.com/odontopcfelipe-prog/chat-crm-juridico/08714e8943e479bcca333bc4b5ebf8490a9a80fc/scripts/vps-redeploy.sh" -o ~/scripts/vps-redeploy.sh
```

O v1 não confere CI, disco nem schema, e não mexe em `RUN_MIGRATIONS`. Se o v2
deixou a API com `RUN_MIGRATIONS=false`, ela continua assim com o v1. Para
conferir e religar:

```bash
docker service inspect chatcrm_api --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' | grep '^RUN_MIGRATIONS='
docker service update --env-rm RUN_MIGRATIONS chatcrm_api
```

## Teste

`bash scripts/ci/test-vps-redeploy.sh` roda os dois scripts com stubs de
`docker`, `curl` e `df` (nada toca Docker, rede ou banco) e entra no CI no
passo "Deploy — vps-redeploy v2 e vps-backup". O leitor de JSON do script é o
`python3` do servidor; o teste também roda com `node`, para funcionar em
máquina sem python.

## Limites conhecidos

- O portão do CI acha o workflow pelo nome ou pelo arquivo
  `.github/workflows/ci.yml`. Se o CI virar um job chamado por outro workflow,
  ajuste `CI_WORKFLOW`/`CI_WORKFLOW_PATH`. Sem token, o GitHub aceita 60
  consultas por hora por IP.
- O diff roda com o prisma da API **que está no ar**. Se a imagem nova trouxer
  um prisma que a velha não entende, o diff falha e conta como PERIGO.
- O rótulo `crm.lab_aware` da imagem só é mostrado; vira trava na F2a.
- A espera da API olha a linha do entrypoint e o estado da task, não o
  `/health`.
