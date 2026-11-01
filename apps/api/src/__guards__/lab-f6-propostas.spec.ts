/**
 * F6 do laboratório — aba Propostas da ficha (PropostasTab.tsx) para o laboratório.
 *
 * A PropostasTab é o centro da venda da clínica e um arquivo de muito movimento: ela NÃO
 * tem pickBt nem const LAB_ (a trava de textos de scripts/ci/check-pick-literals.mjs não
 * olha para ela). O laboratório entra só com portão (`!lab && …`) e texto importado
 * (`lab ? LAB_X.y : 'texto de hoje'`), e os textos novos ficam em lab-propostas-textos.ts.
 * Este spec lê o arquivo pelo AST do TypeScript e confere:
 *   (a) contrato, afiliado, prancha do odontograma e consulta de crédito só aparecem
 *       atrás de `!lab &&`;
 *   (b) "Adicionar ao tratamento (sem cobrar)" e o toggle da consulta de crédito recebem
 *       `lab ? undefined : …`;
 *   (c) sem pickBt e sem const LAB_; todo `lab` vem de isLab(useBusinessType()) e fica
 *       no topo do componente, antes de qualquer return (regra dos hooks);
 *   (d) os textos da clínica que a F6 envolveu continuam com a mesma contagem do commit
 *       d2147294 (lista, não retrato do arquivo inteiro: edição normal da clínica segue
 *       livre);
 *   (e) o GET de /payment-gateway/settings (conta Asaas própria) só roda no laboratório;
 *       o GET das cobranças do plano e o caminho de rascunho da clínica ficam como hoje.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { temPalavraDeClinica } from '../business-type/lab-vocab.interceptor';

const RAIZ = path.resolve(__dirname, '..', '..', '..', '..');
const ARQ = 'apps/web/src/app/atendimento/pacientes/components/PropostasTab.tsx';
const TEXTOS = 'apps/web/src/app/atendimento/pacientes/lab-propostas-textos.ts';

function ler(arq: string): ts.SourceFile {
  const fonte = fs.readFileSync(path.join(RAIZ, arq), 'utf8');
  return ts.createSourceFile(arq, fonte, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function todos(raiz: ts.Node, filtro: (no: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const visitar = (no: ts.Node): void => {
    if (filtro(no)) out.push(no);
    ts.forEachChild(no, visitar);
  };
  visitar(raiz);
  return out;
}

function funcao(sf: ts.SourceFile, nome: string): ts.FunctionDeclaration {
  const achadas = todos(sf, (no) => ts.isFunctionDeclaration(no) && no.name?.text === nome);
  if (achadas.length !== 1) throw new Error(`função ${nome} não achada uma vez só`);
  return achadas[0] as ts.FunctionDeclaration;
}

function linha(sf: ts.SourceFile, no: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(no.getStart(sf)).line + 1;
}

function semParenteses(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x)) x = x.expression;
  return x;
}

/** `!lab` */
function ehNaoLab(e: ts.Expression): boolean {
  const x = semParenteses(e);
  return (
    ts.isPrefixUnaryExpression(x) &&
    x.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isIdentifier(semParenteses(x.operand)) &&
    (semParenteses(x.operand) as ts.Identifier).text === 'lab'
  );
}

/** Operandos de uma cadeia `a && b && c`. */
function operandosE(e: ts.Expression): ts.Expression[] {
  const x = semParenteses(e);
  if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return [...operandosE(x.left), ...operandosE(x.right)];
  }
  return [x];
}

/** O nó está do lado direito de um `… && …` cujo lado esquerdo tem `!lab`? */
function atrasDeNaoLab(no: ts.Node): boolean {
  let filho: ts.Node = no;
  let pai: ts.Node | undefined = no.parent;
  while (pai && !ts.isSourceFile(pai)) {
    if (
      ts.isBinaryExpression(pai) &&
      pai.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      pai.right === filho &&
      operandosE(pai.left).some(ehNaoLab)
    ) {
      return true;
    }
    if (ts.isFunctionDeclaration(pai)) return false;
    filho = pai;
    pai = pai.parent;
  }
  return false;
}

