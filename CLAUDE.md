# Regras para agentes de IA neste repositório

SaaS de gestão de clínicas odontológicas, em produção, com várias clínicas no
mesmo banco. Monorepo: `apps/api` (NestJS), `apps/worker` (NestJS + BullMQ +
crons), `apps/web` (Next.js) e `packages/shared` (tipos, config e o Prisma em
`packages/shared/prisma/schema.prisma`).

Aqui só está o que não se descobre lendo o código; cada regra traz o porquê.
O repositório é **público**: nada de segredo, senha, token, id interno de
clínica ou descrição de falha de segurança em código, commit ou documento.

## Publicar

- Trabalhe num worktree novo de `origin/master`
  (`git fetch origin && git worktree add <pasta> -b <branch> origin/master`).
  Porquê: o checkout principal do dono pode estar atrás e com alterações dele sem commit.
- Commit e push em `master` **e** `main` (`git pull --rebase origin master`, depois
  `git push origin HEAD:master` e `git push origin HEAD:main`).
  Porquê: CI e build das imagens rodam na `master`; a `main` é espelho e não pode divergir.
- **Nunca force-push.**
  Porquê: o dono trabalha em paralelo; o force apaga commit dele.
- Antes de passar o comando de deploy, confira no GitHub Actions, para o sha, o
  workflow **"CI — testes e checagens"** verde (vale a última tentativa do run) e o
  "Build and Push to Docker Hub" concluído.
  Porquê: o CI ainda não trava o build das imagens (`docs/ci.md`); e a imagem `:<sha>` só existe depois do build.
- Deploy: o dono cola no servidor `bash ~/scripts/vps-redeploy.sh <sha40>`, com o sha
  de 40 caracteres do tip publicado (`git rev-parse HEAD`).
  Porquê: o script baixa e fixa a imagem por digest; pull por tag trava no servidor e `:latest` sem digest roda a imagem velha.
- Nunca `docker stack deploy` nem `docker pull` por tag.
  Porquê: o stack vivo tem ajustes feitos por `service update` (ex.: volume da mídia) que um yml desatualizado desfaz.
- Comando para o dono colar no servidor: bash começando com `set +H`, sem `sudo` (lá não há).
  Erro estranho no servidor: `df -h` primeiro.
  Porquê: `!` colado vira expansão de histórico; e o Docker enche o disco do servidor.

## Schema (Prisma)

- Só acrescentar: model, coluna e índice novos.
  Porquê: o boot da API roda `prisma db push --accept-data-loss` (`infra/entrypoint.sh`); DROP, troca de tipo ou NOT NULL vai direto para produção.
- DROP, troca de tipo ou NOT NULL de propósito: linha `schema-destrutivo: <motivo>` na
  mensagem do commit e backup do banco antes do deploy.
  Porquê: sem a linha o `scripts/ci/check-schema-expand-only.sh` bloqueia; com ela nada mais protege o dado.
- Coluna nova em tabela existente é opcional (`?`) ou tem `@default`.
  Porquê: obrigatória sem default não aplica em tabela com linhas, e a API sobe com o schema velho.
- Rollback para imagem anterior a um model ou coluna novos só com `RUN_MIGRATIONS=false` no
  service da API.
  Porquê: a imagem antiga aplica o schema dela com `--accept-data-loss` e apaga o que é novo (ex.: o ponto).
- `{ campo: { not: X } }` (e `notIn`) descarta as linhas com NULL. Em campo opcional use
  `OR: [{ campo: null }, { campo: { not: X } }]`; em campo obrigatório `{ campo: null }` dá 500.
  Porquê: já esvaziou a aba de entradas do financeiro e derrubou contadores do ADMIN.
- SQL cru: a tabela é o nome do model entre aspas (`"Lead"`, `"Patient"`), a coluna é o
  nome do campo. Prefira o ORM.
  Porquê: `FROM patients` volta vazio ou erro engolido (o cron de aniversário ficou sem achar ninguém).

## Injeção de dependência (Nest)

- Dependência cruzada entre módulos usa `forwardRef(() => X)` nos dois lados (`imports`
  do módulo e `@Inject(forwardRef(() => XService))`), ou vira função pura sobre o Prisma.
  Porquê: ciclo de import deixa a API em crash loop no boot, e `tsc`/`nest build` passam.
- Depois do `nest build`, rode `node scripts/ci/di-smoke.cjs api` (e `worker`) antes do push.
  Porquê: é o passo do CI que monta o grafo de providers com env falso, sem banco.
- DTO: o `ValidationPipe` tem `whitelist` + `forbidNonWhitelisted`.
  Porquê: campo novo no body que não está no DTO responde 400.

## Multi-clínica

- Toda leitura/escrita por id filtra `tenant_id` (`findFirst({ where: { id, tenant_id } })`,
  `updateMany`/`deleteMany` com `tenant_id`); id de outra clínica responde 404.
  Porquê: o id vem da URL; sem o filtro uma clínica lê ou altera dado de outra.
