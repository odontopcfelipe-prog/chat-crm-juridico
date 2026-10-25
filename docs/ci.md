# CI — testes e checagens

`.github/workflows/ci.yml` roda em todo push na `master`, em branches `feat/**`
e em PR. Ele **ainda não trava o deploy**: o `deploy.yml` continua montando as
imagens em paralelo. Um CI vermelho é um aviso para não colar o
`vps-redeploy.sh` daquele sha até entender o motivo.

## O que ele confere

| Passo | Pega o quê |
|---|---|
| Schema só-aditivo (`scripts/ci/check-schema-expand-only.sh`) | `DROP TABLE`, `DROP COLUMN`, troca de tipo, `SET NOT NULL`, `RENAME`. A API aplica o schema no boot com `db push --accept-data-loss`, então isso iria direto para produção apagando dado. Coluna e índice novos só geram aviso. |
| Schema aplica num Postgres 15 + pgvector | schema que não sobe (tipo inválido, relação quebrada). |
| Tipos da API e do worker (`tsc --noEmit`) | erro de tipo, inclusive nos specs (o `nest build` não olha os specs e o `ts-jest` não confere tipos). |
| Build (`nest build`) | o mesmo build da imagem. |
| Grafo de injeção (`scripts/ci/di-smoke.cjs`) | ciclo de import entre módulos e provider sem dependência ("Nest can't resolve dependencies…"). Foi o que deixou a API em crash loop em out/2026; o `tsc` não vê. Constrói todos os providers com env falso, sem conectar em banco. |
| Testes da API e do worker (jest) | as regras já cobertas por spec (dinheiro, antifraude, isolamento entre clínicas, ponto, agenda, IA…). |
| Inventário (`apps/api/src/__guards__/inventario.spec.ts`, roda no jest da API) | `@Cron`, fila, job repetível, gatilho de boot, handler ou middleware de socket, `APP_GUARD` ou global do `main.ts` que entrou ou saiu sem atualizar o inventário. Ver [Inventário](#inventário). |
| Web (`next build`) | o mesmo build da imagem do front. |

## Quando o CI fica vermelho

- **Schema bloqueado:** se a mudança destrutiva for de propósito, ponha no
  commit uma linha `schema-destrutivo: <motivo>`. Antes de publicar, faça
  backup do banco: o boot da API vai aplicar a mudança.
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
```

## Decisão pendente do dono

Fazer o build das imagens esperar este CI (`needs`) com uma saída de
emergência para hotfix. Recomendação: ligar depois de 5 dias úteis de CI
estável.