function nomeDaTag(no: ts.Node): string | null {
  if (ts.isJsxSelfClosingElement(no)) return no.tagName.getText();
  if (ts.isJsxOpeningElement(no)) return no.tagName.getText();
  return null;
}

/** Textos que chegam à tela, como o check-pick-literals conta (aparados e sem espaço repetido). */
function textosDoArquivo(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const guardar = (t: string) => {
    const n = t.replace(/\s+/g, ' ').trim();
    if (n) out.push(n);
  };
  const ehTipo = (no: ts.Node) =>
    (no.kind >= ts.SyntaxKind.FirstTypeNode && no.kind <= ts.SyntaxKind.LastTypeNode) ||
    ts.isInterfaceDeclaration(no) ||
    ts.isTypeAliasDeclaration(no);
  const visitar = (no: ts.Node): void => {
    if (ehTipo(no) || ts.isImportDeclaration(no) || ts.isExportDeclaration(no)) return;
    if (ts.isStringLiteral(no) || ts.isNoSubstitutionTemplateLiteral(no)) guardar(no.text);
    else if (ts.isTemplateHead(no) || ts.isTemplateMiddle(no) || ts.isTemplateTail(no)) guardar(no.text);
    else if (ts.isJsxText(no)) guardar(no.text);
    ts.forEachChild(no, visitar);
  };
  visitar(sf);
  return out;
}

/**
 * Textos da clínica que a F6 envolveu (ou deixou ao lado de um texto de laboratório),
 * com a contagem de `git show d2147294:apps/web/src/app/atendimento/pacientes/components/PropostasTab.tsx`,
 * gerada ANTES da edição. Texto aparado e com espaços juntados.
 */
