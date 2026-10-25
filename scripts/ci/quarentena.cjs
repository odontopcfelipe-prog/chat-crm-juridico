#!/usr/bin/env node
/**
 * Imprime os argumentos do jest que pulam os specs em quarentena de um app.
 * A lista mora em scripts/ci/quarentena.txt (uma linha por spec, caminho a
 * partir da raiz do repo, com o motivo depois de #). Linha de base de
 * 24/10/2026: lista vazia — os 80 arquivos de teste passam.
 *
 * Os retratos e inventários de `__guards__/` nunca entram na quarentena: linha
 * que cite `__guards__` faz o script sair com erro e não imprimir nada. No CI o
 * `$(...)` ignora o código de saída, então o jest roda sem nenhum ignore — o
 * retrato não é pulado e a mensagem fica no log do passo.
 *
 * Uso: npx jest --ci $(node ../../scripts/ci/quarentena.cjs api)
 */
const fs = require('fs');
const path = require('path');

const app = process.argv[2];
const file = path.join(__dirname, 'quarentena.txt');
const prefix = `apps/${app}/src/`;

const linhas = fs
  .readFileSync(file, 'utf8')
  .split(/\r?\n/)
  .map((l) => l.replace(/#.*/, '').trim())
  .filter(Boolean);

// Qualquer menção conta: um spec, a pasta inteira, caminho com barra invertida.
const guards = linhas.filter((l) => l.includes('__guards__'));
if (guards.length) {
  process.stderr.write(
    `::error::scripts/ci/quarentena.txt tem spec de __guards__ (retrato/inventário nunca vai para a quarentena): ${guards.join(', ')}. ` +
      'Nenhum spec será pulado. Conserte o código ou atualize o retrato no mesmo commit (docs/ci.md).\n',
  );
  process.exit(1);
}

const patterns = linhas
  .filter((l) => l.startsWith(prefix))
  .map((l) => l.slice(prefix.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

if (patterns.length) {
  process.stdout.write(patterns.map((p) => `--testPathIgnorePatterns=${p}`).join(' '));
}
