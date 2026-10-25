#!/usr/bin/env node
/**
 * Inventário do que roda sozinho e das rotas (F0a, item 2).
 *
 * Varre apps/api/src e apps/worker/src com o compilador do TypeScript (AST,
 * não regex) e lista, de forma determinística (ordenado, sem número de linha):
 *
 *   - automatismos: @Cron, @Interval, @Timeout, @Processor (+ @OnWorkerEvent,
 *     @OnQueueEvent, @QueueEventsListener), onModuleInit, onApplicationBootstrap,
 *     setInterval/setTimeout de boot (construtor, onModuleInit,
 *     onApplicationBootstrap, inicializador de campo, topo do arquivo e main.ts),
 *     new QueueEvents, new Worker do bullmq e BullModule.registerQueue;
 *   - socket: @WebSocketGateway, @SubscribeMessage e os handlers registrados
 *     dentro de um `.on('connection', (socket) => …)` (é assim no main.ts);
 *   - globais: APP_GUARD / APP_INTERCEPTOR / APP_FILTER / APP_PIPE, na ordem
 *     em que aparecem (a ordem dos guards importa: o JwtAuthGuard popula o
 *     req.user antes do RolesGuard);
 *   - controllers: path do @Controller, cada handler (verbo + path) e os
 *     decoradores de acesso da classe e do método.
 *
 * O spec apps/api/src/__guards__/inventario.spec.ts compara isso com os JSON
 * commitados: automatismos, socket e globais em modo ESTRITO (falha); rotas só
 * avisam. É a base da regra futura "o laboratório nega por padrão o que não foi
 * classificado": nada que roda sozinho entra sem alguém olhar.
 *
 * Uso:
 *   node scripts/ci/inventario.cjs            # imprime o JSON dos dois apps
 *   node scripts/ci/inventario.cjs api        # só um app
 *   node scripts/ci/inventario.cjs --write    # grava apps/<app>/src/__guards__/inventario.json
 *                                             # (atalho: npm run guards:update)
 *   node scripts/ci/inventario.cjs --check    # compara com o commitado, sem jest (sai 1 se falhar)
 *
 * Contagem em 08714e89 (= 17062080 em api/worker; AST): 50 @Cron (24 api + 26 worker), 7 @Processor,
 * 12 onModuleInit, 28 @Public. A busca por texto dá 51 e 8 porque conta um
 * `// @Cron(` comentado (collection-engine.service.ts, desligado de propósito) e
 * um `@Processor('memory-jobs')` dentro de comentário (memory-jobs.processor.ts).
 */
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const RAIZ = path.resolve(__dirname, '..', '..');
// O typescript fica içado na raiz pelo npm workspaces; se não estiver, usa o da API.
const ts = (() => {
  try {
    return require('typescript');
  } catch {
    return createRequire(path.join(RAIZ, 'apps', 'api', 'package.json'))('typescript');
  }
})();
const APPS = ['api', 'worker'];

// Decoradores que mudam QUEM entra na rota.
const DECORADORES_ACESSO = new Set([
  'Public',
  'Roles',
  'RequiresPermission',
  'SuperAdmin',
  'UseGuards',
  'Throttle',
  'SkipThrottle',
]);
const VERBOS_HTTP = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  All: 'ALL',
  Options: 'OPTIONS',
  Head: 'HEAD',
};
// Decoradores de método que fazem o código rodar sem requisição.
const DECORADORES_AGENDA = new Set(['Cron', 'Interval', 'Timeout', 'OnWorkerEvent', 'OnQueueEvent']);
// Decoradores de classe que ligam um consumidor de fila.
const DECORADORES_FILA = new Set(['Processor', 'QueueEventsListener']);
const HOOKS_BOOT = new Set(['onModuleInit', 'onApplicationBootstrap']);
// Onde um setInterval/setTimeout conta como "de boot".
const MEMBROS_BOOT = new Set(['constructor', 'onModuleInit', 'onApplicationBootstrap']);
const TOKENS_GLOBAIS = new Set(['APP_GUARD', 'APP_INTERCEPTOR', 'APP_FILTER', 'APP_PIPE']);
const REGISTRO_FILA = new Set([
  'registerQueue',
  'registerQueueAsync',
  'registerFlowProducer',
  'registerFlowProducerAsync',
]);

