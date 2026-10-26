#!/usr/bin/env node
/**
 * Confere que o texto da CLÍNICA não muda quando entra texto de LABORATÓRIO.
 *
 * Por que existe: o laboratório de prótese vai ser o mesmo sistema da clínica
 * com outros nomes. O texto que muda por tipo de negócio sai SEMPRE de
 * pickBt(bt, textoClinica, textoLab) (de @crm/shared: back, worker e front) ou
 * de uma const LAB_* (texto só do laboratório). Enquanto esses textos entram,
 * a clínica tem de continuar recebendo exatamente o que recebe hoje — um acento
 * trocado sem querer ao "envolver" um texto no pickBt já é mudança para todas
 * as clínicas.
 *
 * Compara a BASE (padrão: merge-base com origin/master, senão o commit anterior)
 * com o HEAD, lendo com o compilador do TypeScript (AST, não regex) os
 * .ts/.tsx/.js/.jsx/.mjs/.cjs alterados em apps/ e packages/ (fora
 * node_modules, dist, .next, __guards__, *.spec.* e *.test.*):
 *
 *   TRAVA 1 — texto da clínica intocado. Num arquivo que tem chamada pickBt(...)
 *   ou const LAB_* (no HEAD ou na base), o MULTICONJUNTO de textos fora da
 *   posição de laboratório tem de ser igual nos dois lados. Texto = string,
 *   template sem ${}, as partes fixas de template com ${} e texto de JSX
 *   (aparado). Posição de laboratório = o textoLab do pickBt (e o que vier
 *   depois dele) e o inicializador inteiro de const LAB_*. Também vale
 *   `import { pickBt as x }` e `algo.pickBt(...)`. Não contam:
 *   especificador de import/export/require, diretiva ('use client',
 *   'use strict'), string vazia e o que está em posição de tipo (type,
 *   interface, anotação: nunca chega na tela). Toda outra string conta,
 *   inclusive chave, status e className. Arquivo sem pickBt/LAB_ nos dois lados
 *   não é checado: edição normal de texto continua livre.
 *   Escape consciente: uma linha `texto-clinica: <motivo>` numa mensagem de
 *   commit de base..HEAD libera a trava 1 (fica registrada no resumo do job).
 *
 *   TRAVA 2 — texto de laboratório sem vocabulário da clínica. Todo texto em
 *   posição de laboratório dos arquivos alterados (no HEAD) não pode ter os
 *   termos de PROIBIDOS (abaixo). Não tem escape.
 *
 * Arquivo apagado conta como vazio: apagar (ou mover o texto para outro
 * arquivo) um arquivo com pickBt também precisa do escape. Arquivo renomeado é
 * comparado com o nome antigo.
 *
 * Uso: node scripts/ci/check-pick-literals.mjs [<sha-base>]
 * Teste do próprio script: node scripts/ci/check-pick-literals.selftest.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// O typescript fica içado na raiz pelo npm workspaces (como em inventario.cjs);
// resolve a partir do próprio script, não do cwd: o selftest roda o checker
// dentro de repositórios temporários.
const ts = (() => {
  try {
    return createRequire(import.meta.url)('typescript');
  } catch {
    try {
      return createRequire(path.join(RAIZ, 'apps', 'api', 'package.json'))('typescript');
    } catch {
      console.log('[pick] não achei o pacote typescript (rode o npm install na raiz do repo).');
      process.exit(1);
    }
  }
})();

const ZERO = '0000000000000000000000000000000000000000';
const SELETOR = 'pickBt';
const PREFIXO_LAB = 'LAB_';

const EXTENSOES = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const PASTAS = /^(apps|packages)\//;
const FORA = [
  /(^|\/)(node_modules|dist|\.next|__guards__)\//,
  /\.(spec|test)\.[cm]?[jt]sx?$/,
  /^scripts\/ci\//,
];

// Vocabulário da CLÍNICA que não pode aparecer em texto de laboratório.
// Compara sem maiúsculas e sem acento ("PRONTUÁRIO" = "prontuario") e pela
// palavra inteira: "consultar" e "consultório" passam, "consultas" não.
// "clínica" e "dentista" ficam de fora DE PROPÓSITO: a clínica e o dentista
// são os clientes do laboratório.
const PROIBIDOS = [
  ['paciente(s)', 'pacientes?'],
  ['consulta(s)', 'consultas?'],
  ['prontuário(s)', 'prontuarios?'],
  ['anamnese(s)', 'anamneses?'],
  ['odontograma(s)', 'odontogramas?'],
  ['plano de tratamento', 'planos? de tratamentos?'],
  ['tratamento odontológico', 'tratamentos? odontologicos?'],
  ['TCLE', 'tcle'],
].map(([rotulo, padrao]) => [rotulo, palavra(padrao, '')]);

// Frases do laboratório que contêm um termo proibido. Saem do texto antes de
// procurar os PROIBIDOS.
const PERMITIDOS = [
  'pacientes? do caso', // o paciente do dentista, dono do caso protético
  'consultas? de credito', // consulta de crédito do cliente (financeiro)
].map((padrao) => palavra(padrao, 'g'));

function palavra(padrao, flags) {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${padrao})(?![\\p{L}\\p{N}])`, `u${flags}`);
}

function normalizar(texto) {
  return texto
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function termosProibidos(texto) {
  let t = normalizar(texto);
  for (const re of PERMITIDOS) t = t.replace(re, ' ');
  return PROIBIDOS.filter(([, re]) => re.test(t)).map(([rotulo]) => rotulo);
}

// ---------------------------------------------------------------- git

function sair(codigo, ...linhas) {
  for (const l of linhas) console.log(l);
  process.exit(codigo);
}

let TOPO;
try {
  TOPO = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
} catch {
  sair(1, '[pick] não estou dentro de um repositório git.');
}

function git(args) {
  return execFileSync('git', args, {
    cwd: TOPO,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitOuNada(args) {
  try {
    return git(args).trim();
  } catch {
    return '';
  }
}

const commitDe = (rev) => gitOuNada(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
// Igual a scripts/ci/check-schema-expand-only.sh.
const basePadrao = () => gitOuNada(['merge-base', 'HEAD', 'origin/master']) || commitDe('HEAD~1');

// Lê várias versões de arquivo num processo só (`rev:caminho`); null = não existe.
function lerVersoes(specs) {
  if (!specs.length) return [];
  const r = spawnSync('git', ['cat-file', '--batch'], {
    cwd: TOPO,
    input: specs.join('\n') + '\n',
    maxBuffer: 1 << 30,
  });
  if (r.status !== 0) sair(1, `[pick] git cat-file falhou: ${String(r.stderr || r.error)}`);
  const buf = r.stdout;
  const out = [];
  let pos = 0;
  for (let i = 0; i < specs.length; i++) {
    const fim = buf.indexOf(10, pos);
    const cabecalho = buf.toString('utf8', pos, fim);
    pos = fim + 1;
    if (/ (missing|ambiguous)$/.test(cabecalho)) {
      out.push(null);
      continue;
    }
    const [, tipo, tamanho] = cabecalho.split(' ');
    const n = Number(tamanho);
    out.push(tipo === 'blob' ? buf.toString('utf8', pos, pos + n) : null);
    pos += n + 1;
  }
  return out;
}

const noEscopo = (arq) => !!arq && PASTAS.test(arq) && EXTENSOES.test(arq) && !FORA.some((re) => re.test(arq));

// [{ rotulo, antes, depois }]: caminho na base e no HEAD (null = não existe).
function arquivosAlterados(base, head) {
  const partes = git(['diff', '--name-status', '-z', '-M', '--no-ext-diff', base, head]).split('\0');
  const lista = [];
  for (let i = 0; i < partes.length - 1; ) {
    const status = partes[i];
    let antes;
    let depois;
    if (/^[RC]/.test(status)) {
      antes = status[0] === 'R' ? partes[i + 1] : null; // cópia: o original continua lá
      depois = partes[i + 2];
      i += 3;
    } else {
      antes = status === 'A' ? null : partes[i + 1];
      depois = status === 'D' ? null : partes[i + 1];
      i += 2;
    }
    antes = noEscopo(antes) ? antes : null;
    depois = noEscopo(depois) ? depois : null;
    if (!antes && !depois) continue;
    const rotulo = antes && depois && antes !== depois ? `${antes} → ${depois}` : depois || antes;
    lista.push({ rotulo, antes, depois });
  }
  return lista.sort((a, b) => (a.rotulo < b.rotulo ? -1 : a.rotulo > b.rotulo ? 1 : 0));
}

// ---------------------------------------------------------------- AST

function tipoScript(arq) {
  if (arq.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (arq.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(arq)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

// Posição de tipo: type, interface, anotação, `as`, argumento de tipo.
const ehTipo = (no) =>
  (no.kind >= ts.SyntaxKind.FirstTypeNode && no.kind <= ts.SyntaxKind.LastTypeNode) ||
  ts.isInterfaceDeclaration(no) ||
  ts.isTypeAliasDeclaration(no);

// O texto que o React RECEBE de um JsxText — a mesma regra do compilador
// (cleanJSXElementLiteralChild do Babel / fixupWhitespace do TypeScript): só o
// espaço colado a uma QUEBRA DE LINHA some; linhas em branco somem; as linhas
// restantes se juntam com um espaço. Espaço na mesma linha de um {expr} conta
// ('Olá, {nome}' ≠ 'Olá,{nome}'). Reformatar o JSX continua não contando.
function textoJsx(bruto) {
  const linhas = bruto.split(/\r\n|\n|\r/);
  let ultimaComTexto = 0;
  linhas.forEach((l, i) => {
    if (/[^ \t]/.test(l)) ultimaComTexto = i;
  });
  let saida = '';
  linhas.forEach((l, i) => {
    let t = l.replace(/\t/g, ' ');
    if (i !== 0) t = t.replace(/^ +/, '');
    if (i !== linhas.length - 1) t = t.replace(/ +$/, '');
    if (t) saida += i === ultimaComTexto ? t : `${t} `;
  });
  return decodificarEntidades(saida, 'texto');
}

// JSX decodifica entidades HTML (&quot; &amp; &nbsp; &#233; …) no texto e nos
// atributos entre aspas; string JS não. Para a comparação ver o que a tela
// mostra, a decodificação é a do próprio TypeScript (transpila um trecho mínimo).
const entidadesCache = new Map();
function decodificarEntidades(s, onde) {
  if (!s.includes('&')) return s;
  const chave = `${onde}\u0000${s}`;
  if (entidadesCache.has(chave)) return entidadesCache.get(chave);
  let decodificado = s;
  const aspas = s.includes('"') ? "'" : '"';
  const trecho =
    onde === 'texto'
      ? /[{}<>]/.test(s) ? null : `x = <>${s}</>;`
      : s.includes(aspas) ? null : `x = <a b=${aspas}${s}${aspas} />;`;
  if (trecho) {
    const saida = ts.transpileModule(trecho, {
      fileName: 'entidade.tsx',
      compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 },
      reportDiagnostics: false,
    }).outputText;
    const m = onde === 'texto' ? saida.match(/React\.Fragment, null, ("(?:[^"\\]|\\.)*")\)/) : saida.match(/\{ b: ("(?:[^"\\]|\\.)*") \}/);
    if (m) decodificado = JSON.parse(m[1]);
  }
  entidadesCache.set(chave, decodificado);
  return decodificado;
}

/**
 * clinica: Map texto → quantas vezes (fora da posição de laboratório).
 * lab: [{ texto, linha }] na posição de laboratório.
 * marcado: tem chamada pickBt ou const LAB_*.
 */
