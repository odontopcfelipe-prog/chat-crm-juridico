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

## Token do GitHub (opcional)

Para conferir o CI, o script consulta a API do GitHub. Sem token são **60 consultas
por hora por IP**, divididas com tudo que sai pelo mesmo IP. Aqui o servidor e os
computadores do escritório dividem o IP, então sessões acompanhando o CI gastam a cota
do deploy (cada execução usa até 4: o CI, a comparação com a versão no ar, o topo do
`master` e a comparação com ele; o topo é pulado quando restam menos de 5). Quando ela
acaba, o deploy para e diz a hora em que ela volta. Com token são
5.000 por hora, só dele. Sem token tudo funciona como antes.

**Criar o token**, no site do GitHub, com a conta dona do repositório:

1. Clique na sua foto, no canto superior direito, e depois em **Settings**.
2. Na barra da esquerda, clique em **Developer settings**.
3. Clique em **Personal access tokens** e depois em **Fine-grained tokens**.
4. Clique em **Generate new token**.
5. Em **Token name**, escreva `deploy-servidor`.
6. Em **Expiration**, escolha o maior prazo oferecido e anote a data na agenda.
7. Em **Repository access**, escolha **Public repositories**: o token só lê o que já é
   público. Se essa opção não aparecer, escolha **Only select repositories** e marque
   `chat-crm-juridico`.
8. Em **Permissions**, não marque nada.
9. Clique em **Generate token** e deixe a página aberta: o GitHub mostra o token uma vez só.

**Guardar no servidor.** Abra o terminal do servidor no MobaXterm: o bash, não o chat de
uma IA. Cole o bloco abaixo; se "Cole o token" não aparecer sozinho, aperte Enter. Quando
aparecer, cole o token e aperte Enter. Nada aparece enquanto você cola, e é assim mesmo.

**Só cole o token depois de ver "Cole o token e aperte Enter:".** Se a última linha termina
em `:~$`, ainda não é a hora: colado ali, o token vira comando e fica exposto na tela e no
histórico.

```bash
set +H
mkdir -p ~/.config/chatcrm && chmod 700 ~/.config/chatcrm
read -rs -p 'Cole o token e aperte Enter: ' T; echo; if [ -n "$T" ]; then (umask 077; printf '%s' "$T" > ~/.config/chatcrm/gh-token); chmod 600 ~/.config/chatcrm/gh-token; echo 'Guardado.'; else echo 'Nada colado: cole o bloco de novo.'; fi; unset T
```

O `read` fica de propósito na última linha, com o resto na mesma linha dele: num bloco
colado, ele pegaria a linha seguinte do próprio bloco no lugar do token.

**Conferir**, sem mostrar o token e sem gastar cota:

```bash
set +H
ls -l ~/.config/chatcrm/gh-token
printf 'header = "Authorization: Bearer %s"\n' "$(cat ~/.config/chatcrm/gh-token)" | curl -sS -m 20 --config - -D - -o /dev/null https://api.github.com/rate_limit | grep -i '^x-ratelimit-limit'
```

Tem de aparecer `-rw-------` na primeira linha e `x-ratelimit-limit: 5000` na segunda. Se
aparecer 60, ou nada, o token não valeu: repita o "Guardar". O próximo deploy mostra
"consulta com token".

**Cuidados:**

- O token nunca vai para o chat de uma IA, para uma mensagem nem para um arquivo do
  repositório, que é público.
- Token vencido ou recusado não trava o deploy: o script avisa "o GitHub recusou o token"
  e consulta sem ele. Para trocar, crie outro e repita o "Guardar".
- O arquivo fica fechado, só para o dono (permissão 600). Aberto para outros usuários, o script
  fecha em 600 e avisa; se não conseguir fechar, consulta sem token. A variável de ambiente
  `GITHUB_TOKEN`, se existir, vale no lugar do arquivo.
- O token vai pela entrada padrão do `curl`: não aparece na lista de processos, na saída
  nem em `~/vps-redeploy.log`.

**Colou o token no lugar errado** (prompt do bash, chat, mensagem, print de tela)? Ele ficou
exposto: apague na mesma tela do GitHub (**Delete**) e crie outro. Se foi no prompt do bash,
limpe também o histórico, na mesma aba do terminal:

```bash
set +H
sed -i '/github_pat_/d' ~/.bash_history 2>/dev/null
for n in $(history | grep -F 'github_pat_' | awk '{print $1}' | sort -rn); do history -d "$n"; done
echo 'Histórico limpo.'
```

**Limite atingido:** espere a hora que o script mostra e rode de novo, sem refazer o backup
(o `vps-backup.sh` guarda os 5 mais recentes e apagaria o mais antigo). A hora vem da
própria resposta do GitHub ou de `GET /rate_limit`, que não gasta cota. Sem hora conhecida,
o script pede para esperar alguns minutos. O `--sem-ci` não é a saída para isso: ele pularia
também um CI vermelho que ninguém viu.

## O que o v2 faz, na ordem

