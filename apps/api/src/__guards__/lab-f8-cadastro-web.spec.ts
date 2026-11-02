/**
 * F8 do laboratório — cadastro, ficha e lista do CLIENTE do laboratório no web:
 *   - o cadastro (LabClienteModal) grava a ficha do cliente (PUT /patients/:id/lab-profile,
 *     via lab-perfil.ts) DEPOIS do cadastro: no novo depois do POST, no editar depois do
 *     PATCH, e nunca quando a ficha não carregou;
 *   - o aviso de telefone de outro cliente (GET /leads/check-phone) só roda para quem vê
 *     contato (view_patient_contact);
 *   - o Enter no campo do dentista adiciona o nome sem enviar o formulário;
 *   - a ficha ([id]/page.tsx, MUITO MOVIMENTO) ganha só o portão `{lab && <LabPerfilNaFicha`
 *     e perde o import que ficou sem uso; os textos da clínica do card de dados ficam com a
 *     contagem de 3461015f;
 *   - a lista (pacientes/page.tsx) usa `lab_profile` só atrás de `lab`, e os textos da
 *     clínica ficam com a contagem de 3461015f;
 *   - os textos novos do laboratório: os 90 dias nos cartões e no filtro, e nenhum texto
 *     com palavra de clínica nos arquivos novos;
 *   - os arquivos só do laboratório não chamam rota só de clínica.
 *
 * Lê o código do web pelo AST (no padrão do lab-f7-casca.spec), sem importar o web.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import * as shared from '@crm/shared';
import { DIAS_SEM_ORCAMENTO_PARA_INATIVO } from '@crm/shared';
import { temPalavraDeClinica } from '../business-type/lab-vocab.interceptor';

const RAIZ = path.resolve(__dirname, '..', '..', '..', '..');
const ler = (arq: string): string => {
  const p = path.join(RAIZ, arq);
  if (!fs.existsSync(p)) throw new Error(`${arq} não existe`);
  return fs.readFileSync(p, 'utf8');
};

const PASTA = 'apps/web/src/app/atendimento/pacientes';
const FICHA = `${PASTA}/[id]/page.tsx`;
const LISTA = `${PASTA}/page.tsx`;
const MODAL = `${PASTA}/components/LabClienteModal.tsx`;
const NA_FICHA = `${PASTA}/components/LabPerfilNaFicha.tsx`;
const PERFIL = `${PASTA}/lab-perfil.ts`;
const TEXTOS = `${PASTA}/lab-dentistas-textos.ts`;

const semEspacos = (s: string) => s.replace(/\s+/g, '');
const contarTrecho = (fonte: string, trecho: string) => semEspacos(fonte).split(semEspacos(trecho)).length - 1;

const ehTipo = (no: ts.Node) =>
  (no.kind >= ts.SyntaxKind.FirstTypeNode && no.kind <= ts.SyntaxKind.LastTypeNode) ||
  ts.isInterfaceDeclaration(no) ||
  ts.isTypeAliasDeclaration(no);

const arvore = (arq: string) =>
  ts.createSourceFile(arq, ler(arq), ts.ScriptTarget.Latest, true, arq.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

function visitar(no: ts.Node, fn: (n: ts.Node) => void): void {
  fn(no);
  ts.forEachChild(no, (filho) => visitar(filho, fn));
}

/** Textos do arquivo (string, template e texto de JSX), fora import/export e tipos, com a linha. */
function textosVisiveis(arq: string): Array<{ texto: string; linha: number }> {
  const sf = arvore(arq);
  const out: Array<{ texto: string; linha: number }> = [];
  const guardar = (texto: string, no: ts.Node) => {
    const t = texto.replace(/\s+/g, ' ').trim();
    if (t) out.push({ texto: t, linha: sf.getLineAndCharacterOfPosition(no.getStart(sf)).line + 1 });
  };
  const andar = (no: ts.Node): void => {
    if (ehTipo(no) || ts.isImportDeclaration(no) || ts.isExportDeclaration(no)) return;
    if (ts.isStringLiteral(no) || ts.isNoSubstitutionTemplateLiteral(no)) guardar(no.text, no);
    else if (ts.isTemplateHead(no) || ts.isTemplateMiddle(no) || ts.isTemplateTail(no)) guardar(no.text, no);
    else if (ts.isJsxText(no)) guardar(no.text, no);
    ts.forEachChild(no, andar);
  };
  andar(sf);
  return out;
}