function analisar(arq, fonte) {
  const r = { marcado: false, clinica: new Map(), lab: [] };
  if (fonte == null) return r;
  const sf = ts.createSourceFile(arq, fonte, ts.ScriptTarget.Latest, true, tipoScript(arq));

  // import { pickBt as escolher } também vale.
  const seletores = new Set([SELETOR]);
  for (const st of sf.statements) {
    const nomes = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : undefined;
    if (nomes && ts.isNamedImports(nomes)) {
      for (const el of nomes.elements) if ((el.propertyName ?? el.name).text === SELETOR) seletores.add(el.name.text);
    }
  }
  const ehSeletor = (chamada) => {
    const e = chamada.expression;
    return (ts.isIdentifier(e) && seletores.has(e.text)) || (ts.isPropertyAccessExpression(e) && e.name.text === SELETOR);
  };
  const ehLab = (decl) =>
    ts.isIdentifier(decl.name) &&
    decl.name.text.startsWith(PREFIXO_LAB) &&
    (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const;

  const ignorar = new Set();
  const guardar = (texto, no, lab) => {
    if (!texto) return;
    if (lab) r.lab.push({ texto, linha: sf.getLineAndCharacterOfPosition(no.getStart(sf)).line + 1 });
    else r.clinica.set(texto, (r.clinica.get(texto) || 0) + 1);
  };
  const ignorarDiretivas = (instrucoes) => {
    for (const st of instrucoes) {
      if (!ts.isExpressionStatement(st) || !ts.isStringLiteral(st.expression)) break;
      ignorar.add(st.expression);
    }
  };

  function visitar(no, lab) {
    if (ignorar.has(no) || ehTipo(no)) return;
    // Especificadores de módulo (inclusive `import { 'a-b' as x }`).
    if (ts.isImportDeclaration(no) || ts.isExportDeclaration(no) || ts.isImportEqualsDeclaration(no)) return;
    if (ts.isModuleDeclaration(no) && ts.isStringLiteral(no.name)) ignorar.add(no.name);
    if (ts.isSourceFile(no) || (ts.isBlock(no) && no.parent && ts.isFunctionLike(no.parent))) ignorarDiretivas(no.statements);

    if (ts.isCallExpression(no)) {
      const e = no.expression;
      const [primeiro] = no.arguments;
      const ehModulo =
        e.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(e) && e.text === 'require') ||
        (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'require');
      if (ehModulo && primeiro && ts.isStringLiteralLike(primeiro)) ignorar.add(primeiro);
      if (ehSeletor(no)) {
        r.marcado = true;
        visitar(e, lab);
        no.arguments.forEach((arg, i) => visitar(arg, lab || i >= 2));
        return;
      }
    }
    if (ts.isVariableDeclaration(no) && ehLab(no)) {
      r.marcado = true;
      if (no.initializer) visitar(no.initializer, true);
      return;
    }

    if (ts.isStringLiteral(no) && no.parent && ts.isJsxAttribute(no.parent)) guardar(decodificarEntidades(no.text, 'atributo'), no, lab);
    else if (ts.isStringLiteral(no) || ts.isNoSubstitutionTemplateLiteral(no)) guardar(no.text ?? no.rawText, no, lab);
    else if (ts.isTemplateHead(no) || ts.isTemplateMiddle(no) || ts.isTemplateTail(no)) guardar(no.text ?? no.rawText, no, lab);
    else if (ts.isJsxText(no)) guardar(textoJsx(no.text), no, lab);
    ts.forEachChild(no, (filho) => visitar(filho, lab));
  }

  visitar(sf, false);
  return r;
}

