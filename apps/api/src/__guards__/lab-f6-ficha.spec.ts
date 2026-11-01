/**
 * F6 do laboratório — ficha do cliente: aba Orçamento, aba Trabalhos e a ordem das abas
 * do laboratório. Os arquivos da ficha mudam muito (muitos commits por mês), então neles
 * não entra pickBt nem const LAB_: só portões (`lab && …`) e texto importado
 * (`lab ? LAB_X.y : 'texto de hoje'`). Este spec lê o código do web pelo AST e confere:
 *   - a aba Orçamento (LabOrcamentoTab) só é montada atrás de `lab &&`, e a entrada dela
 *     sai da barra de abas quando não é laboratório;
 *   - na clínica, ?tab=orcamento volta para a Visão geral, e o "ir para a Avaliação" das
 *     Propostas continua indo para ?tab=odontogram;
 *   - o texto da clínica que a F6 envolveu continua com a mesma contagem de antes da F6
 *     (d2147294). É uma LISTA dos literais tocados, não um retrato do arquivo inteiro:
 *     edição normal da clínica nesses arquivos continua livre;
 *   - o hook do tipo de negócio vem antes de qualquer return antecipado;
 *   - a aba Trabalhos: o protético vê só os serviços dele (e os sem responsável), e o
 *     link da agenda fica só na clínica;
 *   - o Financeiro da ficha mostra os botões de PDF também no laboratório (o PDF do
 *     laboratório sai no mesmo deploy, pelo servidor).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const RAIZ = path.resolve(__dirname, '..', '..', '..', '..');
const PASTA = 'apps/web/src/app/atendimento/pacientes';
const FICHA = `${PASTA}/[id]/page.tsx`;
const TRATAMENTO = `${PASTA}/components/TratamentoTab.tsx`;
const FINANCEIRO = `${PASTA}/components/FinanceiroTab.tsx`;
const TEXTOS = `${PASTA}/lab-trabalhos-textos.ts`;

function ler(arq: string): string {
  return fs.readFileSync(path.join(RAIZ, arq), 'utf8');
}

function arvore(arq: string): ts.SourceFile {
  return ts.createSourceFile(arq, ler(arq), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function visitar(no: ts.Node, fn: (n: ts.Node) => void): void {
  fn(no);
  ts.forEachChild(no, (filho) => visitar(filho, fn));
}

/** Textos do arquivo (string, template e texto de JSX), aparados. Fora: import/export e tipos. */
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

function semEspacos(s: string): string {
  return s.replace(/\s+/g, '');
}

function nomeDaTag(no: ts.Node): string | null {
  if (ts.isJsxSelfClosingElement(no)) return no.tagName.getText();
  if (ts.isJsxElement(no)) return no.openingElement.tagName.getText();
  return null;
}

/** Operandos à esquerda de uma cadeia `a && b && c` (sem o último). */
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

/** O nó está do lado direito de um `lab && …` (em qualquer ancestral). */
function atrasDeLab(no: ts.Node): boolean {
  let filho: ts.Node = no;
  for (let pai = no.parent; pai; filho = pai, pai = pai.parent) {
    if (
      ts.isBinaryExpression(pai) &&
      pai.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      pai.right === filho &&
      operandosDoE(pai).some((op) => ts.isIdentifier(op) && op.text === 'lab')
    ) {
      return true;
    }
  }
  return false;
}

/** O nó está no ramo do "senão" de um `lab ? … : …` (em qualquer ancestral). */
function noRamoDaClinica(no: ts.Node): boolean {
  let filho: ts.Node = no;
  for (let pai = no.parent; pai; filho = pai, pai = pai.parent) {
    if (ts.isConditionalExpression(pai) && ts.isIdentifier(pai.condition) && pai.condition.text === 'lab') {
      return pai.whenFalse === filho;
    }
  }
  return false;
}