// Comparação por code unit: igual em qualquer SO e qualquer locale.
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function caminhoInventario(app) {
  return path.join(RAIZ, 'apps', app, 'src', '__guards__', 'inventario.json');
}

/** .ts de produção do app (o mesmo corte do tsconfig.build: sem *spec.ts). */
function listarArquivos(dir) {
  const saida = [];
  const visitar = (d) => {
    const entradas = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => cmp(a.name, b.name));
    for (const e of entradas) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '__guards__') continue;
        visitar(p);
      } else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !/spec\.ts$/.test(e.name)) {
        saida.push(p);
      }
    }
  };
  visitar(dir);
  return saida;
}

function decoradoresDe(node) {
  if (typeof ts.canHaveDecorators === 'function') {
    return (ts.canHaveDecorators(node) && ts.getDecorators(node)) || [];
  }
  return node.decorators || [];
}

/**
 * Texto canônico de uma expressão: aspas simples, sem quebra de linha, sem
 * vírgula sobrando. Assim o prettier ou um reformat não mudam o inventário.
 */
function texto(node, sf) {
  if (!node) return '';
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return `'${node.text}'`;
  if (ts.isNumericLiteral(node) || ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (node.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  if (node.kind === ts.SyntaxKind.NullKeyword) return 'null';
  if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isPropertyAccessExpression(node)) return `${texto(node.expression, sf)}.${node.name.text}`;
  if (ts.isElementAccessExpression(node)) return `${texto(node.expression, sf)}[${texto(node.argumentExpression, sf)}]`;
  if (ts.isArrayLiteralExpression(node)) return `[${node.elements.map((e) => texto(e, sf)).join(', ')}]`;
  if (ts.isObjectLiteralExpression(node)) {
    if (!node.properties.length) return '{}';
    const props = node.properties.map((p) => {
      if (ts.isPropertyAssignment(p)) return `${texto(p.name, sf)}: ${texto(p.initializer, sf)}`;
      if (ts.isShorthandPropertyAssignment(p)) return p.name.text;
      if (ts.isSpreadAssignment(p)) return `...${texto(p.expression, sf)}`;
      return achatar(p, sf);
    });
    return `{ ${props.join(', ')} }`;
  }
  if (ts.isCallExpression(node)) {
    return `${texto(node.expression, sf)}(${node.arguments.map((a) => texto(a, sf)).join(', ')})`;
  }
  if (ts.isNewExpression(node)) {
    return `new ${texto(node.expression, sf)}(${(node.arguments || []).map((a) => texto(a, sf)).join(', ')})`;
  }
  if (ts.isBinaryExpression(node)) {
    return `${texto(node.left, sf)} ${node.operatorToken.getText(sf)} ${texto(node.right, sf)}`;
  }
  if (ts.isPrefixUnaryExpression(node)) return `${ts.tokenToString(node.operator)}${texto(node.operand, sf)}`;
  if (ts.isParenthesizedExpression(node)) return `(${texto(node.expression, sf)})`;
  if (ts.isAsExpression(node)) return `${texto(node.expression, sf)} as ${achatar(node.type, sf)}`;
  if (ts.isComputedPropertyName(node)) return `[${texto(node.expression, sf)}]`;
  return achatar(node, sf);
}

function achatar(node, sf) {
  return node
    .getText(sf)
    .replace(/\s+/g, ' ')
    .replace(/,\s*([}\])])/g, ' $1')
    .trim();
}

function nomeMembro(name, sf) {
  if (!name) return '(sem nome)';
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return texto(name, sf);
}

/** Apelidos de import: `import { Cron as Agenda }` → Agenda vale Cron. */
function mapaImports(sf) {
  const mapa = new Map();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const modulo = st.moduleSpecifier.text;
    const nb = st.importClause.namedBindings;
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        mapa.set(el.name.text, { nome: el.propertyName ? el.propertyName.text : el.name.text, modulo });
      }
    }
  }
  return mapa;
}