| Passo | O que confere | Se falhar |
|---|---|---|
| CI | Runs do workflow **"CI — testes e checagens"** do sha na API do GitHub (token opcional, ver [Token do GitHub](#token-do-github-opcional)). Vale a **última tentativa**: o maior `run_attempt` do run (um re-run que passou libera, sem commit vazio); entre runs diferentes do mesmo sha, o que começou por último. Precisa `completed` + `success`. | Recusa. Escape: `--sem-ci` (aviso na tela e no registro). Com `latest` não há sha para conferir: exige `--sem-ci`. |
| Disco | `df -h` da raiz e do diretório de dados do Docker. | Menos de 10% livre: recusa. Escape: `--forcar-disco`. |
| Imagens | Digest de cada tag no Docker Hub. | Para; nada foi alterado. |
| Versão | Descobre o sha que está no ar (o digest da API que roda, procurado nas tags de sha do Docker Hub, até 300) e compara com o pedido na API do GitHub (`compare`). Sem resposta do GitHub (limite, rede), compara pela data em que cada imagem foi publicada no Docker Hub. Depois lê o topo do `master`, se sobrar cota. Existe porque várias sessões sobem commits ao mesmo tempo e cada uma passa o seu comando: em 10/11/2026 o `57696abd` ficou na fila atrás do `e7cf5b51`, que já o incluía, e teria tirado do ar o que entrou no meio. | Pedido **mais antigo** que o do ar, ou que não contém o do ar: recusa antes de baixar qualquer imagem e mostra a imagem mais nova do Docker Hub. Escape: `--voltar` (volta de propósito; aviso na tela, `versao=` no registro). O `--sem-ci` **não** libera: o dia de cota esgotada é o mesmo dia de comando atrasado. Sem GitHub e a imagem pedida não é mais nova pela data: recusa e diz quando a cota volta. Lista do Docker Hub ilegível: recusa. O `master` já tem commit mais novo: **só avisa**, com o sha do topo. Sha do ar fora das 300 tags, imagem do ar sem digest, ou `latest`: avisa que não conferiu. |
| Uma por vez | No deploy real, `flock` em `~/.vps-redeploy.lock`: uma segunda publicação colada enquanto a primeira baixa é recusada. E, logo antes do primeiro `service update`, a imagem da API é lida de novo. | Outra rodando: recusa antes de qualquer docker. A API mudou durante o download: para, nada alterado. |
| Download | `docker pull` **por digest** das 3 antes de mexer (pull por tag trava neste servidor), até 30 min cada (`ESPERA_PULL_SEG`; eram 15, e a API de 423 MB não terminou numa manhã de internet lenta em 10/11/2026). | Para; nada foi alterado. Rodar o mesmo comando de novo costuma passar: o Docker aproveita as camadas já baixadas. |
| Schema | `docker create` da imagem nova (sem rodar) → `docker cp` do `schema.prisma` dela → `docker cp` para o `/tmp` da API que está no ar → `docker exec` com `prisma migrate diff --from-schema-datasource <schema da própria API> --to-schema-datamodel <schema novo> --script`. O prisma lê o `DATABASE_URL` do ambiente da API (como o `db push` do boot): a URL não vira argumento de processo, não passa pelo host e nunca é impressa. | Diff que não dá para calcular (API fora, erro do prisma) conta como **PERIGO** (falha fechada). |
| Migração | PERIGO → a API sobe com `--env-add RUN_MIGRATIONS=false`, **só** com `--confirmo-sem-migracao`. Sem perigo e a API com `RUN_MIGRATIONS=false` de antes → `--env-rm RUN_MIGRATIONS` (religa). | Sem a confirmação, para antes de mexer. |
| Ordem | API primeiro. Espera (até 300s) uma task **nova** Running cujo log tenha as duas coisas: a linha do entrypoint (`[entrypoint] Schema aplicado com sucesso.` ou `pulando auto-migração`) **e** a do Nest depois do `listen` (`API rodando em`, ou `Nest application successfully started`). Depois, a **mesma** task tem de ficar de pé por 30s. Só então worker e web. A linha do entrypoint sozinha não basta, porque sai antes do `node` subir: um Nest que cai no boot (ciclo de DI, env faltando) imprime essa linha em cada restart. | API não subiu (Nest não chegou ao `listen`, task trocada sem parar, `tentativa 15/15`, tempo esgotado), ou o script foi interrompido no meio da espera: para, worker e web ficam na versão anterior, grava o `falhou` no registro e **mostra** (não executa) o comando de volta. |
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
| `--voltar` | Publicar de propósito um sha mais antigo que o do ar (volta). Sem ela, o script recusa. |

Variáveis (raramente): `STACK` (padrão `chatcrm`), `ESPERA_API_SEG` (300), `ESPERA_PULL_SEG` (1800),
`ESTAVEL_API_SEG` (30), `POLL_SEG` (5), `DISCO_MIN_LIVRE` (10, em %),
`GH_TOKEN_ARQ` (`~/.config/chatcrm/gh-token`), `REDEPLOY_LOG` (`~/vps-redeploy.log`), `DRIFT_EXTRA` (nomes de índice a mais
no drift), `PROTEGIDAS_EXTRA` (tabelas a mais na lista protegida; não dá para
tirar nenhuma). As numéricas são só dígitos (`DISCO_MIN_LIVRE=15`, não `15%`):
fora disso o script sai com 2 antes de chamar o docker.

Saída: 0 = feito; 1 = recusado ou falhou; 2 = uso errado.

## Quando aparece PERIGO

- **Voltando para uma versão mais velha** (o caso normal): é esperado. Faça o
  backup e suba com `--voltar --confirmo-sem-migracao` (o `--voltar` passa pela
  trava de versão; sem ele o script recusa antes de chegar ao schema). A API velha roda sem mexer no
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
`docker service logs --tail=80 chatcrm_api`. O caso mais comum é o Nest cair
no boot depois do `Schema aplicado` (ex.: `Nest can't resolve dependencies`):
o schema novo já foi aplicado, mas o código não subiu.

O mesmo vale se o script for interrompido (Ctrl+C, `kill`, queda da sessão,
quando só o registro fica) durante a espera: ele mostra a volta e grava
`falhou: interrompido` no registro. Interrompido durante o update do worker
ou do web, ele avisa que a API já está na versão nova; rode o mesmo comando
de novo (o mesmo sha é seguro).

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

**Conferir um dump** (o próprio `vps-backup.sh` já faz isso antes de guardar):
só lê o índice, não grava nada no banco.

```bash
PG=$(docker ps -q --filter label=com.docker.swarm.service.name=chatcrm_postgres)
docker exec -i "$PG" pg_restore -l < ~/backups/<arquivo>.dump | head
```

**Teste de restauração completo**: **nunca** dentro do Postgres de produção.
Ele divide o disco e o diretório de dados com o banco no ar; um restore
grande (os anexos dos disparos são bytea) pode encher o disco e derrubar o
Postgres de produção. Use um container descartável, sem rede, com volume
próprio e a **mesma imagem** do Postgres que já roda no servidor (pelo id
local: sem pull, que por tag trava aqui, e com a extensão `vector` que o
banco usa). Faça fora do horário de atendimento: o restore pesa no disco.

```bash
set +H
PG=$(docker ps -q --filter label=com.docker.swarm.service.name=chatcrm_postgres)
IMG=$(docker inspect --format '{{.Image}}' "$PG")
# 1. espaço: o livre no diretório do Docker precisa passar de 2x o banco
docker exec "$PG" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "${POSTGRES_DB:-$POSTGRES_USER}" -tAc "SELECT pg_size_pretty(pg_database_size(current_database()))"'
df -h "$(docker info --format '{{.DockerRootDir}}')"
# 2. só se sobrar espaço: container descartável (sem rede, então trust é local)
docker run -d --name pg-restaurado-teste --network none -e POSTGRES_HOST_AUTH_METHOD=trust -v pg-restaurado-teste:/var/lib/postgresql/data "$IMG"
until docker exec pg-restaurado-teste pg_isready -U postgres; do sleep 2; done
docker exec pg-restaurado-teste createdb -U postgres restaurado_teste
docker exec -i pg-restaurado-teste pg_restore -U postgres -d restaurado_teste --no-owner --no-privileges < ~/backups/<arquivo>.dump
docker exec pg-restaurado-teste psql -U postgres -d restaurado_teste -tAc 'SELECT count(*) FROM "Patient"'
# 3. SEMPRE no fim: apaga o container e o volume do teste
docker rm -f pg-restaurado-teste && docker volume rm pg-restaurado-teste
```

Restaurar por cima do banco de produção é outra coisa: só decidindo com o dono.

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

- Trava de versão: "a versão no ar" é a da **API** (worker e web não entram). O
  sha dela sai do digest casado com as tags de sha do Docker Hub (até 300): imagem
  mais antiga que isso, imagem sem digest ou build refeito do mesmo sha (digest
  novo) ficam sem conferência, só com aviso. O plano B pela data compara quando
  cada build terminou, não a ordem dos commits: dois builds quase juntos podem
  terminar trocados. O `flock` só existe no deploy real (o `--dry-run` não espera).

- O portão do CI acha o workflow pelo nome ou pelo arquivo
  `.github/workflows/ci.yml`. Se o CI virar um job chamado por outro workflow,
  ajuste `CI_WORKFLOW`/`CI_WORKFLOW_PATH`. Sem token, o GitHub aceita 60
  consultas por hora por IP.
- O diff roda com o prisma da API **que está no ar**. Se a imagem nova trouxer
  um prisma que a velha não entende, o diff falha e conta como PERIGO.
- O rótulo `crm.lab_aware` da imagem só é mostrado; vira trava na F2a.
- A espera da API olha o log da task (linha do entrypoint + linha do Nest
  depois do `listen`) e se ela fica de pé 30s; não chama o `/health`. Se a
  frase `API rodando em` de `apps/api/src/main.ts` mudar, a padrão do Nest
  (`Nest application successfully started`) ainda vale; se as duas sumirem,
  o deploy para depois da API (falha fechada: worker e web não sobem).
