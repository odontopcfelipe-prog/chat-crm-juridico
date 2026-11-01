/**
 * F6 do laboratório — painel "Orçamentos de trabalho" (/atendimento/orcamentos),
 * modelos de orçamento (settings/quote-templates), item do menu e atalhos do Início.
 *
 * Esses arquivos da clínica ganham só portão e texto importado
 * (`lab ? LAB_X.y : 'texto de hoje'`), sem pickBt nem const LAB_. Por isso a trava 1
 * de scripts/ci/check-pick-literals.mjs não os enxerga, e este spec faz a guarda:
 *   - os textos e trechos da clínica que a F6 envolveu continuam no arquivo com a
 *     mesma contagem do commit de partida (d2147294);
 *   - o hook do tipo de conta fica no topo do componente (antes de qualquer return);
 *   - os textos novos do laboratório não têm palavra de clínica;
 *   - o menu e o Início do laboratório ganham as duas entradas do painel.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { temPalavraDeClinica } from '../business-type/lab-vocab.interceptor';

const RAIZ = path.resolve(__dirname, '..', '..', '..', '..');
const ler = (arq: string): string => {
  const p = path.join(RAIZ, arq);
  if (!fs.existsSync(p)) throw new Error(`${arq} não existe`);
  return fs.readFileSync(p, 'utf8');
};

const PAINEL = 'apps/web/src/app/atendimento/orcamentos/page.tsx';
const PAINEL_TEXTOS = 'apps/web/src/app/atendimento/orcamentos/lab-orcamentos-textos.ts';
const MODELOS = 'apps/web/src/app/atendimento/settings/quote-templates/page.tsx';
const FICHA_IDS = 'apps/web/src/app/atendimento/pacientes/lab-ficha.ts';
const CONFIG_TEXTOS = 'apps/web/src/app/atendimento/settings/lab-config-textos.ts';
const SIDEBAR = 'apps/web/src/components/Sidebar.tsx';
const CASCA_TEXTOS = 'apps/web/src/lib/lab-casca-textos.ts';
const INICIO = 'apps/web/src/components/home/LabInicio.tsx';

/**
 * Textos (string, partes fixas de template e texto de JSX, com espaços juntados e
 * aparados) e trechos crus de código da clínica, com a contagem de d2147294.
 */
const CLINICA: Record<string, { textos: Array<[string, number]>; trechos: Array<[string, number]> }> = {
  [PAINEL]: {
    textos: [
      ['Sem dentista atribuído', 1],
      ['Enviar orçamento de', 1],
      ['via WhatsApp?', 1],
      ['paciente', 1],
      ['Propostas', 4],
      ['Avaliação', 2],
      ['aprovadas — quem fechou, por ordem. Clique na ficha pra agendar a consulta e não perder ninguém.', 1],
      ['a fazer — rascunhos a montar e enviados aguardando a decisão do paciente. Clique no paciente pra aprovar.', 1],
      ['Funil comercial. Acompanhe as avaliações: rascunhos, aceitações e taxa de conversão.', 1],
      ['Avaliações realizadas', 1],
      ['pacientes únicos com orçamento', 1],
      ['aceita + plano ativado', 1],
      ['Buscar por paciente, telefone ou CPF...', 1],
      ['Nenhum dentista (sem orçamentos)', 1],
      ['Todos os dentistas (', 1],
      ['Limpar filtro de dentista', 1],
      ['Venda', 1],
      ['Paciente', 1],
      ['Abrir as propostas pra aprovar', 1],
      ['Abrir a avaliação do paciente', 2],
      ['Abrir a ficha do paciente pra agendar', 1],
      ['Abrir a negociação (aba Propostas do paciente)', 1],
      ['Ver ficha', 1],
      ['Ver negociação', 1],
      ['Ver avaliação', 1],
      ['odontogram', 2],
    ],
    trechos: [
      ['#{q.id.slice(0, 6).toUpperCase()}', 1],
      ["`/atendimento/pacientes/${q.patient.id}?tab=${isPropostas ? 'proposals' : 'odontogram'}`", 2],
      ["`Enviar orçamento de ${formatBRL(q.total_value)} pra ${q.patient.name || 'paciente'} via WhatsApp?`", 1],
      ['`Todos os dentistas (${dentists.length})`', 1],
      ['router.push(`/atendimento/pacientes/${q.patient.id}?tab=financial`)', 1],
    ],
  },
  [MODELOS]: {
    textos: [
      ['Modelos de Orçamento', 1],
      [
        'Cestas pré-prontas de procedimentos por especialidade. Operador clica "Usar modelo" no orçamento e ganha minutos de cadastro.',
        1,
      ],
      ['procedimento(s)', 1],
      ['Ex: Implante unitário completo', 1],
      ['Especialidade (tag)', 1],
      ['Ex: Implante, Estética, Endodontia', 1],
      ['Modelo ativo (operador pode usar)', 1],
      ['Procedimentos', 1],
      ['Nenhum procedimento. Adicione pelo menos 1 pra o modelo ser útil.', 1],
      ['Selecione procedimento', 1],
      ['Deixe vazio pra usar preço base do procedimento', 1],
    ],
    trechos: [],
  },
  [SIDEBAR]: {
    textos: [
      ['Avaliação', 1],
      ['Propostas', 1],
    ],
    trechos: [
      ['// allItems.orcamentos,           // Avaliação (orcamentos)', 1],
      ['allItems.propostas,', 1],
    ],
  },
};

