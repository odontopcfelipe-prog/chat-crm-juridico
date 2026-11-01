/**
 * F7 do laboratório — casca do /atendimento com a agenda e a Central de Disparos:
 * Início do laboratório (atalhos da Agenda e da Central e o quadro das próximas
 * coletas, provas e entregas), o protético que abre a agenda no laboratório, a busca
 * da agenda no topo, o subtítulo da Agenda no Ctrl+K, o clique no alerta de tarefa e o
 * botão "Agendar coleta" da ficha do cliente.
 *
 * Os arquivos da clínica (layout, ficha, busca, Ctrl+K e alerta) ganham só portão e
 * texto importado (`lab ? LAB_X.y : 'texto de hoje'`), sem pickBt nem const LAB_. Por
 * isso a trava 1 de scripts/ci/check-pick-literals.mjs não os enxerga, e este spec faz
 * a guarda pelo AST:
 *   - os textos e trechos da clínica perto dos portões continuam com a contagem do
 *     commit de partida (9eb61bff). É uma LISTA dos literais vizinhos, não um retrato do
 *     arquivo inteiro: edição normal da clínica continua livre;
 *   - cada portão tem a forma combinada, e o ramo da clínica fica igual;
 *   - os hooks ficam no topo do componente, antes de qualquer return;
 *   - os textos novos do laboratório não têm palavra de clínica;
 *   - o Início lê só a listagem de eventos da agenda (liberada) e filtra pelos tipos
 *     do laboratório.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { TIPOS_SO_DO_LABORATORIO, tipoSoDoLaboratorio } from '@crm/shared';
import { temPalavraDeClinica } from '../business-type/lab-vocab.interceptor';
import { rotaDoLaboratorio } from '../business-type/lab-route-policy';

const RAIZ = path.resolve(__dirname, '..', '..', '..', '..');
const ler = (arq: string): string => {
  const p = path.join(RAIZ, arq);
  if (!fs.existsSync(p)) throw new Error(`${arq} não existe`);
  return fs.readFileSync(p, 'utf8');
};

const W = 'apps/web/src/app/atendimento';
const LAYOUT = `${W}/layout.tsx`;
const FICHA = `${W}/pacientes/[id]/page.tsx`;
const BUSCA = `${W}/components/ContextualSearchModal.tsx`;
const PALETA = `${W}/components/GlobalCommandPalette.tsx`;
const ALERTA = `${W}/components/TaskAlertPopup.tsx`;
const INICIO = 'apps/web/src/components/home/LabInicio.tsx';
const CASCA_TEXTOS = 'apps/web/src/lib/lab-casca-textos.ts';

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

/** Contagem dos textos do arquivo (string, template e texto de JSX), fora import/export e tipos. */
function contarTextos(arq: string): Map<string, number> {
  const m = new Map<string, number>();
  const guardar = (t: string) => {
    const s = t.replace(/\s+/g, ' ').trim();
    if (s) m.set(s, (m.get(s) || 0) + 1);
  };
  const andar = (no: ts.Node): void => {
    if (ehTipo(no) || ts.isImportDeclaration(no) || ts.isExportDeclaration(no)) return;
    if (ts.isStringLiteral(no) || ts.isNoSubstitutionTemplateLiteral(no)) guardar(no.text);
    else if (ts.isTemplateHead(no) || ts.isTemplateMiddle(no) || ts.isTemplateTail(no)) guardar(no.text);
    else if (ts.isJsxText(no)) guardar(no.text);
    ts.forEachChild(no, andar);
  };
  andar(arvore(arq));
  return m;
}

