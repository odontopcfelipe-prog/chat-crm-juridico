/**
 * F6 do laboratório — aba Orçamento da ficha (LabOrcamentoTab) e os componentes de
 * montagem do orçamento de trabalho: seletor de serviços e elementos
 * (AddQuoteItemModal), tabela de serviços (QuotePanel), resumo ao lado dos elementos
 * (DenteReal), versões (QuoteVersions) e anexos (QuoteAttachments).
 *
 * Esses arquivos da clínica ganham só portão e texto importado
 * (`lab ? LAB_X.y : 'texto de hoje'`), sem pickBt nem const LAB_. Por isso a trava 1
 * de scripts/ci/check-pick-literals.mjs não os enxerga, e este spec faz a guarda:
 *   - os textos da clínica que a F6 envolveu continuam no arquivo com a mesma contagem
 *     do commit de partida (d2147294);
 *   - todo texto LAB_ fica do lado do laboratório (`lab ? LAB_… : …`) e o que some no
 *     laboratório fica atrás de `!lab && …`;
 *   - o hook do tipo de conta (e todo hook) fica no topo do componente, antes de
 *     qualquer return e fora de condição ou laço; o resumo (DenteReal) não lê o tipo de
 *     conta, só recebe os textos;
 *   - a aba Orçamento mantém a assinatura que a ficha usa, não chama rota só de clínica,
 *     não passa a anotação do desenho dos dentes nem "Duplicar", e PDF, modelos, anexos
 *     e versões ficam com quem negocia (manage_proposals);
 *   - o arquivo de textos só tem consts LAB_ e nenhum texto com palavra de clínica.
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

const PASTA = 'apps/web/src/app/atendimento/pacientes';
const ABA = `${PASTA}/components/LabOrcamentoTab.tsx`;
const TEXTOS = `${PASTA}/lab-orcamento-textos.ts`;
const MODAL = `${PASTA}/components/AddQuoteItemModal.tsx`;
const PAINEL = `${PASTA}/components/QuotePanel.tsx`;
const VERSOES = `${PASTA}/components/QuoteVersions.tsx`;
const ANEXOS = `${PASTA}/components/QuoteAttachments.tsx`;
const RESUMO = 'apps/web/src/components/odontograma/DenteReal.tsx';

/** Arquivos da clínica que ganharam portão (lab) e texto importado. */
const COM_PORTAO = [MODAL, PAINEL, VERSOES, ANEXOS];
const DO_GRUPO = [ABA, MODAL, PAINEL, VERSOES, ANEXOS, RESUMO];

/**
 * Textos da clínica (string, partes fixas de template e texto de JSX, com espaços
 * juntados e aparados) com a contagem de d2147294 — gerada antes da edição.
 */