const ehTipo = (no: ts.Node) =>
  (no.kind >= ts.SyntaxKind.FirstTypeNode && no.kind <= ts.SyntaxKind.LastTypeNode) ||
  ts.isInterfaceDeclaration(no) ||
  ts.isTypeAliasDeclaration(no);

const fonteTs = (arq: string, fonte: string) =>
  ts.createSourceFile(arq, fonte, ts.ScriptTarget.Latest, true, arq.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** Contagem dos textos do arquivo (fora import/export e tipos). */
function contarTextos(arq: string, fonte: string): Map<string, number> {
  const m = new Map<string, number>();
  const guardar = (t: string) => {
    const s = t.replace(/\s+/g, ' ').trim();
    if (s) m.set(s, (m.get(s) || 0) + 1);
  };
  const visitar = (no: ts.Node): void => {
    if (ehTipo(no) || ts.isImportDeclaration(no) || ts.isExportDeclaration(no)) return;
    if (ts.isStringLiteral(no) || ts.isNoSubstitutionTemplateLiteral(no)) guardar(no.text);
    else if (ts.isTemplateHead(no) || ts.isTemplateMiddle(no) || ts.isTemplateTail(no)) guardar(no.text);
    else if (ts.isJsxText(no)) guardar(no.text);
    ts.forEachChild(no, visitar);
  };
  visitar(fonteTs(arq, fonte));
  return m;
}

const contarTrecho = (fonte: string, trecho: string) => fonte.split(trecho).length - 1;

/** Textos dentro do inicializador de cada const LAB_ do arquivo (o que o laboratório vê). */
function textosDoLab(arq: string): Array<{ nome: string; texto: string }> {
  const out: Array<{ nome: string; texto: string }> = [];
  const sf = fonteTs(arq, ler(arq));
  const coletar = (nome: string, no: ts.Node): void => {
    if (ehTipo(no)) return;
    if (ts.isStringLiteral(no) || ts.isNoSubstitutionTemplateLiteral(no)) out.push({ nome, texto: no.text });
    else if (ts.isTemplateHead(no) || ts.isTemplateMiddle(no) || ts.isTemplateTail(no)) out.push({ nome, texto: no.text });
    ts.forEachChild(no, (f) => coletar(nome, f));
  };
  const visitar = (no: ts.Node): void => {
    if (ts.isVariableDeclaration(no) && ts.isIdentifier(no.name) && no.name.text.startsWith('LAB_') && no.initializer) {
      coletar(no.name.text, no.initializer);
      return;
    }
    ts.forEachChild(no, visitar);
  };
  visitar(sf);
  return out;
}

const CAMINHO_DO_HOOK = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.CallExpression,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.VariableDeclarationList,
  ts.SyntaxKind.VariableStatement,
]);

/**
 * Cada chamada a useBusinessType() tem de estar numa instrução DIRETA do corpo do
 * componente (fora de if/laço/callback) e antes de qualquer return dele.
 */
