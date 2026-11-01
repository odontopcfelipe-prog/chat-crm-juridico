/**
 * F7 do laboratório — tela da agenda (/atendimento/agenda) no laboratório: tipos Coleta,
 * Prova e Entrega, cliente/contato no lugar de paciente/lead, responsável (qualquer pessoa
 * da equipe), status Agendado/Confirmado/Feito/Desmarcado/Não realizado, sem Bloquear,
 * Validar, Notificar, Avaliação, Retornos e a sugestão da IA nas tarefas.
 *
 * Os arquivos da agenda são da clínica e ganham só portão e texto importado
 * (`lab ? LAB_X.y : 'texto de hoje'`), sem pickBt nem const LAB_. Por isso a trava 1 de
 * scripts/ci/check-pick-literals.mjs não os enxerga, e este spec faz a guarda:
 *   - os textos e trechos da clínica continuam com a contagem do commit de partida (9eb61bff);
 *   - o hook do tipo de conta fica no topo de cada componente (antes de qualquer return);
 *   - os portões `!lab` dos botões e chamadas que o laboratório não tem;
 *   - os textos do laboratório (lab-agenda-textos.ts) só em const LAB_, sem palavra de
 *     clínica, e com os tipos e status combinados.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import * as shared from '@crm/shared';
import { TIPOS_DE_AGENDA_DO_LABORATORIO, TIPOS_SO_DO_LABORATORIO } from '@crm/shared';
import { temPalavraDeClinica } from '../business-type/lab-vocab.interceptor';

const RAIZ = path.resolve(__dirname, '..', '..', '..', '..');
const ler = (arq: string): string => {
  const p = path.join(RAIZ, arq);
  if (!fs.existsSync(p)) throw new Error(`${arq} não existe`);
  return fs.readFileSync(p, 'utf8');
};

const PASTA = 'apps/web/src/app/atendimento/agenda';
const PAGINA = `${PASTA}/page.tsx`;
const CONTATO = `${PASTA}/ContactPicker.tsx`;
const TAREFAS = `${PASTA}/TasksPanel.tsx`;
const LISTA = `${PASTA}/AgendaListView.tsx`;
const PROFISSIONAL = `${PASTA}/AgendaResourceLayout.tsx`;
const COLUNAS = `${PASTA}/AgendaResourceView.tsx`;
const TEXTOS = `${PASTA}/lab-agenda-textos.ts`;

const ARQUIVOS_DA_CLINICA = [PAGINA, CONTATO, TAREFAS, LISTA, PROFISSIONAL, COLUNAS];

/**
 * Textos (string, partes fixas de template e texto de JSX, com espaços juntados e
 * aparados) e trechos crus de código da clínica, com a contagem de 9eb61bff.
 */