function infoDecorador(dec, sf, imports) {
  let expr = dec.expression;
  let args = [];
  if (ts.isCallExpression(expr)) {
    args = Array.from(expr.arguments);
    expr = expr.expression;
  }
  let nome;
  if (ts.isIdentifier(expr)) nome = imports.has(expr.text) ? imports.get(expr.text).nome : expr.text;
  else if (ts.isPropertyAccessExpression(expr)) nome = expr.name.text;
  else nome = texto(expr, sf);
  return { nome, args, chamada: ts.isCallExpression(dec.expression) };
}

function textoDecorador(info, sf) {
  return `@${info.nome}${info.chamada ? `(${info.args.map((a) => texto(a, sf)).join(', ')})` : ''}`;
}

/** Path de @Controller / @Get: string vira o próprio texto, objeto { path } idem. */
function pathDe(arg, sf) {
  if (!arg) return '';
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isObjectLiteralExpression(arg)) {
    const p = arg.properties.find((x) => ts.isPropertyAssignment(x) && nomeMembro(x.name, sf) === 'path');
    if (p) return pathDe(p.initializer, sf);
    return '';
  }
  return texto(arg, sf);
}

function juntarRota(base, sub) {
  const partes = [base, sub].map((p) => String(p).replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return `/${partes.join('/')}`;
}

function ehMembroDeClasse(n) {
  return (
    n.parent &&
    ts.isClassLike(n.parent) &&
    (ts.isMethodDeclaration(n) ||
      ts.isConstructorDeclaration(n) ||
      ts.isPropertyDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n) ||
      ts.isClassStaticBlockDeclaration(n))
  );
}

function ehFuncao(n) {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n)
  );
}

function nomeClasse(c) {
  return c.name ? c.name.text : '(classe anônima)';
}

/**
 * Onde o nó está: membro de classe (Classe.metodo), classe (decorador, ex.
 * @Module), função nomeada (bootstrap()) ou o topo do arquivo.
 */
function contexto(node, sf) {
  let n = node.parent;
  let atravessouFuncao = false;
  let funcaoNomeada = null;
  while (n) {
    if (ehMembroDeClasse(n)) {
      const membro = ts.isConstructorDeclaration(n)
        ? 'constructor'
        : ts.isClassStaticBlockDeclaration(n)
          ? 'static {}'
          : nomeMembro(n.name, sf);
      // Inicializador de campo e bloco static rodam na construção/carga.
      const direto = !atravessouFuncao && (ts.isPropertyDeclaration(n) || ts.isClassStaticBlockDeclaration(n));
      return { alvo: `${nomeClasse(n.parent)}.${membro}`, membro, inicializador: direto, emFuncao: true };
    }
    if (ts.isClassLike(n)) {
      return { alvo: nomeClasse(n), membro: null, inicializador: false, emFuncao: atravessouFuncao };
    }
    if (ehFuncao(n)) {
      atravessouFuncao = true;
      if (!funcaoNomeada) {
        if (ts.isFunctionDeclaration(n) && n.name) funcaoNomeada = n.name.text;
        else if (n.parent && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) {
          funcaoNomeada = n.parent.name.text;
        }
      }
    }
    n = n.parent;
  }
  return {
    alvo: funcaoNomeada ? `${funcaoNomeada}()` : atravessouFuncao ? '(função anônima)' : '(topo do arquivo)',
    membro: null,
    inicializador: false,
    emFuncao: atravessouFuncao,
  };
}

