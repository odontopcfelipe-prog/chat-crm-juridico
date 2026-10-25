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

## Rodar localmente

```bash
npm run db:generate -w @crm/shared && npm run build -w @crm/shared
bash scripts/ci/check-schema-expand-only.sh
(cd apps/api && npx tsc -p tsconfig.json --noEmit && npx nest build && npx jest)
node scripts/ci/di-smoke.cjs api
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
