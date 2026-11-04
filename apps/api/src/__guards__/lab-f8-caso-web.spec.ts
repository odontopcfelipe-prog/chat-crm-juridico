/**
 * F8 do laboratório — ficha do caso no web: orçamento de trabalho (LabOrcamentoTab),
 * trabalho aprovado (TratamentoTab, aba também da clínica) e venda rápida
 * (venda-rapida/page.tsx, arquivo de muito movimento).
 *
 * Os componentes e as chamadas de rede da ficha do caso ficam num arquivo só do
 * laboratório (LabFichaDoCaso.tsx) e os textos em lab-caso-textos.ts (só a const
 * LAB_CASO). Os arquivos da clínica ganham só import, portão (`lab && …`) e
 * identificadores. Este spec lê o código do web pelo AST e confere:
 *   - o campo do paciente do caso só aparece em LabFichaDoCaso.tsx (no web inteiro);
 *   - LabOrcamentoTab, TratamentoTab e a venda rápida não chamam as rotas novas direto;
 *   - LabCasoDoTrabalho e LabFichaDoCasoDaVenda só montam atrás de `lab &&`, e a
 *     clínica passa `lab` ao hook dos casos (sem requisição);
 *   - gravarFichaDaVenda só roda com `lab` e depois do POST da venda de balcão;
 *   - a ficha do caso fica fora da chave da venda (saleKeyRef);
 *   - venda-rapida/page.tsx e TratamentoTab.tsx com o MESMO multiconjunto de textos
 *     (strings, templates e texto de JSX) do commit 3461015f, antes da F8;
 *   - lab-caso-textos.ts só com a const LAB_CASO e sem palavra de clínica (só "paciente
 *     do caso"); nenhuma rota de clínica nos 2 arquivos novos.
 *
 * Se um texto da clínica nesses 2 arquivos mudar DE PROPÓSITO depois, a impressão
 * digital abaixo muda junto (o teste mostra a nova).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { temPalavraDeClinica } from '../business-type/lab-vocab.interceptor';

const RAIZ = path.resolve(__dirname, '..', '..', '..', '..');
const WEB = 'apps/web/src';
const PASTA = `${WEB}/app/atendimento/pacientes`;
const FICHA_DO_CASO = `${PASTA}/components/LabFichaDoCaso.tsx`;
const TEXTOS = `${PASTA}/lab-caso-textos.ts`;
const ORCAMENTO = `${PASTA}/components/LabOrcamentoTab.tsx`;
const TRATAMENTO = `${PASTA}/components/TratamentoTab.tsx`;
const VENDA = `${WEB}/app/atendimento/venda-rapida/page.tsx`;

function ler(arq: string): string {
  const p = path.join(RAIZ, arq);
  if (!fs.existsSync(p)) throw new Error(`${arq} não existe`);
  return fs.readFileSync(p, 'utf8');
}

function arvore(arq: string): ts.SourceFile {
  return ts.createSourceFile(arq, ler(arq), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function visitar(no: ts.Node, fn: (n: ts.Node) => void): void {
  fn(no);
  ts.forEachChild(no, (filho) => visitar(filho, fn));
}

const linha = (sf: ts.SourceFile, no: ts.Node) => sf.getLineAndCharacterOfPosition(no.getStart(sf)).line + 1;

/** Textos do arquivo (string, template e texto de JSX), com espaços juntados e aparados. Fora: import/export e tipos. */
function textos(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const guardar = (texto: string) => {
    const t = texto.replace(/\s+/g, ' ').trim();
    if (t) out.push(t);
  };
  const ehTipo = (no: ts.Node) =>
    (no.kind >= ts.SyntaxKind.FirstTypeNode && no.kind <= ts.SyntaxKind.LastTypeNode) ||
    ts.isInterfaceDeclaration(no) ||
    ts.isTypeAliasDeclaration(no);
  const andar = (no: ts.Node): void => {
    if (ehTipo(no) || ts.isImportDeclaration(no) || ts.isExportDeclaration(no)) return;
    if (ts.isStringLiteral(no) || ts.isNoSubstitutionTemplateLiteral(no)) guardar(no.text);
    else if (ts.isTemplateHead(no) || ts.isTemplateMiddle(no) || ts.isTemplateTail(no)) guardar(no.text);
    else if (ts.isJsxText(no)) guardar(no.text);
    ts.forEachChild(no, andar);
  };
  andar(sf);
  return out;
}