function nomeChamada(expr, imports) {
  if (ts.isIdentifier(expr)) return imports.has(expr.text) ? imports.get(expr.text).nome : expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function analisarArquivo(arquivoAbs, srcDir, acc) {
  const rel = path.relative(srcDir, arquivoAbs).split(path.sep).join('/');
  const ehMain = rel === 'main.ts';
  const fonte = fs.readFileSync(arquivoAbs, 'utf8').replace(/^\uFEFF/, '');
  const sf = ts.createSourceFile(rel, fonte, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = mapaImports(sf);

  const auto = (tipo, alvo, detalhe) => acc.automatismos.push({ tipo, arquivo: rel, alvo, detalhe });
  const socket = (tipo, alvo, detalhe) => acc.socket.push({ tipo, arquivo: rel, alvo, detalhe });

  const visitarClasse = (c) => {
    const classe = nomeClasse(c);
    const decsClasse = decoradoresDe(c).map((d) => infoDecorador(d, sf, imports));

    for (const d of decsClasse) {
      if (DECORADORES_FILA.has(d.nome)) {
        auto(`@${d.nome}`, classe, d.args.map((a) => texto(a, sf)).join(', '));
      }
      if (d.nome === 'WebSocketGateway') {
        socket('@WebSocketGateway', classe, d.args.map((a) => texto(a, sf)).join(', '));
      }
    }

    const ctrl = decsClasse.find((d) => d.nome === 'Controller');
    let controller = null;
    if (ctrl) {
      controller = {
        arquivo: rel,
        classe,
        path: pathDe(ctrl.args[0], sf),
        acesso: decsClasse.filter((d) => DECORADORES_ACESSO.has(d.nome)).map((d) => textoDecorador(d, sf)).sort(cmp),
        handlers: [],
      };
      acc.controllers.push(controller);
    }

    for (const m of c.members) {
      const membro = ts.isConstructorDeclaration(m) ? 'constructor' : m.name ? nomeMembro(m.name, sf) : null;
      if (!membro) continue;
      const alvo = `${classe}.${membro}`;
      const decs = decoradoresDe(m).map((d) => infoDecorador(d, sf, imports));

      for (const d of decs) {
        if (DECORADORES_AGENDA.has(d.nome)) {
          auto(`@${d.nome}`, alvo, d.args.map((a) => texto(a, sf)).join(', '));
        }
        if (d.nome === 'SubscribeMessage') {
          socket('@SubscribeMessage', alvo, d.args.map((a) => texto(a, sf)).join(', '));
        }
      }

      const ehMetodo =
        ts.isMethodDeclaration(m) ||
        (ts.isPropertyDeclaration(m) && m.initializer && (ts.isArrowFunction(m.initializer) || ts.isFunctionExpression(m.initializer)));
      if (ehMetodo && HOOKS_BOOT.has(membro)) auto(membro, alvo, '');

      if (controller) {
        const acessoMetodo = decs.filter((d) => DECORADORES_ACESSO.has(d.nome)).map((d) => textoDecorador(d, sf)).sort(cmp);
        for (const d of decs) {
          const verbo = VERBOS_HTTP[d.nome];
          if (!verbo) continue;
          const sub = pathDe(d.args[0], sf);
          controller.handlers.push({
            metodo: alvo,
            verbo,
            path: sub,
            rota: `${verbo} ${juntarRota(controller.path, sub)}`,
            acesso: acessoMetodo,
          });
        }
      }
    }
  };

  const visitar = (node) => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) visitarClasse(node);

    if (ts.isCallExpression(node)) {
      const nome = nomeChamada(node.expression, imports);
      const alvoGlobal =
        ts.isIdentifier(node.expression) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          ['global', 'globalThis', 'window'].includes(node.expression.expression.text));

      // setInterval/setTimeout de boot: construtor, onModuleInit,
      // onApplicationBootstrap, inicializador de campo, topo do arquivo, main.ts.
      if ((nome === 'setInterval' || nome === 'setTimeout') && alvoGlobal) {
        const ctx = contexto(node, sf);
        const boot = ctx.membro
          ? MEMBROS_BOOT.has(ctx.membro) || ctx.inicializador
          : !ctx.emFuncao || ehMain;
        if (boot) auto(`${nome} (boot)`, ctx.alvo, '');
      }

      // BullModule.registerQueue({ name }) — fila nova no app.
      if (
        nome &&
        REGISTRO_FILA.has(nome) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'BullModule'
      ) {
        const ctx = contexto(node, sf);
        for (const a of node.arguments) {
          let det = texto(a, sf);
          if (ts.isObjectLiteralExpression(a)) {
            const p = a.properties.find((x) => ts.isPropertyAssignment(x) && nomeMembro(x.name, sf) === 'name');
            if (p) det = texto(p.initializer, sf);
          }
          auto(`BullModule.${nome}`, ctx.alvo, det);
        }
      }

      // X.on('connection', (socket) => { socket.on('evento', …) })
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === 'on' || node.expression.name.text === 'once') &&
        node.arguments.length >= 2 &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === 'connection' &&
        (ts.isArrowFunction(node.arguments[1]) || ts.isFunctionExpression(node.arguments[1]))
      ) {
        const ctx = contexto(node, sf);
        const receptor = texto(node.expression.expression, sf);
        socket(".on('connection')", ctx.alvo, receptor);
        const cb = node.arguments[1];
        const p0 = cb.parameters[0];
        if (p0 && ts.isIdentifier(p0.name)) {
          const param = p0.name.text;
          const eventos = (n) => {
            if (
              ts.isCallExpression(n) &&
              ts.isPropertyAccessExpression(n.expression) &&
              (n.expression.name.text === 'on' || n.expression.name.text === 'once') &&
              ts.isIdentifier(n.expression.expression) &&
              n.expression.expression.text === param &&
              n.arguments.length >= 1
            ) {
              const ev = n.arguments[0];
              socket(`${param}.${n.expression.name.text}`, ctx.alvo, ts.isStringLiteral(ev) ? ev.text : texto(ev, sf));
            }
            ts.forEachChild(n, eventos);
          };
          ts.forEachChild(cb.body, eventos);
        }
      }
    }

    if (ts.isNewExpression(node)) {
      const nome = nomeChamada(node.expression, imports);
      const deBullmq = ts.isIdentifier(node.expression) && imports.has(node.expression.text)
        ? imports.get(node.expression.text).modulo === 'bullmq'
        : false;
      if (nome === 'QueueEvents' || (nome === 'Worker' && deBullmq)) {
        const ctx = contexto(node, sf);
        auto(`new ${nome}`, ctx.alvo, node.arguments && node.arguments[0] ? texto(node.arguments[0], sf) : '');
      }
    }

    // { provide: APP_GUARD, useClass: X } — em qualquer módulo, na ordem do fonte.
    if (ts.isObjectLiteralExpression(node)) {
      const prop = (k) => node.properties.find((p) => ts.isPropertyAssignment(p) && nomeMembro(p.name, sf) === k);
      const provide = prop('provide');
      if (provide && ts.isIdentifier(provide.initializer) && TOKENS_GLOBAIS.has(provide.initializer.text)) {
        const tipoUso = ['useClass', 'useExisting', 'useFactory', 'useValue'].find((k) => prop(k));
        let classe = '(?)';
        if (tipoUso === 'useClass' || tipoUso === 'useExisting') classe = texto(prop(tipoUso).initializer, sf);
        else if (tipoUso) classe = `(${tipoUso})`;
        acc.globais.push({ arquivo: rel, token: provide.initializer.text, classe });
      }
    }

    ts.forEachChild(node, visitar);
  };

  visitar(sf);
}