- O tenant do request é `req.user.tenant_id` (snake_case, `apps/api/src/auth/jwt.strategy.ts`).
  Porquê: `req.user.tenantId` é undefined, e o Prisma ignora undefined no `where` (pega todas as clínicas).
- Nunca cair no chip, configuração ou conta de cobrança de outra clínica; fallback global
  só onde já é a regra (`getTenantSetting`, chave de IA global).
  Porquê: mensagem e cobrança sairiam pelo número ou pela conta de outra clínica.
- Telefone: sempre `toBrazilWhatsappNumber` / `brazilPhoneMatchVariants`
  (`packages/shared/src/phone.util.ts`); nunca reescrever o telefone salvo nem criar normalização nova.
  Porquê: o mesmo número existe com 12 e 13 dígitos; lógica própria duplica contato e manda para número inexistente.
- Mensagem ou documento a paciente/lead (fora da cobrança): chip por `escolherChipPaciente`
  e conversa por `findOrCreatePatientConversationId`; nunca o chip FINANCEIRO.
  Porquê: o FINANCEIRO é o número isolado da cobrança; atendimento aberto nele mistura as duas conversas.

## Automatismos (crons, filas, disparos)

- Todo `@Cron`, `@Processor`, gatilho de boot (`onModuleInit`, `onApplicationBootstrap`,
  `setInterval`) e handler de socket novo entra no inventário de automatismos, e o commit
  diz se vale para todos os tenants. Se o `package.json` da raiz tem o script `guards:update`,
  rode `npm run guards:update` (regenera `apps/*/src/__guards__`); se ainda não tem, liste
  o automatismo novo na mensagem do commit.
  Porquê: cron roda para todos os tenants do banco, inclusive os que não pediram.
- Disparo novo nasce desligado por clínica: opt-in na Central de Disparos
  (`/atendimento/settings/disparos`; catálogo global, toggle por tenant).
  Porquê: ligado por padrão, ele manda para a carteira inteira de todas as clínicas no primeiro tick e queima o chip.
- Cron que envia faz claim atômico antes do envio (`updateMany` com `sent_at: null`; count 0 =
  outro pegou) ou usa `pg_advisory_xact_lock`.
  Porquê: no deploy dois workers coexistem, e o paciente já recebeu mensagem em dobro.
- Agenda guarda a hora de Maceió nos campos UTC ("naive-UTC"): "agora/hoje" é `Date.now() - 3h`.
  No worker use `apps/worker/src/ai/scheduling-safety.ts`; vencimento de cobrança, `startOfTodayMaceioUtc()`.
  Porquê: comparar com `new Date()` cru some com as consultas das próximas 3 h e adianta lembretes.

## Telas e tabelas que valem para todo tenant

O cadastro vai ganhar um segundo tipo de tenant (laboratório de prótese). Isto já vale:

- Componente montado em `apps/web/src/app/atendimento/layout.tsx` aparece para TODO usuário
  logado, de qualquer tenant, inclusive o futuro laboratório (ex.: `EquipeChat`, a conversa
  da equipe). Confira que as rotas que ele chama servem a qualquer tenant.
  Porquê: o layout envolve todas as telas; rota só de clínica chamada dali quebra ou mostra dado errado em outro tipo de tenant.
- Model novo com `tenant_id` e sem `@relation` para `Tenant` (como `DisparoAnexo`,
  `TeamMessage`, `TeamChannelRead`) não é apagado junto com o tenant. Ainda não existe
  rotina de exclusão de tenant no código (hoje só há a suspensão); não crie uma por conta
  própria: diga no commit e no resumo do trabalho que o model tem `tenant_id` sem `@relation`.
  Porquê: só o `onDelete: Cascade` da relação apaga junto; a exclusão de tenant, quando vier, precisa da lista desses models.
- `/lab` do web (`apps/web/src/app/lab/*`) é sandbox de teste visual, pública e sem dado.
  Porquê: não é o produto laboratório; nada do produto nem dado real vai ali.

## Testes

- Como rodar: `docs/ci.md` ("Rodar localmente"). Primeiro
  `npm run db:generate -w @crm/shared && npm run build -w @crm/shared`.
  Porquê: os specs importam exports novos do shared compilado.
- `npx tsc -p tsconfig.json --noEmit` em `apps/api` e `apps/worker`.
  Porquê: o `nest build` exclui os specs e o `ts-jest` não confere tipos.
- `apps/web` não tem runner de teste: regra de tela/acesso que mora em `packages/shared`
  (ex.: `canAccessRoute`) é testada no jest da API (como `apps/api/src/auth/dentista-acesso.spec.ts`).
- Spec quebrado sem relação com a sua mudança vai para `scripts/ci/quarentena.txt`, com
  motivo. Spec de dinheiro, antifraude, isolamento entre clínicas e ponto **nunca** vai.
  Porquê: são as regras que protegem caixa, prova legal e dado de outra clínica; se quebrou, conserte.
- Mudança de tela: veja o fluxo rodando no navegador antes do push, com o gate no front e no backend.
  Porquê: filtro só no backend parece "não corrigido" para quem usa a tela.