/** Textos dentro do inicializador de cada const LAB_ do arquivo. */
function textosDoLab(arq: string): Array<{ nome: string; texto: string }> {
  const out: Array<{ nome: string; texto: string }> = [];
  const coletar = (nome: string, no: ts.Node): void => {
    if (ehTipo(no)) return;
    if (ts.isStringLiteral(no) || ts.isNoSubstitutionTemplateLiteral(no)) out.push({ nome, texto: no.text });
    else if (ts.isTemplateHead(no) || ts.isTemplateMiddle(no) || ts.isTemplateTail(no)) out.push({ nome, texto: no.text });
    ts.forEachChild(no, (f) => coletar(nome, f));
  };
  visitar(arvore(arq), (no) => {
    if (ts.isVariableDeclaration(no) && ts.isIdentifier(no.name) && no.name.text.startsWith('LAB_') && no.initializer) {
      coletar(no.name.text, no.initializer);
    }
  });
  return out;
}

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

/** Operandos da cadeia `… && X` mais próxima que tem o nó do lado direito. */
function portaoDe(no: ts.Node): ts.Expression[] | null {
  let filho: ts.Node = no;
  for (let pai = no.parent; pai; filho = pai, pai = pai.parent) {
    if (ts.isBinaryExpression(pai) && pai.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && pai.right === filho) {
      return operandosDoE(pai);
    }
  }
  return null;
}

/** Botões <button> cujo conteúdo tem o trecho dado (texto de JSX ou expressão). */
function botoesCom(sf: ts.SourceFile, trecho: string): ts.JsxElement[] {
  const out: ts.JsxElement[] = [];
  visitar(sf, (no) => {
    if (!ts.isJsxElement(no) || no.openingElement.tagName.getText(sf) !== 'button') return;
    const conteudo = no.children.map((c) => (ts.isJsxText(c) ? c.text.replace(/\s+/g, ' ').trim() : c.getText(sf))).join(' ');
    if (conteudo.split(' ').includes(trecho) || conteudo.includes(`{${trecho}}`)) out.push(no);
  });
  return out;
}

const CAMINHO_DO_HOOK = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.CallExpression,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.VariableDeclarationList,
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.ExpressionStatement,
]);

/**
 * Cada hook (useX(...)) de um componente (função com nome em maiúscula) tem de estar
 * numa instrução DIRETA do corpo (fora de if, laço, callback, ?:, && ou ||) e antes de
 * qualquer return do componente.
 */
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

/**
 * Textos e trechos da clínica perto dos portões da F7, com a contagem de 9eb61bff
 * (gerada de `git show 9eb61bff:<arquivo>` antes da edição).
 */
const CLINICA: Record<string, { textos: Array<[string, number]>; trechos: Array<[string, number]> }> = {
  [BUSCA]: {
    textos: [
      ['Localizar na agenda', 1],
      ['Buscar por paciente ou evento…', 1],
      ['Digite o nome do paciente ou do evento', 1],
      ['Localizar contato', 1],
      ['Evento', 1],
      ['/calendar/search', 1],
      ['open_event_id', 1],
      ['/atendimento/agenda', 1],
    ],
    trechos: [
      [
        "agenda: { title: 'Localizar na agenda', placeholder: 'Buscar por paciente ou evento…', hint: 'Digite o nome do paciente ou do evento' },",
        1,
      ],
      ["sessionStorage.setItem('open_event_id', e.id);", 1],
    ],
  },
  [PALETA]: {
    textos: [
      ['Agenda', 1],
      ['Compromissos e audiências', 1],
      ['nav-agenda', 1],
      ['/atendimento/agenda', 1],
    ],
    trechos: [
      [
        "{ id: 'nav-agenda',     label: 'Agenda',                  sublabel: 'Compromissos e audiências',     href: '/atendimento/agenda',              icon: <Calendar size={14} className=\"text-sky-400\" /> },",
        1,
      ],
      ['sublabel: n.sublabel,', 1],
    ],
  },
  [ALERTA]: {
    textos: [['open_event_id', 1]],
    trechos: [
      ["sessionStorage.setItem('open_event_id', taskId);", 1],
      ["router.push('/atendimento/agenda');", 1],
    ],
  },
  [LAYOUT]: {
    textos: [
      ['dentista', 2],
      ['manage_agenda', 1],
      // +2 no ramo do laboratório da aba Agenda do protético (o da clínica segue em /minha-agenda)
      ['/atendimento/agenda', 6],
      ['/atendimento/minha-agenda', 3],
    ],
    trechos: [
      ["if (permsReady && dentistListAgenda) router.replace('/atendimento/minha-agenda');", 1],
      ["&& !hasPermission('manage_agenda')", 1],
      ["&& pathname.startsWith('/atendimento/agenda');", 1],
      ["href: lab ? '/atendimento/agenda' : '/atendimento/minha-agenda', icon: Calendar, match: (p: string) => p.startsWith(lab ? '/atendimento/agenda' : '/atendimento/minha-agenda'),", 1],
    ],
  },
  [FICHA]: {
    textos: [
      ['Agendar', 1],
      ['Agendar consulta para este paciente', 1],
    ],
    trechos: [
      ["{!lab && patient.status !== 'ARCHIVED' && canSchedule && (", 1],
      ["patient_name: patient.name || '',", 1],
      ["phone: patient.phone || '',", 1],
    ],
  },
};