function diferenca(antes, depois) {
  const entrou = [];
  const saiu = [];
  for (const t of new Set([...antes.keys(), ...depois.keys()])) {
    const d = (depois.get(t) || 0) - (antes.get(t) || 0);
    if (d > 0) entrou.push([t, d]);
    if (d < 0) saiu.push([t, -d]);
  }
  const ordem = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return { entrou: entrou.sort(ordem), saiu: saiu.sort(ordem) };
}

const mostrar = ([t, n]) => `${JSON.stringify(t)}${n > 1 ? ` (×${n})` : ''}`;

// ---------------------------------------------------------------- main

const arg = (process.argv[2] || '').trim();
let base;
if (!arg || arg === ZERO) {
  base = basePadrao();
} else {
  base = commitDe(arg);
  if (!base) {
    base = basePadrao();
    console.log(`[pick] base ${arg.slice(0, 8)} não existe neste clone — usando ${base ? base.slice(0, 8) : 'nada'}.`);
  }
}
if (!base) sair(0, '[pick] HEAD não tem commit anterior — nada a comparar.', '[pick] OK');
const head = commitDe('HEAD');
const b8 = base.slice(0, 8);

const SUMMARY = process.env.GITHUB_STEP_SUMMARY;
const resumo = (...linhas) => {
  if (SUMMARY) appendFileSync(SUMMARY, linhas.join('\n') + '\n');
};
resumo(`### Textos da clínica (pickBt) desde \`${b8}\``);

