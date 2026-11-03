/**
 * Dono do sistema dentro de outra conta sem ter usuário nela (auth/acesso-clinica.ts):
 * login reemitido com a conta escolhida, modo 'ver' bloqueia tudo que grava, a
 * volta é o login de sempre, e cada entrada/volta fica no AuditLog.
 */
import { BadRequestException, ExecutionContext, ForbiddenException, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SuperAdmin } from './decorators/super-admin.decorator';
import { McpController } from '../mcp/mcp.controller';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { ModoSoVerGuard } from './modo-so-ver.guard';
import { CODIGO_SO_VER } from './acesso-clinica';
import { rotaDoLaboratorio } from '../business-type/lab-route-policy';

const CASA = 'tenant-casa';
const CLINICA = 'tenant-clinica';
const LAB = 'tenant-lab';
const ORIGEM = { ip: '203.0.113.7', user_agent: 'Navegador de teste' };
const jwt = new JwtService({ secret: 'segredo-so-de-teste' });

beforeEach(() => {
  for (const nivel of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

function montar(roles = ['SUPER_ADMIN', 'ADMIN']) {
  const auditoria: any[] = [];
  const prisma: any = {
    user: { findUnique: jest.fn(async () => ({ id: 'u-dono', email: 'dono@exemplo.com', roles, tenant_id: CASA })) },
    tenant: {
      findUnique: jest.fn(async ({ where }: any) => {
        const contas: Record<string, { id: string; name: string; status: string }> = {
          [CLINICA]: { id: CLINICA, name: 'Clínica Sorriso', status: 'ACTIVE' },
          [LAB]: { id: LAB, name: 'Lab Prótese', status: 'SUSPENDED' },
          'tenant-encerrado': { id: 'tenant-encerrado', name: 'Encerrada', status: 'DELETED' },
        };
        return contas[where.id] ?? null;
      }),
    },
    tenantBusinessProfile: {
      findUnique: jest.fn(async ({ where }: any) => (where.tenant_id === LAB ? { business_type: 'LABORATORIO' } : null)),
    },
    auditLog: { create: jest.fn(async ({ data }: any) => auditoria.push(data)) },
  };
  const auth = new AuthService({} as any, jwt, prisma, {} as any);
  return { auth, prisma, auditoria };
}

const ler = (token: string) => jwt.verify(token) as any;

describe('POST /auth/acessar-clinica', () => {
  it('entrar só para ver: login na conta escolhida, mesmos papéis, marca de acesso, vale 12 h', async () => {
    const { auth, auditoria } = montar();
    const r: any = await auth.acessarClinica('u-dono', CLINICA, 'ver', ORIGEM);
    const p = ler(r.access_token);
    expect(p).toMatchObject({
      sub: 'u-dono', email: 'dono@exemplo.com', roles: ['SUPER_ADMIN', 'ADMIN'], tenant_id: CLINICA,
      acesso_clinica: { modo: 'ver', nome: 'Clínica Sorriso' },
    });
    expect(p.bt).toBeUndefined();
    expect(p.exp - p.iat).toBe(12 * 3600);
    expect(auditoria).toEqual([
      expect.objectContaining({ actor_user_id: 'u-dono', tenant_id: CLINICA, entity: 'ACESSO_CLINICA', entity_id: CLINICA, action: 'ENTROU_SO_VER' }),
    ]);
  });

  it('laboratório (mesmo suspenso): token com o tipo da conta; modo mexer auditado como tal', async () => {
    const { auth, auditoria } = montar();
    const p = ler(((await auth.acessarClinica('u-dono', LAB, 'mexer', ORIGEM)) as any).access_token);
    expect(p).toMatchObject({ tenant_id: LAB, bt: 'LABORATORIO', acesso_clinica: { modo: 'mexer', nome: 'Lab Prótese' } });
    expect(auditoria[0].action).toBe('ENTROU_VER_E_MEXER');
  });

  it('voltar (sem conta ou a própria): o login de sempre, sem marca, e registro da volta', async () => {
    const { auth, auditoria } = montar();
    for (const destino of [null, undefined, '', CASA]) {
      const p = ler(((await auth.acessarClinica('u-dono', destino as any, undefined, ORIGEM)) as any).access_token);
      expect(p).toMatchObject({ sub: 'u-dono', roles: ['SUPER_ADMIN', 'ADMIN'], tenant_id: CASA });
      expect(p.acesso_clinica).toBeUndefined();
    }
    expect(auditoria.map((a) => a.action)).toEqual(['VOLTOU', 'VOLTOU', 'VOLTOU', 'VOLTOU']);
  });

  it('quem não é o dono no BANCO: 403 (token antigo não basta); nada auditado', async () => {
    const { auth, auditoria } = montar(['OPERADOR', 'ADMIN']);
    await expect(auth.acessarClinica('u-dono', CLINICA, 'ver', ORIGEM)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(auth.acessarClinica('u-dono', null, undefined, ORIGEM)).rejects.toBeInstanceOf(ForbiddenException);
    expect(auditoria).toEqual([]);
  });

  it('modo inválido = 400; conta que não existe ou encerrada = 404', async () => {
    const { auth } = montar();
    await expect(auth.acessarClinica('u-dono', CLINICA, 'tudo', ORIGEM)).rejects.toBeInstanceOf(BadRequestException);
    await expect(auth.acessarClinica('u-dono', 'nao-existe', 'ver', ORIGEM)).rejects.toBeInstanceOf(NotFoundException);
    await expect(auth.acessarClinica('u-dono', 'tenant-encerrado', 'ver', ORIGEM)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('POST /auth/voltar-conta: de dentro do laboratório passa no guard dele; quem não é o dono leva 403', async () => {
    expect(rotaDoLaboratorio('AuthController.voltarParaMinhaConta')).toBe(true);
    expect(rotaDoLaboratorio('AuthController.acessarClinica')).toBe(false);
    const dono = montar();
    const p = ler(((await new AuthController(dono.auth).voltarParaMinhaConta({ user: { id: 'u-dono' }, headers: {} })) as any).access_token);
    expect(p).toMatchObject({ tenant_id: CASA });
    const outro = montar(['ADMIN']);
    await expect(new AuthController(outro.auth).voltarParaMinhaConta({ user: { id: 'u-dono' }, headers: {} })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('POST /mcp (rota pública, confere o token sozinha): login de conta visitada é recusado, nada roda', async () => {
    const tools = { callTool: jest.fn(async () => ({ ok: true })) };
    const semLaboratorio: any = { tenantBusinessProfile: { findMany: jest.fn(async () => []) } };
    const ctl = new McpController(jwt, tools as any, semLaboratorio);
    const chamar = async (token: string) => {
      const res: any = { statusCode: 200 };
      res.status = jest.fn((c: number) => ((res.statusCode = c), res));
      res.json = jest.fn(() => res);
      res.send = jest.fn(() => res);
      await ctl.handle({ headers: { authorization: `Bearer ${token}` } } as any, res, {
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'criar_cliente', arguments: {} },
      });
      return res.statusCode;
    };
    const { auth } = montar();
    for (const modo of ['ver', 'mexer']) {
      expect(await chamar(((await auth.acessarClinica('u-dono', CLINICA, modo, ORIGEM)) as any).access_token)).toBe(401);
    }
    expect(tools.callTool).not.toHaveBeenCalled();
    // Login da própria conta: o MCP segue como antes.
    expect(await chamar(((await auth.acessarClinica('u-dono', null, undefined, ORIGEM)) as any).access_token)).toBe(200);
  });

  it('token do MCP (1 ano) só na própria conta', async () => {
    const { auth } = montar();
    await expect(
      auth.generateMcpToken({ id: 'u-dono', email: 'e', roles: ['SUPER_ADMIN'], tenant_id: CLINICA, acesso_clinica: { modo: 'mexer', nome: 'x' } }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('JwtStrategy: a marca chega ao req.user', () => {
  const strategy = new JwtStrategy();
  const base = { sub: 'u', email: 'e@x', roles: ['SUPER_ADMIN'], tenant_id: CLINICA };

  it('com a marca: req.user.acesso_clinica; login normal: as chaves de sempre', async () => {
    expect(await strategy.validate({ ...base, acesso_clinica: { modo: 'ver', nome: 'C' } })).toMatchObject({
      tenant_id: CLINICA,
      acesso_clinica: { modo: 'ver', nome: 'C' },
    });
    expect(Object.keys(await strategy.validate(base))).toEqual(['id', 'email', 'roles', 'role', 'tenant_id']);
  });

  it('marca que não se lê: 401 (nunca vira sessão comum, com acesso total na conta visitada)', async () => {
    for (const marca of [{ modo: 'admin' }, null, 'ver', {}]) {
      await expect(strategy.validate({ ...base, acesso_clinica: marca })).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });
});

describe('ModoSoVerGuard', () => {
  const guard = new ModoSoVerGuard();
  class PatientsController { create() {} }
  class CampanhasController { previa() {} }
  // Rota @SuperAdmin que grava na conta da sessão (sincronizar chip): não é "da plataforma".
  class WhatsappController {
    @SuperAdmin()
    syncContacts() {}
  }

  function ctx(user: any, method: string, classe: any, handler: any): ExecutionContext {
    return {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => ({ user, method }) }),
      getClass: () => classe,
      getHandler: () => handler,
    } as any;
  }
  const ver = { id: 'u', roles: ['SUPER_ADMIN'], tenant_id: CLINICA, acesso_clinica: { modo: 'ver', nome: 'C' } };
  const mexer = { ...ver, acesso_clinica: { modo: 'mexer', nome: 'C' } };
  const normal = { id: 'u', roles: ['ADMIN'], tenant_id: CLINICA };
  const gravar = PatientsController.prototype.create;

  const barrado = (c: ExecutionContext) => {
    try {
      guard.canActivate(c);
      return 'passou';
    } catch (e: any) {
      return e instanceof ForbiddenException ? e.getResponse() && (e.getResponse() as any).code : 'outro erro';
    }
  };

  it('só ver: POST/PATCH/PUT/DELETE de dado da conta = 403 SO_VER', () => {
    for (const m of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(barrado(ctx(ver, m, PatientsController, gravar))).toBe(CODIGO_SO_VER);
    }
  });

  it('só ver: rota @SuperAdmin que não está na lista também é barrada', () => {
    expect(barrado(ctx(ver, 'POST', WhatsappController, WhatsappController.prototype.syncContacts))).toBe(CODIGO_SO_VER);
  });

  it('só ver: leitura, trocar/voltar de conta e prévias passam', () => {
    expect(guard.canActivate(ctx(ver, 'GET', PatientsController, gravar))).toBe(true);
    expect(guard.canActivate(ctx(ver, 'POST', AuthController, AuthController.prototype.acessarClinica))).toBe(true);
    expect(guard.canActivate(ctx(ver, 'POST', CampanhasController, CampanhasController.prototype.previa))).toBe(true);
    expect(guard.canActivate(ctx(ver, 'POST', AuthController, AuthController.prototype.voltarParaMinhaConta))).toBe(true);
  });

  it('ver e mexer, login normal e rota pública: igual a antes', () => {
    expect(guard.canActivate(ctx(mexer, 'POST', PatientsController, gravar))).toBe(true);
    expect(guard.canActivate(ctx(normal, 'DELETE', PatientsController, gravar))).toBe(true);
    expect(guard.canActivate(ctx(undefined, 'POST', PatientsController, gravar))).toBe(true);
  });
});