function chaveItem(i) {
  return [i.tipo, i.arquivo, i.alvo, i.detalhe].join('\u0000');
}

/** Mesmo item duas vezes no mesmo lugar (ex.: 2 setTimeout no onModuleInit) ganha #2. */
function numerarRepetidos(itens) {
  const vistos = new Map();
  for (const i of itens) {
    const k = chaveItem(i);
    const n = (vistos.get(k) || 0) + 1;
    vistos.set(k, n);
    if (n > 1) i.detalhe = i.detalhe ? `${i.detalhe} #${n}` : `#${n}`;
  }
  return itens;
}

function ordenarItens(itens) {
  return itens.sort(
    (a, b) => cmp(a.tipo, b.tipo) || cmp(a.arquivo, b.arquivo) || cmp(a.alvo, b.alvo) || cmp(a.detalhe, b.detalhe),
  );
}

function gerarInventario(app) {
  if (!APPS.includes(app)) throw new Error(`app desconhecido: ${app}`);
  const srcDir = path.join(RAIZ, 'apps', app, 'src');
  const acc = { automatismos: [], socket: [], globais: [], controllers: [] };
  for (const f of listarArquivos(srcDir)) analisarArquivo(f, srcDir, acc);

  const automatismos = ordenarItens(numerarRepetidos(acc.automatismos));
  const socket = ordenarItens(numerarRepetidos(acc.socket));
  // Globais: arquivos em ordem; dentro do arquivo, a ordem do fonte (importa).
  const globais = acc.globais
    .map((g, i) => ({ g, i }))
    .sort((a, b) => cmp(a.g.arquivo, b.g.arquivo) || a.i - b.i)
    .map((x) => x.g);
  const controllers = acc.controllers.sort((a, b) => cmp(a.arquivo, b.arquivo) || cmp(a.classe, b.classe));

  const contagem = {};
  for (const i of automatismos) contagem[i.tipo] = (contagem[i.tipo] || 0) + 1;
  const handlers = controllers.reduce((s, c) => s + c.handlers.length, 0);
  const publicos = controllers.reduce(
    (s, c) =>
      s +
      c.acesso.filter((a) => a.startsWith('@Public')).length +
      c.handlers.reduce((t, h) => t + h.acesso.filter((a) => a.startsWith('@Public')).length, 0),
    0,
  );

  return {
    _aviso: 'Gerado por scripts/ci/inventario.cjs — não edite à mão. Atualize com: npm run guards:update',
    app,
    resumo: {
      automatismos: Object.fromEntries(Object.keys(contagem).sort(cmp).map((k) => [k, contagem[k]])),
      socket: socket.length,
      globais: globais.length,
      controllers: controllers.length,
      handlers,
      '@Public': publicos,
    },
    automatismos,
    socket,
    globais,
    controllers,
  };
}

