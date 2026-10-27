/**
 * Cadastro do usuário na resposta da API: a senha criptografada e os códigos de
 * troca de senha e de confirmação de e-mail NUNCA saem do servidor.
 *
 * (1) As rotas de usuários (lista da equipe, "meus dados", criar, editar,
 *     supervisores) devolvem o usuário sem esses campos; "meus dados" também sem
 *     o pagamento do profissional.
 * (2) A lista de tarefas traz do responsável só id e nome (e do contato só id,
 *     nome e telefone).
 * (3) Trava para o futuro: em nenhum lugar da API uma relação que aponta para
 *     User entra num include/select inteira (`: true` ou objeto sem `select`) —
 *     fora de `_count`, que só conta.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { Prisma } from '@crm/shared';
import { UsersService } from '../users/users.service';
import { TasksService } from '../tasks/tasks.service';
import {
  CAMPOS_DE_PAGAMENTO_DO_USUARIO,
  CAMPOS_SECRETOS_DO_USUARIO,
  semSegredos,
  semSegredosNemPagamento,
} from '../users/usuario-sem-segredos';

const CLINICA = '00000000-0000-0000-0000-0000000000c1';

/** Usuário como o banco devolve sem select: com tudo. */
const USUARIO_COMPLETO = {
  id: 'usuario-1',
  name: 'Ana Exemplo',
  email: 'ana@exemplo.test',
  phone: '5582900000001',
  roles: ['DENTIST'],
  tenant_id: CLINICA,
  sector: 'dentista',
  extra_grants: [],
  extra_revokes: [],
  password_hash: '$argon2id$exemplo',
  password_reset_token: 'codigo-de-troca-exemplo',
  password_reset_sent_at: new Date('2026-10-27T10:00:00Z'),
  email_verify_token: 'codigo-de-confirmacao-exemplo',
  email_verify_sent_at: new Date('2026-10-27T10:00:00Z'),
  commission_sale_type: 'PERCENT',
  commission_sale_value: 5,
  commission_exec_type: 'FIXED',
  commission_exec_value: 100,
  daily_rate: 300,
  inboxes: [{ id: 'setor-1', name: 'Clínica' }],
};

const semNenhum = (obj: any, campos: readonly string[]) => campos.filter((c) => c in (obj ?? {}));

// Escritos à mão (não as constantes do código): o teste não pode ficar cego se alguém tirar um item de lá.
const SECRETOS = ['password_hash', 'password_reset_token', 'password_reset_sent_at', 'email_verify_token', 'email_verify_sent_at'];
const PAGAMENTO = ['commission_sale_type', 'commission_sale_value', 'commission_exec_type', 'commission_exec_value', 'daily_rate'];