const arquivos = arquivosAlterados(base, head);
if (!arquivos.length) {
  resumo('Nenhum arquivo de código alterado em apps/ ou packages/.');
  sair(0, `[pick] OK — nenhum arquivo de código mudou em apps/ ou packages/ desde ${b8}.`);
}

const versoes = lerVersoes(
  arquivos.flatMap(({ antes, depois }) => [antes ? `${base}:${antes}` : '', depois ? `${head}:${depois}` : '']).filter(Boolean),
);
let k = 0;
const falhas1 = [];
const falhas2 = [];
let checados = 0;
for (const a of arquivos) {
  const fonteAntes = a.antes ? versoes[k++] : null;
  const fonteDepois = a.depois ? versoes[k++] : null;
  const antes = analisar(a.antes || a.depois, fonteAntes);
  const depois = analisar(a.depois || a.antes, fonteDepois);
  if (antes.marcado || depois.marcado) {
    checados++;
    const d = diferenca(antes.clinica, depois.clinica);
    if (d.entrou.length || d.saiu.length) falhas1.push({ rotulo: a.rotulo, ...d });
  }
  for (const { texto, linha } of depois.lab) {
    const termos = termosProibidos(texto);
    if (termos.length) falhas2.push(`${a.depois}:${linha}  ${JSON.stringify(texto)}  → ${termos.join(', ')}`);
  }
}