/**
 * JSON com um item por linha (objeto "folha" = só primitivos e listas de
 * primitivos): o diff do git mostra uma linha por rota/automatismo.
 */
function serializar(inv) {
  const primitivo = (x) => x === null || typeof x !== 'object';
  const listaSimples = (x) => Array.isArray(x) && x.every(primitivo);
  const umaLinha = (x) => (listaSimples(x) ? `[${x.map((y) => JSON.stringify(y)).join(', ')}]` : JSON.stringify(x));
  const folha = (v) => Object.values(v).every((x) => primitivo(x) || listaSimples(x));
  const emitir = (v, ind) => {
    const pad = '  '.repeat(ind);
    const padIn = '  '.repeat(ind + 1);
    if (Array.isArray(v)) {
      if (listaSimples(v)) return umaLinha(v);
      return `[\n${v.map((x) => padIn + emitir(x, ind + 1)).join(',\n')}\n${pad}]`;
    }
    if (v && typeof v === 'object') {
      const ents = Object.entries(v);
      if (!ents.length) return '{}';
      if (folha(v) && ind > 0) return `{ ${ents.map(([k, x]) => `${JSON.stringify(k)}: ${umaLinha(x)}`).join(', ')} }`;
      return `{\n${ents.map(([k, x]) => `${padIn}${JSON.stringify(k)}: ${emitir(x, ind + 1)}`).join(',\n')}\n${pad}}`;
    }
    return JSON.stringify(v);
  };
  return `${emitir(inv, 0)}\n`;
}

// ─── Comparação (usada pelo spec) ─────────────────────────────────────────

function linhaItem(i) {
  return [i.tipo, i.arquivo, i.alvo, i.detalhe].filter(Boolean).join('  ');
}

/** Diferença entre duas listas de itens {tipo, arquivo, alvo, detalhe}. */
function diffItens(antes, depois) {
  const a = new Set((antes || []).map(chaveItem));
  const d = new Set((depois || []).map(chaveItem));
  const novos = (depois || []).filter((i) => !a.has(chaveItem(i))).map(linhaItem);
  const removidos = (antes || []).filter((i) => !d.has(chaveItem(i))).map(linhaItem);
  return { novos, removidos };
}

function linhaGlobal(g) {
  return `${g.arquivo}  ${g.token}  ${g.classe}`;
}

/** Globais: a ORDEM conta. Devolve as duas listas se mudou algo. */
function diffGlobais(antes, depois) {
  const a = (antes || []).map(linhaGlobal);
  const d = (depois || []).map(linhaGlobal);
  return JSON.stringify(a) === JSON.stringify(d) ? null : { antes: a, depois: d };
}