function hooksForaDoTopo(arq: string): string[] {
  const sf = fonteTs(arq, ler(arq));
  const ruins: string[] = [];
  const linha = (no: ts.Node) => sf.getLineAndCharacterOfPosition(no.getStart(sf)).line + 1;
  const funcaoDe = (no: ts.Node): ts.FunctionLikeDeclaration | undefined => {
    let p = no.parent;
    while (p && !ts.isFunctionLike(p)) p = p.parent;
    return p as ts.FunctionLikeDeclaration | undefined;
  };
  const returnsDiretos = (fn: ts.FunctionLikeDeclaration): ts.ReturnStatement[] => {
    const lista: ts.ReturnStatement[] = [];
    const v = (no: ts.Node): void => {
      if (no !== fn.body && ts.isFunctionLike(no)) return;
      if (ts.isReturnStatement(no)) lista.push(no);
      ts.forEachChild(no, v);
    };
    if (fn.body) v(fn.body);
    return lista;
  };
  const visitar = (no: ts.Node): void => {
    if (ts.isCallExpression(no) && ts.isIdentifier(no.expression) && no.expression.text === 'useBusinessType') {
      const fn = funcaoDe(no);
      const corpo = fn?.body;
      if (!fn || !corpo || !ts.isBlock(corpo)) {
        ruins.push(`${arq}:${linha(no)} hook fora de componente`);
      } else {
        // Do hook até o corpo só pode haver chamada e declaração de variável
        // (nada de if, laço, bloco, ?:, && ou ||).
        let instrucao: ts.Node = no;
        let soDeclaracao = true;
        while (instrucao.parent && instrucao.parent !== corpo) {
          instrucao = instrucao.parent;
          if (!CAMINHO_DO_HOOK.has(instrucao.kind)) soDeclaracao = false;
        }
        if (instrucao.parent !== corpo || !soDeclaracao) ruins.push(`${arq}:${linha(no)} hook fora do topo do componente`);
        const antes = returnsDiretos(fn).filter((r) => r.getStart(sf) < no.getStart(sf));
        if (antes.length) ruins.push(`${arq}:${linha(no)} hook depois de um return (linha ${linha(antes[0])})`);
      }
    }
    ts.forEachChild(no, visitar);
  };
  visitar(sf);
  return ruins;
}