const contarTexto = (arq: string, texto: string) => textosVisiveis(arq).filter((t) => t.texto === texto).length;

/** Operandos de uma cadeia `a && b && c` (sem o último). */
function operandosDoE(no: ts.BinaryExpression): ts.Expression[] {
  const out: ts.Expression[] = [];
  let atual: ts.Expression = no.left;
  while (ts.isBinaryExpression(atual) && atual.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    out.push(atual.right);
    atual = atual.left;
  }
  out.push(atual);
  return out;
}

const ehLab = (e: ts.Node) => ts.isIdentifier(e) && e.text === 'lab';

/** O nó só roda com `lab`: ramo `lab ? X : …`, cadeia `lab && … && X` ou `if (lab) X`. */
function atrasDeLab(no: ts.Node): boolean {
  let filho: ts.Node = no;
  for (let pai = no.parent; pai; filho = pai, pai = pai.parent) {
    if (ts.isConditionalExpression(pai) && ehLab(pai.condition) && pai.whenTrue === filho) return true;
    if (
      ts.isBinaryExpression(pai) &&
      pai.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      pai.right === filho &&
      operandosDoE(pai).some(ehLab)
    ) {
      return true;
    }
    if (ts.isIfStatement(pai) && ehLab(pai.expression) && pai.thenStatement === filho) return true;
  }
  return false;
}

/** Chamadas `nome(...)` (identificador) do arquivo. */
function chamadasDe(sf: ts.SourceFile, nome: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  visitar(sf, (no) => {
    if (ts.isCallExpression(no) && ts.isIdentifier(no.expression) && no.expression.text === nome) out.push(no);
  });
  return out;
}

/** Ancestral mais próximo que satisfaz o teste. */
function subirAte<T extends ts.Node>(no: ts.Node, teste: (n: ts.Node) => n is T): T | undefined {
  for (let pai = no.parent; pai; pai = pai.parent) if (teste(pai)) return pai;
  return undefined;
}

/**
 * Cada hook (useX(...)) de um componente (função com nome em maiúscula) fica numa
 * instrução DIRETA do corpo (fora de if, laço, callback, ?:, && ou ||) e antes de
 * qualquer return do componente. `useX().y(...)` conta como direto.
 */
const CAMINHO_DO_HOOK = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.CallExpression,
  ts.SyntaxKind.PropertyAccessExpression,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.VariableDeclarationList,
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.ExpressionStatement,
]);
function hooksForaDoTopo(arq: string): string[] {
  const sf = arvore(arq);
  const ruins: string[] = [];
  const linha = (no: ts.Node) => sf.getLineAndCharacterOfPosition(no.getStart(sf)).line + 1;
  const componentes: ts.FunctionDeclaration[] = [];
  visitar(sf, (no) => {
    if (ts.isFunctionDeclaration(no) && no.body && no.name && /^[A-Z]/.test(no.name.text)) componentes.push(no);
  });
  for (const fn of componentes) {
    const corpo = fn.body!;
    const returns: ts.ReturnStatement[] = [];
    const hooks: ts.CallExpression[] = [];
    const andar = (no: ts.Node, dentroDeOutraFuncao: boolean): void => {
      const outra = dentroDeOutraFuncao || (no !== fn && ts.isFunctionLike(no));
      if (!outra && ts.isReturnStatement(no)) returns.push(no);
      if (!outra && ts.isCallExpression(no) && ts.isIdentifier(no.expression) && /^use[A-Z]/.test(no.expression.text)) hooks.push(no);
      ts.forEachChild(no, (f) => andar(f, outra));
    };
    andar(corpo, false);
    for (const h of hooks) {
      let instrucao: ts.Node = h;
      let soDeclaracao = true;
      while (instrucao.parent && instrucao.parent !== corpo) {
        instrucao = instrucao.parent;
        if (!CAMINHO_DO_HOOK.has(instrucao.kind)) soDeclaracao = false;
      }
      const nome = `${fn.name!.text}:${linha(h)} ${(h.expression as ts.Identifier).text}`;
      if (instrucao.parent !== corpo || !soDeclaracao) ruins.push(`${arq} ${nome} fora do topo do componente`);
      const antes = returns.filter((r) => r.getStart(sf) < h.getStart(sf));
      if (antes.length) ruins.push(`${arq} ${nome} depois de um return (linha ${linha(antes[0])})`);
    }
  }
  return ruins;
}

