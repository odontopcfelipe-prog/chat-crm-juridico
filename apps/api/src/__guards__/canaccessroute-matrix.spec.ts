/**
 * F0a — retrato de comportamento "clínica idêntica": acesso por tela.
 *
 * Congela em canaccessroute.matrix.json o que decide qual tela cada setor da
 * clínica abre (packages/shared/src/sectors.config.ts):
 *   - rotas:      tela × setor → canAccessRoute(tela, permissões padrão do setor)
 *   - papeis:     roles do JWT → setor (mapBackendRole)
 *   - permissoes: setor × permissão → está no pacote padrão do setor? Inclui as
 *                 linhas "(setor nulo)" e "(setor desconhecido)": o fallback do
 *                 getSector (hoje SECTORS[0] = recepção) para quem tem setor
 *                 vazio ou um id que não existe.
 *
 * As telas são as páginas de apps/web/src/app/atendimento (page.tsx) mais os
 * prefixos do ROUTE_ACCESS. As fases do laboratório não podem mudar nada disso
 * para as clínicas.
 *
 * Regras:
 *   - par que JÁ está no JSON e mudou de resultado → FALHA;
 *   - tela, setor, papel ou permissão nova/removida → só aviso (passa): no
 *     console.warn e, no GitHub Actions, no resumo do job ($GITHUB_STEP_SUMMARY),
 *     com o valor de cada setor para a tela nova;
 *   - GUARDS_UPDATE=1 regrava o JSON com o estado atual (e mostra o que mudou):
 *       cd apps/api && GUARDS_UPDATE=1 npx jest __guards__/canaccessroute
 *     O script raiz `npm run guards:update` deve rodar isto também.
 *
 * O spec lê o @crm/shared COMPILADO (dist): depois de mexer no sectors.config,
 * rode `npm run build -w @crm/shared` antes.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  canAccessRoute,
  mapBackendRole,
  PERMISSIONS,
  resolvePermissions,
  ROUTE_ACCESS,
  SECTORS,
} from '@crm/shared';

const ARQUIVO = path.join(__dirname, 'canaccessroute.matrix.json');
const PAGINAS_WEB = path.resolve(__dirname, '..', '..', '..', 'web', 'src', 'app', 'atendimento');
const ATUALIZAR = process.env.GUARDS_UPDATE === '1';
const COMANDO = 'npm run guards:update (ou, em apps/api: GUARDS_UPDATE=1 npx jest __guards__/canaccessroute)';
// Linhas extras do bloco permissoes: o que recebe quem tem setor nulo ou um id que não existe.
const SETOR_NULO = '(setor nulo)';
const SETOR_DESCONHECIDO = '(setor desconhecido)';

type Linha = Record<string, boolean>;
interface Matriz {
  _leia: string;
  setores: string[];
  rotas: Record<string, Linha>;
  papeis: Record<string, string>;
  permissoes: Record<string, Linha>;
}

// Papéis que o login emite e os apelidos que o mapBackendRole aceita, mais
// combinações que exercitam a prioridade (admin > dentista > acd_asb >
// financeiro > crc > recepcao). [] = usuário sem papel.
const PAPEIS_FIXOS: string[][] = [
  [],
  ['SUPER_ADMIN'], ['ADMIN'], ['DENTIST'], ['DENTISTA'], ['ACD'], ['ASB'], ['ACD_ASB'], ['AUXILIAR'],
  ['FINANCEIRO'], ['COMERCIAL'], ['ASSISTANT'], ['OPERADOR'], ['admin'], ['DESCONHECIDO'],
  ['ADMIN', 'DENTIST'], ['DENTIST', 'FINANCEIRO'], ['ACD', 'FINANCEIRO'], ['FINANCEIRO', 'COMERCIAL'],
  ['ASSISTANT', 'OPERADOR'], ['OPERADOR', 'DENTIST'],
];

/** Páginas do Next em /atendimento ("(grupo)" some da URL; "@slot" e "_privada" não são rota). */
function paginasDoWeb(): string[] {
  if (!fs.existsSync(PAGINAS_WEB)) {
    console.warn(`[guards] ${PAGINAS_WEB} não existe — matriz só com os prefixos do ROUTE_ACCESS.`);
    return [];
  }
  const rotas: string[] = [];
  const andar = (dir: string, segs: string[]) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name.startsWith('@') || e.name.startsWith('_') || e.name === 'node_modules') continue;
        const grupo = e.name.startsWith('(') && e.name.endsWith(')');
        andar(path.join(dir, e.name), grupo ? segs : [...segs, e.name]);
      } else if (/^page\.(tsx|ts|jsx|js|mdx)$/.test(e.name)) {
        rotas.push(['/atendimento', ...segs].join('/'));
      }
    }
  };
  andar(PAGINAS_WEB, []);
  return rotas;
}

