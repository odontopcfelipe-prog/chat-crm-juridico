# Contract Templates (PDFs anexos)

Onda 14.31/14.32 — PDFs oficiais da clínica que são mesclados com o contrato
principal quando o operador marca os checkboxes correspondentes no card
"Contrato de tratamento" da aba Propostas.

## Como funciona

1. O contrato principal (qualificação das partes, objeto, valor, cláusulas
   gerais, TCLE, LGPD) é gerado dinamicamente via `pdfkit` no
   `ContractPdfService.renderPdf()`.
2. Após o contrato principal, pra cada documento marcado em
   `Contract.selected_documents`, o sistema procura o PDF correspondente
   neste diretório.
3. Se o PDF existir → suas páginas são mescladas ao final do contrato
   via `pdf-lib`.
4. Se o PDF não existir → fallback: usa o texto base gerado por pdfkit
   via `extraDocumentContent(docId)`.

## Mapeamento docId → arquivo

| docId | Arquivo esperado |
|---|---|
| `USO_IMAGEM` | `uso-de-imagem.pdf` |
| `CLAREAMENTO` | `clareamento.pdf` |
| `FACETAS_RESINA` | `facetas-de-resina.pdf` |
| `LAMINADOS_CERAMICOS` | `laminados-ceramicos.pdf` |
| `PROTESE` | `protese-pronto.pdf` |
| `ENDODONTIA_ADULTO` | `termo-endo.pdf` |
| `ENDODONTIA_MENOR` | `termo-endo-menor.pdf` |
| `EXTRACAO_ADULTO` | `termo-extracao-adulto.pdf` |
| `EXTRACAO_MENOR` | `termo-exo-menor-certo.pdf` |
| `IMPLANTE` | `termo-implante.pdf` |
| `RESTAURACAO` | `termo-pronto-restauracao.pdf` |

## Como adicionar/substituir um PDF

1. Copie o PDF original (oficial da clínica) para este diretório
2. Renomeie pra bater exatamente com o nome esperado na tabela acima
3. Commit + push no repositório
4. Próxima vez que um contrato for gerado com aquele docId marcado, o
   PDF oficial será mesclado no resultado

## Como atualizar o conteúdo de um termo

Edite o PDF localmente (Word/InDesign/etc), exporte como PDF, sobrescreva
o arquivo neste diretório, commit + push. Próximas gerações usam o
arquivo atualizado.

## Fallback (sem PDF)

Se nenhum PDF for fornecido pra um docId específico, o sistema gera o
texto contratual base (versão genérica) via pdfkit. Esses textos estão
no método `extraDocumentContent()` do `contract-pdf.service.ts`.

Pra forçar o uso só do PDF oficial (sem fallback de texto), use o
comportamento atual — o operador simplesmente vai ver o texto base nos
contratos que ainda não têm PDF oficial copiado pra cá.

## Caminho absoluto em runtime

Em produção, este diretório é resolvido via `__dirname` relativo ao
`contract-pdf.service.ts`. Funciona tanto em dev (`ts-node`) quanto em
produção (`dist/`) porque ambos preservam a estrutura `src/commercial/
contract-templates/`.

Onda 14.32 e adiante: dá pra evoluir pra storage remoto (S3) com URL
configurável, mas pra Fase 1 o sistema de arquivos local é suficiente
e mais previsível.