const TEXTOS_DA_CLINICA: ReadonlyArray<readonly [string, number]> = [
  ["Cortesia clínica", 1],
  ["limpeza, clareamento, kit higiene oral...", 1],
  ["Ex: Limpeza profissional + clareamento de bandeja inclusos", 1],
  ["12 meses em vez de 6, manutenção inclusa...", 1],
  ["Ex: Garantia estendida pra 12 meses + 1 manutenção anual", 1],
  ["Procedimento adicional", 1],
  ["panorâmica, moldagem digital, consultas extras...", 1],
  ["Ex: Radiografia panorâmica + moldagem digital inclusas", 1],
  ["Descreva o bônus oferecido ao paciente...", 1],
  ["só o que dói ou bloqueia o resto", 1],
  ["só o que não pode esperar — sem estética opcional", 1],
  ["plano ideal — todos os procedimentos sugeridos", 1],
  ["Abre a página hospedada do Asaas — útil pra copiar o link e mandar pro paciente via WhatsApp", 1],
  ["🔗 Abrir página de pagamento (pra enviar ao paciente)", 1],
  ["Cobrança ONLINE gerada no Asaas — o paciente paga pelo link/QR", 1],
  ["Recebido na clínica — entra direto no caixa, sem cobrança no Asaas", 1],
  ["NA CLÍNICA", 1],
  ["Proposta salva — aguardando decisão do paciente", 1],
  ["/commercial/patients/", 1],
  ["criada. Adicione os procedimentos pela aba Avaliacao quando puder.", 1],
  ["Proposta enviada pro paciente", 1],
  ["⚠ Consulta de crédito DISPENSADA — operador assume o risco.", 1],
  ["• Ativar o plano", 1],
  ["Proposta aprovada e boletos gerados (consulta dispensada).", 1],
  ["/commercial/treatment-plans/", 1],
  ["(recebido na clínica, sem Asaas)", 1],
  ["• Ativar o plano de tratamento", 2],
  ["• Aceitar o orçamento + ativar o plano", 1],
  ["• Enviar pro paciente", 1],
  ["Crie uma proposta direto agora ou monte o orçamento detalhado na aba", 1],
  ["Ir para Avaliação", 2],
  ["Plano de tratamento", 1],
  ["Remover desta aba (continua em Avaliação e Orçamentos)", 1],
  ["Confirme que o paciente entregou o dinheiro em mãos.", 3],
  ["PIX da entrada gerado — mostre o QR Code pro paciente", 1],
  ["Dente", 1],
  ["procedimento incluído", 1],
  ["procedimentos incluídos", 1],
  ["Boleto financiado", 1],
  ["Envia link da proposta pro paciente abrir e decidir", 1],
  ["Enviar pro paciente", 1],
  ["Aprova a venda: cria as cobranças (ou lança o recebimento manual no caixa) e move a proposta pra aba Financeiro do paciente", 1],
  ["Cobrança do tratamento", 3],
  ["Valor total do tratamento", 3],
  ["Tratamento", 3],
  ["procedimento", 3],
  ["procedimentos", 3],
  ["S/J (sem juros): as parcelas do boleto saem SEM os 1,5%/mês e dispensam a consulta de crédito. Independente do desconto à vista.", 1],
  ["Quanto o paciente paga no fechamento — sem juros", 1],
  ["juros 1,5%/mês ·", 1],
  ["exige consulta de crédito", 1],
  ["consulta dispensada", 2],
  ["sem juros · consulta dispensada", 1],
  ["consulta de crédito", 1],
  ["Esta já é a forma salva. Clique pra re-salvar com a configuração atual. Fica validada até \"Encaminhar ao financeiro\".", 2],
  ["Esta já é a forma salva. Clique pra re-salvar com os valores atuais. Fica validada até \"Encaminhar ao financeiro\".", 1],
  ["Salva esta forma de pagamento como a escolhida pra apresentar ao paciente. Cobranças no Asaas só serão criadas quando o operador clicar \"Encaminhar ao financeiro\" no rodapé.", 1],
  ["Salva como forma escolhida. O lançamento (caixa/cobrança) só sai quando o operador clicar \"Encaminhar ao financeiro\" no rodapé.", 1],
  ["Salva Cartão como forma escolhida. Link Asaas só será gerado quando o operador clicar 'Encaminhar ao financeiro' no rodapé.", 1],
  ["Enviar link da proposta no WhatsApp pra ele revisar antes", 2],
  ["Enviar link da proposta no WhatsApp pra o paciente revisar", 1],
  ["Enviar link no WhatsApp", 3],
  ["Boletos e PIX emitidos via Asaas. Análise de crédito (parcelamentos) via Serasa Crediscore. Sinal/entrada são idempotentes — não re-emite se já existir.", 1],
  ["Serasa Crediscore", 1],
  ["A proposta foi encaminhada ao financeiro. O paciente tem", 1],
  ["Só arquiva o que você marcar acima.", 1],
  ["Arquivados somem de \"Plano de tratamento\" e ficam em", 1],
  ["Orçamentos › Arquivado", 1],
  ["por 30 dias. Você pode desarquivar quando quiser.", 1],
  ["Como o paciente vai pagar?", 1],
  ["PIX (QR Code) · PIX maquineta (sem QR) · Espécie · Misto", 1],
  ["QR (Asaas) ou na clínica", 1],
  ["Banco Asaas (QR), em conta ou na maquineta", 1],
  ["recebido na clínica", 2],
  ["Valor do tratamento", 1],
  ["PIX recebido na clínica (em conta / maquineta), lançado no caixa. Sem QR/cobrança Asaas, com baixa automática.", 1],
  ["· processado pelo Asaas", 1],
  ["Escolha o parcelamento · paciente preenche os dados do cartão na página segura do Asaas", 1],
  ["Asaas Tap (cartão presencial)", 1],
  ["Pagamento processado pelo Asaas + PagBank. Paciente preenche os dados do cartão em página segura hospedada (PCI-DSS) — ou paga presencialmente via Asaas Tap.", 1],
  ["PagBank", 1],
  ["Tap", 1],
  ["Caso o paciente pague algo agora (PIX/Boleto/Espécie) e use o cartão só pro restante", 1],
  ["Crie um orçamento na aba", 1],
  ["Criar a proposta direto agora ou ir pra aba", 1],
  ["\"Criar agora\" gera proposta vazia — adicione procedimentos depois pela aba Avaliação.", 1],
  ["Criar novo orçamento na Avaliação", 1],
  ["⚠ Esta cobrança já existia pra este plano", 1],
  ["Obrigado por ser nosso paciente 💚", 1],
  ["Pagamento confirmado pelo Asaas e lançado no financeiro do paciente.", 1],
  ["Mostre o QR Code abaixo pro paciente", 1],
  ["(sem Asaas). Passe o cartão na maquineta e confirme o recebimento — cai no caixa como cartão. Dá pra confirmar depois no Financeiro do paciente também.", 1],
  ["💳 Link de pagamento pro paciente", 1],
  ["Compartilhe esse link com o paciente. Ele vai preencher os dados do cartão em página segura do Asaas.", 1],
  ["🔔 O Asaas envia automaticamente por email/WhatsApp pro paciente. Você acompanha o status na aba", 1],
  ["do paciente.", 1],
];

