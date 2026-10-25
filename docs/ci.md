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

## Decisão pendente do dono

Fazer o build das imagens esperar este CI (`needs`) com uma saída de
emergência para hotfix. Recomendação: ligar depois de 5 dias úteis de CI
estável.
