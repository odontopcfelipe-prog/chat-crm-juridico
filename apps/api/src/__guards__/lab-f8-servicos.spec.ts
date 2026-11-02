/**
 * F8 do laboratório — ficha técnica do serviço na tabela de serviços
 * (apps/web/src/app/atendimento/settings/procedures).
 *
 * A página (page.tsx) já chama pickBt, então a trava 1 de
 * scripts/ci/check-pick-literals.mjs não deixa entrar string nova nela. A F8 entra
 * por componentes importados de LabFichaServico.tsx e textos de
 * lab-servicos-textos.ts. Este spec guarda:
 *   - a página não chama rota nova (a lista de chamadas é a de 3461015f) e o corpo do
 *     POST/PATCH do serviço não muda;
 *   - coluna Prazo, célula e bloco "Ficha técnica" só aparecem como `lab && <… />`;
 *     validarFicha e gravarFichaLab só rodam com `lab`, e a ficha grava DEPOIS do
 *     serviço e antes de fechar o modal;
 *   - todo hook no topo do componente (antes de return, fora de condição ou laço);
 *   - LabFichaServico.tsx sem pickBt, sem const LAB_, sem texto escrito na tela, sem
 *     rota de clínica, com leitura só no laboratório; o PUT leva exatamente as chaves
 *     de CAMPOS_DA_FICHA_TECNICA e nunca lança;
 *   - lab-servicos-textos.ts só com a const LAB_ congelada e nenhum texto com palavra
 *     de clínica.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import * as shared from '@crm/shared';
import { CAMPOS_DA_FICHA_TECNICA, GARANTIA_MAX_DIAS, PRAZO_MAX_DIAS, UNIDADES_DO_SERVICO } from '@crm/shared';
import { temPalavraDeClinica } from '../business-type/lab-vocab.interceptor';

const RAIZ = path.resolve(__dirname, '..', '..', '..', '..');
const ler = (arq: string): string => {
  const p = path.join(RAIZ, arq);
  if (!fs.existsSync(p)) throw new Error(`${arq} não existe`);
  return fs.readFileSync(p, 'utf8');
};

const PASTA = 'apps/web/src/app/atendimento/settings/procedures';
const PAGINA = `${PASTA}/page.tsx`;
const COMPONENTE = `${PASTA}/LabFichaServico.tsx`;
const TEXTOS = `${PASTA}/lab-servicos-textos.ts`;

/** Trechos de rota que são só de clínica (mesma lista de lab-arquivos-do-lab.spec.ts). */
const ROTAS_DE_CLINICA = [
  '/calendar/',
  '/odontogram',
  '/anamnes',
  '/memories',
  '/google-drive',
  '/honorarios',
  '/allergies',
  '/medications',
  '/start-attending',
  '/birthdays',
  '/first-visits',
  '/portal/',
  '/state-suggestions',
  '/duplicate-as-option',
  '/contract',
  '/credit-check',
  '/accept-no-charge',
  '/affiliates/options',
  '/commercial/',
];

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

const semParenteses = (e: ts.Node): ts.Node => (ts.isParenthesizedExpression(e) ? semParenteses(e.expression) : e);
const ehIdent = (e: ts.Node, nome: string) => ts.isIdentifier(semParenteses(e)) && (semParenteses(e) as ts.Identifier).text === nome;

/** Operando mais à esquerda de uma cadeia `a && b && c`. */
function maisAEsquerda(e: ts.Expression): ts.Node {
  const x = semParenteses(e);
  if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return maisAEsquerda(x.left);
  return x;
}

/** Contém `no` (por posição). */
const contem = (pai: ts.Node, no: ts.Node) => no.pos >= pai.pos && no.end <= pai.end;

/** Lado do laboratório: `lab ? <aqui> : …`, `lab && … && <aqui>` ou `if (lab && …) { <aqui> }`. */
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

function elementosJsx(arq: string, tag: string): Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> {
  const out: Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> = [];
  todos(fonteTs(arq), (n) => {
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText() === tag) out.push(n);
  });
  return out;
}