const CLINICA: Record<string, Array<[string, number]>> = {
  [MODAL]: [
    ['Adicionar procedimentos ao orçamento', 1],
    ['Adicionar procedimentos à avaliação', 1],
    ['Adicionar ao orçamento', 1],
    ['Adicionar à avaliação', 1],
    ['Orçamento atualizado', 1],
    ['Avaliação atualizada', 1],
    ['Nada pra salvar — adicione, remova procedimentos ou edite o nome', 1],
    ['Selecione um procedimento da cesta primeiro', 2],
    ['Pra mudar procedimentos, crie uma nova versão do plano na aba Propostas.', 1],
    ['O orçamento já foi enviado ao paciente. Pra editar, primeiro retorne pra DRAFT na aba Orçamentos.', 1],
    ['Crie uma nova versão ou duplique este orçamento.', 1],
    ['Ex: Reabilitação superior, Canal + coroa 36 (opcional)', 1],
    ['Prioridade', 1],
    ['✓ Completo', 1],
    ['⚠ Essencial', 1],
    ['🔥 Urgente', 1],
    ['Tratamento completo — sem urgência', 1],
    ['Procedimentos importantes — fazer em breve', 1],
    ['Urgência — paciente precisa o quanto antes', 1],
    ['Buscar por nome ou código TUSS...', 1],
    ['Sem especialidade', 1],
    ['procedimento', 2],
    ['Nenhum procedimento cadastrado.', 1],
    ['Cadastrar tabela de preços', 1],
    ['Nenhum procedimento corresponde aos filtros.', 1],
    ['⏱', 1],
    ['min', 3],
    ['TUSS', 1],
    ['Carregando procedimentos...', 1],
    ['Click nos procedimentos da esquerda pra adicionar à cesta.', 1],
    ['Remover dente', 1],
    ['clique no odontograma acima', 1],
    ['× (1/dente)', 1],
    ['dente', 1],
    ['de cadeira', 1],
    ['Selecione os dentes para', 1],
    ['Selecione os dentes envolvidos no tratamento', 1],
    ['Adulto', 1],
    ['Infantil', 1],
    ['Dente', 3],
    ['· clique pra remover', 1],
    ['Clique pra adicionar o dente', 1],
    ["Duplicar este orçamento (cria novo rascunho com os mesmos procedimentos + ' cópia N')", 1],
  ],
  [PAINEL]: [
    ['Remover este procedimento do orcamento?', 1],
    ['Sem especialidade', 1],
    ['Plano de tratamento', 1],
    ['procedimentos', 2],
    ['Comece adicionando procedimentos', 1],
    ['Clique em um dente para anotar · Ctrl+clique em varios para orcar em lote · Ou use o botao abaixo', 1],
    ['Dente', 2],
    ['Procedimento', 1],
    ['Dentista', 1],
    ['Qtd', 1],
    ['Buscar procedimento por nome ou TUSS...', 1],
    ['Nenhum procedimento cadastrado.', 1],
    ['Cadastrar tabela de precos', 1],
    ['Nenhum procedimento corresponde a &quot;', 1],
    ['TUSS', 1],
    ['min', 1],
    ['Clique para editar dente ·', 1],
    ['sem especialidade', 1],
    ['Clique para vincular um dente FDI (ex: 12, 36)', 1],
    ['?', 1],
    [
      'inline-flex items-center justify-center w-8 h-8 rounded-md border-2 border-dashed border-amber-500 text-amber-700 font-mono font-bold text-xs hover:bg-amber-500/10 transition animate-pulse',
      1,
    ],
    ['Vincule um dente para que apareca no odontograma', 1],
    ['Dentista que vai fazer este procedimento', 1],
    ['Dentista do procedimento', 1],
    ['Sem dentista', 1],
  ],
  [RESUMO]: [
    ['Resumo do plano', 1],
    ['Os procedimentos que você marcar aparecem somados aqui.', 1],
    ['Dente', 3],
    ['Dentes', 1],
    ['procedimento', 1],
    ['dente', 1],
  ],
  [VERSOES]: [
    ['PROCEDIMENTOS', 1],
    ['Procedimento', 1],
    ['Dente', 1],
  ],
  [ANEXOS]: [
    ['Antes/Depois', 2],
    ['Exame', 1],
    ['TCLE', 1],
    ['Receita', 1],
    ['Plano de tratamento', 1],
    ['Outro', 1],
    ['Adicione fotos antes/depois, exames ou documentos auxiliares.', 1],
  ],
};

// ---------------------------------------------------------------- AST