console.log(`[pick] ${arquivos.length} arquivo(s) de código alterado(s) desde ${b8}; ${checados} com pickBt/LAB_.`);
resumo(`${arquivos.length} arquivo(s) de código alterado(s); ${checados} com pickBt/LAB_.`);

let reprovou = false;
let liberado = '';

if (falhas1.length) {
  const linhas = falhas1.flatMap((f) => [
    `  ${f.rotulo}`,
    ...f.entrou.map((x) => `    entrou: ${mostrar(x)}`),
    ...f.saiu.map((x) => `    saiu:   ${mostrar(x)}`),
  ]);
  const escape = git(['log', '--format=%B', `${base}..${head}`])
    .split(/\r?\n/)
    .find((l) => /^texto-cl[ií]nica:\s*(.+)$/.test(l) && l.replace(/^texto-cl[ií]nica:/, '').trim().length >= 3);
  if (escape) {
    liberado = escape;
    console.log(`[pick] texto da clínica MUDOU — liberado pelo commit: ${escape}`);
    linhas.forEach((l) => console.log(l));
    resumo(`**Texto da clínica liberado** — ${escape}`, '```text', ...linhas, '```');
  } else {
    reprovou = true;
    console.log('[pick] BLOQUEADO — o texto da clínica mudou em arquivo com pickBt/LAB_:');
    linhas.forEach((l) => console.log(l));
    console.log(
      [
        '',
        'Num arquivo com pickBt/LAB_, o texto que a clínica vê tem de ficar idêntico.',
        '  - Texto de laboratório vai no textoLab — pickBt(bt, textoClinica, textoLab) — ou numa const LAB_*.',
        '  - Ao envolver um texto existente, copie-o igual (acento, espaço, pontuação) no textoClinica.',
        '  - Toda string do arquivo conta (inclusive chave, status, className): código novo com string aqui também cai nesta trava.',
        'Se a mudança no texto da clínica for de propósito, ponha no commit uma linha:  texto-clinica: <motivo>',
        '',
      ].join('\n'),
    );
    resumo('**BLOQUEADO:** o texto da clínica mudou em arquivo com pickBt/LAB_.', '```text', ...linhas, '```');
  }
}

if (falhas2.length) {
  reprovou = true;
  console.log('[pick] BLOQUEADO — texto de laboratório com vocabulário da clínica:');
  falhas2.forEach((l) => console.log(`  ${l}`));
  console.log(
    [
      '',
      'Troque pelo termo do laboratório (caso, pedido, trabalho, cliente...). Podem: "clínica", "dentista",',
      '"paciente do caso" e "consulta de crédito". Esta trava não tem escape.',
      '',
    ].join('\n'),
  );
  resumo('**BLOQUEADO:** texto de laboratório com vocabulário da clínica.', '```text', ...falhas2, '```');
}

if (reprovou) process.exit(1);

if (!checados) {
  resumo('OK — nenhum arquivo alterado tem pickBt/LAB_.');
  sair(0, '[pick] OK — nenhum arquivo alterado tem pickBt/LAB_.');
}
const fim = liberado
  ? 'mudança no texto da clínica liberada pelo commit; texto de laboratório sem termo clínico.'
  : 'texto da clínica intacto e texto de laboratório sem termo clínico.';
resumo(`OK — ${fim}`);
console.log(`[pick] OK — ${fim}`);