/**
 * Literais da clínica que a F6 envolveu (`lab ? LAB_X.y : 'literal'`), com a contagem no
 * arquivo em d2147294 (antes da F6). Gerada de `git show d2147294:<arquivo>` antes da
 * edição. Se um texto da clínica for mudado de propósito, a contagem muda aqui junto.
 */
const LITERAIS_DA_CLINICA: Record<string, Array<[string, number]>> = {
  [FICHA]: [
    ['Tratamento', 1],
    ['odontogram', 5],
    ['?tab=odontogram', 2],
  ],
  [TRATAMENTO]: [
    ['Erro ao carregar plano de tratamento', 1],
    ['Aguardando validação do Financeiro — o tratamento ainda não foi liberado.', 1],
    ['(dente', 1],
    ['Validar "', 1],
    ['" como concluído?', 1],
    ['• Marca status = DONE', 1],
    ['• Registra você como dentista executante', 1],
    ['• Data de execução = agora', 1],
    ['Procedimento validado', 1],
    ['Erro ao validar', 1],
    ['Carregando plano de tratamento…', 1],
    ['Plano de Tratamento', 1],
    ['Procedimentos fechados — dentista responsável valida cada um quando realizado.', 1],
    ['Esconder feitos', 1],
    ['Progresso do tratamento', 1],
    ['O tratamento foi aceito, mas o Financeiro precisa conferir e liberar antes de aparecer aqui pra confirmação dos procedimentos.', 1],
    ['Nenhum procedimento fechado ainda', 1],
    ['Quando um orçamento for aceito pelo paciente, os procedimentos aparecem aqui.', 1],
    ['Plano de tratamento', 1],
    ['Aceito em', 1],
    ['O Financeiro precisa conferir e liberar este tratamento antes que os procedimentos possam ser confirmados como feitos.', 1],
    ['Procedimento', 1],
    ['Dente', 1],
    ['Executado por', 1],
    ['/atendimento/agenda', 1],
    ['Ver na agenda', 1],
    ['🔒 Aguardando validação do Financeiro — o tratamento precisa ser liberado antes de confirmar os procedimentos', 1],
    ['Validar — marca este procedimento como feito', 1],
    ['Procedimento de', 1],
    ['Apenas dentistas/admin podem validar', 1],
    ['Validar', 1],
    ['Validado', 1],
    ['Apenas', 1],
    ['dentistas', 1],
    ['admin', 1],
    ['podem validar procedimentos como feitos. Sua visão é somente leitura.', 1],
    ['Aguardando assinatura', 1],
    ['Ativo', 1],
    ['Concluído', 2],
  ],
  [FINANCEIRO]: [
    ['PDF com valores', 1],
    ['PDF sem valores', 1],
    ['Baixar o PDF do orçamento COM os valores', 1],
    ['Baixar o PDF só com a lista de procedimentos (sem valores)', 1],
  ],
};