const CLINICA: Record<string, { textos: Array<[string, number]>; trechos: Array<[string, number]> }> = {
  [PAGINA]: {
    textos: [
      ['Consulta', 2],
      ['Procedimento', 2],
      ['Retorno', 2],
      ['Ortodontia', 2],
      ['Bloqueio', 2],
      ['Tarefa', 2],
      ['Outro', 1],
      ['Agendado', 2],
      ['Confirmado', 2],
      ['Chegou', 2],
      ['Em atendimento', 2],
      ['Atendido', 3],
      ['Desmarcou', 2],
      ['Faltou', 2],
      ['A Fazer', 1],
      ['Em Andamento', 1],
      ['Avaliação', 2],
      ['CONSULTA', 7],
      ['Dentista', 1],
      ['Paciente', 2],
      ['Filtrar agenda por dentista', 1],
      ['Todos os dentistas', 1],
      ['barra à esquerda = dentista', 1],
      ['Abrir ficha do paciente', 1],
      ['Paciente sem nome', 1],
      ['Dentista / Responsavel', 1],
      ['Paciente / Lead', 1],
      ['Avaliação / consulta com...', 1],
      ['Procedimento — ex: Instalação de implante', 1],
      ['Retorno pós-tratamento', 1],
      ['Bloqueio — ex: Folga / Congresso', 1],
      ['Titulo do evento', 1],
      ['/users/lawyers', 1],
      ['Bloquear', 1],
      ['Bloquear agenda (férias, doença, etc)', 1],
      ['Validar atendimento clinicamente', 1],
      ['Atendimento validado', 2],
      ['Notificar', 1],
      ['Reenviar notificação WhatsApp ao paciente', 1],
      ['Avaliação — abre odontograma do paciente', 1],
      ['Exportar .ics', 1],
      ['.ics', 2],
      ['Informe o título do evento', 1],
      ['Informe a data do evento', 1],
      ['Tipos', 1],
      ['/calendar/reminders/config', 1],
      ['/calendar/events', 3],
    ],
    trechos: [
      ["const titleBase = presetType && presetType.id !== 'CONSULTA' ? presetType.label : (labAgora ? LAB_AGENDA_UI.tituloPadrao : 'Avaliação');", 1],
      ['title: patientName ? `${titleBase} — ${patientName}` : titleBase,', 1],
      ['...(presetType ? { type: presetType.id } : {}),', 1],
      ['const statusClass = PATIENT_APPT_TYPES.includes(e.type) || visita', 1],
      ['const isCardType = AGENDA_CARD_TYPES.includes(e.type) || visita;', 1],
      ["const ant = Array.isArray(r.data?.default_antecedencias) ? r.data.default_antecedencias : null;", 1],
      ["showError(e?.response?.data?.message || e?.message || 'Erro ao reenviar notificação');", 1],
    ],
  },
  [CONTATO]: {
    textos: [
      ['erro ao carregar pacientes', 1],
      ['erro ao carregar leads', 1],
      ['Carregando paciente...', 1],
      ['Carregando lead...', 1],
      ['Paciente', 2],
      ['Lead', 2],
      ['Nenhum — clique pra buscar paciente ou lead', 1],
      ['Buscar por nome, telefone ou CPF...', 1],
      ['Carregando pacientes e leads...', 1],
      ['Nenhum paciente ou lead corresponde a "', 1],
      ['Cadastre pacientes em Pacientes → Novo paciente.', 1],
      ['CPF', 1],
      ['Sem nome', 4],
      ['Nenhum contato disponível.', 1],
    ],
    trechos: [],
  },
  [TAREFAS]: {
    textos: [
      ['Próxima Ação IA', 1],
      ['Analisar tarefas', 1],
      ['Consultando IA...', 1],
      ['/tasks/next-action', 1],
      ['Erro ao consultar IA', 1],
    ],
    trechos: [],
  },
  [LISTA]: {
    textos: [
      ['Instituto Odonto Passos — Agenda', 1],
      ['Avaliação', 1],
      ['Avaliação — abre odontograma do paciente', 1],
      ['Consulta', 1],
      ['Procedimento', 1],
      ['Retorno', 1],
      ['Ortodontia', 1],
      ['Atendido', 1],
      ['Não compareceu', 1],
      ['Desmarcou', 1],
      ['CONSULTA', 1],
      ['PROCEDIMENTO', 1],
      ['RETORNO', 1],
      ['ORTODONTIA', 1],
    ],
    trechos: [],
  },
  [PROFISSIONAL]: {
    textos: [
      ['/return-alerts/pending-now', 1],
      ['Retornos', 1],
      ['ver todos', 1],
      ['Nada pendente', 1],
      ['/atendimento/return-alerts', 2],
    ],
    trechos: [],
  },
  [COLUNAS]: {
    textos: [
      ['Agendado', 1],
      ['Confirmado', 1],
      ['Em atendimento', 1],
      ['Atendido', 1],
      ['Desmarcou', 1],
      ['Faltou', 1],
      ['Legenda:', 1],
    ],
    trechos: [],
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
const contarRegex = (fonte: string, re: RegExp) => (fonte.match(new RegExp(re.source, 'g')) ?? []).length;

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

/** Carrega lab-agenda-textos.ts (arquivo do web) com o @crm/shared de verdade. */
function carregarTextos(): Record<string, any> {
  const js = ts.transpileModule(ler(TEXTOS), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod: { exports: Record<string, any> } = { exports: {} };
  const requerer = (nome: string) => {
    if (nome === '@crm/shared') return shared;
    throw new Error(`lab-agenda-textos.ts não pode importar ${nome}`);
  };
  new Function('exports', 'require', 'module', js)(mod.exports, requerer, mod);
  return mod.exports;
}

describe('F7 — agenda do laboratório: clínica intacta', () => {
  it.each(ARQUIVOS_DA_CLINICA.map((a) => [a]))('%s: sem pickBt( e sem const LAB_', (arq) => {
    const src = ler(arq);
    expect(src.match(/\bpickBt\s*\(/g) ?? []).toEqual([]);
    expect(src.match(/\b(?:const|let|var)\s+LAB_\w*/g) ?? []).toEqual([]);
  });

  it.each(Object.keys(CLINICA).map((a) => [a]))('%s: textos da clínica com a contagem de 9eb61bff', (arq) => {
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
    expect(ARQUIVOS_DA_CLINICA.flatMap((a) => hooksForaDoTopo(a))).toEqual([]);
  });

  it('cada componente da agenda lê o tipo de conta uma vez', () => {
    for (const arq of ARQUIVOS_DA_CLINICA) {
      expect([arq, ler(arq).match(/const lab = isLab\(useBusinessType\(\)\);/g)?.length]).toEqual([arq, 1]);
    }
  });

  it('agenda: Bloquear, bloqueio de agenda, validação, Notificar e Avaliação só na clínica', () => {
    const src = ler(PAGINA);
    expect(contarTrecho(src, '{!lab && role.canCreateAgendaEvent && (')).toBe(1);
    expect(contarRegex(src, /\{!lab && \(\s*<ScheduleBlockModal/)).toBe(1);
    expect(contarTrecho(src, '<ScheduleBlockModal')).toBe(1);
    // validação clínica e Notificar
    expect(contarTrecho(src, '{!lab && editingEvent && PATIENT_APPT_TYPES.includes(editingEvent.type) && (')).toBe(2);
    // Avaliação (odontograma)
    expect(contarTrecho(src, '{!lab && editingEvent && editingEvent.patient_id')).toBe(1);
    // as chamadas negadas ao laboratório só existem nos handlers desses botões
    expect(contarTrecho(src, '/notify`')).toBe(1);
    expect(contarTrecho(src, '/validate`')).toBe(1);
    expect(contarTrecho(src, '/unvalidate`')).toBe(1);
  });

  it('agenda: tipos, cores, deep-link e tipo padrão do laboratório', () => {
    const src = ler(PAGINA);
    expect(src).toContain('return lab ? LAB_AGENDA_UI.tipos : EVENT_TYPES;');
    expect(contarTrecho(src, 'tiposDaAgenda.map(t => (')).toBe(2);
    // Fora a lista inicial do filtro, a tela lê os tipos por tiposDaTela/tiposDaAgenda.
    expect(contarTrecho(src, 'EVENT_TYPES.find(')).toBe(0);
    expect(contarTrecho(src, 'EVENT_TYPES.map(')).toBe(1);
    expect(contarTrecho(src, 'EVENT_TYPES.map(t => t.id)')).toBe(1);
    expect(contarTrecho(src, "type: isLab(btAgora()) ? LAB_AGENDA_UI.tipoPadrao : 'CONSULTA',")).toBe(2);
    expect(contarTrecho(src, "const presetType = tiposDaTela(labAgora).find((t) => t.id === params.get('type'));")).toBe(1);
    expect(contarTrecho(src, '...(isLab(btAgora()) ? LAB_AGENDA_UI.calendarios : {}),')).toBe(1);
    expect(contarTrecho(src, 'if (lab) setFilterTypes(LAB_AGENDA_UI.tipos.map(t => t.id));')).toBe(1);
  });

  it('agenda: responsável (qualquer pessoa da equipe), lembretes de 48 h e 24 h e cliente obrigatório', () => {
    const src = ler(PAGINA);
    expect(contarTrecho(src, "api.get(labNoMount ? '/users/agents' : '/users/lawyers')")).toBe(1);
    expect(contarTrecho(src, "labNoMount ? ant.filter(lembreteDoLaboratorio('WHATSAPP')) : ant")).toBe(1);
    expect(contarTrecho(src, 'isLab(btAgora()) ? REMINDER_CONFIG_PADRAO_DO_LABORATORIO.default_antecedencias : FALLBACK_DEFAULT_ANTECEDENCIAS')).toBe(1);
    expect(contarTrecho(src, 'reminders: lab && !tipoSoDoLaboratorio(formData.type) ? [] : remindersPayload,')).toBe(1);
    expect(contarTrecho(src, 'if (lab && tipoSoDoLaboratorio(formData.type) && !formData.patient_id && !formData.lead_id) {')).toBe(1);
    expect(contarTrecho(src, 'showError(LAB_AGENDA_TEXTOS.clienteObrigatorio);')).toBe(1);
  });

  it('tarefas: a sugestão da IA (POST /tasks/next-action) some no laboratório', () => {
    const src = ler(TAREFAS);
    expect(
      contarRegex(src, /\{!lab && \(\s*<div className="shrink-0 px-6 py-3 border-b border-border bg-gradient-to-r from-primary\/5 to-transparent">/),
    ).toBe(1);
    expect(contarTrecho(src, 'onClick={fetchNba}')).toBe(1);
  });

  it('por profissional: no laboratório não busca nem mostra os Retornos', () => {
    const src = ler(PROFISSIONAL);
    const portao = src.indexOf('if (isLab(btAgora())) return;');
    expect(portao).toBeGreaterThan(-1);
    expect(src.indexOf("'/return-alerts/pending-now'")).toBeGreaterThan(portao);
    expect(contarRegex(src, /\{!lab && \(\s*<div className="bg-card border border-border rounded-xl p-3 flex-1 flex flex-col overflow-hidden">/)).toBe(1);
  });

  it('lista: sem o atalho clínico Avaliação no laboratório', () => {
    expect(contarTrecho(ler(LISTA), 'const canAttend = !lab && !!ev.patient_id && !isCancelled')).toBe(1);
  });
});

describe('F7 — textos da agenda do laboratório (lab-agenda-textos.ts)', () => {
  it('só o import do @crm/shared e consts LAB_', () => {
    const sf = fonteTs(TEXTOS, ler(TEXTOS));
    const nomes = sf.statements.map((st) =>
      ts.isVariableStatement(st) ? st.declarationList.declarations.map((d) => d.name.getText(sf)).join(',') : ts.SyntaxKind[st.kind],
    );
    expect(nomes).toEqual(['ImportDeclaration', 'LAB_AGENDA_UI', 'LAB_AGENDA_STATUS', 'LAB_AGENDA_CONTATO', 'LAB_AGENDA_LISTA']);
  });

  it('nenhum texto do laboratório com palavra de clínica', () => {
    const ruins = textosDoLab(TEXTOS)
      .filter(({ texto }) => temPalavraDeClinica(texto))
      .map(({ nome, texto }) => `${nome}: ${JSON.stringify(texto)}`);
    expect(ruins).toEqual([]);
  });

  it('tipos: os da agenda do laboratório (sem os tipos de clínica), Coleta como padrão', () => {
    const { LAB_AGENDA_UI } = carregarTextos();
    const ids = LAB_AGENDA_UI.tipos.map((t: { id: string }) => t.id);
    expect([...ids].sort()).toEqual([...TIPOS_DE_AGENDA_DO_LABORATORIO].sort());
    expect(ids).toEqual(['COLETA', 'PROVA', 'ENTREGA', 'BLOQUEIO', 'TAREFA', 'OUTRO']);
    for (const t of ['CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA', 'AUDIENCIA', 'PERICIA', 'PRAZO']) expect(ids).not.toContain(t);
    expect(LAB_AGENDA_UI.tipos.slice(0, 3).map((t: { label: string }) => t.label)).toEqual(['Coleta', 'Prova', 'Entrega']);
    expect(LAB_AGENDA_UI.tipoPadrao).toBe('COLETA');
    expect(LAB_AGENDA_UI.tituloPadrao).toBe('Coleta');
    expect(Object.keys(LAB_AGENDA_UI.calendarios)).toEqual([...TIPOS_SO_DO_LABORATORIO]);
    for (const k of Object.keys(LAB_AGENDA_UI.placeholders)) expect(ids).toContain(k);
  });

  it('status: Agendado, Confirmado, Feito, Desmarcado e Não realizado (Chegou e Em atendimento fora)', () => {
    const { LAB_AGENDA_STATUS, LAB_AGENDA_UI } = carregarTextos();
    expect(Object.entries(LAB_AGENDA_STATUS)).toEqual([
      ['AGENDADO', 'Agendado'],
      ['CONFIRMADO', 'Confirmado'],
      ['CONCLUIDO', 'Feito'],
      ['CANCELADO', 'Desmarcado'],
      ['NO_SHOW', 'Não realizado'],
    ]);
    expect(LAB_AGENDA_UI.kanban.map((c: { id: string; label: string }) => [c.id, c.label])).toEqual([
      ['AGENDADO', 'A Fazer'],
      ['CONFIRMADO', 'Em Andamento'],
      ['CONCLUIDO', 'Feito'],
    ]);
    expect(LAB_AGENDA_UI.rotulos.responsavel).toBe('Responsável');
  });

  it('seletor de contato: textos montados', () => {
    const { LAB_AGENDA_CONTATO } = carregarTextos();
    expect(LAB_AGENDA_CONTATO.semResultado('ana')).toBe('Nenhum cliente ou contato corresponde a "ana".');
    expect(LAB_AGENDA_CONTATO.documento('12.345.678/0001-90')).toBe('CPF/CNPJ 12.345.678/0001-90');
  });
});