/** Multiconjunto de textos: total, quantos diferentes e o sha256 dos pares [texto, contagem] em ordem. */
function impressaoDigital(arq: string): { total: number; unicos: number; sha256: string } {
  const lista = textos(arvore(arq));
  const mapa = new Map<string, number>();
  for (const t of lista) mapa.set(t, (mapa.get(t) || 0) + 1);
  const pares = [...mapa.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    total: lista.length,
    unicos: pares.length,
    sha256: crypto.createHash('sha256').update(JSON.stringify(pares)).digest('hex'),
  };
}

function nomeDaTag(no: ts.Node): string | null {
  if (ts.isJsxSelfClosingElement(no)) return no.tagName.getText();
  if (ts.isJsxElement(no)) return no.openingElement.tagName.getText();
  return null;
}

/** Operandos de uma cadeia `a && b && c` (todos). */
function operandosDoE(no: ts.Expression): ts.Expression[] {
  const out: ts.Expression[] = [];
  let atual: ts.Expression = no;
  while (ts.isBinaryExpression(atual) && atual.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    out.push(atual.right);
    atual = atual.left;
  }
  out.push(atual);
  return out;
}

const ehLab = (e: ts.Expression) => ts.isIdentifier(e) && e.text === 'lab';

/** O nó está do lado direito de um `lab && …` (em qualquer ancestral). */
function atrasDeLab(no: ts.Node): boolean {
  let filho: ts.Node = no;
  for (let pai = no.parent; pai; filho = pai, pai = pai.parent) {
    if (
      ts.isBinaryExpression(pai) &&
      pai.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      pai.right === filho &&
      operandosDoE(pai.left).some(ehLab)
    ) {
      return true;
    }
  }
  return false;
}

/** O nó está no "então" de um `if (lab && …)` (em qualquer ancestral). */
function dentroDeIfLab(no: ts.Node): boolean {
  let filho: ts.Node = no;
  for (let pai = no.parent; pai; filho = pai, pai = pai.parent) {
    if (ts.isIfStatement(pai) && pai.thenStatement === filho && operandosDoE(pai.expression).some(ehLab)) return true;
  }
  return false;
}

function funcaoDe(no: ts.Node): ts.Node | undefined {
  for (let p = no.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p;
  return undefined;
}

function chamadas(sf: ts.SourceFile, nome: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  visitar(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === nome) out.push(n);
  });
  return out;
}

/** Arquivos de código do web (sem node_modules e .next). */
function arquivosDoWeb(): string[] {
  const out: string[] = [];
  const andar = (rel: string) => {
    for (const e of fs.readdirSync(path.join(RAIZ, rel), { withFileTypes: true })) {
      const filho = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== '.next') andar(filho);
      } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name)) {
        out.push(filho);
      }
    }
  };
  andar(WEB);
  return out;
}

/** Trechos de rota que são só de clínica (mesma lista de lab-arquivos-do-lab.spec). */
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

/**
 * Multiconjunto de textos em 3461015f (antes da F8), gerado de `git show 3461015f:<arquivo>`
 * antes da edição. A F8 só acrescenta import, portão e identificador nesses arquivos.
 * A venda rápida mudou de propósito depois: pagamento em lista e sem o PIX online (nov/2026).
 */