describe('F6 do laboratório — ficha do cliente (abas Orçamento e Trabalhos)', () => {
  describe('texto da clínica que a F6 envolveu: mesma contagem de antes da F6', () => {
    const casos = Object.entries(LITERAIS_DA_CLINICA).flatMap(([arq, lista]) =>
      lista.map(([literal, contagem]) => [arq, literal, contagem] as const),
    );
    const cache = new Map<string, string[]>();
    const textosDe = (arq: string) => {
      if (!cache.has(arq)) cache.set(arq, textos(arvore(arq)));
      return cache.get(arq)!;
    };
    it.each(casos)('%s: %j aparece %i vez(es)', (arq, literal, contagem) => {
      expect(textosDe(arq).filter((t) => t === literal).length).toBe(contagem);
    });
  });

  it.each([[FICHA], [TRATAMENTO], [FINANCEIRO]])('%s: sem pickBt( e sem const LAB_ (só portões e texto importado)', (arq) => {
    const fonte = ler(arq);
    expect(fonte.includes('pickBt(')).toBe(false);
    expect(/\bconst\s+LAB_/.test(fonte)).toBe(false);
  });

  it.each([[FICHA], [TRATAMENTO]])('%s: o hook do tipo de negócio vem antes de qualquer return antecipado', (arq) => {
    const sf = arvore(arq);
    const ruins: string[] = [];
    visitar(sf, (no) => {
      if (!ts.isFunctionDeclaration(no) || !no.body) return;
      const instrucoes = no.body.statements;
      const iHook = instrucoes.findIndex((st) => st.getText(sf).includes('useBusinessType()'));
      if (iHook < 0) return;
      for (let i = 0; i < iHook; i++) {
        let temReturn = false;
        visitar(instrucoes[i], (n) => {
          if (ts.isReturnStatement(n) && dentroDoCorpo(n, no)) temReturn = true;
        });
        if (temReturn) ruins.push(`${no.name?.text ?? '?'}: return antes do hook`);
      }
    });
    expect(ruins).toEqual([]);
  });

  describe('ficha ([id]/page.tsx)', () => {
    const sf = arvore(FICHA);
    const fonte = semEspacos(ler(FICHA));

    it('a aba Orçamento (LabOrcamentoTab) só é montada atrás de `lab &&`', () => {
      const usos: ts.Node[] = [];
      visitar(sf, (no) => {
        if (nomeDaTag(no) === 'LabOrcamentoTab') usos.push(no);
      });
      expect(usos.length).toBeGreaterThan(0);
      expect(usos.filter((u) => !atrasDeLab(u)).map((u) => u.getText(sf).slice(0, 60))).toEqual([]);
    });

    it('a entrada da aba Orçamento sai da barra quando não é laboratório (e sem permissão)', () => {
      expect(fonte).toContain(semEspacos('.filter((t) => lab || t.id !== ABA_ORCAMENTO_DO_LAB)'));
      expect(fonte).toContain(semEspacos('.filter((t) => t.id !== ABA_ORCAMENTO_DO_LAB || canQuotes)'));
    });

    it('a ordem do laboratório só vale no laboratório (a clínica fica com a ordem de TABS)', () => {
      expect(fonte).toContain(
        semEspacos('return lab ? [...lista].sort((a, b) => ordemNoLab(a.id) - ordemNoLab(b.id)) : lista;'),
      );
    });

    it('o nome das abas do laboratório só entra com lab (a clínica fica com t.label)', () => {
      const rotulo = semEspacos('{(lab && LAB_ABAS_DA_FICHA[t.id as keyof typeof LAB_ABAS_DA_FICHA]) || t.label}');
      expect(fonte.split(rotulo).length - 1).toBe(2);
      expect(fonte.includes('{t.label}')).toBe(false);
    });

    it('na clínica, ?tab=orcamento volta para a Visão geral', () => {
      expect(fonte).toContain(semEspacos(": tab === ABA_ORCAMENTO_DO_LAB && !isLab(btAgora())) setTab('overview');"));
    });

    it('onGoToEvaluation: o ramo da clínica continua em ?tab=odontogram', () => {
      let achou = false;
      visitar(sf, (no) => {
        if (!ts.isJsxAttribute(no) || no.name.getText(sf) !== 'onGoToEvaluation') return;
        achou = true;
        let se: ts.IfStatement | undefined;
        visitar(no, (n) => {
          if (!se && ts.isIfStatement(n) && ts.isIdentifier(n.expression) && n.expression.text === 'lab') se = n;
        });
        expect(se).toBeDefined();
        const clinica = semEspacos(se!.elseStatement?.getText(sf) ?? '');
        expect(clinica).toContain(semEspacos("setTab('odontogram');"));
        expect(clinica).toContain(semEspacos('router.push(`/atendimento/pacientes/${patient.id}?tab=odontogram`);'));
        expect(clinica.includes('ABA_ORCAMENTO_DO_LAB')).toBe(false);
      });
      expect(achou).toBe(true);
    });
  });

  describe('aba Trabalhos (TratamentoTab.tsx)', () => {
    const sf = arvore(TRATAMENTO);
    const fonte = semEspacos(ler(TRATAMENTO));

    it('o protético do laboratório vê só os serviços dele e os sem responsável', () => {
      expect(fonte).toContain(semEspacos('const soOsMeus = lab && role.isDentist && !role.isAdmin && !role.isSuperAdmin;'));
      expect(fonte).toContain(semEspacos('r.item.dentist?.id === role.userId || !r.item.dentist'));
      // os grupos e os números saem da mesma lista filtrada
      expect(fonte).toContain(semEspacos('for (const row of itens)'));
      expect(fonte).toContain(semEspacos('const validatedItems = itens.filter('));
    });

    it('o link da agenda fica só no ramo da clínica', () => {
      const usos: ts.Node[] = [];
      visitar(sf, (no) => {
        if ((ts.isStringLiteral(no) || ts.isNoSubstitutionTemplateLiteral(no)) && no.text === '/atendimento/agenda') usos.push(no);
      });
      expect(usos.length).toBe(1);
      expect(noRamoDaClinica(usos[0])).toBe(true);
    });

    it('não chama nada da Avaliação nem do Progresso', () => {
      const tudo = ler(TRATAMENTO);
      for (const trecho of ['/odontogram', 'finalize', 'ortho-board', 'journey-board']) expect(tudo.includes(trecho)).toBe(false);
    });
  });

  describe('Financeiro da ficha (FinanceiroTab.tsx)', () => {
    const sf = arvore(FINANCEIRO);

    it.each([['PDF com valores'], ['PDF sem valores']])('o botão %j aparece também no laboratório (sem portão)', (rotulo) => {
      const botoes: ts.JsxElement[] = [];
      visitar(sf, (no) => {
        if (
          ts.isJsxElement(no) &&
          no.openingElement.tagName.getText(sf) === 'button' &&
          no.children.some((c) => ts.isJsxText(c) && c.text.replace(/\s+/g, ' ').trim() === rotulo)
        ) {
          botoes.push(no);
        }
      });
      expect(botoes.length).toBe(1);
      // filho direto do <div> da barra: nada de `{!lab && (…)}` em volta
      expect(ts.isJsxElement(botoes[0].parent)).toBe(true);
    });
  });

  describe('textos do laboratório (lab-trabalhos-textos.ts)', () => {
    const sf = arvore(TEXTOS);

    it('só tem as consts LAB_ exportadas', () => {
      const nomes: string[] = [];
      const outras: string[] = [];
      for (const st of sf.statements) {
        const exportada = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (ts.isVariableStatement(st) && exportada && (st.declarationList.flags & ts.NodeFlags.Const) !== 0) {
          for (const d of st.declarationList.declarations) nomes.push(d.name.getText(sf));
        } else {
          outras.push(st.getText(sf).slice(0, 60));
        }
      }
      expect(outras).toEqual([]);
      expect(nomes.sort()).toEqual(['LAB_ABAS_DA_FICHA', 'LAB_TRABALHOS']);
    });

    it('LAB_ABAS_DA_FICHA usa os ids das abas da ficha (orcamento e treatment)', () => {
      const fonte = semEspacos(ler(TEXTOS));
      expect(fonte).toContain(semEspacos("orcamento: 'Orçamento',"));
      expect(fonte).toContain(semEspacos("treatment: 'Trabalhos',"));
    });
  });
});

/** O return pertence ao corpo da função `fn` (não a uma função de dentro dela). */
function dentroDoCorpo(no: ts.Node, fn: ts.FunctionDeclaration): boolean {
  for (let pai = no.parent; pai; pai = pai.parent) {
    if (pai === fn) return true;
    if (ts.isFunctionLike(pai)) return false;
  }
  return false;
}