/** Rotas: por handler (Classe.metodo + verbo + path), com o acesso da classe e do método. */
function diffRotas(antes, depois) {
  const indexar = (ctrls) => {
    const m = new Map();
    for (const c of ctrls || []) {
      for (const h of c.handlers) {
        m.set(`${c.arquivo}  ${h.metodo}  ${h.rota}`, `classe [${c.acesso.join(' ')}] método [${h.acesso.join(' ')}]`);
      }
    }
    return m;
  };
  const a = indexar(antes);
  const d = indexar(depois);
  const novos = [...d.keys()].filter((k) => !a.has(k)).map((k) => `${k}  ${d.get(k)}`);
  const removidos = [...a.keys()].filter((k) => !d.has(k)).map((k) => `${k}  ${a.get(k)}`);
  const acessoMudou = [...d.keys()]
    .filter((k) => a.has(k) && a.get(k) !== d.get(k))
    .map((k) => `${k}\n      antes:  ${a.get(k)}\n      agora:  ${d.get(k)}`);
  const ctrlA = new Set((antes || []).map((c) => `${c.arquivo}  ${c.classe}  @Controller('${c.path}')`));
  const ctrlD = new Set((depois || []).map((c) => `${c.arquivo}  ${c.classe}  @Controller('${c.path}')`));
  const controllersNovos = [...ctrlD].filter((k) => !ctrlA.has(k));
  const controllersRemovidos = [...ctrlA].filter((k) => !ctrlD.has(k));

  // A ordem dos handlers decide qual rota casa primeiro (ex.: 'quotes/journey-board'
  // tem de vir antes de 'quotes/:id'). Compara a sequência dos que existem nos dois.
  const ordemMudou = [];
  const porClasse = (ctrls) => new Map((ctrls || []).map((c) => [`${c.arquivo}  ${c.classe}`, c]));
  const ca = porClasse(antes);
  for (const [k, cd] of porClasse(depois)) {
    const cAntes = ca.get(k);
    if (!cAntes) continue;
    const id = (h) => `${h.metodo}  ${h.rota}`;
    const emAmbos = new Set(cAntes.handlers.map(id).filter((x) => cd.handlers.some((h) => id(h) === x)));
    const seqA = cAntes.handlers.map(id).filter((x) => emAmbos.has(x));
    const seqD = cd.handlers.map(id).filter((x) => emAmbos.has(x));
    if (JSON.stringify(seqA) !== JSON.stringify(seqD)) ordemMudou.push(k);
  }
  return { controllersNovos, controllersRemovidos, novos, removidos, acessoMudou, ordemMudou };
}

const lista = (titulo, linhas, marca) =>
  linhas.length ? [`  ${titulo}:`, ...linhas.map((l) => `    ${marca ? `${marca} ` : ''}${l}`)] : [];

/**
 * Compara o inventário commitado com o gerado agora. Devolve:
 *   - estrito: texto do que mudou em automatismos / socket / globais (FALHA);
 *   - avisos:  texto do que mudou em controllers / rotas / acesso (só avisa).
 * null quando não mudou nada naquela parte.
 */