describe('F6 — aba Propostas no laboratório (PropostasTab.tsx)', () => {
  const sf = ler(ARQ);
  const fonte = sf.getFullText();

  it.each([['ContratoCard'], ['AfiliadoDaVenda'], ['OdontogramaPrancha'], ['ResumoProcedimentos'], ['CreditCheckDialog']])(
    '<%s> só aparece atrás de `!lab &&`',
    (tag) => {
      const usos = todos(sf, (no) => nomeDaTag(no) === tag);
      expect(usos.length).toBeGreaterThan(0);
      const soltos = usos.filter((no) => !atrasDeNaoLab(no)).map((no) => `${ARQ}:${linha(sf, no)} <${tag}>`);
      expect(soltos).toEqual([]);
    },
  );

  it.each([['onAcceptNoCharge'], ['onToggleRequiresCreditCheck']])('%s recebe `lab ? undefined : …` onde é passado', (prop) => {
    const atributos = todos(sf, (no) => ts.isJsxAttribute(no) && no.name.getText() === prop) as ts.JsxAttribute[];
    expect(atributos.length).toBeGreaterThan(0);
    const errados = atributos
      .filter((a) => {
        const ini = a.initializer;
        if (!ini || !ts.isJsxExpression(ini) || !ini.expression) return true;
        const e = semParenteses(ini.expression);
        return !(
          ts.isConditionalExpression(e) &&
          ts.isIdentifier(semParenteses(e.condition)) &&
          (semParenteses(e.condition) as ts.Identifier).text === 'lab' &&
          ts.isIdentifier(semParenteses(e.whenTrue)) &&
          (semParenteses(e.whenTrue) as ts.Identifier).text === 'undefined'
        );
      })
      .map((a) => `${ARQ}:${linha(sf, a)} ${prop}`);
    expect(errados).toEqual([]);
  });

  it('o toggle da consulta de crédito no modal do boleto também fica atrás de `!lab &&`', () => {
    const usos = todos(
      funcao(sf, 'BoletoCobrancaUnificadaModal'),
      (no) =>
        ts.isJsxExpression(no) &&
        !!no.expression &&
        operandosE(no.expression).some((op) => ts.isIdentifier(op) && op.text === 'onToggleRequiresCreditCheck'),
    ) as ts.JsxExpression[];
    expect(usos.length).toBeGreaterThan(0);
    const soltos = usos
      .filter((no) => !operandosE(no.expression!).some(ehNaoLab))
      .map((no) => `${ARQ}:${linha(sf, no)}`);
    expect(soltos).toEqual([]);
  });

  it('sem pickBt e sem const LAB_ (arquivo de muito movimento)', () => {
    expect(fonte.includes('pickBt(')).toBe(false);
    const labs = todos(
      sf,
      (no) => ts.isVariableDeclaration(no) && ts.isIdentifier(no.name) && no.name.text.startsWith('LAB_'),
    ).map((no) => `${ARQ}:${linha(sf, no)}`);
    expect(labs).toEqual([]);
  });

  it('todo `lab` vem de isLab(useBusinessType()), no topo do componente e antes de qualquer return', () => {
    const decls = todos(
      sf,
      (no) => ts.isVariableDeclaration(no) && ts.isIdentifier(no.name) && no.name.text === 'lab',
    ) as ts.VariableDeclaration[];
    expect(decls.length).toBeGreaterThanOrEqual(15);
    const temReturn = (no: ts.Node): boolean => {
      if (ts.isReturnStatement(no)) return true;
      if (ts.isFunctionLike(no)) return false;
      return ts.forEachChild(no, temReturn) === true;
    };
    const ruins: string[] = [];
    for (const d of decls) {
      const ini = d.initializer ? d.initializer.getText(sf).replace(/\s+/g, '') : '';
      if (ini !== 'isLab(useBusinessType())') ruins.push(`${ARQ}:${linha(sf, d)} inicializador ${ini}`);
      const stmt = d.parent?.parent;
      const bloco = stmt?.parent;
      const fn = bloco?.parent;
      if (!stmt || !ts.isVariableStatement(stmt) || !bloco || !ts.isBlock(bloco) || !fn || !ts.isFunctionDeclaration(fn)) {
        ruins.push(`${ARQ}:${linha(sf, d)} fora do topo de um componente`);
        continue;
      }
      const idx = bloco.statements.indexOf(stmt);
      const antes = bloco.statements.slice(0, idx).filter((s) => temReturn(s));
      if (antes.length > 0) ruins.push(`${ARQ}:${linha(sf, d)} depois de um return (${fn.name?.text})`);
    }
    expect(ruins).toEqual([]);
  });

  it('os textos da clínica que a F6 envolveu continuam com a contagem de d2147294', () => {
    const textos = textosDoArquivo(sf);
    const diferentes = TEXTOS_DA_CLINICA.map(([texto, esperado]) => [texto, esperado, textos.filter((t) => t === texto).length] as const)
      .filter(([, esperado, agora]) => esperado !== agora)
      .map(([texto, esperado, agora]) => `${JSON.stringify(texto)}: ${esperado} → ${agora}`);
    expect(diferentes).toEqual([]);
  });

  it('o GET de /payment-gateway/settings só roda no laboratório (`if (!lab) return;` no começo do efeito)', () => {
    const usos = todos(sf, (no) => ts.isStringLiteral(no) && no.text === '/payment-gateway/settings');
    expect(usos.length).toBe(1);
    const ruins = usos
      .filter((no) => {
        let p: ts.Node | undefined = no.parent;
        while (p && !ts.isArrowFunction(p) && !ts.isFunctionExpression(p)) p = p.parent;
        if (!p || !ts.isBlock((p as ts.ArrowFunction).body)) return true;
        const primeiro = ((p as ts.ArrowFunction).body as ts.Block).statements[0];
        return !(
          primeiro &&
          ts.isIfStatement(primeiro) &&
          ehNaoLab(primeiro.expression) &&
          ts.isReturnStatement(primeiro.thenStatement) &&
          !primeiro.thenStatement.expression
        );
      })
      .map((no) => `${ARQ}:${linha(sf, no)}`);
    expect(ruins).toEqual([]);
  });

  it('as cobranças do plano só são buscadas fora do laboratório e o rascunho da clínica segue no caminho de hoje', () => {
    const planos = todos(sf, (no) => ts.isTemplateHead(no) && no.text === '/commercial/treatment-plans/');
    expect(planos.length).toBe(1);
    const dentroDeIfNaoLab = (no: ts.Node): boolean => {
      let p: ts.Node | undefined = no.parent;
      while (p && !ts.isSourceFile(p)) {
        if (ts.isIfStatement(p) && operandosE(p.expression).some(ehNaoLab)) return true;
        p = p.parent;
      }
      return false;
    };
    expect(planos.filter((no) => !dentroDeIfNaoLab(no)).map((no) => `${ARQ}:${linha(sf, no)}`)).toEqual([]);

    const rascunhos = todos(sf, (no) => ts.isTemplateHead(no) && no.text === '/commercial/patients/');
    expect(rascunhos.length).toBe(1);
    const noRamoDaClinica = rascunhos.every((no) => {
      const tpl = no.parent;
      const cond = tpl?.parent;
      return (
        !!cond &&
        ts.isConditionalExpression(cond) &&
        ts.isIdentifier(semParenteses(cond.condition)) &&
        (semParenteses(cond.condition) as ts.Identifier).text === 'lab' &&
        cond.whenFalse === tpl
      );
    });
    expect(noRamoDaClinica).toBe(true);
  });
});

