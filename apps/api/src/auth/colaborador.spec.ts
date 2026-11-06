import * as path from 'path';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import {
  COLABORADOR_HOME,
  colaboradorAllowsRoute,
  ehSoPonto,
  mapBackendRole,
  resolveHomeActions,
  resolvePermissions,
  SECTORS,
} from '@crm/shared';
import { CODIGO_SO_PONTO, ColaboradorGuard, ROTAS_DO_COLABORADOR } from './colaborador.guard';
import { PermissionsGuard } from './decorators/requires-permission.decorator';

// Regra do dono (nov/2026): por enquanto, o colaborador só tem acesso ao ponto.

type Inventario = { controllers: Array<{ classe: string; handlers: Array<{ metodo: string }> }> };
const RAIZ = path.resolve(__dirname, '..', '..', '..', '..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const inv = require(path.join(RAIZ, 'scripts', 'ci', 'inventario.cjs')) as { gerarInventario(app: string): Inventario };

/** Handler de mentira só para montar a chave 'Classe.metodo' que o guard lê. */
function contexto(classe: string, metodo: string, user?: unknown, tipo = 'http'): ExecutionContext {
  const controller = { [classe]: class {} }[classe];
  const handler = { [metodo]() {} }[metodo];
  return {
    getType: () => tipo,
    getClass: () => controller,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('colaborador — regra compartilhada', () => {
  it('o papel COLABORADOR vai para o setor colaborador (não cai na recepção)', () => {
    expect(mapBackendRole(['COLABORADOR'])).toBe('colaborador');
  });

  it('não muda o setor de quem acumula outro papel', () => {
    expect(mapBackendRole(['ADMIN', 'COLABORADOR'])).toBe('admin');
    expect(mapBackendRole(['OPERADOR', 'COLABORADOR'])).toBe('recepcao');
  });

  it('setor desconhecido ou vazio continua caindo na recepção', () => {
    expect(SECTORS[0].id).toBe('recepcao');
    expect(mapBackendRole([])).toBe('recepcao');
    expect(mapBackendRole(['DESCONHECIDO'])).toBe('recepcao');
  });

  it('não tem permissão nem balão', () => {
    expect(resolvePermissions('colaborador').size).toBe(0);
    expect(resolveHomeActions('colaborador')).toEqual([]);
  });

  it('só abre a tela do próprio ponto', () => {
    expect(colaboradorAllowsRoute(COLABORADOR_HOME)).toBe(true);
    expect(colaboradorAllowsRoute('/atendimento/ponto/')).toBe(true);
    expect(colaboradorAllowsRoute('/atendimento/ponto?mes=2026-11')).toBe(true);
    for (const tela of [
      '/atendimento',
      '/atendimento/dashboard',
      '/atendimento/ponto/equipe',
      '/atendimento/ponto-antigo',
      '/atendimento/tasks',
      '/atendimento/pacientes',
      '/atendimento/settings/ponto',
    ]) {
      expect(colaboradorAllowsRoute(tela)).toBe(false);
    }
    expect(colaboradorAllowsRoute(undefined)).toBe(false);
  });

  it('ehSoPonto: basta o setor do banco OU o papel do token', () => {
    expect(ehSoPonto('colaborador', ['COLABORADOR'])).toBe(true);
    expect(ehSoPonto('colaborador', ['OPERADOR'])).toBe(true); // token velho de quem foi rebaixado
    expect(ehSoPonto(null, ['COLABORADOR'])).toBe(true); // cadastro sem setor gravado
    expect(ehSoPonto('recepcao', ['OPERADOR'])).toBe(false);
    expect(ehSoPonto('admin', ['ADMIN'])).toBe(false);
    expect(ehSoPonto(null, [])).toBe(false);
  });

  it('ehSoPonto: o dono do sistema nunca é travado', () => {
    expect(ehSoPonto('colaborador', ['SUPER_ADMIN', 'ADMIN'])).toBe(false);
  });
});

describe('ColaboradorGuard', () => {
  const prisma = (sector: string | null) => ({
    user: { findUnique: jest.fn().mockResolvedValue({ sector, extra_grants: [], extra_revokes: [] }) },
  });
  const usuario = (id: string, roles: string[]) => ({ id, roles, tenant_id: 't1' });
  const guardCom = (sector: string | null) => new ColaboradorGuard(prisma(sector) as any);
  const chamar = (guard: ColaboradorGuard, classe: string, metodo: string, user: unknown) =>
    guard.canActivate(contexto(classe, metodo, user));

  beforeEach(() => {
    for (const id of ['colab', 'rec', 'adm', 'dono', 'antigo', 'sem-setor']) PermissionsGuard.invalidate(id);
  });

  it('colaborador alcança o que está na lista', async () => {
    const guard = guardCom('colaborador');
    for (const chave of ROTAS_DO_COLABORADOR) {
      const [classe, metodo] = chave.split('.');
      await expect(chamar(guard, classe, metodo, usuario('colab', ['COLABORADOR']))).resolves.toBe(true);
    }
  });

  it.each([
    ['PatientsController', 'findAll'],
    ['ConversationsController', 'getUnreadCounts'],
    ['TasksController', 'findAll'],
    ['TeamChatController', 'overview'],
    ['UsersController', 'findAgents'],
    ['UsersController', 'findOne'],
    ['PontoController', 'team'],
    ['PontoController', 'report'],
    ['AuthController', 'mcpToken'],
    ['ControllerQueAindaNaoExiste', 'handlerNovo'],
  ])('colaborador não alcança %s.%s', async (classe, metodo) => {
    await expect(chamar(guardCom('colaborador'), classe, metodo, usuario('colab', ['COLABORADOR']))).rejects.toMatchObject({
      response: { code: CODIGO_SO_PONTO },
    });
  });

  it('o 403 não usa PERMISSION_DENIED (senão a tela mostraria o aviso "Sem autorização")', async () => {
    const erro = await chamar(guardCom('colaborador'), 'TasksController', 'findAll', usuario('colab', ['COLABORADOR'])).catch((e) => e);
    expect(erro).toBeInstanceOf(ForbiddenException);
    expect((erro.getResponse() as { code: string }).code).not.toBe('PERMISSION_DENIED');
  });

  it('quem acabou de virar colaborador é barrado mesmo com o token antigo', async () => {
    await expect(chamar(guardCom('colaborador'), 'TasksController', 'findAll', usuario('antigo', ['OPERADOR']))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('cadastro sem setor gravado é barrado pelo papel', async () => {
    await expect(chamar(guardCom(null), 'TasksController', 'findAll', usuario('sem-setor', ['COLABORADOR']))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('os outros setores passam direto', async () => {
    await expect(chamar(guardCom('recepcao'), 'TasksController', 'findAll', usuario('rec', ['OPERADOR']))).resolves.toBe(true);
    await expect(chamar(guardCom('admin'), 'TasksController', 'findAll', usuario('adm', ['ADMIN']))).resolves.toBe(true);
  });

  it('o dono do sistema passa, sem consultar o banco', async () => {
    const p = prisma('colaborador');
    await expect(new ColaboradorGuard(p as any).canActivate(contexto('TasksController', 'findAll', usuario('dono', ['SUPER_ADMIN'])))).resolves.toBe(true);
    expect(p.user.findUnique).not.toHaveBeenCalled();
  });

  it('rota pública (sem usuário) e socket passam', async () => {
    const guard = guardCom('colaborador');
    await expect(guard.canActivate(contexto('AuthController', 'login', undefined))).resolves.toBe(true);
    await expect(guard.canActivate(contexto('ChatGateway', 'x', usuario('colab', ['COLABORADOR']), 'ws'))).resolves.toBe(true);
  });

  it('toda entrada da lista aponta para um handler que existe e não abre a central da equipe', () => {
    const { controllers } = inv.gerarInventario('api');
    // No inventário, `metodo` já vem como 'Classe.metodo'.
    const existentes = new Set(controllers.flatMap((c) => c.handlers.map((h) => h.metodo)));
    expect([...ROTAS_DO_COLABORADOR].filter((k) => !existentes.has(k))).toEqual([]);
    expect([...ROTAS_DO_COLABORADOR].filter((k) => k.startsWith('PontoController.')).sort()).toEqual([
      'PontoController.me',
      'PontoController.punch',
      'PontoController.status',
    ]);
  }, 120_000);
});