const ANTES_DA_F8: Record<string, { total: number; unicos: number; sha256: string }> = {
  [VENDA]: { total: 502, unicos: 360, sha256: '7ef6b1e9b212873fc6c8102fb015cee028c3edb326f6490981fcb442428b7071' },
  [TRATAMENTO]: { total: 171, unicos: 154, sha256: '24ef358cd65d78edb597871149e0b3a2fa7cb432ed092403c790facf5164a443' },
};

describe('F8 — ficha do caso no web', () => {
  it('o campo do paciente do caso só aparece em LabFichaDoCaso.tsx (web inteiro)', () => {
    const achados = arquivosDoWeb().filter((arq) => /\bpatient_ref\b/.test(ler(arq)));
    expect(achados).toEqual([FICHA_DO_CASO]);
  });

  it.each([[ORCAMENTO], [TRATAMENTO], [VENDA]])('%s: sem as rotas novas nem o campo do paciente do caso (tudo no componente)', (arq) => {
    const src = ler(arq);
    const trechos = ['/lab-case', '/lab-cases', '/lab/procedure-specs', '/lab-profile', 'patient_ref'];
    expect(trechos.filter((t) => src.includes(t))).toEqual([]);
  });

  it.each([
    [TRATAMENTO, 'LabCasoDoTrabalho'],
    [VENDA, 'LabFichaDoCasoDaVenda'],
  ])('%s: <%s> só monta atrás de `lab &&`', (arq, tag) => {
    const sf = arvore(arq);
    const usos: ts.Node[] = [];
    visitar(sf, (no) => {
      if (nomeDaTag(no) === tag) usos.push(no);
    });
    expect(usos.length).toBe(1);
    expect(usos.filter((u) => !atrasDeLab(u)).map((u) => `${arq}:${linha(sf, u)}`)).toEqual([]);
  });

  it('os componentes da ficha do caso só montam nas 3 telas da F8', () => {
    const tags = /<(LabCasoDoTrabalho|LabFichaDoCasoDaVenda|LabFichaDoCasoDoOrcamento|LabSeloDoCaso|LabFichaDoCaso)\b/;
    const fora = arquivosDoWeb().filter((arq) => ![FICHA_DO_CASO, ORCAMENTO, TRATAMENTO, VENDA].includes(arq) && tags.test(ler(arq)));
    expect(fora).toEqual([]);
  });

  it('os hooks dos casos: a clínica passa `lab` (sem requisição) e a aba Orçamento (só do laboratório) passa true', () => {
    const doTratamento = chamadas(arvore(TRATAMENTO), 'useCasosDoCliente').map((c) => c.getText());
    expect(doTratamento).toEqual(['useCasosDoCliente(lab, patientId)']);
    const doOrcamento = chamadas(arvore(ORCAMENTO), 'useCasosDoCliente').map((c) => c.getText());
    expect(doOrcamento).toEqual(['useCasosDoCliente(true, patientId)']);
    // O hook do tipo vem antes do hook dos casos na aba da clínica.
    const src = ler(TRATAMENTO);
    expect(src.indexOf('const lab = isLab(useBusinessType());')).toBeGreaterThan(-1);
    expect(src.indexOf('const lab = isLab(useBusinessType());')).toBeLessThan(src.indexOf('useCasosDoCliente(lab, patientId)'));
  });

  it('venda rápida: gravarFichaDaVenda só com `lab` e depois do POST da venda de balcão', () => {
    const sf = arvore(VENDA);
    const gravar = chamadas(sf, 'gravarFichaDaVenda');
    expect(gravar.length).toBe(1);
    const balcao: ts.CallExpression[] = [];
    visitar(sf, (n) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'post' &&
        n.arguments[0] &&
        ts.isStringLiteralLike(n.arguments[0]) &&
        n.arguments[0].text === '/venda-rapida/balcao'
      ) {
        balcao.push(n);
      }
    });
    expect(balcao.length).toBe(1);
    for (const g of gravar) {
      expect(dentroDeIfLab(g)).toBe(true);
      expect(funcaoDe(g)).toBe(funcaoDe(balcao[0]));
      expect(g.getStart(sf)).toBeGreaterThan(balcao[0].getEnd());
      // O id é o orçamento que a venda criou.
      // A ficha é a guardada com a venda enviada: no reenvio depois do F5 o estado já foi embora.
      expect(g.arguments.map((a) => a.getText())).toEqual(['sale.quote_id', 'envio.ficha ?? FICHA_VAZIA']);
    }
    // Limpa a ficha só no laboratório, depois da venda.
    expect(chamadas(sf, 'setFichaDoCaso').every((c) => dentroDeIfLab(c))).toBe(true);
  });

  it('venda rápida: a ficha do caso fica FORA da chave da venda (saleKeyRef)', () => {
    const sf = arvore(VENDA);
    const efeitos = chamadas(sf, 'useEffect').filter((c) => c.arguments[0]?.getText().includes('saleKeyRef.current = null'));
    expect(efeitos.length).toBe(1);
    const deps = efeitos[0].arguments[1];
    expect(deps && ts.isArrayLiteralExpression(deps)).toBe(true);
    const nomes = (deps as ts.ArrayLiteralExpression).elements.map((e) => e.getText());
    expect(nomes).toEqual(['cart', 'patient', 'dentistId', 'pagamento']);
  });

  it.each(Object.keys(ANTES_DA_F8).map((a) => [a]))('%s: mesmo multiconjunto de textos de 3461015f (só import, portão e identificador)', (arq) => {
    expect(impressaoDigital(arq)).toEqual(ANTES_DA_F8[arq]);
  });

  it.each([[TRATAMENTO], [VENDA], [FICHA_DO_CASO]])('%s: sem pickBt( e sem const LAB_', (arq) => {
    const src = ler(arq);
    expect(src.match(/\bpickBt\s*\(/g) ?? []).toEqual([]);
    expect(src.match(/\b(?:const|let|var)\s+LAB_\w*/g) ?? []).toEqual([]);
  });
});

