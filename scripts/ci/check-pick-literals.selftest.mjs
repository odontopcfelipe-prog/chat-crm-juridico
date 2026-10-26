#!/usr/bin/env node
/**
 * Teste do scripts/ci/check-pick-literals.mjs (trava "textos da clínica
 * intactos"). Roda antes do checker no CI: se a trava parar de pegar o que
 * deve (ou começar a barrar o que não deve), o passo fica vermelho aqui, e não
 * no dia em que um texto da clínica mudar sem ninguém ver.
 *
 * Cada caso cria um repositório git descartável em os.tmpdir() (commit base,
 * altera, commit head), roda o checker com o cwd lá dentro e confere o código
 * de saída e trechos da saída. O git roda isolado da configuração do usuário
 * (sem gitconfig global/de sistema), com nome/e-mail locais de exemplo.
 * Fixtures só com dados óbvios de exemplo ("Clínica Exemplo").
 *
 * Uso: node scripts/ci/check-pick-literals.selftest.mjs
 *      (PICK_SELFTEST_MANTER=1 mantém os repositórios temporários.)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-pick-literals.mjs');
const ZERO = '0'.repeat(40);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-selftest-'));
const GITCONFIG_VAZIO = path.join(TMP, 'gitconfig-vazio');
fs.writeFileSync(GITCONFIG_VAZIO, '');

// Nada do ambiente de fora (GIT_DIR de um hook, resumo do Actions) vaza para cá.
const ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'GITHUB_STEP_SUMMARY'),
);
Object.assign(ENV, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: GITCONFIG_VAZIO, GIT_TERMINAL_PROMPT: '0' });

const git = (dir, ...args) =>
  execFileSync('git', args, { cwd: dir, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let n = 0;
function novoRepo() {
  const dir = path.join(TMP, `repo-${++n}`);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'Selftest pick');
  git(dir, 'config', 'user.email', 'selftest@example.invalid');
  git(dir, 'config', 'core.autocrlf', 'false');
  return dir;
}

// arquivos: { caminho: conteúdo | null (apaga) }. Devolve o sha do commit.
function commit(dir, arquivos, msg = 'teste') {
  for (const [rel, conteudo] of Object.entries(arquivos)) {
    const p = path.join(dir, rel);
    if (conteudo === null) fs.rmSync(p);
    else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, conteudo);
    }
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

// ---------------------------------------------------------------- fixtures

const AVISO = 'apps/api/src/avisos/confirmacao.ts';
const avisoComPick = (clinica) => `import { pickBt } from '@crm/shared';

export function confirmacao(bt: string, nome: string) {
  return pickBt(
    bt,
    \`Olá, \${nome}! ${clinica} da sua consulta na Clínica Exemplo.\`,
    \`Olá, \${nome}! O caso foi recebido no laboratório.\`,
  );
}
`;

const CABECALHO = 'apps/web/src/app/agenda/Cabecalho.tsx';
const cabecalho = (titulo) => `import { pickBt } from '@crm/shared';

export function Cabecalho({ bt }: { bt: string }) {
  return (
    <header>
      <h1>${titulo}</h1>
      <p>{pickBt(bt, 'Nenhum horário marcado', 'Nenhuma entrega marcada')}</p>
    </header>
  );
}
`;

// ---------------------------------------------------------------- casos

// montar(repo) → argumentos do checker. esperado = código de saída.
const casos = [
  {
    nome: '(a) trocar um acento no textoClinica do pickBt reprova',
    montar(r) {
      commit(r, { [AVISO]: avisoComPick('Confirmação') });
      commit(r, { [AVISO]: avisoComPick('Confirmacao') });
      return [];
    },
    esperado: 1,
    contem: [
      'BLOQUEADO — o texto da clínica mudou',
      AVISO,
      'entrou: "! Confirmacao da sua consulta na Clínica Exemplo."',
      'saiu:   "! Confirmação da sua consulta na Clínica Exemplo."',
      'texto-clinica: <motivo>',
    ],
  },
  {
    nome: "(b) const LAB_X = 'Sua consulta com o dentista' reprova",
    montar(r) {
      commit(r, { 'apps/worker/src/leia-me.ts': "export const x = 1;\n" });
      commit(r, { 'apps/worker/src/lab/textos.ts': "export const LAB_LEMBRETE = 'Sua consulta com o dentista';\n" });
      return [];
    },
    esperado: 1,
    contem: ['BLOQUEADO — texto de laboratório com vocabulário da clínica', 'apps/worker/src/lab/textos.ts:1', 'consulta(s)'],
    naoContem: ['o texto da clínica mudou'],
  },
  {
    nome: '(b2) a trava 2 não tem escape (texto-clinica: no commit não libera)',
    montar(r) {
      commit(r, { 'apps/worker/src/leia-me.ts': "export const x = 1;\n" });
      commit(
        r,
        { 'apps/worker/src/lab/textos.ts': "export const LAB_LEMBRETE = 'Sua consulta com o dentista';\n" },
        'feat: textos\n\ntexto-clinica: tentando liberar',
      );
      return [];
    },
    esperado: 1,
    contem: ['vocabulário da clínica', 'consulta(s)', 'não tem escape'],
  },
  {
    nome: "(c) envolver um texto existente em pickBt(bt, 'mesmo texto', 'Texto do lab') passa",
    montar(r) {
      const f = 'apps/api/src/pedidos/aviso.ts';
      commit(r, { [f]: "export function aviso(bt: string) {\n  return 'Seu horário está confirmado.';\n}\n" });
      commit(r, {
        [f]: "import { pickBt } from '@crm/shared';\n\nexport function aviso(bt: string) {\n  return pickBt(bt, 'Seu horário está confirmado.', 'Texto do lab');\n}\n",
      });
      return [];
    },
    esperado: 0,
    contem: ['1 com pickBt/LAB_', '[pick] OK'],
  },
  {
    nome: "(d) 'paciente do caso', 'consulta de crédito', clínica e dentista passam em texto de lab",
    montar(r) {
      const f = 'apps/api/src/casos/rotulo.ts';
      commit(r, { [f]: "export const rotulo = (bt: string) => 'Nome do paciente';\n" });
      commit(r, {
        [f]: "import { pickBt } from '@crm/shared';\nexport const rotulo = (bt: string) => pickBt(bt, 'Nome do paciente', 'Nome do paciente do caso');\n",
        'packages/shared/src/lab-textos.ts': [
          'export const LAB_TEXTOS = {',
          "  credito: 'CONSULTA DE CRÉDITO aprovada',",
          "  clientes: 'A clínica e o dentista acompanham o pedido',",
          '  caso: (nome: string) => `Paciente do caso: ${nome}`,',
          "  verbo: 'Consultar o pedido no consultório do dentista',",
          '};',
          '',
        ].join('\n'),
      });
      return [];
    },
    esperado: 0,
    contem: ['2 com pickBt/LAB_', '[pick] OK'],
  },
  {
    nome: '(e) mudar texto em arquivo sem pickBt/LAB_ passa',
    montar(r) {
      const f = 'apps/web/src/components/Saudacao.tsx';
      commit(r, { [f]: "export const Saudacao = () => <p className=\"a\">Olá, tudo bem?</p>;\n" });
      commit(r, { [f]: "export const Saudacao = () => <p className=\"b\">Oi, tudo certo? Sua consulta é amanhã.</p>;\n" });
      return [];
    },
    esperado: 0,
    contem: ['[pick] OK — nenhum arquivo alterado tem pickBt/LAB_'],
  },
  {
    nome: '(f) o caso (a) com a linha texto-clinica: no commit passa e fica no resumo',
    resumo: true,
    montar(r) {
      commit(r, { [AVISO]: avisoComPick('Confirmação') });
      commit(
        r,
        { [AVISO]: avisoComPick('Confirmacao') },
        'fix(avisos): acento\n\ntexto-clinica: grafia pedida pela Clínica Exemplo',
      );
      return [];
    },
    esperado: 0,
    contem: ['liberado pelo commit: texto-clinica: grafia pedida pela Clínica Exemplo', 'entrou: "! Confirmacao', '[pick] OK'],
    resumoContem: ['**Texto da clínica liberado** — texto-clinica: grafia pedida', 'saiu:   "! Confirmação'],
  },
  {
    nome: '(f2) motivo com menos de 3 letras não vale como escape',
    montar(r) {
      commit(r, { [AVISO]: avisoComPick('Confirmação') });
      commit(r, { [AVISO]: avisoComPick('Confirmacao') }, 'fix\n\ntexto-clinica: ok');
      return [];
    },
    esperado: 1,
    contem: ['BLOQUEADO — o texto da clínica mudou'],
  },
  {
    nome: '(g) arquivo novo com pickBt cujo textoClinica é texto novo reprova',
    montar(r) {
      commit(r, { 'apps/api/src/leia-me.ts': 'export const x = 1;\n' });
      commit(r, {
        'apps/api/src/novo/aviso.ts':
          "import { pickBt } from '@crm/shared';\nexport const aviso = (bt: string) => pickBt(bt, 'Texto novo da clínica', 'Texto novo do laboratório');\n",
      });
      return [];
    },
    esperado: 1,
    contem: ['apps/api/src/novo/aviso.ts', 'entrou: "Texto novo da clínica"'],
    naoContem: ['Texto novo do laboratório'],
  },
  {
    nome: '(h) TSX: JsxText alterado no mesmo arquivo de um pickBt reprova',
    montar(r) {
      commit(r, { [CABECALHO]: cabecalho('Agenda do dia') });
      commit(r, { [CABECALHO]: cabecalho('Agenda de hoje') });
      return [];
    },
    esperado: 1,
    contem: [CABECALHO, 'entrou: "Agenda de hoje"', 'saiu:   "Agenda do dia"'],
  },
  {
    nome: "(h2) JSX: 'Olá, {nome}' virar pickBt(bt, 'Olá,') + {nome} perde o espaço e reprova",
    montar(r) {
      const f = 'apps/web/src/components/Ola.tsx';
      commit(r, { [f]: 'export const Ola = ({ nome }: { nome: string }) => <p>Olá, {nome}!</p>;\n' });
      commit(r, {
        [f]: "import { pickBt } from '@crm/shared';\nexport const Ola = ({ bt, nome }: { bt: string; nome: string }) => <p>{pickBt(bt, 'Olá,', 'Oi,')}{nome}!</p>;\n",
      });
      return [];
    },
    esperado: 1,
    contem: ['entrou: "Olá,"', 'saiu:   "Olá, "'],
  },
  {
    nome: "(h3) JSX: o envolvimento certo, pickBt(bt, 'Olá, ', …), passa",
    montar(r) {
      const f = 'apps/web/src/components/Ola.tsx';
      commit(r, { [f]: 'export const Ola = ({ nome }: { nome: string }) => <p>Olá, {nome}!</p>;\n' });
      commit(r, {
        [f]: "import { pickBt } from '@crm/shared';\nexport const Ola = ({ bt, nome }: { bt: string; nome: string }) => <p>{pickBt(bt, 'Olá, ', 'Oi, ')}{nome}!</p>;\n",
      });
      return [];
    },
    esperado: 0,
    contem: ['[pick] OK'],
  },
  {
    nome: '(h4) JSX: tirar o espaço entre duas expressões reprova',
    montar(r) {
      const f = 'apps/web/src/components/Par.tsx';
      const com = (meio) => `import { pickBt } from '@crm/shared';\nexport const Par = ({ bt, a, b }: { bt: string; a: string; b: string }) => <p>{pickBt(bt, 'Paciente:', 'Caso:')}${meio}</p>;\n`;
      commit(r, { [f]: com(' {a} {b}') });
      commit(r, { [f]: com('{a}{b}') });
      return [];
    },
    esperado: 1,
    contem: ['saiu:   " "'],
  },
  {
    nome: '(h5) JSX: &quot; copiado cru para o pickBt reprova (a tela mostraria &quot;)',
    montar(r) {
      const f = 'apps/web/src/components/Busca.tsx';
      commit(r, { [f]: 'export const Busca = ({ s }: { s: string }) => <p>Nenhum resultado para &quot;{s}&quot;</p>;\n' });
      commit(r, {
        [f]: "import { pickBt } from '@crm/shared';\nexport const Busca = ({ bt, s }: { bt: string; s: string }) => <p>{pickBt(bt, 'Nenhum resultado para &quot;', 'Nada para \"')}{s}&quot;</p>;\n",
      });
      return [];
    },
    esperado: 1,
    contem: ['entrou: "Nenhum resultado para &quot;"', 'saiu:   "Nenhum resultado para \\""'],
  },
  {
    nome: '(h6) JSX: a mesma busca com a aspa de verdade passa; atributo com entidade também',
    montar(r) {
      const f = 'apps/web/src/components/Busca.tsx';
      commit(r, {
        [f]: 'export const Busca = ({ s }: { s: string }) => <p title="Busca &amp; filtro">Nenhum resultado para &quot;{s}&quot;</p>;\n',
      });
      commit(r, {
        [f]: "import { pickBt } from '@crm/shared';\nexport const Busca = ({ bt, s }: { bt: string; s: string }) => <p title={'Busca & filtro'}>{pickBt(bt, 'Nenhum resultado para \"', 'Nada para \"')}{s}&quot;</p>;\n",
      });
      return [];
    },
    esperado: 0,
    contem: ['[pick] OK'],
  },
  {
    nome: "(i) 'use client', import novo, tipo literal e JSX reformatado não contam",
    montar(r) {
      commit(r, { [CABECALHO]: cabecalho('Agenda do dia') });
      commit(r, {
        [CABECALHO]: `'use client';
import { useState } from 'react';
import { pickBt } from '@crm/shared';

type Bt = 'CLINICA' | 'LABORATORIO';

export function Cabecalho({ bt }: { bt: Bt }) {
  return (
    <header>
      <h1>
        Agenda
        do dia
      </h1>
      <p>{pickBt<string>(bt, 'Nenhum horário marcado', 'Nenhuma entrega marcada')}</p>
    </header>
  );
}
`,
      });
      return [];
    },
    esperado: 0,
    contem: ['[pick] OK — texto da clínica intacto'],
  },
  {
    nome: '(j) trava 2 pega termo sem acento/maiúscula, em objeto, array e template',
    montar(r) {
      commit(r, { 'apps/api/src/leia-me.ts': 'export const x = 1;\n' });
      commit(r, {
        'apps/api/src/lab/fichas.ts': [
          'export const LAB_FICHA = {',
          "  titulo: 'PRONTUÁRIO do caso',",
          "  itens: ['Ficha de Anamnese', `Plano  de",
          'tratamento ${1}`],',
          '  rodape: { termo: `TCLE assinado`, mapa: "Odontogramas" },',
          "  ok: 'Consultar o pedido',",
          '};',
          "export const LAB_TRAT = 'Tratamento Odontológico completo';",
          '',
        ].join('\n'),
      });
      return [];
    },
    esperado: 1,
    contem: [
      'fichas.ts:2  "PRONTUÁRIO do caso"  → prontuário(s)',
      'fichas.ts:3  "Ficha de Anamnese"  → anamnese(s)',
      'plano de tratamento',
      'fichas.ts:5  "TCLE assinado"  → TCLE',
      'odontograma(s)',
      'fichas.ts:8  "Tratamento Odontológico completo"  → tratamento odontológico',
    ],
    naoContem: ['Consultar o pedido'],
  },
  {
    nome: '(k) desfazer o pickBt mantendo o textoClinica passa',
    montar(r) {
      commit(r, { [CABECALHO]: cabecalho('Agenda do dia') });
      commit(r, {
        [CABECALHO]: cabecalho('Agenda do dia')
          .replace("import { pickBt } from '@crm/shared';\n\n", '')
          .replace("{pickBt(bt, 'Nenhum horário marcado', 'Nenhuma entrega marcada')}", "{'Nenhum horário marcado'}"),
      });
      return [];
    },
    esperado: 0,
    contem: ['1 com pickBt/LAB_', '[pick] OK'],
  },
  {
    nome: '(l) spec, scripts/ e dist/ ficam fora',
    montar(r) {
      commit(r, { 'apps/api/src/leia-me.ts': 'export const x = 1;\n' });
      const lab = "export const LAB_X = 'Paciente na consulta';\n";
      commit(r, {
        'apps/api/src/lab/x.spec.ts': lab,
        'apps/web/src/lab/x.test.tsx': lab,
        'apps/api/dist/lab/x.js': lab,
        'apps/api/src/__guards__/x.ts': lab,
        'scripts/lab/x.ts': lab,
        'apps/api/src/lab/x.md': lab,
      });
      return [];
    },
    esperado: 0,
    contem: ['[pick] OK — nenhum arquivo de código mudou'],
  },
  {
    nome: '(m) renomear arquivo com pickBt sem mexer no texto passa',
    montar(r) {
      commit(r, { [AVISO]: avisoComPick('Confirmação') });
      commit(r, { [AVISO]: null, 'apps/api/src/avisos/confirmacao-consulta.ts': avisoComPick('Confirmação') });
      return [];
    },
    // Sem a detecção de rename seriam dois arquivos (um apagado, um novo) e reprovaria.
    esperado: 0,
    contem: ['1 com pickBt/LAB_', '[pick] OK'],
  },
  {
    nome: '(n) apagar arquivo com pickBt reprova (texto da clínica saiu) — pede o escape',
    montar(r) {
      commit(r, { [AVISO]: avisoComPick('Confirmação'), 'apps/api/src/leia-me.ts': 'export const x = 1;\n' });
      commit(r, { [AVISO]: null });
      return [];
    },
    esperado: 1,
    contem: ['saiu:   "! Confirmação da sua consulta na Clínica Exemplo."', 'texto-clinica: <motivo>'],
  },
  {
    nome: '(o) apelido do import e pickBt por namespace também são posição de lab',
    montar(r) {
      const f = 'apps/worker/src/avisos/chegada.ts';
      commit(r, { [f]: "export const a = (bt: string) => 'Olá';\nexport const b = (bt: string) => 'Até logo';\n" });
      commit(r, {
        [f]: [
          "import { pickBt as escolher } from '@crm/shared';",
          "import * as shared from '@crm/shared';",
          "export const a = (bt: string) => escolher(bt, 'Olá', 'Seu paciente chegou');",
          "export const b = (bt: string) => shared.pickBt(bt, 'Até logo', 'Nova consulta marcada');",
          '',
        ].join('\n'),
      });
      return [];
    },
    esperado: 1,
    contem: ['chegada.ts:3  "Seu paciente chegou"  → paciente(s)', 'chegada.ts:4  "Nova consulta marcada"  → consulta(s)'],
    naoContem: ['o texto da clínica mudou'],
  },
  {
    nome: '(p) base explícita pega todos os commits desde ela',
    montar(r) {
      const sha = commit(r, { [AVISO]: avisoComPick('Confirmação') });
      commit(r, { [AVISO]: avisoComPick('Confirmacao') });
      commit(r, { 'apps/api/src/leia-me.ts': 'export const x = 2;\n' });
      return [sha];
    },
    esperado: 1,
    contem: ['entrou: "! Confirmacao'],
  },
  {
    nome: '(q) base de 40 zeros cai no commit anterior (sem origin/master)',
    montar(r) {
      commit(r, { [AVISO]: avisoComPick('Confirmação') });
      commit(r, { [AVISO]: avisoComPick('Confirmacao') });
      commit(r, { 'apps/api/src/leia-me.ts': 'export const x = 2;\n' });
      return [ZERO];
    },
    esperado: 0,
    contem: ['[pick] OK — nenhum arquivo alterado tem pickBt/LAB_'],
  },
];

// ---------------------------------------------------------------- roda

let falhas = 0;
for (const caso of casos) {
  const repo = novoRepo();
  const erros = [];
  let saida = '';
  let resumo = '';
  try {
    const args = caso.montar(repo);
    const env = { ...ENV };
    const arqResumo = path.join(TMP, `resumo-${n}.md`);
    if (caso.resumo) env.GITHUB_STEP_SUMMARY = arqResumo;
    const r = spawnSync(process.execPath, [CHECKER, ...args], { cwd: repo, env, encoding: 'utf8' });
    saida = `${r.stdout || ''}${r.stderr || ''}`;
    if (caso.resumo) resumo = fs.existsSync(arqResumo) ? fs.readFileSync(arqResumo, 'utf8') : '';
    if (r.status !== caso.esperado) erros.push(`saída ${r.status}, esperado ${caso.esperado}`);
    for (const t of caso.contem || []) if (!saida.includes(t)) erros.push(`faltou na saída: ${t}`);
    for (const t of caso.naoContem || []) if (saida.includes(t)) erros.push(`não devia estar na saída: ${t}`);
    for (const t of caso.resumoContem || []) if (!resumo.includes(t)) erros.push(`faltou no resumo: ${t}`);
  } catch (e) {
    erros.push(`erro ao montar o caso: ${e.message}`);
  }
  if (erros.length) {
    falhas++;
    console.log(`✗ ${caso.nome}`);
    for (const e of erros) console.log(`    ${e}`);
    console.log(saida.replace(/^/gm, '    | '));
  } else {
    console.log(`✓ ${caso.nome}`);
  }
}

const manter = falhas > 0 || process.env.PICK_SELFTEST_MANTER === '1';
if (manter) console.log(`[pick-selftest] repositórios temporários em ${TMP}`);
else fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });

console.log(`[pick-selftest] ${casos.length - falhas}/${casos.length} casos OK`);
process.exit(falhas ? 1 : 0);