function chavePapel(roles: string[]): string {
  return roles.length ? roles.join('+') : '(sem papel)';
}

function montarAtual(): Matriz {
  const setores = SECTORS.map((s) => s.id as string);
  const telas = [...new Set([...paginasDoWeb(), ...ROUTE_ACCESS.map((r) => r.path)])].sort();

  const rotas: Record<string, Linha> = {};
  for (const tela of telas) {
    const linha: Linha = {};
    for (const s of SECTORS) {
      const perms = resolvePermissions(s.id);
      linha[s.id] = canAccessRoute(tela, (p) => perms.has(p));
    }
    rotas[tela] = linha;
  }

  const papeis: Record<string, string> = {};
  const listas = [...PAPEIS_FIXOS, ...SECTORS.flatMap((s) => s.backendRoles.map((r) => [r]))];
  for (const roles of listas) papeis[chavePapel(roles)] = mapBackendRole(roles);

  const permissoes: Record<string, Linha> = {};
  const linhaDe = (perms: Set<string>): Linha => {
    const linha: Linha = {};
    for (const p of PERMISSIONS) linha[p.key] = perms.has(p.key);
    return linha;
  };
  for (const s of SECTORS) permissoes[s.id] = linhaDe(resolvePermissions(s.id));
  // Fallback do getSector: um setor novo na frente do SECTORS mudaria isto para
  // todo usuário com setor vazio/desconhecido — e aqui é par comparado (reprova).
  permissoes[SETOR_NULO] = linhaDe(resolvePermissions(null as any));
  permissoes[SETOR_DESCONHECIDO] = linhaDe(resolvePermissions('__desconhecido__' as any));

  return {
    _leia:
      'Retrato do acesso por tela das clínicas (F0a). Gerado por apps/api/src/__guards__/canaccessroute-matrix.spec.ts — ' +
      `não edite à mão. Para regravar: ${COMANDO}.`,
    setores,
    rotas,
    papeis,
    permissoes,
  };
}

/** JSON estável: uma linha por tela/setor, pra o diff do commit mostrar só o par que mudou. */
function serializar(m: Matriz): string {
  const bloco = (obj: Record<string, unknown>) =>
    Object.keys(obj)
      .map((k) => `    ${JSON.stringify(k)}: ${JSON.stringify(obj[k])}`)
      .join(',\n');
  const papeisOrdenados = Object.fromEntries(Object.keys(m.papeis).sort().map((k) => [k, m.papeis[k]]));
  return [
    '{',
    `  "_leia": ${JSON.stringify(m._leia)},`,
    `  "setores": ${JSON.stringify(m.setores)},`,
    '  "rotas": {',
    bloco(m.rotas),
    '  },',
    '  "papeis": {',
    bloco(papeisOrdenados),
    '  },',
    '  "permissoes": {',
    bloco(m.permissoes),
    '  }',
    '}',
    '',
  ].join('\n');
}

function lerSalvo(): Matriz | null {
  if (!fs.existsSync(ARQUIVO)) return null;
  return JSON.parse(fs.readFileSync(ARQUIVO, 'utf8')) as Matriz;
}

interface Comparacao {
  mudou: string[];
  novos: string[];
  removidos: string[];
}

/** Como mostrar, no aviso, o valor de uma linha ou coluna nova. */
interface Detalhe {
  linha: (l: Linha) => string;
  coluna: (col: string, atual: Record<string, Linha>) => string;
}

