/**
 * Sessão da equipe × token do portal do paciente.
 *
 * O token do login (e o mcp_token) é a sessão da EQUIPE: vale na API da equipe,
 * no tempo real (socket) e no MCP — exatamente como antes (o retrato
 * auth-payload continua igual). O token do portal do paciente (kind 'patient')
 * vale SÓ nas rotas do portal (PortalJwtGuard), também como antes.
 *
 * Usa o JwtService real com as opções do AuthModule e do PortalModule (segredo
 * de teste) e a estratégia do passport de verdade (Bearer → verifica → validate).
 */
import * as fs from 'fs';
import * as path from 'path';
import { UnauthorizedException } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module';
import { JwtStrategy } from '../auth/jwt.strategy';
import { eSessaoDaEquipe } from '../auth/sessao-da-equipe';
import { McpController } from '../mcp/mcp.controller';
import { PortalModule } from '../portal/portal.module';
import { PortalJwtGuard } from '../portal/portal-jwt.guard';

// Só para este teste — nunca é o segredo de nenhum ambiente.
const SEGREDO_TESTE = 'guards-sessao-equipe-somente-teste';
const CLINICA = '00000000-0000-0000-0000-0000000000c1';
const LOGIN = { email: 'recepcao@exemplo.test', sub: 'usuario-1', roles: ['OPERADOR'], tenant_id: CLINICA };
const PORTAL = { sub: 'paciente-1', kind: 'patient', patient_id: 'paciente-1', tenant_id: CLINICA };

/** As opções do JwtModule.registerAsync de um módulo, como em runtime (sem instanciar o módulo). */
async function opcoesJwtDo(modulo: any): Promise<any> {
  const imports: any[] = Reflect.getMetadata('imports', modulo) ?? [];
  const jwtDinamico = imports.find((i) => i && i.module === JwtModule);
  if (!jwtDinamico) throw new Error(`${modulo.name} não importa o JwtModule.registerAsync`);
  const fabrica = (jwtDinamico.providers ?? []).find((p: any) => p && typeof p.useFactory === 'function');
  return fabrica.useFactory();
}

/** Roda a estratégia do passport de verdade. */
function autenticar(strategy: JwtStrategy, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const s: any = Object.create(strategy);
    s.success = (user: any) => resolve(user);
    s.fail = (info: any) => reject(new UnauthorizedException(String(info?.message ?? info ?? 'recusado')));
    s.error = (err: any) => reject(err);
    s.authenticate({ headers: { authorization: `Bearer ${token}` } }, {});
  });
}

let segredoAntes: string | undefined;
let jwtEquipe: JwtService;
let jwtPortal: JwtService;
let strategy: JwtStrategy;
let tokenLogin: string;
let tokenPortal: string;

beforeAll(async () => {
  segredoAntes = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SEGREDO_TESTE;
  jwtEquipe = new JwtService(await opcoesJwtDo(AuthModule));
  jwtPortal = new JwtService(await opcoesJwtDo(PortalModule));
  strategy = new JwtStrategy();
  tokenLogin = jwtEquipe.sign(LOGIN);
  tokenPortal = await jwtPortal.signAsync(PORTAL, { expiresIn: '30d' });
});

