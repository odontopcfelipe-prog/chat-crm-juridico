# CI — testes e checagens

`.github/workflows/ci.yml` roda em todo push na `master`, em branches `feat/**`
e em PR. Ele **ainda não trava o deploy**: o `deploy.yml` continua montando as
imagens em paralelo. Um CI vermelho é um aviso para não colar o
`vps-redeploy.sh` daquele sha até entender o motivo.

## O que ele confere

| Passo | Pega o quê |
|---|---|
| Schema só-aditivo (`scripts/ci/check-schema-expand-only.sh`) | `DROP TABLE`, `DROP COLUMN`, troca de tipo, `SET NOT NULL`, `RENAME`. A API aplica o schema no boot com `db push --accept-data-loss`, então isso iria direto para produção apagando dado. Coluna e índice novos só geram aviso. |
| Textos da clínica intactos (`scripts/ci/check-pick-literals.mjs` + selftest) | em arquivo que usa `pickBt`/`const LAB_*`: qualquer texto da clínica que mudou (letra, espaço, entidade do JSX) — o 1º argumento do `pickBt` é o texto de hoje e não muda. Também barra texto de laboratório com vocabulário clínico (paciente, consulta, prontuário…). Arquivo sem `pickBt`/`LAB_` não é checado. |
| Schema aplica num Postgres 15 + pgvector | schema que não sobe (tipo inválido, relação quebrada). |
| Tipos da API e do worker (`tsc --noEmit`) | erro de tipo, inclusive nos specs (o `nest build` não olha os specs e o `ts-jest` não confere tipos). |
| Build (`nest build`) | o mesmo build da imagem. |
| Grafo de injeção (`scripts/ci/di-smoke.cjs`) | ciclo de import entre módulos e provider sem dependência ("Nest can't resolve dependencies…"). Foi o que deixou a API em crash loop em out/2026; o `tsc` não vê. Constrói todos os providers com env falso, sem conectar em banco. |
| Deploy — vps-redeploy v2 e vps-backup (`scripts/ci/test-vps-redeploy.sh`) | os scripts do servidor (portão do CI, disco, diff de schema, ordem dos updates, `--dry-run`, backup) rodando com stubs de docker/curl/df. Ver `docs/deploy.md`. |
| Testes da API e do worker (jest) | as regras já cobertas por spec (dinheiro, antifraude, isolamento entre clínicas, ponto, agenda, IA…). |
| Inventário (`apps/api/src/__guards__/inventario.spec.ts`, roda no jest da API) | `@Cron`, fila, job repetível, gatilho de boot, handler ou middleware de socket, `APP_GUARD` ou global do `main.ts` que entrou ou saiu sem atualizar o inventário. Ver [Inventário](#inventário). |
| Web (`next build`) | o mesmo build da imagem do front. |

## Quando o CI fica vermelho

- **Schema bloqueado:** se a mudança destrutiva for de propósito, ponha no
  commit uma linha `schema-destrutivo: <motivo>`. Antes de publicar, faça
  backup do banco: o boot da API vai aplicar a mudança.
- **Texto da clínica mudou (pickBt):** se foi de propósito (correção pedida
  pela clínica), ponha no commit uma linha `texto-clinica: <motivo>`. Texto de
  laboratório com vocabulário clínico não tem escape: troque a palavra.
- **Retrato (`__guards__/*.snap`) mudou:** é o que a clínica envia ou vê. Se
  foi de propósito, `npx jest <spec> -u` no app e commite o `.snap` junto,
  dizendo no commit o que mudou para as clínicas.
- **Grafo de injeção:** use `forwardRef(() => X)` nos dois lados (no
  `@Inject` e no `imports` do módulo) ou tire a dependência cruzada.
- **Teste quebrado sem relação com a sua mudança:** registre em
  `scripts/ci/quarentena.txt` com o motivo. Spec de dinheiro, antifraude,
  isolamento entre clínicas e ponto nunca vai para a quarentena.

## Inventário

`scripts/ci/inventario.cjs` lê o código da API e do worker com o compilador do
TypeScript (AST, não busca por texto: decorator comentado não conta) e grava
`apps/api/src/__guards__/inventario.json` e `apps/worker/src/__guards__/inventario.json`.
O spec gera de novo em memória e compara com o que está commitado:

- **Falha (estrito):**
  - o que roda sem ninguém pedir: `@Cron`, `@Interval`, `@Timeout`,
    `@Processor` e eventos de fila, `onModuleInit`, `onApplicationBootstrap`,
    `setInterval`/`setTimeout` de boot (também dentro de IIFE no topo do
    arquivo), `new QueueEvents`, `BullModule.registerQueue` e job repetível
    do BullMQ (`upsertJobScheduler`, `add`/`addBulk` com `repeat`). Classe que
    estende outra do app entra com os itens da base ("herdado de"), menos o
    método que ela sobrescreve;
  - o socket: `.on('connection')` (e `'connect'`, que é sinônimo), com
    handler inline, nomeado ou `this.metodo`, os `socket.on/once/onAny/use`
    de dentro dele, o middleware de conexão `io.use(...)` (o JWT) e
    `@SubscribeMessage`;
  - os globais, na ordem: `APP_GUARD`/`APP_INTERCEPTOR`/`APP_FILTER`/`APP_PIPE`
    e, no `main.ts`, `app.useGlobalGuards/Pipes/Interceptors/Filters`,
    `app.use` e `app.setGlobalPrefix`, com as opções (mudar o
    `ValidationPipe` também falha).
- **Só aviso:** controllers, rotas (verbo + path, na ordem do arquivo),
  decoradores de acesso (`@Public`, `@Roles`, `@RequiresPermission`,
  `@SuperAdmin`, `@UseGuards`, `@Throttle`, `@SkipThrottle`) e produtores de
  fila (`queue.add`/`addBulk` sem `repeat`).

No GitHub Actions, o que mudou (falha e aviso) vai também para o resumo do job
(`$GITHUB_STEP_SUMMARY`): o aviso de rota ou de acesso não fica perdido no
meio do log do jest.

Por que estrito: é a base da regra do laboratório — o que não foi classificado é
negado por padrão. Nenhum automatismo novo entra sem alguém olhar se ele pode
rodar para todos os tenants.

Quando falhar: confira o item listado na mensagem, rode `npm run guards:update`
**na raiz do repo** (dentro de `apps/api` o script não existe; lá use
`node ../../scripts/ci/inventario.cjs --write`) e commite o `inventario.json`
junto com a mudança. Para conferir sem jest: `node scripts/ci/inventario.cjs --check`.

Linha de base (master 08714e89, código igual ao 17062080; AST): 50 `@Cron` (24 API + 26 worker), 7 `@Processor`,
12 `onModuleInit`, 28 `@Public`, 933 rotas, 11 globais da API (7 `APP_*` + 4
do `main.ts`), 7 itens de socket e 30 `queue.add`. A busca por texto dá 51 e 8
porque conta um `@Cron` comentado (`collection-engine.service.ts`) e um
`@Processor` citado num comentário (`memory-jobs.processor.ts`).

Não vê (limites conhecidos): timer ou `socket.on` registrado num método
*chamado* pelo hook ou pelo handler (indireto), `repeat` passado por variável,
decorator novo que embrulhe `@Cron`/`@Roles` com outro nome, middleware de
módulo (`consumer.apply(...)`) e rota fora de decorator.

## Rodar localmente

```bash
npm run db:generate -w @crm/shared && npm run build -w @crm/shared
bash scripts/ci/check-schema-expand-only.sh
(cd apps/api && npx tsc -p tsconfig.json --noEmit && npx nest build && npx jest)
node scripts/ci/di-smoke.cjs api
node scripts/ci/inventario.cjs --check   # ou: npm run guards:update
bash scripts/ci/test-vps-redeploy.sh
```

## Retratos de comportamento (clínica idêntica)

`apps/api/src/__guards__/` congela, em teste, o que as fases do laboratório
**não podem mudar para as clínicas**. Rodam no passo "Testes — API", só com
mocks (sem banco, sem rede).

| Spec | Congela |
|---|---|
| `auth-payload.spec.ts` | token do login e do MCP com exatamente `email, sub, roles, tenant_id` (+ `iat/exp`), e o `req.user` que o `JwtStrategy` monta. Validade (30 dias por padrão / 365 no MCP) e HS256 saem das opções que o próprio `AuthModule` entrega ao `JwtModule` (o `useFactory`, lido da metadata do módulo). Sem snapshot: a lista de chaves está no próprio spec. |
| `canaccessroute-matrix.spec.ts` + `canaccessroute.matrix.json` | tela × setor (`canAccessRoute` com as permissões padrão do setor), papel → setor (`mapBackendRole`) e setor × permissão, incluindo o que recebe quem tem setor nulo ou desconhecido (fallback do `getSector`). Telas = páginas de `apps/web/src/app/atendimento` + prefixos do `ROUTE_ACCESS`. |
| `tenant-defaults.spec.ts` | especialidades, tabela de preços e anamnese padrão; o que `seedTenantDefaults` grava; o que `POST /signup` grava (tenant TRIAL 14 dias, admin `ADMIN`, e-mail de boas-vindas) e que tenant, admin e defaults passam todos pelo `tx` da mesma `$transaction`. |
| `receita-clinica.spec.ts` | a RECEITA que `ensureChargeReceita` lança no caixa para cobrança de clínica (kind null, SINAL, ENTRADA, INSTALLMENT), com create e vínculo dentro da trava anti-corrida (pelo `tx`, antes do fim da transação) e a liberação das comissões; os caminhos reais que a chamam (`registerClinicReceipt` em dinheiro e maquineta, `confirmCartaoReceipt`, ramo RECEIVED do `handleWebhook`, `ensureReceitaBackfillCron`) com as opções que passam, a marca de recebida e o AuditLog `COBRANCA_BAIXA_MANUAL`; e os 403 `PERMISSION_DENIED` de `receive-in-cash` e `confirm-cartao` por setor. |

**Retrato vermelho** = o comportamento de clínica mudou. Se não era para
mudar, conserte o código. Se era (decisão do dono para as clínicas), atualize o
retrato **no mesmo commit** e diga o porquê na mensagem:

```bash
cd apps/api
npx jest __guards__/tenant-defaults -u        # snapshots (.snap)
npx jest __guards__/receita-clinica -u
GUARDS_UPDATE=1 npx jest __guards__/canaccessroute   # regrava o JSON e lista o que mudou
```

- Na matriz, só par **que já existe** no JSON e muda de resultado reprova. Tela,
  setor, papel ou permissão nova/removida só dá aviso pedindo a regravação: no
  `console.warn` e no **resumo do job** do GitHub Actions, com o valor de cada
  setor para a tela nova (uma tela sem regra no `ROUTE_ACCESS` aparece aberta
  para todos). O script raiz `npm run guards:update` (`scripts/ci/inventario.cjs
  --write`) deve rodar também o `GUARDS_UPDATE=1 npx jest __guards__/canaccessroute`.
- A matriz lê o `@crm/shared` **compilado**: depois de mexer em
  `sectors.config.ts`, rode `npm run build -w @crm/shared` antes do jest.
- Retrato quebrado nunca vai para a quarentena: se `scripts/ci/quarentena.txt`
  citar `__guards__`, o `quarentena.cjs` recusa a lista inteira (erro no log e
  nenhum spec pulado).

## Decisão pendente do dono

Fazer o build das imagens esperar este CI (`needs`) com uma saída de
emergência para hotfix. Recomendação: ligar depois de 5 dias úteis de CI
estável.