const fontes = new Map<string, ts.SourceFile>();
function fonteTs(arq: string): ts.SourceFile {
  let sf = fontes.get(arq);
  if (!sf) {
    sf = ts.createSourceFile(arq, ler(arq), ts.ScriptTarget.Latest, true, arq.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    fontes.set(arq, sf);
  }
  return sf;
}

const ehTipo = (no: ts.Node) =>
  (no.kind >= ts.SyntaxKind.FirstTypeNode && no.kind <= ts.SyntaxKind.LastTypeNode) ||
  ts.isInterfaceDeclaration(no) ||
  ts.isTypeAliasDeclaration(no);

function todos(no: ts.Node, ver: (n: ts.Node) => void): void {
  ver(no);
  ts.forEachChild(no, (f) => todos(f, ver));
}

const linha = (sf: ts.SourceFile, no: ts.Node) => sf.getLineAndCharacterOfPosition(no.getStart(sf)).line + 1;

/** Textos do arquivo (fora import/export e tipos), com espaços juntados e aparados. */
function textosDoArquivo(arq: string): Array<{ texto: string; no: ts.Node }> {
  const out: Array<{ texto: string; no: ts.Node }> = [];
  const guardar = (t: string, no: ts.Node) => {
    const s = t.replace(/\s+/g, ' ').trim();
    if (s) out.push({ texto: s, no });
  };
  const visitar = (no: ts.Node): void => {
    if (ehTipo(no) || ts.isImportDeclaration(no) || ts.isExportDeclaration(no)) return;
    if (ts.isStringLiteral(no) || ts.isNoSubstitutionTemplateLiteral(no)) guardar(no.text, no);
    else if (ts.isTemplateHead(no) || ts.isTemplateMiddle(no) || ts.isTemplateTail(no)) guardar(no.text, no);
    else if (ts.isJsxText(no)) guardar(no.text, no);
    ts.forEachChild(no, visitar);
  };
  visitar(fonteTs(arq));
  return out;
}

const semParenteses = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) ? semParenteses(e.expression) : e);

/** Operando mais à esquerda de uma cadeia `a && b && c`. */
function maisAEsquerda(e: ts.Expression): ts.Expression {
  const x = semParenteses(e);
  if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return maisAEsquerda(x.left);
  return x;
}

const ehIdent = (e: ts.Expression, nome: string) => ts.isIdentifier(semParenteses(e)) && (semParenteses(e) as ts.Identifier).text === nome;
const ehNegacaoDe = (e: ts.Expression, nome: string) => {
  const x = semParenteses(e);
  return ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.ExclamationToken && ehIdent(x.operand, nome);
};

/** Contém `no` (por posição). */
const contem = (pai: ts.Node, no: ts.Node) => no.pos >= pai.pos && no.end <= pai.end;

/**
 * Lado do laboratório: o primeiro portão acima é `lab ? <aqui> : …`, `lab && … && <aqui>`
 * ou `if (lab && …) { <aqui> }`. Lado da clínica (`lab ? … : <aqui>`) devolve false.
 */
function ladoDoLab(no: ts.Node): boolean {
  let filho: ts.Node = no;
  for (let p = no.parent; p; filho = p, p = p.parent) {
    if (ts.isConditionalExpression(p) && ehIdent(maisAEsquerda(p.condition), 'lab')) {
      if (contem(p.whenTrue, filho)) return true;
      if (contem(p.whenFalse, filho)) return false;
    }
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && contem(p.right, filho)) {
      if (ehIdent(maisAEsquerda(p.left), 'lab')) return true;
    }
    if (ts.isIfStatement(p) && contem(p.thenStatement, filho) && ehIdent(maisAEsquerda(p.expression), 'lab')) return true;
  }
  return false;
}

/** Só na clínica: `!lab && … && <aqui>`, `lab ? … : <aqui>` ou `(!lab && …) ? <aqui> : …`. */
function soNaClinica(no: ts.Node): boolean {
  let filho: ts.Node = no;
  for (let p = no.parent; p; filho = p, p = p.parent) {
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && contem(p.right, filho)) {
      if (ehNegacaoDe(maisAEsquerda(p.left), 'lab')) return true;
    }
    if (ts.isConditionalExpression(p)) {
      if (ehIdent(maisAEsquerda(p.condition), 'lab') && contem(p.whenFalse, filho)) return true;
      if (ehNegacaoDe(maisAEsquerda(p.condition), 'lab') && contem(p.whenTrue, filho)) return true;
    }
  }
  return false;
}

/** Dentro de `<nome> && …` (o operando mais à esquerda da cadeia é o identificador). */
function atrasDe(no: ts.Node, nome: string): boolean {
  let filho: ts.Node = no;
  for (let p = no.parent; p; filho = p, p = p.parent) {
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && contem(p.right, filho)) {
      const esq = p.left;
      // `a && b && <aqui>`: qualquer operando da cadeia à esquerda serve.
      const operandos: ts.Expression[] = [];
      const juntar = (e: ts.Expression) => {
        const x = semParenteses(e);
        if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
          juntar(x.left);
          juntar(x.right);
        } else operandos.push(x);
      };
      juntar(esq);
      if (operandos.some((o) => ehIdent(o, nome))) return true;
    }
  }
  return false;
}