describe('F6 — painel de orçamentos, modelos e menu: clínica intacta', () => {
  it.each([[PAINEL], [MODELOS], [SIDEBAR]])('%s: sem pickBt( e sem const LAB_', (arq) => {
    const src = ler(arq);
    expect(src.match(/\bpickBt\s*\(/g) ?? []).toEqual([]);
    expect(src.match(/\b(?:const|let|var)\s+LAB_\w*/g) ?? []).toEqual([]);
  });

  it.each(Object.keys(CLINICA).map((a) => [a]))('%s: textos da clínica com a contagem de d2147294', (arq) => {
    const fonte = ler(arq);
    const textos = contarTextos(arq, fonte);
    const { textos: esperados, trechos } = CLINICA[arq];
    const diferentes = [
      ...esperados
        .filter(([t, n]) => (textos.get(t) || 0) !== n)
        .map(([t, n]) => `${JSON.stringify(t)}: esperado ${n}, achou ${textos.get(t) || 0}`),
      ...trechos
        .filter(([t, n]) => contarTrecho(fonte, t) !== n)
        .map(([t, n]) => `trecho ${JSON.stringify(t)}: esperado ${n}, achou ${contarTrecho(fonte, t)}`),
    ];
    expect(diferentes).toEqual([]);
  });

  it('o hook do tipo de conta fica no topo de cada componente, antes de qualquer return', () => {
    expect([...hooksForaDoTopo(PAINEL), ...hooksForaDoTopo(MODELOS), ...hooksForaDoTopo(INICIO)]).toEqual([]);
  });

  it('painel: os 3 componentes leem o tipo de conta (página, vendas e tabela)', () => {
    const src = ler(PAINEL);
    expect(src.match(/const lab = isLab\(useBusinessType\(\)\);/g)?.length).toBe(3);
  });

  it('painel: no laboratório os links vão para a aba da ficha onde o orçamento aparece (ou Propostas)', () => {
    const src = ler(PAINEL);
    expect(src).toContain("import { abaDoOrcamentoNoLab } from '../pacientes/lab-ficha';");
    const linkLab = "`/atendimento/pacientes/${q.patient.id}?tab=${isPropostas ? 'proposals' : abaDoOrcamentoNoLab(q)}`";
    const linkClinica = "`/atendimento/pacientes/${q.patient.id}?tab=${isPropostas ? 'proposals' : 'odontogram'}`";
    const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const portao = new RegExp(`lab\\s*\\?\\s*${escapar(linkLab)}\\s*:\\s*${escapar(linkClinica)}`, 'g');
    expect(src.match(portao)?.length).toBe(2);
  });

  it('lab-ficha: rascunho e enviado abrem em Orçamento, aceito em Trabalhos, o resto em Propostas', () => {
    const js = ts.transpileModule(ler(FICHA_IDS), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const mod: { exports: Record<string, any> } = { exports: {} };
    const requerer = (nome: string) => (nome === '@crm/shared' ? { labAllowsRoute: () => true } : require(nome));
    new Function('exports', 'require', 'module', js)(mod.exports, requerer, mod);
    const aba = mod.exports.abaDoOrcamentoNoLab as (q: { status: string; archived_at?: string | null }) => string;
    expect(aba({ status: 'DRAFT' })).toBe('orcamento');
    expect(aba({ status: 'SENT' })).toBe('orcamento');
    expect(aba({ status: 'ACCEPTED' })).toBe('treatment');
    expect(aba({ status: 'REJECTED' })).toBe('proposals');
    expect(aba({ status: 'EXPIRED' })).toBe('proposals');
    expect(aba({ status: 'DRAFT', archived_at: '2026-10-01T00:00:00Z' })).toBe('proposals');
    expect(aba({ status: 'ACCEPTED', archived_at: null })).toBe('treatment');
  });

  it('modelos: as duas partes da tela leem o tipo de conta', () => {
    expect(ler(MODELOS).match(/const lab = isLab\(useBusinessType\(\)\);/g)?.length).toBe(2);
  });

  it('menu: "Orçamentos de trabalho" só entra no laboratório, e o rótulo da clínica fica', () => {
    const src = ler(SIDEBAR);
    expect(src).toContain("label: lab ? LAB_MENU.orcamentos : 'Avaliação',");
    expect(contarTrecho(src, '...(lab ? [allItems.orcamentos] : []),')).toBe(1);
    // Na clínica o item continua fora do menu: o único uso fora do comentário é o do portão.
    const usos = src.split('\n').filter((l) => l.includes('allItems.orcamentos') && !l.trim().startsWith('//'));
    expect(usos.map((l) => l.trim())).toEqual(['...(lab ? [allItems.orcamentos] : []),']);
  });
});

describe('F6 — textos do laboratório do painel, modelos, menu e Início', () => {
  it('textos do painel: só a const LAB_PAINEL_ORCAMENTOS', () => {
    const sf = fonteTs(PAINEL_TEXTOS, ler(PAINEL_TEXTOS));
    const nomes = sf.statements.map((st) =>
      ts.isVariableStatement(st) ? st.declarationList.declarations.map((d) => d.name.getText(sf)).join(',') : ts.SyntaxKind[st.kind],
    );
    expect(nomes).toEqual(['LAB_PAINEL_ORCAMENTOS']);
  });

  it.each([[PAINEL_TEXTOS], [CONFIG_TEXTOS], [CASCA_TEXTOS]])('%s: nenhum texto do laboratório com palavra de clínica', (arq) => {
    const ruins = textosDoLab(arq)
      .filter(({ texto }) => temPalavraDeClinica(texto))
      .map(({ nome, texto }) => `${nome}: ${JSON.stringify(texto)}`);
    expect(ruins).toEqual([]);
  });

  it('modelos de orçamento: rótulo no menu de Configurações e textos da tela', () => {
    const src = ler(CONFIG_TEXTOS);
    expect(src).toContain("'/atendimento/settings/quote-templates': 'Modelos de orçamento',");
    expect(src).toContain('export const LAB_MODELOS = Object.freeze({');
  });

  it('menu e Início: rótulos das entradas do painel', () => {
    const src = ler(CASCA_TEXTOS);
    expect(src).toContain("orcamentos: 'Orçamentos de trabalho',");
    expect(src).toContain("orcamentos: Object.freeze({ label: 'Orçamentos de trabalho', desc: 'Monte, envie e acompanhe os orçamentos.' }),");
    expect(src).toContain("propostas: Object.freeze({ label: 'Propostas', desc: 'Orçamentos enviados aguardando o cliente.' }),");
  });

  it('Início do laboratório: atalhos do painel e da visão Propostas, com manage_proposals', () => {
    const src = ler(INICIO);
    expect(src).toContain("'/atendimento/orcamentos': 'orcamentos',");
    expect(src).toContain("'/atendimento/orcamentos?status=SENT': 'propostas',");
    expect(src).toMatch(/orcamentos: 'manage_proposals',\s*propostas: 'manage_proposals',/);
    expect(src).toMatch(/orcamentos: DocArt,\s*propostas: DocArt,/);
  });
});
