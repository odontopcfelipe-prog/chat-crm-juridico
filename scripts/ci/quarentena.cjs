#!/usr/bin/env node
/**
 * Imprime os argumentos do jest que pulam os specs em quarentena de um app.
 * A lista mora em scripts/ci/quarentena.txt (uma linha por spec, caminho a
 * partir da raiz do repo, com o motivo depois de #). Linha de base de
 * 24/10/2026: lista vazia — os 80 arquivos de teste passam.
 *
 * Uso: npx jest --ci $(node ../../scripts/ci/quarentena.cjs api)
 */
const fs = require('fs');
const path = require('path');

const app = process.argv[2];
const file = path.join(__dirname, 'quarentena.txt');
const prefix = `apps/${app}/src/`;

const patterns = fs
  .readFileSync(file, 'utf8')
  .split(/\r?\n/)
  .map((l) => l.replace(/#.*/, '').trim())
  .filter((l) => l.startsWith(prefix))
  .map((l) => l.slice(prefix.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

if (patterns.length) {
  process.stdout.write(patterns.map((p) => `--testPathIgnorePatterns=${p}`).join(' '));
}