function elementosJsx(arq: string, tag: string): Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> {
  const out: Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> = [];
  todos(fonteTs(arq), (n) => {
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText() === tag) out.push(n);
  });
  return out;
}

const atributos = (el: ts.JsxOpeningElement | ts.JsxSelfClosingElement) =>
  el.attributes.properties.filter(ts.isJsxAttribute);
const nomeDoAtributo = (a: ts.JsxAttribute) => a.name.getText();

const ehHook = (c: ts.CallExpression) => ts.isIdentifier(c.expression) && /^use[A-Z]/.test(c.expression.text);

/** Função mais próxima que contém o nó. */
function funcaoDe(no: ts.Node): ts.SignatureDeclaration | undefined {
  for (let p = no.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p;
  return undefined;
}

/** Hooks fora do topo de cada componente (função com nome em maiúscula). */
function hooksForaDoTopo(arq: string): string[] {
  const sf = fonteTs(arq);
  const ruins: string[] = [];
  todos(sf, (n) => {
    if (!ts.isFunctionDeclaration(n) || !n.name || !/^[A-Z]/.test(n.name.text) || !n.body) return;
    const corpo = n.body;
    const instrucoes = corpo.statements;
    let primeiroReturn = Infinity;
    instrucoes.forEach((st, i) => {
      let tem = false;
      todos(st, (x) => {
        if (ts.isReturnStatement(x) && funcaoDe(x) === n) tem = true;
      });
      if (tem && i < primeiroReturn) primeiroReturn = i;
    });
    todos(corpo, (x) => {
      if (!ts.isCallExpression(x) || !ehHook(x) || funcaoDe(x) !== n) return;
      // Sobe até a instrução direta do corpo: nada de condição, laço ou curto-circuito no caminho.
      let p: ts.Node = x;
      let problema = '';
      while (p.parent && p.parent !== corpo) {
        const q = p.parent;
        if (
          ts.isIfStatement(q) || ts.isForStatement(q) || ts.isForOfStatement(q) || ts.isForInStatement(q) ||
          ts.isWhileStatement(q) || ts.isDoStatement(q) || ts.isSwitchStatement(q) || ts.isTryStatement(q) ||
          ts.isConditionalExpression(q) ||
          (ts.isBinaryExpression(q) &&
            [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(q.operatorToken.kind))
        ) {
          problema = 'dentro de condição ou laço';
          break;
        }
        p = q;
      }
      const idx = instrucoes.indexOf(p as ts.Statement);
      if (!problema && idx > primeiroReturn) problema = 'depois de um return';
      if (problema) ruins.push(`${arq}:${linha(sf, x)} ${n.name!.text}: ${x.expression.getText()} ${problema}`);
    });
  });
  return ruins;
}

// ---------------------------------------------------------------- testes

describe('F6 — textos da clínica congelados nos componentes do orçamento', () => {
  it.each(Object.keys(CLINICA).map((a) => [a]))('%s: mesma contagem de d2147294', (arq) => {
    const contagem = new Map<string, number>();
    for (const { texto } of textosDoArquivo(arq)) contagem.set(texto, (contagem.get(texto) || 0) + 1);
    const diferentes = CLINICA[arq]
      .filter(([texto, n]) => (contagem.get(texto.replace(/\s+/g, ' ').trim()) || 0) !== n)
      .map(([texto, n]) => `${JSON.stringify(texto)}: esperado ${n}, achei ${contagem.get(texto) || 0}`);
    expect(diferentes).toEqual([]);
  });
});

describe('F6 — portões nos componentes da clínica', () => {
  it.each(DO_GRUPO.map((a) => [a]))('%s: sem pickBt e sem const LAB_', (arq) => {
    const src = ler(arq);
    expect([src.includes('pickBt(') && 'pickBt(', src.includes('const LAB_') && 'const LAB_'].filter(Boolean)).toEqual([]);
  });

  it.each(COM_PORTAO.map((a) => [a]))('%s: todo LAB_ está do lado do laboratório (lab ? LAB_… : texto de hoje)', (arq) => {
    const sf = fonteTs(arq);
    const ruins: string[] = [];
    let usos = 0;
    todos(sf, (n) => {
      if (!ts.isIdentifier(n) || !n.text.startsWith('LAB_')) return;
      if (n.parent && (ts.isImportSpecifier(n.parent) || ts.isNamespaceImport(n.parent))) return;
      usos++;
      if (!ladoDoLab(n)) ruins.push(`${arq}:${linha(sf, n)} ${n.parent?.getText() ?? n.text}`);
    });
    expect(usos).toBeGreaterThan(0);
    expect(ruins).toEqual([]);
  });

  it.each(COM_PORTAO.map((a) => [a]))('%s: o tipo de conta vem de isLab(useBusinessType())', (arq) => {
    const src = ler(arq);
    expect(src).toContain("import { isLab } from '@crm/shared';");
    expect(src).toContain("import { useBusinessType } from '@/lib/useBusinessType';");
    expect(src).toContain('const lab = isLab(useBusinessType());');
  });

  it.each(DO_GRUPO.map((a) => [a]))('%s: todo hook no topo do componente (antes de return, fora de condição/laço)', (arq) => {
    expect(hooksForaDoTopo(arq)).toEqual([]);
  });

  it('seletor (AddQuoteItemModal): prioridade, TUSS, duração e horas de cadeira só na clínica', () => {
    const sf = fonteTs(MODAL);
    const alvo = (texto: string) => textosDoArquivo(MODAL).filter((t) => t.texto === texto);
    const fora = [
      ...alvo('Prioridade'),
      ...alvo('✓ Completo'),
      ...alvo('🔥 Urgente'),
      ...alvo('⏱'),
      ...alvo('TUSS'),
      ...alvo('de cadeira'),
    ].filter(({ no }) => !soNaClinica(no));
    expect(fora.map(({ texto, no }) => `${linha(sf, no)} ${texto}`)).toEqual([]);
    // O resumo recebe os textos do laboratório só no laboratório.
    const resumo = elementosJsx(MODAL, 'ResumoProcedimentos');
    expect(resumo).toHaveLength(1);
    const textos = atributos(resumo[0]).find((a) => nomeDoAtributo(a) === 'textos');
    expect(textos?.initializer?.getText()).toBe('{lab ? LAB_ORC_ITENS.resumo : undefined}');
    // O envio dos itens não muda: 1 item por elemento; sem elemento, vai a quantidade.
    expect(ler(MODAL).split('const qtyPerPost = it.tooth_fdis.length > 0 ? 1 : it.quantity;').length - 1).toBe(2);
  });

  it('tabela (QuotePanel): TUSS, minutos, aviso de dente e "?" pulsante só na clínica; elemento inválido avisa só no laboratório', () => {
    const sf = fonteTs(PAINEL);
    const alvo = (texto: string) => textosDoArquivo(PAINEL).filter((t) => t.texto === texto);
    const pulsante =
      'inline-flex items-center justify-center w-8 h-8 rounded-md border-2 border-dashed border-amber-500 text-amber-700 font-mono font-bold text-xs hover:bg-amber-500/10 transition animate-pulse';
    const fora = [
      ...alvo('TUSS'),
      ...alvo('min'),
      ...alvo('Vincule um dente para que apareca no odontograma'),
      ...alvo(pulsante),
      ...alvo('?'),
    ].filter(({ no }) => !soNaClinica(no));
    expect(fora.map(({ texto, no }) => `${linha(sf, no)} ${texto}`)).toEqual([]);
    // A mesma regra de FDI do servidor (11-48 e 51-85).
    expect(ler(PAINEL)).toContain('const FDI_REGEX = /^([1-4][1-8]|[5-8][1-5])$/;');
  });

  it('resumo (DenteReal): não lê o tipo de conta; os textos chegam pela prop opcional', () => {
    const src = ler(RESUMO);
    expect(src).not.toContain('useBusinessType');
    expect(src).not.toContain('isLab');
    expect(src).not.toContain('lab-orcamento-textos');
    expect(src).toMatch(/export function ResumoProcedimentos\(\{ itens, className = '', textos \}: \{ itens: ItemResumo\[\]; className\?: string; textos\?: TextosDoResumo \}\)/);
  });
});

describe('F6 — aba Orçamento do laboratório (LabOrcamentoTab)', () => {
  it('assinatura que a ficha usa: default export LabOrcamentoTab({ patientId, readOnly?, onGoToProposals? })', () => {
    const sf = fonteTs(ABA);
    const fn = sf.statements.find(
      (s): s is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(s) &&
        !!s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
        !!s.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword),
    );
    expect(fn?.name?.text).toBe('LabOrcamentoTab');
    const tipo = fn?.parameters[0]?.type;
    expect(tipo && ts.isTypeLiteralNode(tipo)).toBe(true);
    const membros = (tipo as ts.TypeLiteralNode).members
      .filter(ts.isPropertySignature)
      .map((m) => `${m.name.getText()}${m.questionToken ? '?' : ''}: ${m.type?.getText()}`);
    expect(membros).toEqual(['patientId: string', 'readOnly?: boolean', 'onGoToProposals?: () => void']);
  });

  it('não chama rota só de clínica e não importa a aba de avaliação da clínica', () => {
    const src = ler(ABA);
    const rotas = ['/odontogram', '/state-suggestions', '/duplicate-as-option', '/contract', '/credit-check', '/commercial/'];
    expect(rotas.filter((r) => src.includes(r))).toEqual([]);
    const imports = fonteTs(ABA).statements.filter(ts.isImportDeclaration).map((i) => (i.moduleSpecifier as ts.StringLiteral).text);
    expect(imports.filter((m) => /OdontogramaTab|OrcamentoTab|PropostasTab/.test(m))).toEqual([]);
  });

  it('a tabela de serviços vai sem anotação do desenho dos dentes e com seleção fixa', () => {
    const els = elementosJsx(ABA, 'QuotePanel');
    expect(els).toHaveLength(1);
    const nomes = atributos(els[0]).map(nomeDoAtributo);
    expect(nomes).toEqual(expect.arrayContaining(['compact', 'selectedTeeth', 'onClearSelection']));
    expect(nomes).not.toContain('lastAnnotation');
    expect(nomes).not.toContain('onAnnotationConsumed');
    const sel = atributos(els[0]).find((a) => nomeDoAtributo(a) === 'selectedTeeth');
    expect(sel?.initializer?.getText()).toBe('{SEM_DENTES_SELECIONADOS}');
    // Array constante do módulo (não renderiza à toa).
    const decl = fonteTs(ABA)
      .statements.filter(ts.isVariableStatement)
      .flatMap((s) => [...s.declarationList.declarations])
      .find((d) => ts.isIdentifier(d.name) && d.name.text === 'SEM_DENTES_SELECIONADOS');
    expect(decl?.initializer && ts.isArrayLiteralExpression(decl.initializer) && decl.initializer.elements.length).toBe(0);
  });

  it('o seletor abre sem "Duplicar" e sem elementos pré-marcados', () => {
    const els = elementosJsx(ABA, 'AddQuoteItemModal');
    expect(els).toHaveLength(1);
    const nomes = atributos(els[0]).map(nomeDoAtributo);
    expect(nomes).not.toContain('onDuplicate');
    expect(nomes).not.toContain('prefillTeeth');
    expect(nomes).toEqual(expect.arrayContaining(['quoteId', 'procedures', 'onClose', 'onAdded']));
  });

  it('PDF, modelos, anexos e versões só para quem negocia (manage_proposals)', () => {
    const sf = fonteTs(ABA);
    const src = ler(ABA);
    expect(src).toContain("const podeNegociar = hasPermission('manage_proposals');");
    const ruins: string[] = [];
    for (const tag of ['QuoteAttachments', 'QuoteVersions']) {
      const els = elementosJsx(ABA, tag);
      if (els.length !== 1) ruins.push(`${tag}: ${els.length} elemento(s)`);
      for (const el of els) if (!atrasDe(el, 'podeNegociar')) ruins.push(`${linha(sf, el)} ${tag} fora de podeNegociar &&`);
    }
    todos(sf, (n) => {
      if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression)) return;
      if (!['verPdf', 'abrirModelos'].includes(n.expression.text)) return;
      if (!n.parent || !ts.isArrowFunction(n.parent)) return; // só os cliques da tela
      if (!atrasDe(n, 'podeNegociar')) ruins.push(`${linha(sf, n)} ${n.expression.text} fora de podeNegociar &&`);
    });
    expect(ruins).toEqual([]);
  });

  it('todo texto vem do arquivo de textos (sem texto de JSX nem title/placeholder escrito na tela)', () => {
    const sf = fonteTs(ABA);
    const ruins: string[] = [];
    todos(sf, (n) => {
      if (ts.isJsxText(n) && /\p{L}/u.test(n.text)) ruins.push(`${linha(sf, n)} ${JSON.stringify(n.text.trim())}`);
      if (
        ts.isJsxAttribute(n) &&
        ['title', 'placeholder', 'aria-label', 'alt'].includes(nomeDoAtributo(n)) &&
        n.initializer &&
        ts.isStringLiteral(n.initializer)
      ) {
        ruins.push(`${linha(sf, n)} ${nomeDoAtributo(n)}=${n.initializer.getText()}`);
      }
    });
    expect(ruins).toEqual([]);
    expect(textosDoArquivo(ABA).filter(({ texto }) => temPalavraDeClinica(texto)).map(({ texto }) => texto)).toEqual([]);
  });
});