afterAll(() => {
  if (segredoAntes === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = segredoAntes;
});

describe('eSessaoDaEquipe', () => {
  it('login, mcp_token e token antigo (role em texto): sim', () => {
    expect(eSessaoDaEquipe(LOGIN)).toBe(true);
    expect(eSessaoDaEquipe({ ...LOGIN, iat: 1, exp: 2 })).toBe(true);
    expect(eSessaoDaEquipe({ email: 'a@exemplo.test', sub: 'usuario-2', role: 'ADMIN', tenant_id: CLINICA })).toBe(true);
  });

  it('token sem e-mail ou sem papel (formato que login e mcp_token nunca emitem): não', () => {
    // Ex.: um token reassinado a partir de uma sessão que não era de usuário da equipe.
    expect(eSessaoDaEquipe({ sub: 'paciente-1', roles: ['OPERADOR'], tenant_id: CLINICA })).toBe(false);
    expect(eSessaoDaEquipe({ ...LOGIN, email: '' })).toBe(false);
    expect(eSessaoDaEquipe({ ...LOGIN, roles: [] })).toBe(false);
    expect(eSessaoDaEquipe({ email: LOGIN.email, sub: 'usuario-1', tenant_id: CLINICA })).toBe(false);
  });

  it('portal do paciente, qualquer outro kind, sem sub ou vazio: não', () => {
    expect(eSessaoDaEquipe(PORTAL)).toBe(false);
    expect(eSessaoDaEquipe({ ...LOGIN, kind: 'outro' })).toBe(false);
    expect(eSessaoDaEquipe({ ...LOGIN, patient_id: 'paciente-1' })).toBe(false);
    for (const p of [{ ...LOGIN, sub: undefined }, { ...LOGIN, sub: '' }, { ...LOGIN, sub: 123 }, null, undefined, 'texto', 42]) {
      expect(eSessaoDaEquipe(p)).toBe(false);
    }
  });
});

describe('API da equipe (JwtStrategy do passport, de verdade)', () => {
  it('token do login: entra, com o mesmo req.user de antes', async () => {
    const user = await autenticar(strategy, tokenLogin);
    expect(user).toEqual({ id: 'usuario-1', email: 'recepcao@exemplo.test', roles: ['OPERADOR'], role: 'OPERADOR', tenant_id: CLINICA });
  });

  it('token no formato do mcp_token reassinado a partir de uma sessão sem e-mail: recusado (401)', async () => {
    // generateMcpToken monta { email, sub, roles, tenant_id } a partir do req.user.
    const reassinado = jwtEquipe.sign({ email: undefined, sub: 'paciente-1', roles: ['OPERADOR'], tenant_id: CLINICA });
    await expect(autenticar(strategy, reassinado)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('token do portal do paciente: recusado (401)', async () => {
    // Mesmo segredo: a assinatura confere — quem recusa é a regra da sessão da equipe.
    expect(jwtEquipe.verify(tokenPortal)).toMatchObject({ kind: 'patient' });
    await expect(autenticar(strategy, tokenPortal)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('portal do paciente (PortalJwtGuard) — igual a antes', () => {
  const contexto = (token: string) => {
    const req: any = { headers: { authorization: `Bearer ${token}` } };
    return { req, ctx: { switchToHttp: () => ({ getRequest: () => req }) } as any };
  };

  it('token do portal: entra, com req.patient', async () => {
    const { req, ctx } = contexto(tokenPortal);
    expect(await new PortalJwtGuard(jwtPortal).canActivate(ctx)).toBe(true);
    expect(req.patient).toEqual({ patient_id: 'paciente-1', tenant_id: CLINICA });
  });

  it('token do login: recusado no portal', async () => {
    await expect(new PortalJwtGuard(jwtPortal).canActivate(contexto(tokenLogin).ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('MCP (rota pública com token próprio)', () => {
  function chamar(token: string) {
    const tools = { callTool: jest.fn(async () => ({ ok: true })) };
    const ctl = new McpController(jwtEquipe, tools as any);
    const res: any = { statusCode: 200, corpo: undefined };
    res.status = jest.fn((c: number) => {
      res.statusCode = c;
      return res;
    });
    res.json = jest.fn((x: any) => {
      res.corpo = x;
      return res;
    });
    res.send = jest.fn(() => res);
    const req: any = { headers: { authorization: `Bearer ${token}` } };
    return { ctl, req, res, tools };
  }
  const listar = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'listar_clientes', arguments: {} } };

  it('token do login: a ferramenta roda como antes', async () => {
    const m = chamar(tokenLogin);
    await m.ctl.handle(m.req, m.res, listar);
    expect(m.res.statusCode).toBe(200);
    expect(m.tools.callTool).toHaveBeenCalledWith('listar_clientes', {}, expect.objectContaining({ sub: 'usuario-1', tenant_id: CLINICA }));
  });

  it('token do portal: 401 "Token inválido", nenhuma ferramenta roda', async () => {
    const m = chamar(tokenPortal);
    await m.ctl.handle(m.req, m.res, listar);
    expect(m.res.statusCode).toBe(401);
    expect(m.res.corpo.error.message).toBe('Token inválido');
    expect(m.tools.callTool).not.toHaveBeenCalled();
  });
});

describe('tempo real (socket.io em main.ts)', () => {
  // O middleware de conexão fica dentro do bootstrap(): confere no fonte que o
  // payload verificado passa por eSessaoDaEquipe ANTES de virar socket.data.user.
  it('a conexão só guarda o usuário depois da regra da sessão da equipe', () => {
    const fonte = fs.readFileSync(path.resolve(__dirname, '..', 'main.ts'), 'utf8');
    const ini = fonte.indexOf('io.use((socket, next) => {');
    const fim = fonte.indexOf('socket.data.user = payload;', ini);
    expect(ini).toBeGreaterThan(-1);
    expect(fim).toBeGreaterThan(ini);
    const bloco = fonte.slice(ini, fim);
    const verifica = bloco.indexOf('jwtService.verify(token)');
    const regra = bloco.search(/if \(!eSessaoDaEquipe\(payload\)\) \{\s*\r?\n[^\n]*\r?\n\s*return next\(new Error\('Invalid token'\)\);/);
    expect(verifica).toBeGreaterThan(-1);
    expect(regra).toBeGreaterThan(verifica);
  });
});