function montarUsuarios() {
  const prisma: any = {
    user: {
      findMany: jest.fn(async () => [USUARIO_COMPLETO, { ...USUARIO_COMPLETO, id: 'usuario-2' }]),
      findUnique: jest.fn(async () => USUARIO_COMPLETO),
      create: jest.fn(async () => USUARIO_COMPLETO),
      update: jest.fn(async (args: any) => (args.select ? { id: 'usuario-1', name: 'Ana Exemplo', supervisors: [] } : USUARIO_COMPLETO)),
      count: jest.fn(async () => 1),
    },
    tenant: { findUnique: jest.fn(async () => ({ plan: 'PRO' })) },
    inbox: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
    globalSetting: { findUnique: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    tenantSetting: { findUnique: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  };
  const mail: any = { send: jest.fn(async () => false), renderTemplate: jest.fn(() => ''), isConfigured: jest.fn(async () => false) };
  const svc = new UsersService(prisma, {} as any, mail);
  (svc as any).logger = { log: () => undefined, warn: () => undefined, error: () => undefined };
  return { svc, prisma };
}

describe('semSegredos / semSegredosNemPagamento', () => {
  it('tiram os campos secretos e não mexem no original', () => {
    const r = semSegredos(USUARIO_COMPLETO);
    expect(semNenhum(r, CAMPOS_SECRETOS_DO_USUARIO)).toEqual([]);
    expect(r).toMatchObject({ id: 'usuario-1', name: 'Ana Exemplo', daily_rate: 300 });
    expect(USUARIO_COMPLETO.password_reset_token).toBe('codigo-de-troca-exemplo');
    const r2 = semSegredosNemPagamento(USUARIO_COMPLETO);
    expect(semNenhum(r2, [...SECRETOS, ...PAGAMENTO])).toEqual([]);
    expect([...CAMPOS_SECRETOS_DO_USUARIO].sort()).toEqual([...SECRETOS].sort());
    expect([...CAMPOS_DE_PAGAMENTO_DO_USUARIO].sort()).toEqual([...PAGAMENTO].sort());
    expect(r2).toMatchObject({ id: 'usuario-1', email: 'ana@exemplo.test', roles: ['DENTIST'], sector: 'dentista' });
  });

  it('a lista de campos secretos cobre todo campo de User com senha, código ou envio de código', () => {
    const campos = Prisma.dmmf.datamodel.models.find((m) => m.name === 'User')!.fields.map((f) => f.name);
    const parecemSecretos = campos.filter((c) => /password|token|_sent_at|secret/i.test(c));
    expect(parecemSecretos.filter((c) => !(CAMPOS_SECRETOS_DO_USUARIO as readonly string[]).includes(c))).toEqual([]);
  });
});

describe('rotas de usuários (UsersService)', () => {
  it('GET /users (tela de equipe do ADMIN): sem senha nem códigos; comissão e diária ficam', async () => {
    const { svc } = montarUsuarios();
    const lista = await svc.findAll(CLINICA);
    expect(lista).toHaveLength(2);
    for (const u of lista as any[]) {
      expect(semNenhum(u, SECRETOS)).toEqual([]);
      expect(u.daily_rate).toBe(300);
      expect(u.commission_sale_value).toBe(5);
    }
  });

  it('GET /users/me e /users/:id: sem senha, sem códigos e sem o pagamento do profissional', async () => {
    const { svc } = montarUsuarios();
    const u: any = await svc.findById('usuario-1', CLINICA);
    expect(semNenhum(u, [...SECRETOS, ...PAGAMENTO])).toEqual([]);
    expect(u).toMatchObject({ id: 'usuario-1', name: 'Ana Exemplo', email: 'ana@exemplo.test', roles: ['DENTIST'], sector: 'dentista', extra_grants: [], extra_revokes: [] });
    expect(u.inboxes).toEqual([{ id: 'setor-1', name: 'Clínica' }]);
  });

  it('POST /users: o código de confirmação recém-gerado não volta', async () => {
    const { svc, prisma } = montarUsuarios();
    const u: any = await svc.create({ name: 'Ana Exemplo', email: 'ana@exemplo.test', password: 'senha-de-teste-123', tenant_id: CLINICA });
    expect(prisma.user.create.mock.calls[0][0].data.email_verify_token).toEqual(expect.any(String));
    expect(semNenhum(u, SECRETOS)).toEqual([]);
    expect(u.id).toBe('usuario-1');
  });

  it('PATCH /users/:id: sem senha nem códigos', async () => {
    const { svc } = montarUsuarios();
    const u: any = await svc.update('usuario-1', { name: 'Ana Exemplo' }, CLINICA);
    expect(semNenhum(u, SECRETOS)).toEqual([]);
    expect(u.id).toBe('usuario-1');
  });

  it('PATCH /users/:id/supervisors: só id, nome e supervisores', async () => {
    const { svc, prisma } = montarUsuarios();
    const u: any = await svc.linkSupervisors('usuario-1', [], CLINICA);
    expect(prisma.user.update.mock.calls[0][0].select).toEqual({
      id: true,
      name: true,
      supervisors: { select: { id: true, name: true } },
    });
    expect(prisma.user.update.mock.calls[0][0].include).toBeUndefined();
    expect(Object.keys(u).sort()).toEqual(['id', 'name', 'supervisors']);
  });
});

describe('lista de tarefas (GET /tasks)', () => {
  it.each([
    ['paginada', 1, 50],
    ['sem paginação (contadores e selos)', undefined, 500],
  ])('%s: do responsável só id e nome; do contato só id, nome e telefone', async (_n, page, limit) => {
    const findMany = jest.fn(async () => []);
    const prisma: any = {
      task: { findMany, count: jest.fn(async () => 0) },
      $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
    };
    const svc = new TasksService(prisma, {} as any, {} as any);
    await svc.findAll(CLINICA, page as any, limit as any, {});
    const include = (findMany.mock.calls as any[])[0][0].include;
    expect(include.assigned_user).toEqual({ select: { id: true, name: true } });
    expect(include.lead).toEqual({ select: { id: true, name: true, phone: true } });
  });
});

describe('trava: relação com User nunca entra inteira num include/select da API', () => {
  const RAIZ_SRC = path.resolve(__dirname, '..');
  // Relações (em qualquer model) que apontam para User.
  const RELACOES = new Set(
    Prisma.dmmf.datamodel.models.flatMap((m) => m.fields.filter((f) => f.kind === 'object' && f.type === 'User').map((f) => f.name)),
  );
  // Onde um nome de relação é filtro ou escrita, não projeção do que volta.
  const FILTROS = new Set([
    'where', 'data', 'orderBy', 'cursor', 'distinct', 'having', 'by',
    'connect', 'connectOrCreate', 'disconnect', 'set', 'some', 'every', 'none', 'is', 'isNot',
    'AND', 'OR', 'NOT', 'create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany',
  ]);

  function arquivos(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return ['__guards__', 'node_modules'].includes(e.name) ? [] : arquivos(p);
      return /\.ts$/.test(e.name) && !/\.spec\.ts$/.test(e.name) ? [p] : [];
    });
  }

  const nomeDe = (n: ts.Node | undefined) => (n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : '');
  /** Nós que não mudam o sentido do objeto (`as`, `satisfies`, parênteses, lista). */
  const transparente = (n: ts.Node) =>
    ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n) || ts.isTypeAssertionExpression(n) || ts.isArrayLiteralExpression(n);
  const subir = (n: ts.Node | undefined) => {
    let p = n;
    while (p && transparente(p)) p = p.parent;
    return p;
  };

  /**
   * A propriedade está numa projeção (o que a consulta DEVOLVE)? Sobe pelos objetos:
   * include/select → projeção (select de _count → contagem); where/data/orderBy/... →
   * não; objeto guardado em variável ou campo de classe cujo nome ou tipo fala de
   * include/select (ex.: `const includeOpts`, `closingInclude`, `satisfies
   * Prisma.XInclude`) → projeção.
   */
  function contexto(no: ts.PropertyAssignment): 'projecao' | 'contagem' | 'outro' {
    let objeto: ts.Node = no.parent;
    for (;;) {
      const pai = subir(objeto.parent);
      if (!pai) return 'outro';
      if (ts.isPropertyAssignment(pai)) {
        const chave = nomeDe(pai.name);
        if (FILTROS.has(chave)) return 'outro';
        if (chave === '_count') return 'contagem';
        if (chave === 'include' || chave === 'select') {
          const acima = subir(pai.parent?.parent);
          if (chave === 'select' && acima && ts.isPropertyAssignment(acima) && nomeDe(acima.name) === '_count') return 'contagem';
          return 'projecao';
        }
        objeto = pai.parent;
        continue;
      }
      if (ts.isVariableDeclaration(pai) || ts.isPropertyDeclaration(pai)) {
        const nome = nomeDe(pai.name);
        const tipos = `${pai.type?.getText() ?? ''} ${(pai.initializer?.getText().match(/\b(satisfies|as)\s+[\w.<>]+/g) ?? []).join(' ')}`;
        return /include|select/i.test(nome) || /Include|Select/.test(tipos) ? 'projecao' : 'outro';
      }
      return 'outro';
    }
  }

  const semSelect = (v: ts.Expression) =>
    ts.isObjectLiteralExpression(v) && !v.properties.some((p) => p.name && nomeDe(p.name) === 'select');
  const inteira = (v: ts.Expression): boolean =>
    v.kind === ts.SyntaxKind.TrueKeyword || semSelect(v) || (ts.isConditionalExpression(v) && (inteira(v.whenTrue) || inteira(v.whenFalse)));

  /** O que a trava acusa num arquivo. */
  function varrer(fonte: ts.SourceFile, rotulo: string): string[] {
    const achados: string[] = [];
    const visitar = (no: ts.Node) => {
      if (ts.isPropertyAssignment(no) && contexto(no) === 'projecao') {
        const nome = nomeDe(no.name);
        const relacaoInteira = RELACOES.has(nome) && inteira(no.initializer);
        const campoSecreto = SECRETOS.includes(nome) && no.initializer.kind === ts.SyntaxKind.TrueKeyword && secretoDeRelacao(no);
        if (relacaoInteira || campoSecreto) {
          const { line } = fonte.getLineAndCharacterOfPosition(no.getStart());
          achados.push(`${rotulo}:${line + 1} ${no.getText().slice(0, 60)}`);
        }
      }
      ts.forEachChild(no, visitar);
    };
    visitar(fonte);
    return achados;
  }
  /** Campo secreto num select DE UMA RELAÇÃO com User (o que volta junto de outro registro). */
  function secretoDeRelacao(no: ts.PropertyAssignment): boolean {
    const sel = subir(no.parent.parent);
    if (!sel || !ts.isPropertyAssignment(sel) || nomeDe(sel.name) !== 'select') return false;
    const rel = subir(sel.parent?.parent);
    return !!rel && ts.isPropertyAssignment(rel) && RELACOES.has(nomeDe(rel.name));
  }
  const varrerTexto = (codigo: string) => varrer(ts.createSourceFile('exemplo.ts', codigo, ts.ScriptTarget.Latest, true), 'exemplo');

  it('o mapa de relações é o do schema (não ficou vazio)', () => {
    expect(RELACOES.has('assigned_user')).toBe(true);
    expect(RELACOES.has('opened_by')).toBe(true);
    expect(RELACOES.size).toBeGreaterThan(10);
  });

  it('a própria trava: acusa as formas inteiras e deixa passar filtro, escrita, contagem e select', () => {
    const acusa = [
      `const includeOpts = { lead: true, assigned_user: true };`,
      `class S { private readonly closingInclude = { opened_by: true }; }`,
      `const include = { primary_dentist: { include: { inboxes: true } } } satisfies Prisma.PatientInclude;`,
      `prisma.task.findMany({ include: { lead: true, assigned_user: true } as any });`,
      `prisma.task.findMany({ include: { assigned_user: true } });`,
      `prisma.task.findMany({ include: { lead: { include: { assigned_user: true } } } });`,
      `prisma.task.findMany({ include: { assigned_user: full ? true : { select: { id: true } } } });`,
      `prisma.task.findMany({ select: { assigned_user: { select: { id: true, password_hash: true } } } });`,
      `prisma.task.findMany({ include: { assigned_user: { where: { active: true } } } });`,
    ];
    for (const codigo of acusa) expect({ codigo, acusou: varrerTexto(codigo).length > 0 }).toEqual({ codigo, acusou: true });
    const passa = [
      `prisma.task.findMany({ where: { assigned_user: { tenant_id: t } } });`,
      `prisma.task.update({ data: { assigned_user: { connect: { id } } } });`,
      `prisma.tenant.findMany({ include: { _count: { select: { users: true } } } });`,
      `prisma.task.findMany({ include: { assigned_user: { select: { id: true, name: true } } } });`,
      `const includeOpts = { assigned_user: { select: { id: true, name: true } } };`,
      `function f() { return { user: { id: u.id, name: u.name } }; }`,
      `prisma.task.findMany({ orderBy: { assigned_user: { name: 'asc' } } });`,
      // leitura interna do próprio usuário (validade do código), sem relação: não sai para a tela
      `prisma.user.findFirst({ where: { password_reset_token: t }, select: { id: true, password_reset_sent_at: true } });`,
    ];
    for (const codigo of passa) expect({ codigo, achados: varrerTexto(codigo) }).toEqual({ codigo, achados: [] });
  });

  it('no código da API: nenhuma relação com User inteira, nem campo secreto, em include/select', () => {
    const achados = arquivos(RAIZ_SRC).flatMap((arquivo) =>
      varrer(ts.createSourceFile(arquivo, fs.readFileSync(arquivo, 'utf8'), ts.ScriptTarget.Latest, true), path.relative(RAIZ_SRC, arquivo)),
    );
    expect(achados).toEqual([]);
  });
});