describe('F7 — casca do laboratório: clínica intacta', () => {
  it.each([[LAYOUT], [FICHA], [BUSCA], [PALETA], [ALERTA]])('%s: sem pickBt( e sem const LAB_ (só portão e texto importado)', (arq) => {
    const src = ler(arq);
    expect(src.match(/\bpickBt\s*\(/g) ?? []).toEqual([]);
    expect(src.match(/\b(?:const|let|var)\s+LAB_\w*/g) ?? []).toEqual([]);
  });

  it.each(Object.keys(CLINICA).map((a) => [a]))('%s: textos e trechos da clínica com a contagem de 9eb61bff', (arq) => {
    const fonte = ler(arq);
    const textos = contarTextos(arq);
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

  it('os hooks ficam no topo de cada componente, antes de qualquer return', () => {
    expect([...hooksForaDoTopo(INICIO), ...hooksForaDoTopo(BUSCA), ...hooksForaDoTopo(PALETA), ...hooksForaDoTopo(ALERTA)]).toEqual([]);
  });

  it('layout: só o laboratório deixa de mandar o protético para /minha-agenda', () => {
    const src = ler(LAYOUT);
    expect(contarTrecho(src, "const dentistListAgenda = !lab && permSector === 'dentista'")).toBe(1);
    expect(contarTrecho(src, 'const lab = isLab(bt);')).toBe(1);
  });

  it('busca do topo: o texto do laboratório só entra na agenda e com lab', () => {
    const src = ler(BUSCA);
    expect(contarTrecho(src, 'const lab = isLab(useBusinessType());')).toBe(1);
    expect(contarTrecho(src, "const cfg = kind === 'agenda' && lab ? LAB_BUSCA_AGENDA : CONFIG[kind];")).toBe(1);
    expect(contarTrecho(src, 'CONFIG[kind]')).toBe(1);
  });

  it('Ctrl+K: NAV_ITEMS fica igual e o subtítulo do laboratório só entra com lab', () => {
    const src = ler(PALETA);
    expect(contarTrecho(src, 'const lab = isLab(bt);')).toBe(1);
    expect(contarTrecho(src, 'const sublabelDoLab = lab ? LAB_ATALHOS_SUBLABEL[n.id] : undefined;')).toBe(1);
    expect(contarTrecho(src, 'return sublabelDoLab ? { ...n, sublabel: sublabelDoLab } : n;')).toBe(1);
  });

  it('alerta de tarefa: no laboratório o clique abre a agenda quando ela está na lista de rotas', () => {
    const src = ler(ALERTA);
    expect(contarTrecho(src, "if (lab && !labAllowsRoute('/atendimento/agenda')) return;")).toBe(1);
    expect(contarTrecho(src, 'if (lab) return;')).toBe(0);
  });
});

describe('F7 — ficha do cliente: "Agendar coleta"', () => {
  const sf = arvore(FICHA);
  const src = ler(FICHA);

  it('o "Agendar" da clínica continua só fora do laboratório, com o mesmo link', () => {
    const botoes = botoesCom(sf, 'Agendar');
    expect(botoes.length).toBe(1);
    const portao = portaoDe(botoes[0])?.map((op) => op.getText(sf)) ?? [];
    expect(portao).toEqual(['canSchedule', "patient.status !== 'ARCHIVED'", '!lab']);
    expect(botoes[0].getText(sf)).toContain("router.push(`/atendimento/agenda?${params.toString()}`);");
    expect(botoes[0].getText(sf)).toContain("patient_name: patient.name || '',");
  });

  it('o "Agendar coleta" só aparece no laboratório, com a agenda na lista e quem marca na agenda', () => {
    const botoes = botoesCom(sf, 'LAB_FICHA_AGENDA.agendarColeta');
    expect(botoes.length).toBe(1);
    const portao = portaoDe(botoes[0])?.map((op) => op.getText(sf)) ?? [];
    expect(portao).toEqual(['canSchedule', "patient.status !== 'ARCHIVED'", "labAllowsRoute('/atendimento/agenda')", 'lab']);
    expect(botoes[0].getText(sf)).toContain("new URLSearchParams({ new: '1', patient_id: patient.id, type: 'COLETA' })");
    expect(botoes[0].getText(sf)).toContain('router.push(`/atendimento/agenda?${params.toString()}`);');
    expect(botoes[0].getText(sf)).toContain('title={LAB_FICHA_AGENDA.dica}');
  });

  it('o link leva à agenda com new=1, o cliente e o tipo Coleta (tipo do laboratório)', () => {
    expect(new URLSearchParams({ new: '1', patient_id: 'c1', type: 'COLETA' }).toString()).toBe('new=1&patient_id=c1&type=COLETA');
    expect(TIPOS_SO_DO_LABORATORIO).toContain('COLETA');
    expect(src.match(/'COLETA'/g)?.length).toBe(1);
  });
});

describe('F7 — Início do laboratório: Agenda, Central e próximas visitas', () => {
  const src = ler(INICIO);

  it('a única rota de agenda que o Início chama é a listagem de eventos (liberada no laboratório)', () => {
    // (o comentário do topo também cita a rota: vale o conjunto)
    expect([...new Set(src.match(/\/calendar\/[\w/-]*/g) ?? [])]).toEqual(['/calendar/events']);
    expect(contarTrecho(src, "api.get<EventoDaAgenda[]>('/calendar/events', {")).toBe(1);
    expect((src.match(/\bapi\s*\.\s*(get|post|put|patch|delete)\b/g) ?? []).map(semEspacos)).toEqual(['api.get']);
    const inventario = JSON.parse(fs.readFileSync(path.join(__dirname, 'inventario.json'), 'utf8')) as {
      controllers: Array<{ handlers: Array<{ metodo: string; rota: string }> }>;
    };
    const handler = inventario.controllers.flatMap((c) => c.handlers).find((h) => h.rota === 'GET /calendar/events');
    expect(handler?.metodo).toBe('CalendarController.findAll');
    expect(rotaDoLaboratorio('CalendarController.findAll')).toBe(true);
  });

  it('o quadro só lê para quem abre a agenda, na sessão de laboratório, e some no erro', () => {
    expect(
      contarTrecho(src, 'const verProximas = proprio && permissoesProntas && canAccessRouteBt(AGENDA, hasPermission, BT_LABORATORIO);'),
    ).toBe(1);
    expect(contarTrecho(src, 'if (!verProximas || !isLab(btAgora())) {')).toBe(1);
    expect(contarTrecho(src, "const AGENDA = '/atendimento/agenda';")).toBe(1);
    expect(contarTrecho(src, '{verProximas && proximas && (')).toBe(1);
    expect(contarTrecho(src, 'if (!cancelado) setProximas(null);')).toBe(1);
  });

  it('janela naive-UTC: de agora (Date.now() − 3 h) até 7 dias depois', () => {
    expect(contarTrecho(src, 'const TRES_HORAS_MS = 3 * 60 * 60 * 1000;')).toBe(1);
    expect(contarTrecho(src, 'const SETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;')).toBe(1);
    expect(contarTrecho(src, 'const agora = Date.now() - TRES_HORAS_MS;')).toBe(1);
    expect(
      contarTrecho(src, 'params: { start: new Date(agora).toISOString(), end: new Date(agora + SETE_DIAS_MS).toISOString() },'),
    ).toBe(1);
    // dia e hora da agenda naive-UTC (getUTC*), nunca toLocale*
    expect(contarTrecho(src, '{dataCurtaNaive(ev.start_at)}')).toBe(1);
    expect(contarTrecho(src, '{horaCurtaNaive(ev.start_at)}')).toBe(1);
    expect(src.includes('toLocale')).toBe(false);
  });

  it('a lista: só coleta, prova e entrega que ainda vão acontecer, por horário, no máximo 5', () => {
    // Roda as declarações do próprio arquivo (FORA_DAS_PROXIMAS, MAXIMO_DE_PROXIMAS e proximasDaLista).
    const sf = arvore(INICIO);
    const nomes = new Set(['FORA_DAS_PROXIMAS', 'MAXIMO_DE_PROXIMAS', 'proximasDaLista']);
    const partes = sf.statements
      .filter(
        (st) =>
          (ts.isFunctionDeclaration(st) && st.name && nomes.has(st.name.text)) ||
          (ts.isVariableStatement(st) &&
            st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && nomes.has(d.name.text))),
      )
      .map((st) => st.getText(sf));
    expect(partes.length).toBe(3);
    const js = ts.transpileModule(partes.join('\n'), {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
    }).outputText;
    const proximasDaLista = new Function('tipoSoDoLaboratorio', `${js}\nreturn proximasDaLista;`)(tipoSoDoLaboratorio) as (
      lista: unknown,
    ) => Array<{ id: string }>;
    const ev = (id: string, type: string, start_at: string, status = 'AGENDADO') => ({ id, type, start_at, status });
    const lista = [
      ev('c1', 'CONSULTA', '2026-11-02T09:00:00.000Z'),
      ev('t1', 'TAREFA', '2026-11-02T08:00:00.000Z'),
      ev('e1', 'ENTREGA', '2026-11-03T10:00:00.000Z'),
      ev('k1', 'COLETA', '2026-11-02T09:30:00.000Z'),
      ev('p1', 'PROVA', '2026-11-02T14:00:00.000Z', 'CONFIRMADO'),
      ev('x1', 'COLETA', '2026-11-02T11:00:00.000Z', 'CANCELADO'),
      ev('x2', 'PROVA', '2026-11-02T12:00:00.000Z', 'NO_SHOW'),
      ev('x3', 'ENTREGA', '2026-11-02T13:00:00.000Z', 'CONCLUIDO'),
      ev('k2', 'COLETA', '2026-11-04T08:00:00.000Z'),
      ev('k3', 'COLETA', '2026-11-05T08:00:00.000Z'),
      ev('k4', 'COLETA', '2026-11-06T08:00:00.000Z'),
    ];
    expect(proximasDaLista(lista).map((e) => e.id)).toEqual(['k1', 'p1', 'e1', 'k2', 'k3']);
    expect(proximasDaLista(null)).toEqual([]);
    expect(proximasDaLista({ data: lista })).toEqual([]);
  });

  it('atalhos: Agenda pelos balões do setor e Central de Disparos para quem abre a tela', () => {
    expect(contarTrecho(src, "'/atendimento/agenda': 'agenda',")).toBe(1);
    expect(contarTrecho(src, "const CENTRAL = '/atendimento/settings/disparos';")).toBe(1);
    expect(
      contarTrecho(src, 'if (proprio && !atalhos.some((x) => x.href === CENTRAL) && canAccessRouteBt(CENTRAL, hasPermission, BT_LABORATORIO)) {'),
    ).toBe(1);
    expect(contarTrecho(src, "atalhos.push({ href: CENTRAL, chave: 'avisos', lucide: 'Send' });")).toBe(1);
    expect(src).toMatch(/agenda: CalendarArt,\s*avisos: GearArt,/);
    // o balão da lista do protético (/minha-agenda, fechada no laboratório) leva à agenda;
    // o atalho de cada balão continua passando pela lista de rotas do laboratório
    expect(contarTrecho(src, "const href = a.href === '/atendimento/minha-agenda' ? AGENDA : a.href;")).toBe(1);
    expect(contarTrecho(src, 'if (!canAccessRouteBt(href, hasPermission, BT_LABORATORIO)) continue;')).toBe(1);
  });

  it('o clique numa visita abre o evento na agenda (o mesmo caminho da busca do topo)', () => {
    expect(contarTrecho(src, "sessionStorage.setItem('open_event_id', id);")).toBe(1);
    expect(contarTrecho(src, '<Link href={AGENDA} className="dh-task" onClick={() => abrirNaAgenda(ev.id)}>')).toBe(1);
  });
});

describe('F7 — textos da casca do laboratório (lab-casca-textos.ts)', () => {
  it('só tem consts LAB_ exportadas', () => {
    const sf = arvore(CASCA_TEXTOS);
    const outras: string[] = [];
    const nomes: string[] = [];
    for (const st of sf.statements) {
      const exportada = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (ts.isVariableStatement(st) && exportada && (st.declarationList.flags & ts.NodeFlags.Const) !== 0) {
        for (const d of st.declarationList.declarations) nomes.push(d.name.getText(sf));
      } else {
        outras.push(st.getText(sf).slice(0, 60));
      }
    }
    expect(outras).toEqual([]);
    expect(nomes.filter((n) => !n.startsWith('LAB_'))).toEqual([]);
    expect(nomes).toEqual(expect.arrayContaining(['LAB_PROXIMAS', 'LAB_BUSCA_AGENDA', 'LAB_ATALHOS_SUBLABEL', 'LAB_FICHA_AGENDA']));
  });

  it('os textos novos da F7', () => {
    const src = ler(CASCA_TEXTOS);
    for (const linha of [
      "agenda: Object.freeze({ label: 'Agenda', desc: 'Coletas, provas e entregas nos consultórios.' }),",
      "avisos: Object.freeze({ label: 'Central de Disparos', desc: 'Avisos automáticos para os clientes e a equipe.' }),",
      "titulo: 'Próximas coletas, provas e entregas',",
      "vazio: 'Nada marcado para os próximos 7 dias.',",
      "abrir: 'Abrir a agenda',",
      "semCliente: 'Sem cliente',",
      "title: 'Localizar na agenda',",
      "placeholder: 'Buscar por cliente ou evento…',",
      "hint: 'Digite o nome do cliente ou do evento',",
      "'nav-agenda': 'Coletas, provas e entregas',",
      "agendarColeta: 'Agendar coleta',",
    ]) {
      expect(src).toContain(linha);
    }
  });

  it('nenhum texto do laboratório com palavra de clínica', () => {
    const ruins = textosDoLab(CASCA_TEXTOS)
      .filter(({ texto }) => temPalavraDeClinica(texto))
      .map(({ nome, texto }) => `${nome}: ${JSON.stringify(texto)}`);
    expect(ruins).toEqual([]);
  });
});