// rotas: tela nova mostra o valor de cada setor; setor novo, quais telas abre.
const DETALHE_ROTAS: Detalhe = {
  linha: (l) => Object.keys(l).map((k) => `${k}=${l[k]}`).join(' '),
  coluna: (col, atual) => {
    const telas = Object.keys(atual);
    const abre = telas.filter((t) => atual[t][col]);
    const lista = abre.length > 15 ? [...abre.slice(0, 15), `… +${abre.length - 15}`] : abre;
    return `abre ${abre.length} de ${telas.length} telas${abre.length ? ': ' + lista.join(', ') : ''}`;
  },
};
// permissoes: setor novo mostra o pacote; permissão nova, quais setores a têm.
const DETALHE_PERMISSOES: Detalhe = {
  linha: (l) => `com: ${Object.keys(l).filter((k) => l[k]).join(', ') || 'nenhuma'}`,
  coluna: (col, atual) => `setores com ela: ${Object.keys(atual).filter((s) => atual[s][col]).join(', ') || 'nenhum'}`,
};

/**
 * Compara pares (linha × coluna). Só par cuja linha E coluna existem nos dois
 * lados conta como mudança; linha ou coluna nova/removida é avisada uma vez.
 */
function compararPares(
  bloco: string,
  nomeLinha: string,
  nomeColuna: string,
  salvo: Record<string, Linha>,
  atual: Record<string, Linha>,
  detalhe: Detalhe,
  out: Comparacao,
) {
  const colunas = (m: Record<string, Linha>) => new Set(Object.values(m).flatMap((l) => Object.keys(l)));
  const colSalvo = colunas(salvo);
  const colAtual = colunas(atual);
  for (const c of colAtual) {
    if (!colSalvo.has(c)) out.novos.push(`${bloco}: ${nomeColuna} ${c} (${detalhe.coluna(c, atual)})`);
  }
  for (const c of colSalvo) if (!colAtual.has(c)) out.removidos.push(`${bloco}: ${nomeColuna} ${c}`);
  for (const linha of Object.keys(atual)) {
    if (!(linha in salvo)) {
      out.novos.push(`${bloco}: ${nomeLinha} ${linha} (${detalhe.linha(atual[linha])})`);
      continue;
    }
    for (const col of Object.keys(atual[linha])) {
      if (!(col in salvo[linha])) continue;
      if (salvo[linha][col] !== atual[linha][col]) {
        out.mudou.push(`${bloco}: ${linha} × ${col} era ${salvo[linha][col]}, agora ${atual[linha][col]}`);
      }
    }
  }
  for (const linha of Object.keys(salvo)) {
    if (!(linha in atual)) out.removidos.push(`${bloco}: ${nomeLinha} ${linha}`);
  }
}

function comparar(salvo: Matriz, atual: Matriz): Comparacao {
  const out: Comparacao = { mudou: [], novos: [], removidos: [] };
  // Nas rotas as colunas são os setores; nas permissões, as linhas.
  compararPares('rotas', 'tela', 'setor', salvo.rotas ?? {}, atual.rotas, DETALHE_ROTAS, out);
  compararPares('permissoes', 'setor', 'permissão', salvo.permissoes ?? {}, atual.permissoes, DETALHE_PERMISSOES, out);
  // A ordem dos setores decide o fallback do getSector. O efeito já é par comparado
  // (linhas "(setor nulo)" e "(setor desconhecido)"); aqui é só aviso.
  const comuns = (de: string[], em: string[]) => de.filter((s) => em.includes(s));
  const ordemSalva = comuns(salvo.setores ?? [], atual.setores);
  const ordemAtual = comuns(atual.setores, salvo.setores ?? []);
  if (ordemSalva.join(',') !== ordemAtual.join(',')) {
    out.novos.push(`setores: ordem mudou (${ordemSalva.join(', ')} → ${ordemAtual.join(', ')})`);
  }
  const papeisSalvos = salvo.papeis ?? {};
  for (const k of Object.keys(atual.papeis)) {
    if (!(k in papeisSalvos)) out.novos.push(`papeis: ${k} → ${atual.papeis[k]}`);
    else if (papeisSalvos[k] !== atual.papeis[k]) {
      out.mudou.push(`papeis: ${k} ia para o setor ${papeisSalvos[k]}, agora vai para ${atual.papeis[k]}`);
    }
  }
  for (const k of Object.keys(papeisSalvos)) {
    if (!(k in atual.papeis)) out.removidos.push(`papeis: ${k}`);
  }
  return out;
}