describe('F6 — arquivo de textos do orçamento de trabalho', () => {
  it('só tem import type e consts LAB_ congeladas (Object.freeze)', () => {
    const sf = fonteTs(TEXTOS);
    const ruins: string[] = [];
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && st.importClause?.isTypeOnly) continue;
      if (ts.isVariableStatement(st) && st.declarationList.flags & ts.NodeFlags.Const) {
        const ok = st.declarationList.declarations.every(
          (d) =>
            ts.isIdentifier(d.name) &&
            d.name.text.startsWith('LAB_') &&
            !!d.initializer &&
            ts.isCallExpression(d.initializer) &&
            d.initializer.expression.getText() === 'Object.freeze',
        );
        if (ok) continue;
      }
      ruins.push(`${linha(sf, st)} ${st.getText().slice(0, 60)}`);
    }
    expect(ruins).toEqual([]);
  });

  it('nenhum texto com palavra de clínica', () => {
    const ruins = textosDoArquivo(TEXTOS)
      .filter(({ texto }) => temPalavraDeClinica(texto))
      .map(({ texto, no }) => `${linha(fonteTs(TEXTOS), no)} ${JSON.stringify(texto)}`);
    expect(ruins).toEqual([]);
  });

  it('o resumo, as categorias de anexo e as versões têm as chaves combinadas', () => {
    const src = ler(TEXTOS);
    expect(src).toContain('export const LAB_ORCAMENTO = Object.freeze(');
    expect(src).toContain('export const LAB_ORC_ITENS = Object.freeze(');
    expect(src).toContain('export const LAB_ORC_ANEXOS = Object.freeze(');
    expect(src).toContain('export const LAB_ORC_VERSOES = Object.freeze(');
    expect(src).toContain("semNome: 'Orçamento de trabalho',");
    expect(src).toContain("categorias: Object.freeze(['Foto do caso', 'Print do escaneamento', 'Pedido do dentista', 'Cor / escala', 'Outro']),");
    for (const chave of [
      "titulo: 'Resumo do orçamento',",
      "vazio: 'Os serviços que você marcar aparecem somados aqui.',",
      "elemento: 'Elemento',",
      "elementos: 'Elementos',",
      "servico: 'serviço',",
      "servicos: 'serviços',",
    ]) {
      expect(src).toContain(chave);
    }
  });
});