describe('F6 — textos de laboratório da aba Propostas (lab-propostas-textos.ts)', () => {
  const sf = ler(TEXTOS);

  it('nenhum texto com palavra de clínica', () => {
    const ruins = textosDoArquivo(sf)
      .filter((t) => temPalavraDeClinica(t))
      .map((t) => JSON.stringify(t));
    expect(ruins).toEqual([]);
  });

  it('só declara consts LAB_ no nível do arquivo', () => {
    const fora = sf.statements
      .filter((s) => !ts.isImportDeclaration(s))
      .filter(
        (s) =>
          !(
            ts.isVariableStatement(s) &&
            s.declarationList.declarations.every((d) => ts.isIdentifier(d.name) && d.name.text.startsWith('LAB_'))
          ),
      )
      .map((s) => `${TEXTOS}:${linha(sf, s)}`);
    expect(fora).toEqual([]);
  });

  it('os placeholders dos bônus no laboratório começam diferentes (o diálogo compara os 20 primeiros caracteres)', () => {
    // Placeholders da clínica por tipo (BONUS_TEMPLATES da PropostasTab).
    const tab = ler(ARQ);
    const porTipo = new Map<string, string>();
    for (const no of todos(tab, (n) => ts.isObjectLiteralExpression(n))) {
      const obj = no as ts.ObjectLiteralExpression;
      const prop = (nome: string) =>
        obj.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(tab) === nome);
      const tipo = prop('type');
      const ph = prop('placeholder');
      if (tipo && ph && ts.isStringLiteral(tipo.initializer) && ts.isStringLiteral(ph.initializer)) {
        porTipo.set(tipo.initializer.text, ph.initializer.text);
      }
    }
    expect(porTipo.size).toBe(6);
    // Troca pelos placeholders de laboratório (LAB_PROPOSTAS.bonus).
    const bonus = todos(sf, (n) => ts.isPropertyAssignment(n) && n.name.getText(sf) === 'bonus')[0] as ts.PropertyAssignment;
    expect(bonus).toBeDefined();
    const trocados = todos(bonus, (n) => ts.isPropertyAssignment(n) && n.name.getText(sf) === 'placeholder') as ts.PropertyAssignment[];
    expect(trocados.length).toBeGreaterThan(0);
    for (const p of trocados) {
      let dono: ts.Node = p.parent;
      while (!ts.isPropertyAssignment(dono)) dono = dono.parent;
      const tipo = dono.name.getText(sf);
      expect(porTipo.has(tipo)).toBe(true);
      porTipo.set(tipo, (p.initializer as ts.StringLiteral).text);
    }
    const comecos = [...porTipo.values()].map((ph) => ph.slice(0, 20));
    expect(new Set(comecos).size).toBe(comecos.length);
  });
});