/** O elemento é exatamente o operando direito de `lab && <Tag … />`. */
function soAtrasDeLab(el: ts.JsxOpeningElement | ts.JsxSelfClosingElement): boolean {
  let no: ts.Node = ts.isJsxOpeningElement(el) ? el.parent : el;
  while (no.parent && ts.isParenthesizedExpression(no.parent)) no = no.parent;
  const p = no.parent;
  return (
    !!p &&
    ts.isBinaryExpression(p) &&
    p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
    p.right === no &&
    ehIdent(p.left, 'lab')
  );
}

function chamadas(arq: string, nome: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  todos(fonteTs(arq), (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === nome) out.push(n);
  });
  return out;
}

/** `api.<metodo>(<1º argumento>)` do arquivo, como texto. */
function chamadasDaApi(arq: string): string[] {
  const out: string[] = [];
  todos(fonteTs(arq), (n) => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
    if (!ehIdent(n.expression.expression, 'api')) return;
    out.push(`${n.expression.name.text} ${n.arguments[0]?.getText() ?? ''}`);
  });
  return out.sort();
}

const ehHook = (c: ts.CallExpression) => ts.isIdentifier(c.expression) && /^use[A-Z]/.test(c.expression.text);

function funcaoDe(no: ts.Node): ts.SignatureDeclaration | undefined {
  for (let p = no.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p;
  return undefined;
}

/** Hooks fora do topo de cada componente (função com nome em maiúscula) ou do hook (use…). */
function hooksForaDoTopo(arq: string): string[] {
  const sf = fonteTs(arq);
  const ruins: string[] = [];
  todos(sf, (n) => {
    if (!ts.isFunctionDeclaration(n) || !n.name || !/^([A-Z]|use[A-Z])/.test(n.name.text) || !n.body) return;
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

function funcao(arq: string, nome: string): ts.FunctionDeclaration {
  let achou: ts.FunctionDeclaration | undefined;
  todos(fonteTs(arq), (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === nome) achou = n;
  });
  if (!achou) throw new Error(`${arq}: função ${nome} não existe`);
  return achou;
}

/**
 * Carrega um arquivo do web transpilado para CommonJS, com os imports trocados por
 * `stubs`. Só para chamar as funções puras e a gravação (nenhum componente renderiza).
 */
function carregar(arq: string, stubs: Record<string, unknown>): Record<string, any> {
  const js = ts.transpileModule(ler(arq), {
    fileName: arq,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const modulo = { exports: {} as Record<string, unknown> };
  const req = (m: string) => {
    if (m in stubs) return stubs[m];
    throw new Error(`${arq}: import inesperado ${m}`);
  };
  new Function('exports', 'require', 'module', js)(modulo.exports, req, modulo);
  return modulo.exports;
}

function carregarTextos(): Record<string, any> {
  return carregar(TEXTOS, {}).LAB_SERVICOS_FICHA;
}

function carregarComponente(api: Record<string, jest.Mock>, toast: Record<string, jest.Mock>): Record<string, any> {
  const semUso = () => {
    throw new Error('hook ou componente não deveria rodar aqui');
  };
  return carregar(COMPONENTE, {
    react: { useCallback: semUso, useEffect: semUso, useState: semUso },
    'react/jsx-runtime': { jsx: semUso, jsxs: semUso, Fragment: {} },
    '@crm/shared': shared,
    '@/lib/api': { __esModule: true, default: api },
    '@/lib/toast': toast,
    '@/lib/useBusinessType': { btAgora: semUso },
    './lab-servicos-textos': { LAB_SERVICOS_FICHA: carregarTextos() },
  });
}

// ---------------------------------------------------------------- página

describe('F8 — tabela de serviços (page.tsx): só portão e componente importado', () => {
  it('nenhuma rota nova: as chamadas da página são as de 3461015f', () => {
    expect(chamadasDaApi(PAGINA)).toEqual(
      [
        'delete `/procedures/${p.id}`',
        'get `/procedures?${params}`',
        'get `/procedures?${params}`',
        "get '/specialties'",
        'patch `/procedures/${p.id}`',
        'patch `/procedures/${p.id}`',
        'patch `/procedures/${p.id}`',
        'patch `/procedures/${p.id}`',
        'patch `/procedures/${procedure!.id}`',
        "post '/procedures'",
      ].sort(),
    );
    const src = ler(PAGINA);
    expect(['/lab-spec', '/lab/procedure-specs', 'lab-servicos-textos', 'const LAB_'].filter((t) => src.includes(t))).toEqual([]);
  });

  it('o corpo do POST/PATCH do serviço não muda', () => {
    const modal = funcao(PAGINA, 'ProcedureModal');
    let chaves: string[] | null = null;
    todos(modal, (n) => {
      if (ts.isVariableDeclaration(n) && ehIdent(n.name, 'payload') && n.initializer && ts.isObjectLiteralExpression(n.initializer)) {
        chaves = n.initializer.properties.map((p) => p.name?.getText() ?? p.getText());
      }
    });
    expect(chaves).toEqual([
      'name',
      'code_tuss',
      'internal_code',
      'description',
      'duration_minutes',
      'base_price',
      'specialty_id',
      'requires_x_ray',
      'requires_anesthesia',
      'commissionable',
      'default_revisit_months',
    ]);
  });

  it('importa da ficha só os componentes, o hook e as funções combinadas', () => {
    const imp = fonteTs(PAGINA).statements.find(
      (s): s is ts.ImportDeclaration => ts.isImportDeclaration(s) && (s.moduleSpecifier as ts.StringLiteral).text === './LabFichaServico',
    );
    const nomes = imp?.importClause?.namedBindings && ts.isNamedImports(imp.importClause.namedBindings)
      ? imp.importClause.namedBindings.elements.map((e) => e.name.text).sort()
      : [];
    expect(nomes).toEqual(
      ['LabFichaTecnica', 'LabPrazoCabecalho', 'LabPrazoCelula', 'gravarFichaLab', 'useFichaDoServico', 'useFichasTecnicasLab', 'validarFicha'].sort(),
    );
  });

  it.each(['LabPrazoCabecalho', 'LabPrazoCelula', 'LabFichaTecnica'].map((t) => [t]))('<%s /> aparece uma vez e só como `lab && <… />`', (tag) => {
    const els = elementosJsx(PAGINA, tag);
    expect(els).toHaveLength(1);
    expect(els.filter((el) => !soAtrasDeLab(el)).map((el) => linha(fonteTs(PAGINA), el))).toEqual([]);
  });

  it('o hook das fichas recebe o `lab` do topo e a lista recarrega depois de salvar', () => {
    const usos = chamadas(PAGINA, 'useFichasTecnicasLab');
    expect(usos).toHaveLength(1);
    expect(usos[0].arguments.map((a) => a.getText())).toEqual(['lab']);
    expect(funcaoDe(usos[0])).toBe(funcao(PAGINA, 'ProceduresSettingsPage'));
    expect(ler(PAGINA)).toContain('const { fichas, recarregar } = useFichasTecnicasLab(lab);');
    expect(chamadas(PAGINA, 'recarregar')).toHaveLength(1);
  });

  it('validarFicha e gravarFichaLab só com `lab`; a ficha grava depois do serviço e antes de fechar', () => {
    const sf = fonteTs(PAGINA);
    const validar = chamadas(PAGINA, 'validarFicha');
    const gravar = chamadas(PAGINA, 'gravarFichaLab');
    expect(validar).toHaveLength(1);
    expect(gravar).toHaveLength(1);
    expect([...validar, ...gravar].filter((c) => !ladoDoLab(c)).map((c) => linha(sf, c))).toEqual([]);
    expect(gravar[0].arguments.map((a) => a.getText())).toEqual(['salvoId', 'fichaDoServico.ficha']);

    const modal = funcao(PAGINA, 'ProcedureModal');
    expect(funcaoDe(gravar[0])).not.toBe(modal); // dentro do submit
    const corpo = modal.getText();
    const iPost = corpo.indexOf("await api.post<{ id: string }>('/procedures', payload);");
    const iPatch = corpo.indexOf('await api.patch(`/procedures/${procedure!.id}`, payload);');
    const iGravar = corpo.indexOf('if (lab && salvoId && fichaDoServico.pronta) await gravarFichaLab(salvoId, fichaDoServico.ficha);');
    const iFechar = corpo.indexOf('onSaved();', iGravar);
    expect(Math.min(iPost, iPatch, iGravar, iFechar)).toBeGreaterThan(-1);
    expect(iGravar).toBeGreaterThan(Math.max(iPost, iPatch));
    expect(iFechar).toBeGreaterThan(iGravar);
    // A validação vem antes de gravar qualquer coisa; ficha que não carregou não é conferida nem gravada.
    const VALIDA = 'const erroFicha = lab && fichaDoServico.pronta ? validarFicha(fichaDoServico.ficha) : null;';
    expect(corpo.indexOf(VALIDA)).toBeGreaterThan(-1);
    expect(corpo.indexOf(VALIDA)).toBeLessThan(corpo.indexOf('setSaving(true);'));
    // O rascunho vem do servidor ao abrir (nunca do mapa da lista, que pode não ter chegado).
    expect(corpo).toContain('const fichaDoServico = useFichaDoServico(lab, procedure?.id ?? null);');
    expect(corpo).not.toContain('fichaLab');
  });

  it.each([[PAGINA], [COMPONENTE]])('%s: todo hook no topo (antes de return, fora de condição/laço)', (arq) => {
    expect(hooksForaDoTopo(arq)).toEqual([]);
  });
});

// ---------------------------------------------------------------- componente

describe('F8 — LabFichaServico.tsx (só do laboratório)', () => {
  it('sem pickBt e sem const LAB_', () => {
    const sf = fonteTs(COMPONENTE);
    const ruins: string[] = [];
    todos(sf, (n) => {
      if (ts.isIdentifier(n) && n.text === 'pickBt') ruins.push(`${linha(sf, n)} pickBt`);
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text.startsWith('LAB_')) ruins.push(`${linha(sf, n)} ${n.name.text}`);
    });
    expect(ruins).toEqual([]);
  });

  it('sem texto escrito na tela (JSX, title, placeholder, aria-label, alt): tudo de lab-servicos-textos.ts', () => {
    const sf = fonteTs(COMPONENTE);
    const ruins: string[] = [];
    todos(sf, (n) => {
      if (ts.isJsxText(n) && /\p{L}/u.test(n.text)) ruins.push(`${linha(sf, n)} ${JSON.stringify(n.text.trim())}`);
      if (
        ts.isJsxAttribute(n) &&
        ['title', 'placeholder', 'aria-label', 'alt'].includes(n.name.getText()) &&
        n.initializer &&
        ts.isStringLiteral(n.initializer)
      ) {
        ruins.push(`${linha(sf, n)} ${n.name.getText()}=${n.initializer.getText()}`);
      }
    });
    expect(ruins).toEqual([]);
    expect(textosDoArquivo(COMPONENTE).filter(({ texto }) => temPalavraDeClinica(texto)).map(({ texto }) => texto)).toEqual([]);
  });

  it('chama só a leitura das fichas e o PUT da ficha, nenhuma rota de clínica', () => {
    expect(chamadasDaApi(COMPONENTE)).toEqual(["get '/lab/procedure-specs'", 'get `/procedures/${procedureId}/lab-spec`', 'put `/procedures/${id}/lab-spec`']);
    for (const arq of [COMPONENTE, TEXTOS]) {
      const src = ler(arq);
      expect(ROTAS_DE_CLINICA.filter((r) => src.includes(r)).map((r) => `${arq} cita ${r}`)).toEqual([]);
    }
  });

  it('a leitura só acontece no laboratório (portão no efeito, com btAgora)', () => {
    const hook = funcao(COMPONENTE, 'useFichasTecnicasLab');
    const efeitos = chamadas(COMPONENTE, 'useEffect');
    expect(efeitos).toHaveLength(2);
    const efeito = efeitos.filter((e) => funcaoDe(e) === hook);
    expect(efeito).toHaveLength(1);
    // O 2º efeito é o da ficha do serviço aberto, também atrás do laboratório.
    const doServico = efeitos.find((e) => funcaoDe(e) === funcao(COMPONENTE, 'useFichaDoServico'));
    expect(doServico?.getText()).toContain('if (!ler || !isLab(btAgora())) {');
    expect(funcao(COMPONENTE, 'useFichaDoServico').getText()).toContain('const ler = lab && !!procedureId;');
    const cb = efeito[0].arguments[0];
    expect(cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && ts.isBlock(cb.body)).toBe(true);
    const primeira = ((cb as ts.ArrowFunction).body as ts.Block).statements[0];
    expect(primeira.getText()).toBe('if (!lab || !isLab(btAgora())) return;');
    expect(efeito[0].arguments[1]?.getText()).toBe('[lab, versao]');
    // Na clínica `recarregar` não muda estado e `fichas` é a constante vazia.
    expect(hook.getText()).toContain('if (lab) setVersao((v) => v + 1);');
    expect(hook.getText()).toContain('return { fichas: lab ? fichas : SEM_FICHAS, recarregar };');
  });

  it('PUT: exatamente as chaves de CAMPOS_DA_FICHA_TECNICA, prazo e garantia como número, vazio vira null', async () => {
    const api = { put: jest.fn().mockResolvedValue({ data: {} }), get: jest.fn() };
    const toast = { showError: jest.fn() };
    const m = carregarComponente(api, toast);
    const r = { ...m.fichaInicial(null), prazo: ' 7 ', garantia: '', material: '  ', pedeCor: true };
    await expect(m.gravarFichaLab('srv-1', r)).resolves.toBe(true);
    expect(api.put).toHaveBeenCalledTimes(1);
    const [url, corpo] = api.put.mock.calls[0];
    expect(url).toBe('/procedures/srv-1/lab-spec');
    expect(Object.keys(corpo).sort()).toEqual([...CAMPOS_DA_FICHA_TECNICA].sort());
    expect(corpo).toEqual({
      lead_time_days: 7,
      warranty_days: null,
      unit: 'ELEMENTO',
      default_material: null,
      needs_shade: true,
      has_tryin: false,
    });
    expect(toast.showError).not.toHaveBeenCalled();
    expect(api.get).not.toHaveBeenCalled();

    await m.gravarFichaLab('srv-2', { ...r, garantia: '90', material: ' Zircônia ', unidade: 'ARCADA', temProva: true });
    expect(api.put.mock.calls[1][1]).toEqual({
      lead_time_days: 7,
      warranty_days: 90,
      unit: 'ARCADA',
      default_material: 'Zircônia',
      needs_shade: true,
      has_tryin: true,
    });
  });

  it('PUT que falha não lança: avisa com erros.salvar e devolve false', async () => {
    const api = { put: jest.fn().mockRejectedValue(new Error('rede')), get: jest.fn() };
    const toast = { showError: jest.fn() };
    const m = carregarComponente(api, toast);
    await expect(m.gravarFichaLab('srv-1', { ...m.fichaInicial(null), prazo: '3' })).resolves.toBe(false);
    expect(toast.showError).toHaveBeenCalledWith(carregarTextos().erros.salvar);
  });

  it('fichaInicial: padrão vazio e a ficha gravada vira rascunho', () => {
    const m = carregarComponente({}, {});
    expect(m.fichaInicial(null)).toEqual({ prazo: '', garantia: '', unidade: 'ELEMENTO', material: '', pedeCor: false, temProva: false });
    expect(m.fichaInicial(undefined)).toEqual(m.fichaInicial(null));
    expect(
      m.fichaInicial({ lead_time_days: 7, warranty_days: 90, unit: 'PECA', default_material: 'Resina', needs_shade: true, has_tryin: true }),
    ).toEqual({ prazo: '7', garantia: '90', unidade: 'PECA', material: 'Resina', pedeCor: true, temProva: true });
    expect(
      m.fichaInicial({ lead_time_days: 0, warranty_days: null, unit: 'ARCADA', default_material: null, needs_shade: false, has_tryin: false }),
    ).toEqual({ prazo: '0', garantia: '', unidade: 'ARCADA', material: '', pedeCor: false, temProva: false });
  });

  it('validarFicha: prazo obrigatório e inteiro de 0 a PRAZO_MAX_DIAS; garantia vazia ou de 0 a GARANTIA_MAX_DIAS', () => {
    const m = carregarComponente({}, {});
    const T = carregarTextos();
    const base = m.fichaInicial(null);
    const erroPrazo = T.erros.prazo(PRAZO_MAX_DIAS);
    const erroGarantia = T.erros.garantia(GARANTIA_MAX_DIAS);
    for (const prazo of ['', ' ', '-1', '2.5', '7,5', 'abc', String(PRAZO_MAX_DIAS + 1), '1e2']) {
      expect([prazo, m.validarFicha({ ...base, prazo })]).toEqual([prazo, erroPrazo]);
    }
    for (const prazo of ['0', '7', ` ${PRAZO_MAX_DIAS} `]) expect(m.validarFicha({ ...base, prazo })).toBeNull();
    for (const garantia of ['-1', '1.5', 'x', String(GARANTIA_MAX_DIAS + 1)]) {
      expect([garantia, m.validarFicha({ ...base, prazo: '7', garantia })]).toEqual([garantia, erroGarantia]);
    }
    for (const garantia of ['', '  ', '0', '90', String(GARANTIA_MAX_DIAS)]) {
      expect(m.validarFicha({ ...base, prazo: '7', garantia })).toBeNull();
    }
  });
});

// ---------------------------------------------------------------- textos

describe('F8 — lab-servicos-textos.ts', () => {
  it('só tem a const LAB_SERVICOS_FICHA congelada (Object.freeze)', () => {
    const sf = fonteTs(TEXTOS);
    const ruins: string[] = [];
    for (const st of sf.statements) {
      if (ts.isVariableStatement(st) && st.declarationList.flags & ts.NodeFlags.Const) {
        const ok = st.declarationList.declarations.every(
          (d) =>
            ts.isIdentifier(d.name) &&
            d.name.text === 'LAB_SERVICOS_FICHA' &&
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

  it('as chaves combinadas, as 3 unidades e a dica dos dias corridos', () => {
    const T = carregarTextos();
    expect(Object.isFrozen(T)).toBe(true);
    for (const chave of [
      'colunaPrazo',
      'prazoDias',
      'semPrazo',
      'semPrazoDica',
      'unidades',
      'pedeCorCurto',
      'temProvaCurto',
      'garantiaCurta',
      'fichaTitulo',
      'fichaDica',
      'prazo',
      'prazoPlaceholder',
      'garantia',
      'garantiaPlaceholder',
      'unidade',
      'materialPadrao',
      'materialPadraoPlaceholder',
      'pedeCor',
      'temProva',
      'erros',
    ]) {
      expect([chave, T[chave] !== undefined]).toEqual([chave, true]);
    }
    expect(Object.keys(T.unidades).sort()).toEqual([...UNIDADES_DO_SERVICO].sort());
    expect(T.prazoDias(1)).toBe('1 dia');
    expect(T.prazoDias(7)).toBe('7 dias');
    expect(T.garantiaCurta(90)).toBe('garantia 90 d');
    expect(T.fichaDica).toContain('dias corridos');
    expect(T.materialPadrao).toBe('Material padrão (opcional)');
    expect(T.erros.prazo(PRAZO_MAX_DIAS)).toContain(String(PRAZO_MAX_DIAS));
    expect(T.erros.garantia(GARANTIA_MAX_DIAS)).toContain(String(GARANTIA_MAX_DIAS));
    expect(typeof T.erros.salvar).toBe('string');
  });
});