/**
 * No GitHub Actions, acrescenta as linhas ao resumo do job (mesmo padrão do
 * check-schema-expand-only.sh). Fora dele, não faz nada.
 */
function noResumoDoJob(titulo: string, linhas: string[]) {
  const arquivo = process.env.GITHUB_STEP_SUMMARY;
  if (!arquivo || !linhas.length) return;
  try {
    fs.appendFileSync(arquivo, `### ${titulo}\n\n${linhas.map((l) => `- \`${l}\``).join('\n')}\n\n`, 'utf8');
  } catch (e: any) {
    console.warn(`[guards] não consegui escrever no resumo do job: ${e?.message}`);
  }
}

describe('retrato: acesso por tela × setor das clínicas (F0a)', () => {
  const atual = montarAtual();

  it('a matriz encontrou as telas do web e os 6 setores de hoje', () => {
    // Sanidade do gerador: sem isto, um caminho errado geraria matriz vazia e o
    // spec passaria sem comparar nada.
    expect(paginasDoWeb().length).toBeGreaterThan(20);
    expect(Object.keys(atual.rotas).length).toBeGreaterThan(ROUTE_ACCESS.length);
    expect(atual.rotas['/atendimento']).toBeDefined();
    expect(atual.setores).toEqual(expect.arrayContaining(['recepcao', 'dentista', 'acd_asb', 'crc', 'financeiro', 'admin']));
    expect(Object.keys(atual.permissoes)).toEqual(expect.arrayContaining([SETOR_NULO, SETOR_DESCONHECIDO]));
  });

  it('nenhum par (tela, setor), (papel → setor) ou (setor, permissão) já retratado mudou', () => {
    const salvo = lerSalvo();

    if (ATUALIZAR) {
      if (salvo) {
        const c = comparar(salvo, atual);
        const linhas = [...c.mudou.map((x) => `MUDOU ${x}`), ...c.novos.map((x) => `NOVO ${x}`), ...c.removidos.map((x) => `SAIU ${x}`)];
        console.log(`[guards] canaccessroute.matrix.json regravado.${linhas.length ? '\n' + linhas.join('\n') : ' Sem diferenças.'}`);
      } else {
        console.log('[guards] canaccessroute.matrix.json criado.');
      }
      fs.writeFileSync(ARQUIVO, serializar(atual), 'utf8');
      return;
    }

    if (!salvo) {
      throw new Error(`canaccessroute.matrix.json não existe. Gere com: ${COMANDO}`);
    }

    const c = comparar(salvo, atual);
    if (c.novos.length || c.removidos.length) {
      const linhas = [...c.novos.map((x) => `+ ${x}`), ...c.removidos.map((x) => `- ${x}`)];
      console.warn(
        `[guards] Matriz de acesso por tela desatualizada (não é erro). Rode ${COMANDO} e commite o JSON.\n` +
          linhas.map((x) => `  ${x}`).join('\n'),
      );
      noResumoDoJob(`Matriz de acesso por tela: desatualizada (aviso, não reprova). Rode ${COMANDO}`, linhas);
    }
    if (c.mudou.length) {
      noResumoDoJob('Matriz de acesso por tela: MUDOU para as clínicas (reprovado)', c.mudou.map((x) => `* ${x}`));
      throw new Error(
        'O acesso por tela das clínicas mudou (as fases do laboratório não podem mudar isso):\n' +
          c.mudou.map((x) => `  * ${x}`).join('\n') +
          `\nSe a mudança é de propósito (decisão do dono para as clínicas), rode ${COMANDO} e commite o JSON junto.`,
      );
    }
  });
});