/** Carrega lab-dentistas-textos.ts (arquivo do web) com o @crm/shared de verdade. */
function carregarTextos(): Record<string, any> {
  const js = ts.transpileModule(ler(TEXTOS), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod: { exports: Record<string, any> } = { exports: {} };
  const requerer = (nome: string) => {
    if (nome === '@crm/shared') return shared;
    throw new Error(`lab-dentistas-textos.ts não pode importar ${nome}`);
  };
  new Function('exports', 'require', 'module', js)(mod.exports, requerer, mod);
  return mod.exports;
}

/** Carrega lab-perfil.ts (arquivo do web) com o @crm/shared de verdade e uma api simulada. */
function carregarPerfilWeb() {
  const chamadas: unknown[][] = [];
  const respostas: { get: unknown; put: unknown } = { get: null, put: null };
  const api = {
    get: async (url: string) => {
      chamadas.push(['get', url]);
      return { data: respostas.get };
    },
    put: async (url: string, corpo: unknown) => {
      chamadas.push(['put', url, corpo]);
      return { data: respostas.put };
    },
  };
  const js = ts.transpileModule(ler(PERFIL), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const mod: { exports: Record<string, any> } = { exports: {} };
  const requerer = (nome: string) => {
    if (nome === '@crm/shared') return shared;
    if (nome === '@/lib/api') return { __esModule: true, default: api };
    throw new Error(`lab-perfil.ts não pode importar ${nome}`);
  };
  new Function('exports', 'require', 'module', js)(mod.exports, requerer, mod);
  return { mod: mod.exports, chamadas, respostas };
}

/** Trechos de rota que são só de clínica (a mesma lista do lab-arquivos-do-lab.spec). */
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

describe('F8 — arquivos da clínica: só portão e texto importado', () => {
  it.each([[FICHA], [LISTA]])('%s: sem pickBt( e sem const LAB_', (arq) => {
    const src = ler(arq);
    expect(src.match(/\bpickBt\s*\(/g) ?? []).toEqual([]);
    expect(src.match(/\b(?:const|let|var)\s+LAB_\w*/g) ?? []).toEqual([]);
  });

  it.each([[FICHA], [LISTA]])('%s: não chama a ficha do cliente direto (só pelo componente do laboratório)', (arq) => {
    const src = ler(arq);
    expect(textosVisiveis(arq).filter(({ texto }) => texto.includes('lab-profile'))).toEqual([]);
    expect(src.includes('carregarPerfil')).toBe(false);
    expect(src.includes('salvarPerfil')).toBe(false);
  });
});

describe('F8 — ficha do cliente ([id]/page.tsx)', () => {
  const src = ler(FICHA);
  const sf = arvore(FICHA);

  it('a linha Tipo virou o componente do laboratório, atrás de `lab &&`', () => {
    expect(contarTrecho(src, '{lab && <LabPerfilNaFicha cadastro={patient} />}')).toBe(1);
    expect(contarTrecho(src, '<LabPerfilNaFicha')).toBe(1);
    const usos: ts.Node[] = [];
    visitar(sf, (no) => {
      if ((ts.isJsxSelfClosingElement(no) || ts.isJsxOpeningElement(no)) && no.tagName.getText(sf) === 'LabPerfilNaFicha') usos.push(no);
    });
    expect(usos.length).toBe(1);
    expect(usos.filter((u) => !atrasDeLab(u)).map((u) => u.getText(sf))).toEqual([]);
    // carregado sob demanda, como a aba Orçamento do laboratório (fora do pacote da clínica)
    expect(contarTrecho(src, "const LabPerfilNaFicha = dynamic(() => import('../components/LabPerfilNaFicha'), { ssr: false });")).toBe(1);
  });

  it('sem o tipo pelo documento na ficha e sem import sobrando', () => {
    expect(src.includes('tipoDoDocumento(')).toBe(false);
    expect(/\btipoDoDocumento\b/.test(src)).toBe(false);
    expect(/\bLAB_CADASTRO\b/.test(src)).toBe(false);
    expect(contarTrecho(src, "import { LAB_FICHA } from '../lab-dentistas-textos';")).toBe(1);
  });

  // Contagem em 3461015f (gerada de `git show 3461015f:<arquivo>` antes da edição).
  it.each([
    ['Dados pessoais', 1],
    ['Nome', 1],
    ['CPF', 1],
    ['RG', 1],
    ['Telefone', 1],
    ['Email', 1],
    ['Endereço', 1],
  ] as const)('texto da clínica %j aparece %i vez(es), como em 3461015f', (texto, n) => {
    expect(contarTexto(FICHA, texto)).toBe(n);
  });
});

describe('F8 — lista de clientes (pacientes/page.tsx)', () => {
  const src = ler(LISTA);
  const sf = arvore(LISTA);

  // Contagem em 3461015f (gerada de `git show 3461015f:<arquivo>` antes da edição).
  it.each([
    ['Com atendimento nos últimos 12 meses', 1],
    ['Mais de 12 meses sem atendimento', 1],
    ['Buscar por nome, ficha, CPF, telefone, email ou etiqueta...', 1],
    ['Buscar por nome, ficha, CPF ou etiqueta...', 1],
  ] as const)('texto da clínica %j aparece %i vez(es), como em 3461015f', (texto, n) => {
    expect(contarTexto(LISTA, texto)).toBe(n);
  });

  it('todo uso de lab_profile fica atrás de `lab`', () => {
    const usos: ts.Node[] = [];
    visitar(sf, (no) => {
      if (ts.isPropertyAccessExpression(no) && no.name.text === 'lab_profile') usos.push(no);
    });
    expect(usos.length).toBeGreaterThanOrEqual(5);
    expect(usos.filter((u) => !atrasDeLab(u)).map((u) => u.getText(sf))).toEqual([]);
  });

  it('os 90 dias entram só no laboratório (cartões e dica do filtro de status)', () => {
    expect(
      contarTrecho(src, "hint: lab ? LAB_LISTA.cards.ativos(DIAS_SEM_ORCAMENTO_PARA_INATIVO) : 'Com atendimento nos últimos 12 meses' },"),
    ).toBe(1);
    expect(
      contarTrecho(src, "hint: lab ? LAB_LISTA.cards.inativos(DIAS_SEM_ORCAMENTO_PARA_INATIVO) : 'Mais de 12 meses sem atendimento' },"),
    ).toBe(1);
    // undefined não vira atributo: o <select> da clínica fica igual
    expect(contarTrecho(src, 'title={lab ? LAB_LISTA.filtroStatusDica(DIAS_SEM_ORCAMENTO_PARA_INATIVO) : undefined}')).toBe(1);
  });

  it('selo pelo tipo gravado; o rótulo CPF/CNPJ continua pelo documento', () => {
    expect(contarTrecho(src, 'const tipoDoc = lab ? tipoDoDocumento(p.cpf) : null;')).toBe(1);
    expect(contarTrecho(src, 'const tipoCliente = lab ? (p.lab_profile?.kind ?? tipoDoc) : null;')).toBe(1);
    expect(contarTrecho(src, "{LAB_CADASTRO.tipos[tipoCliente ?? 'DENTISTA']}")).toBe(1);
    expect(contarTrecho(src, '{tipoDoc ? LAB_LISTA.documento[tipoDoc] : LAB_LISTA.documentoSemTipo}')).toBe(1);
    expect(contarTrecho(src, ': <span>CPF: {formatCPF(p.cpf)}</span>)}')).toBe(1);
  });
});

describe('F8 — cadastro do cliente (LabClienteModal)', () => {
  const src = ler(MODAL);
  const sf = arvore(MODAL);
  const pos = (trecho: string) => {
    const i = src.indexOf(trecho);
    if (i < 0) throw new Error(`não achei ${trecho}`);
    return i;
  };

  it('a ficha do cliente é gravada depois do PATCH (editar) e depois do POST (novo), antes da foto', () => {
    const chamadas = chamadasDe(sf, 'salvarPerfil');
    expect(chamadas.length).toBe(2);
    const patch = pos('api.patch(');
    const post = pos("api.post('/patients'");
    const avatar = pos('/avatar`');
    const [editar, novo] = chamadas.map((c) => c.getStart(sf));
    expect(editar).toBeGreaterThan(patch);
    expect(editar).toBeLessThan(post);
    expect(novo).toBeGreaterThan(post);
    expect(novo).toBeLessThan(avatar);
    // o PUT de /lab-profile mora em lab-perfil.ts (o modal não monta a rota)
    expect(textosVisiveis(MODAL).filter(({ texto }) => texto.includes('lab-profile'))).toEqual([]);
  });

  it('sem a ficha carregada não vai PUT; falha no editar não fecha o modal; falha no novo segue', () => {
    expect(contarTrecho(src, 'const perfil = perfilPronto ? corpoDoPerfil({ ...form, novoDentista }, tipo, podeVerContato) : null;')).toBe(1);
    const [editar, novo] = chamadasDe(sf, 'salvarPerfil');
    for (const c of [editar, novo]) {
      const se = subirAte(c, ts.isIfStatement);
      expect(se?.expression.getText(sf).startsWith('perfil')).toBe(true);
    }
    const capturaEditar = subirAte(editar, ts.isTryStatement)?.catchClause?.block.getText(sf) ?? '';
    expect(capturaEditar).toContain('LAB_CADASTRO.perfilFalhouEditar(');
    expect(capturaEditar).toContain('return;');
    expect(capturaEditar).not.toContain('onUpdated');
    const capturaNovo = subirAte(novo, ts.isTryStatement)?.catchClause?.block.getText(sf) ?? '';
    expect(capturaNovo).toContain('LAB_CADASTRO.perfilFalhouNovo(');
    expect(capturaNovo).not.toContain('return');
    // o onUpdated do editar vem depois da gravação da ficha
    expect(pos('props.onUpdated();')).toBeGreaterThan(editar.getStart(sf));
  });

  it('o editar trava o Salvar enquanto a ficha carrega', () => {
    expect(contarTrecho(src, "disabled={salvando || perfilEstado === 'carregando'}")).toBe(1);
    expect(contarTrecho(src, "if (salvando || perfilEstado === 'carregando') return;")).toBe(1);
    expect(contarTrecho(src, "useState<EstadoDoPerfil>(() => (editando ? 'carregando' : 'pronto'))")).toBe(1);
  });

  it('o aviso de telefone (/leads/check-phone) só roda para quem vê contato', () => {
    expect(contarTrecho(src, "const podeVerContato = useUserPermissions().hasPermission('view_patient_contact');")).toBe(1);
    const literais: ts.StringLiteral[] = [];
    visitar(sf, (no) => {
      if (ts.isStringLiteral(no) && no.text === '/leads/check-phone') literais.push(no);
    });
    expect(literais.length).toBe(1);
    // o efeito que chama a rota começa saindo quando a pessoa não vê contato
    let efeito: ts.CallExpression | undefined;
    for (let pai = literais[0].parent; pai; pai = pai.parent) {
      if (ts.isCallExpression(pai) && ts.isIdentifier(pai.expression) && pai.expression.text === 'useEffect') {
        efeito = pai;
        break;
      }
    }
    expect(efeito).toBeDefined();
    const fn = efeito!.arguments[0];
    expect(ts.isArrowFunction(fn) && ts.isBlock(fn.body)).toBe(true);
    const primeira = ((fn as ts.ArrowFunction).body as ts.Block).statements[0];
    expect(ts.isIfStatement(primeira)).toBe(true);
    const se = primeira as ts.IfStatement;
    expect(se.expression.getText(sf).startsWith('!podeVerContato ||')).toBe(true);
    expect(ts.isReturnStatement(se.thenStatement)).toBe(true);
    // a 2ª leitura (de quem é o número) fica no mesmo efeito
    expect(efeito!.getText(sf)).toContain('/patients/by-lead/');
    // o aviso também só aparece para quem vê contato
    expect(contarTrecho(src, 'podeVerContato && !telIntocado && avisoTel && avisoTel.chave === chaveDoTel ? avisoTel.nome : null')).toBe(1);
  });

  it('o telefone conferido é o mesmo que o cadastro grava (sem lógica nova de 55)', () => {
    expect(contarTrecho(src, "return `+${ddi || '55'} ${tel.trim()}`;")).toBe(1);
    expect(contarTrecho(src, "api.get('/leads/check-phone', { params: { phone: telefoneComDdi(ddi, form.tel) } })")).toBe(1);
    expect(contarTrecho(src, 'return telefoneComDdi(ddi, tel);')).toBe(1);
  });

  it('o Enter no campo do dentista adiciona o nome sem enviar o formulário', () => {
    const teclas: ts.JsxAttribute[] = [];
    visitar(sf, (no) => {
      if (ts.isJsxAttribute(no) && no.name.getText(sf) === 'onKeyDown') teclas.push(no);
    });
    expect(teclas.length).toBe(1);
    const corpo = semEspacos(teclas[0].getText(sf));
    expect(corpo).toContain(semEspacos("if (e.key === 'Enter') {"));
    expect(corpo).toContain('e.preventDefault();');
    expect(corpo).toContain('adicionarDentista();');
  });

  it('dentistas que pedem trabalhos: só clínica e no máximo MAX_DENTISTAS_SOLICITANTES', () => {
    expect(contarTrecho(src, '{ehClinica && (')).toBeGreaterThanOrEqual(1);
    expect(contarTrecho(src, 'const listaCheia = form.dentistas.length >= MAX_DENTISTAS_SOLICITANTES;')).toBe(1);
    expect(contarTrecho(src, 'if (lista.length > MAX_DENTISTAS_SOLICITANTES) return;')).toBe(1);
  });

  it('os hooks ficam no topo de cada componente, antes de qualquer return', () => {
    expect([...hooksForaDoTopo(MODAL), ...hooksForaDoTopo(NA_FICHA)]).toEqual([]);
  });
});

describe('F8 — lab-perfil.ts (ficha do cliente no web)', () => {
  const src = ler(PERFIL);

  it('lê e grava só pela rota da ficha do cliente', () => {
    expect((src.match(/\bapi\s*\.\s*(get|post|put|patch|delete)\b/g) ?? []).map(semEspacos)).toEqual(['api.get', 'api.put']);
    expect(contarTrecho(src, 'await api.get(`/patients/${patientId}/lab-profile`);')).toBe(1);
    expect(contarTrecho(src, 'await api.put(`/patients/${patientId}/lab-profile`, escolherChaves(corpo));')).toBe(1);
  });

  it('o corpo leva só as chaves do perfil e não leva o telefone de quem não vê contato', () => {
    expect(contarTrecho(src, 'for (const chave of CAMPOS_DO_PERFIL) {')).toBe(1);
    expect(contarTrecho(src, 'if (podeVerContato) corpo.contact_phone = textoOuNulo(form.contatoTel);')).toBe(1);
  });

  describe('rodando o módulo (api simulada)', () => {
    const { mod, chamadas, respostas } = carregarPerfilWeb();
    const vazio = {
      cro: '',
      croUf: '',
      razaoSocial: '',
      clinicaOndeAtende: '',
      contatoNome: '',
      contatoTel: '',
      entrega: '',
      dentistas: [] as string[],
    };
    beforeEach(() => {
      chamadas.length = 0;
    });

    it('formulário vazio: as 9 chaves, null no vazio e [] na lista', () => {
      const corpo = mod.corpoDoPerfil(vazio, 'DENTISTA', true);
      expect(Object.keys(corpo).sort()).toEqual([...shared.CAMPOS_DO_PERFIL].sort());
      expect(corpo).toEqual({
        kind: 'DENTISTA',
        cro_number: null,
        cro_uf: null,
        legal_name: null,
        clinic_name: null,
        contact_name: null,
        contact_phone: null,
        requesting_dentists: [],
        delivery_notes: null,
      });
    });

    it('sem view_patient_contact o corpo não leva contact_phone (o null apagaria o gravado)', () => {
      const corpo = mod.corpoDoPerfil({ ...vazio, contatoTel: '(82) 3333-4444' }, 'CLINICA', false);
      expect(Object.prototype.hasOwnProperty.call(corpo, 'contact_phone')).toBe(false);
      expect(Object.keys(corpo).length).toBe(8);
      expect(mod.corpoDoPerfil({ ...vazio, contatoTel: ' (82) 3333-4444 ' }, 'CLINICA', true).contact_phone).toBe('(82) 3333-4444');
    });

    it('clínica: razão social e dentistas (com o nome digitado e não adicionado), sem clínica onde atende', () => {
      const corpo = mod.corpoDoPerfil(
        { ...vazio, cro: '12345', croUf: 'AL', razaoSocial: ' Sorriso Ltda ', clinicaOndeAtende: 'X', dentistas: ['Dr. Ana'], novoDentista: ' dr.  ANA ' },
        'CLINICA',
        true,
      );
      expect(corpo).toMatchObject({ kind: 'CLINICA', cro_number: '12345', cro_uf: 'AL', legal_name: 'Sorriso Ltda', clinic_name: null });
      expect(corpo.requesting_dentists).toEqual(['Dr. Ana']);
      expect(mod.corpoDoPerfil({ ...vazio, dentistas: ['Dr. Ana'], novoDentista: 'Dra. Bia' }, 'CLINICA', true).requesting_dentists).toEqual([
        'Dr. Ana',
        'Dra. Bia',
      ]);
    });

    it('dentista: clínica onde atende, lista vazia e UF só com o número', () => {
      const corpo = mod.corpoDoPerfil(
        { ...vazio, croUf: 'AL', razaoSocial: 'Y', clinicaOndeAtende: ' Clínica Sorriso ', dentistas: ['Dr. Ana'], novoDentista: 'Dra. Bia' },
        'DENTISTA',
        true,
      );
      expect(corpo).toMatchObject({ kind: 'DENTISTA', cro_number: null, cro_uf: null, legal_name: null, clinic_name: 'Clínica Sorriso' });
      expect(corpo.requesting_dentists).toEqual([]);
    });

    it('o PUT leva só as chaves aceitas (nada de gravado, patient_id ou updated_at)', async () => {
      respostas.put = { patient_id: 'p1', gravado: true, updated_at: null, kind: 'DENTISTA', requesting_dentists: [] };
      await mod.salvarPerfil('p1', { kind: 'DENTISTA', cro_number: '1', gravado: true, patient_id: 'p1', updated_at: 'x' });
      expect(chamadas).toEqual([['put', '/patients/p1/lab-profile', { kind: 'DENTISTA', cro_number: '1' }]]);
    });

    it('o GET devolve a ficha com as chaves de sempre (lista nunca nula, tipo pelo documento sem ficha)', async () => {
      respostas.get = { patient_id: 'p1', gravado: false, updated_at: null, kind: 'CLINICA', requesting_dentists: null };
      const p = await mod.carregarPerfil('p1', '11.222.333/0001-81');
      expect(chamadas).toEqual([['get', '/patients/p1/lab-profile']]);
      expect(p).toMatchObject({ patient_id: 'p1', gravado: false, kind: 'CLINICA', cro_number: null, requesting_dentists: [] });
      respostas.get = '';
      await expect(mod.carregarPerfil('p1', null)).rejects.toThrow();
    });

    it('CRO só com dígitos e telefone do contato com 10 ou 11 dígitos', () => {
      expect(mod.soDigitosDoCro('AL-12.345678999')).toBe('12345678');
      expect(mod.telefoneDoContatoOk('')).toBe(true);
      expect(mod.telefoneDoContatoOk('(82) 3333-4444')).toBe(true);
      expect(mod.telefoneDoContatoOk('(82) 99999-4444')).toBe(true);
      expect(mod.telefoneDoContatoOk('(82) 3333-444')).toBe(false);
    });
  });
});

describe('F8 — textos do laboratório (lab-dentistas-textos.ts)', () => {
  const textos = carregarTextos();

  it('os cartões e o filtro dizem os 90 dias sem orçamento', () => {
    expect(DIAS_SEM_ORCAMENTO_PARA_INATIVO).toBe(90);
    expect(textos.LAB_LISTA.cards.ativos(90)).toContain('90');
    expect(textos.LAB_LISTA.cards.inativos(90)).toContain('90');
    expect(textos.LAB_LISTA.filtroStatusDica(90)).toContain('90');
    expect(textos.LAB_LISTA.cards.inativos(90)).toBe('Sem orçamento há mais de 90 dias');
  });

  it('CRO na lista e na ficha', () => {
    expect(textos.LAB_LISTA.cro('AL', '12345')).toBe('CRO-AL 12345');
    expect(textos.LAB_LISTA.cro(null, '12345')).toBe('CRO 12345');
    expect(textos.LAB_FICHA.croValor('AL', '12345')).toBe('AL 12345');
    expect(textos.LAB_FICHA.croValor(null, '12345')).toBe('12345');
  });

  it('o aviso de campo faltando lista CRO e UF do CRO', () => {
    const { campos, preencha } = textos.LAB_CADASTRO;
    expect(preencha([campos.cro, campos.croUf].join(', '))).toBe('Preencha: CRO, UF do CRO.');
  });

  it('só tem consts LAB_ exportadas (e o import de tipo)', () => {
    const sf = arvore(TEXTOS);
    const outras: string[] = [];
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && st.importClause?.isTypeOnly) continue;
      const exportada = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (ts.isVariableStatement(st) && exportada && (st.declarationList.flags & ts.NodeFlags.Const) !== 0) {
        for (const d of st.declarationList.declarations) if (!d.name.getText(sf).startsWith('LAB_')) outras.push(d.name.getText(sf));
      } else {
        outras.push(st.getText(sf).slice(0, 60));
      }
    }
    expect(outras).toEqual([]);
  });
});

describe('F8 — arquivos só do laboratório', () => {
  it.each([[NA_FICHA], [PERFIL], [TEXTOS], [MODAL]])('%s: nenhum texto visível com palavra de clínica', (arq) => {
    const ruins = textosVisiveis(arq)
      .filter(({ texto }) => temPalavraDeClinica(texto))
      .map(({ texto, linha }) => `${arq}:${linha} ${JSON.stringify(texto)}`);
    expect(ruins).toEqual([]);
  });

  it.each([[NA_FICHA], [PERFIL], [TEXTOS], [MODAL]])('%s: nenhuma chamada a rota só de clínica', (arq) => {
    const src = ler(arq);
    expect(ROTAS_DE_CLINICA.filter((r) => src.includes(r)).map((r) => `${arq} cita ${r}`)).toEqual([]);
  });

  it.each([[NA_FICHA], [PERFIL]])('%s: sem pickBt( e sem const LAB_', (arq) => {
    const src = ler(arq);
    expect(src.match(/\bpickBt\s*\(/g) ?? []).toEqual([]);
    expect(src.match(/\b(?:const|let|var)\s+LAB_\w*/g) ?? []).toEqual([]);
  });

  it('a ficha só lê no laboratório (defesa no 1º quadro) e o Tipo cai no documento sem ficha', () => {
    const src = ler(NA_FICHA);
    expect(contarTrecho(src, 'if (!isLab(btAgora())) return;')).toBe(1);
    expect(contarTrecho(src, 'carregarPerfil(cadastro.id, cadastro.cpf)')).toBe(1);
    expect(contarTrecho(src, 'const tipo = tipoDoCliente(p?.kind ?? null, cadastro.cpf);')).toBe(1);
    expect(src.includes('api.')).toBe(false);
  });
});