describe('F8 — componente da ficha do caso (LabFichaDoCaso.tsx)', () => {
  const sf = arvore(FICHA_DO_CASO);
  const src = ler(FICHA_DO_CASO);

  it('só chama as rotas do laboratório da F8', () => {
    const rotas = new Set<string>();
    visitar(sf, (n) => {
      if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
      if (n.expression.expression.getText() !== 'api') return;
      const alvo = n.arguments[0];
      if (!alvo) return;
      const molde = ts.isTemplateExpression(alvo)
        ? [alvo.head.text, ...alvo.templateSpans.map((s) => s.literal.text)].join(':id')
        : ts.isStringLiteralLike(alvo)
          ? alvo.text
          : alvo.getText();
      rotas.add(`${n.expression.name.text.toUpperCase()} ${molde}`);
    });
    expect([...rotas].sort()).toEqual([
      'GET /lab/procedure-specs',
      'GET /patients/:id/lab-cases',
      'GET /patients/:id/lab-profile',
      'GET /quotes/:id/lab-case',
      'PUT /quotes/:id/lab-case',
    ]);
  });

  it('nenhuma rota de clínica nos 2 arquivos novos', () => {
    for (const arq of [FICHA_DO_CASO, TEXTOS]) {
      const s = ler(arq);
      expect(ROTAS_DE_CLINICA.filter((r) => s.includes(r)).map((r) => `${arq} cita ${r}`)).toEqual([]);
    }
  });

  it('nenhum texto visível com palavra de clínica (fora "paciente do caso")', () => {
    const ruins = textos(sf).filter((t) => temPalavraDeClinica(t));
    expect(ruins).toEqual([]);
  });

  it('datas por texto: sem toLocaleDateString e sem new Date(...) no código', () => {
    const ruins: string[] = [];
    visitar(sf, (n) => {
      if (ts.isPropertyAccessExpression(n) && /^toLocale(Date)?String$/.test(n.name.text)) ruins.push(`${linha(sf, n)} ${n.getText()}`);
      if (ts.isNewExpression(n) && n.expression.getText() === 'Date') ruins.push(`${linha(sf, n)} ${n.getText()}`);
    });
    expect(ruins).toEqual([]);
  });

  it('nada vai para o console', () => {
    expect(/\bconsole\s*\./.test(src)).toBe(false);
  });

  it('link externo sempre com rel="noopener noreferrer"', () => {
    const ruins: string[] = [];
    let externos = 0;
    visitar(sf, (n) => {
      if (!ts.isJsxOpeningElement(n) && !ts.isJsxSelfClosingElement(n)) return;
      const attrs = n.attributes.properties.filter(ts.isJsxAttribute);
      const valor = (nome: string) => {
        const a = attrs.find((x) => x.name.getText() === nome);
        return a?.initializer && ts.isStringLiteral(a.initializer) ? a.initializer.text : null;
      };
      if (valor('target') !== '_blank') return;
      externos++;
      if (valor('rel') !== 'noopener noreferrer') ruins.push(`${linha(sf, n)}`);
    });
    expect(externos).toBeGreaterThan(0);
    expect(ruins).toEqual([]);
  });

  it('o PUT manda só os 8 campos do caso (paraCorpo com CAMPOS_DO_CASO)', () => {
    expect(src).toMatch(/export function paraCorpo\(f: FichaDoCaso\): Partial<FichaDoCasoLab>/);
    expect(src).toContain('for (const campo of CAMPOS_DO_CASO)');
    const puts: string[] = [];
    visitar(sf, (n) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'put') {
        puts.push(n.arguments[1]?.getText() ?? '');
      }
    });
    expect(puts.length).toBeGreaterThan(0);
    expect(puts.filter((p) => !/^paraCorpo\(/.test(p))).toEqual([]);
  });

  it('gravarFichaDaVenda nunca lança (try/catch no corpo inteiro) e ficha vazia não grava', () => {
    const fn = sf.statements.find(
      (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'gravarFichaDaVenda',
    );
    expect(fn?.body?.statements.length).toBe(1);
    expect(fn && ts.isTryStatement(fn.body!.statements[0])).toBe(true);
    expect(fn!.body!.getText()).toContain('fichaVazia(ficha)');
    expect(fn!.body!.getText()).toContain('showError(LAB_CASO.erros.vendaSemFicha)');
  });

  it('quem edita no trabalho sai das permissões DENTRO do componente', () => {
    const fn = sf.statements.find(
      (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'LabCasoDoTrabalho',
    );
    const corpo = fn?.body?.getText() ?? '';
    expect(corpo).toContain("hasPermission('manage_proposals') || hasPermission('create_evaluation')");
  });
});

describe('F8 — textos da ficha do caso (lab-caso-textos.ts)', () => {
  const sf = arvore(TEXTOS);

  it('só tem a const LAB_CASO exportada e congelada', () => {
    const outras: string[] = [];
    const nomes: string[] = [];
    for (const st of sf.statements) {
      const exportada = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (ts.isVariableStatement(st) && exportada && (st.declarationList.flags & ts.NodeFlags.Const) !== 0) {
        for (const d of st.declarationList.declarations) {
          nomes.push(d.name.getText(sf));
          expect(d.initializer?.getText(sf).startsWith('Object.freeze(')).toBe(true);
        }
      } else {
        outras.push(st.getText(sf).slice(0, 60));
      }
    }
    expect(outras).toEqual([]);
    expect(nomes).toEqual(['LAB_CASO']);
  });

  it('nenhum texto com palavra de clínica (só "paciente do caso")', () => {
    const lista = textos(sf);
    expect(lista.length).toBeGreaterThan(30);
    expect(lista.filter((t) => temPalavraDeClinica(t))).toEqual([]);
    // "paciente" só na expressão do laboratório.
    const semPermitida = lista.map((t) => t.replace(/paciente do caso/gi, ''));
    expect(semPermitida.filter((t) => /paciente/i.test(t))).toEqual([]);
  });
});