function compararInventarios(app, commitado, gerado) {
  const json = path.relative(RAIZ, caminhoInventario(app)).split(path.sep).join('/');
  const partes = [];

  const auto = diffItens(commitado.automatismos, gerado.automatismos);
  if (auto.novos.length || auto.removidos.length) {
    partes.push('  O que roda sozinho (automatismos) mudou:');
    partes.push(...lista('novo', auto.novos, '+').map((l) => `  ${l}`));
    partes.push(...lista('removido', auto.removidos, '-').map((l) => `  ${l}`));
  }
  const sock = diffItens(commitado.socket, gerado.socket);
  if (sock.novos.length || sock.removidos.length) {
    partes.push('  Handlers de socket mudaram:');
    partes.push(...lista('novo', sock.novos, '+').map((l) => `  ${l}`));
    partes.push(...lista('removido', sock.removidos, '-').map((l) => `  ${l}`));
  }
  const glob = diffGlobais(commitado.globais, gerado.globais);
  if (glob) {
    partes.push('  Ordem/lista dos APP_GUARD (e APP_INTERCEPTOR/APP_FILTER/APP_PIPE) mudou:');
    partes.push(...lista('antes', glob.antes, '').map((l) => `  ${l}`));
    partes.push(...lista('agora', glob.depois, '').map((l) => `  ${l}`));
  }
  const igual = (k) => JSON.stringify(commitado[k] || []) === JSON.stringify(gerado[k] || []);
  if (!partes.length && !(igual('automatismos') && igual('socket') && igual('globais'))) {
    partes.push('  O inventário commitado não bate com o gerado (editado à mão ou gerador mudou).');
  }
  const estrito = partes.length
    ? [
        `[inventário ${app}] mudou o que roda sem requisição:`,
        ...partes,
        '',
        `Rode "npm run guards:update", confira se esse automatismo pode rodar para todos os tenants`,
        `(as clínicas de hoje e o laboratório que vem) e commite o inventário junto (${json}).`,
      ].join('\n')
    : null;

  const r = diffRotas(commitado.controllers, gerado.controllers);
  const av = [
    ...lista('controller novo', r.controllersNovos, '+'),
    ...lista('controller removido', r.controllersRemovidos, '-'),
    ...lista('rota nova', r.novos, '+'),
    ...lista('rota removida', r.removidos, '-'),
    ...lista('acesso mudou', r.acessoMudou, '~'),
    ...lista('ordem das rotas mudou (a ordem decide qual rota casa primeiro)', r.ordemMudou, '~'),
  ];
  if (!av.length && !igual('controllers')) av.push('  inventário de rotas desatualizado (só forma).');
  const avisos = av.length
    ? [
        `[inventário ${app}] rotas/controllers mudaram (só aviso, não falha):`,
        ...av,
        `Confira o acesso de cada rota nova e rode "npm run guards:update" para atualizar ${json}.`,
      ].join('\n')
    : null;

  return { estrito, avisos };
}

module.exports = {
  APPS,
  RAIZ,
  caminhoInventario,
  gerarInventario,
  serializar,
  diffItens,
  diffGlobais,
  diffRotas,
  compararInventarios,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const gravar = args.includes('--write');
  const conferir = args.includes('--check');
  const pedidos = args.filter((a) => !a.startsWith('--'));
  for (const p of pedidos) {
    if (!APPS.includes(p)) {
      console.error('uso: node scripts/ci/inventario.cjs [api|worker] [--write | --check]');
      process.exit(2);
    }
  }
  const apps = pedidos.length ? pedidos : APPS;
  if (conferir) {
    // O mesmo que o spec faz, sem jest: sai 1 se mudou algo estrito.
    let falhou = false;
    for (const app of apps) {
      const destino = caminhoInventario(app);
      if (!fs.existsSync(destino)) {
        console.error(`[inventário ${app}] ${destino} não existe — rode "npm run guards:update".`);
        falhou = true;
        continue;
      }
      const { estrito, avisos } = compararInventarios(app, JSON.parse(fs.readFileSync(destino, 'utf8')), gerarInventario(app));
      if (avisos) console.warn(avisos);
      if (estrito) {
        console.error(estrito);
        falhou = true;
      }
      if (!estrito && !avisos) console.log(`[inventário ${app}] igual ao commitado`);
    }
    process.exit(falhou ? 1 : 0);
  } else if (gravar) {
    for (const app of apps) {
      const inv = gerarInventario(app);
      const destino = caminhoInventario(app);
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.writeFileSync(destino, serializar(inv));
      const r = inv.resumo;
      const autos = Object.entries(r.automatismos).map(([k, v]) => `${v} ${k}`).join(', ');
      console.log(
        `[inventario] ${app}: ${path.relative(RAIZ, destino).split(path.sep).join('/')} — ${autos}; ` +
          `${r.socket} socket; ${r.globais} globais; ${r.controllers} controllers, ${r.handlers} rotas, ${r['@Public']} @Public`,
      );
    }
  } else {
    const saida = apps.length === 1 ? gerarInventario(apps[0]) : Object.fromEntries(apps.map((a) => [a, gerarInventario(a)]));
    process.stdout.write(serializar(saida));
  }
}
