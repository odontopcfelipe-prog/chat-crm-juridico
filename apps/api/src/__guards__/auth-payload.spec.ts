/**
 * F0a — retrato de comportamento "clínica idêntica": o token do login.
 *
 * O web (useRole, useUserPermissions, barra lateral), o socket, o MCP e todos os
 * guards leem o JWT e o req.user. As fases do laboratório NÃO podem mudar o que
 * um usuário de clínica recebe: chave nova, chave a menos ou formato diferente
 * quebra quem lê sem avisar. Por isso o retrato é EXATO (lista de chaves), não
 * "contém".
 *
 * Usa as classes reais (AuthController, AuthService, UsersService, JwtStrategy)
 * e o JwtService real com segredo de teste. O Prisma é mockado — sem banco.
 * Se a mudança for de propósito, atualize este spec no mesmo commit e diga no
 * commit o porquê (o web e o worker precisam acompanhar).
 */
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { AuthController } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { JwtStrategy } from '../auth/jwt.strategy';
import { UsersService } from '../users/users.service';

// Só para este teste — nunca é o segredo de nenhum ambiente.
const SEGREDO_TESTE = 'guards-auth-payload-somente-teste';
const SENHA_TESTE = 'senha-de-teste-123';
const TENANT_CLINICA = '00000000-0000-0000-0000-0000000000c1';

// O que o JWT carrega hoje. iat/exp são do próprio jsonwebtoken.
const CHAVES_PAYLOAD = ['email', 'roles', 'sub', 'tenant_id'];
const CHAVES_TOKEN = [...CHAVES_PAYLOAD, 'exp', 'iat'].sort();
// O que o JwtStrategy.validate põe em req.user hoje.
const CHAVES_REQ_USER = ['email', 'id', 'role', 'roles', 'tenant_id'];

const DIA = 24 * 60 * 60;

function chaves(o: object): string[] {
  return Object.keys(o).sort();
}

/** Roda a estratégia do passport de verdade (Bearer → verifica → validate). */
function autenticar(strategy: JwtStrategy, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const s: any = Object.create(strategy);
    s.success = (user: any) => resolve(user);
    s.fail = (info: any) => reject(new Error(`token recusado: ${String(info?.message ?? info)}`));
    s.error = (err: any) => reject(err);
    s.authenticate({ headers: { authorization: `Bearer ${token}` } }, {});
  });
}

describe('retrato: payload do login de usuário de clínica (F0a)', () => {
  let hash: string;
  let segredoAntes: string | undefined;
  let jwt: JwtService;
  let strategy: JwtStrategy;

  beforeAll(async () => {
    hash = await argon2.hash(SENHA_TESTE);
    segredoAntes = process.env.JWT_SECRET;
    process.env.JWT_SECRET = SEGREDO_TESTE;
    // Mesmas opções que o AuthModule passa ao JwtModule (JWT_EXPIRES_IN padrão = 30d).
    jwt = new JwtService({ secret: SEGREDO_TESTE, signOptions: { expiresIn: '30d' } });
    strategy = new JwtStrategy();
  });

  afterAll(() => {
    if (segredoAntes === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = segredoAntes;
  });

  function montar(usuario: Record<string, any>) {
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue({ password_hash: hash, ...usuario }) },
      tenant: {
        findUnique: jest.fn().mockResolvedValue({
          status: 'ACTIVE', suspended_reason: null, trial_ends_at: null, name: 'Clínica Teste',
        }),
      },
    };
    const users = new UsersService(prisma, {} as any, {} as any);
    const mail: any = { send: jest.fn(), renderTemplate: jest.fn() };
    const auth = new AuthService(users, jwt, prisma, mail);
    return { controller: new AuthController(auth), auth, prisma };
  }

  // Usuário de clínica como está no banco (com campos que NÃO podem vazar pro token).
  const usuarioClinica = {
    id: 'u-clinica-1',
    email: 'recepcao@clinica.teste',
    name: 'Recepção Teste',
    roles: ['OPERADOR'],
    tenant_id: TENANT_CLINICA,
    sector: 'recepcao',
    extra_grants: ['view_reports'],
    extra_revokes: [],
    phone: '82999990000',
    inbox_id: null,
    password_reset_token: null,
  };

  it('POST /auth/login devolve só {access_token, user} e user = {email, sub, roles, tenant_id}', async () => {
    const { controller } = montar(usuarioClinica);
    const r: any = await controller.login({ email: usuarioClinica.email, password: SENHA_TESTE } as any);

    expect(chaves(r)).toEqual(['access_token', 'user']);
    expect(typeof r.access_token).toBe('string');
    expect(chaves(r.user)).toEqual(CHAVES_PAYLOAD);
    expect(r.user).toEqual({
      email: 'recepcao@clinica.teste',
      sub: 'u-clinica-1',
      roles: ['OPERADOR'],
      tenant_id: TENANT_CLINICA,
    });
  });

  it('o JWT assinado tem EXATAMENTE email, sub, roles, tenant_id (+ iat/exp), HS256 e 30 dias', async () => {
    const { controller } = montar(usuarioClinica);
    const r: any = await controller.login({ email: usuarioClinica.email, password: SENHA_TESTE } as any);

    const completo: any = jwt.decode(r.access_token, { complete: true });
    expect(completo.header).toEqual({ alg: 'HS256', typ: 'JWT' });

    const payload: any = jwt.verify(r.access_token);
    expect(chaves(payload)).toEqual(CHAVES_TOKEN);
    expect(payload).toEqual({ ...r.user, iat: expect.any(Number), exp: expect.any(Number) });
    expect(payload.exp - payload.iat).toBe(30 * DIA);
  });

  it('JwtStrategy (passport de verdade) aceita o token e monta req.user no formato de hoje', async () => {
    const { controller } = montar(usuarioClinica);
    const r: any = await controller.login({ email: usuarioClinica.email, password: SENHA_TESTE } as any);

    const reqUser = await autenticar(strategy, r.access_token);
    expect(chaves(reqUser)).toEqual(CHAVES_REQ_USER);
    expect(reqUser).toEqual({
      id: 'u-clinica-1',
      email: 'recepcao@clinica.teste',
      roles: ['OPERADOR'],
      role: 'OPERADOR',
      tenant_id: TENANT_CLINICA,
    });
  });

  it.each([
    // [roles no banco, roles no token, req.user.role]
    [['ADMIN'], ['ADMIN'], 'ADMIN'],
    [['DENTIST'], ['DENTIST'], 'DENTIST'],
    [['OPERADOR'], ['OPERADOR'], 'OPERADOR'],
    [['COMERCIAL'], ['COMERCIAL'], 'COMERCIAL'],
    [['ASSISTANT'], ['ASSISTANT'], 'ASSISTANT'],
    [['FINANCEIRO'], ['FINANCEIRO'], 'FINANCEIRO'],
    [['ADMIN', 'DENTIST'], ['ADMIN', 'DENTIST'], 'ADMIN'],
    [[], ['OPERADOR'], 'OPERADOR'],
  ])('roles %j → token %j, req.user.role %s (mesmas chaves para todo setor)', async (dbRoles, tokenRoles, role) => {
    const { controller } = montar({ ...usuarioClinica, roles: dbRoles });
    const r: any = await controller.login({ email: usuarioClinica.email, password: SENHA_TESTE } as any);

    const payload: any = jwt.verify(r.access_token);
    expect(chaves(payload)).toEqual(CHAVES_TOKEN);
    expect(payload.roles).toEqual(tokenRoles);
    expect(payload.tenant_id).toBe(TENANT_CLINICA);

    const reqUser = await autenticar(strategy, r.access_token);
    expect(chaves(reqUser)).toEqual(CHAVES_REQ_USER);
    expect(reqUser.roles).toEqual(tokenRoles);
    expect(reqUser.role).toBe(role);
  });

  it('token MCP (POST /auth/mcp-token com o req.user do login): mesmo payload, 365 dias', async () => {
    const { controller } = montar(usuarioClinica);
    const login: any = await controller.login({ email: usuarioClinica.email, password: SENHA_TESTE } as any);
    const reqLogin = await autenticar(strategy, login.access_token);
    const r = await controller.mcpToken({ user: reqLogin });

    expect(chaves(r)).toEqual(['mcp_token']);
    const payload: any = jwt.verify(r.mcp_token);
    expect(chaves(payload)).toEqual(CHAVES_TOKEN);
    expect(payload.exp - payload.iat).toBe(365 * DIA);

    const reqUser = await autenticar(strategy, r.mcp_token);
    expect(reqUser).toEqual({
      id: 'u-clinica-1', email: 'recepcao@clinica.teste', roles: ['OPERADOR'], role: 'OPERADOR', tenant_id: TENANT_CLINICA,
    });
  });

  it('token antigo (role string, sem roles) continua entrando com o mesmo req.user', async () => {
    const antigo = jwt.sign({ email: 'antigo@clinica.teste', sub: 'u-antigo', role: 'DENTIST', tenant_id: TENANT_CLINICA });
    const reqUser = await autenticar(strategy, antigo);
    expect(reqUser).toEqual({
      id: 'u-antigo', email: 'antigo@clinica.teste', roles: ['DENTIST'], role: 'DENTIST', tenant_id: TENANT_CLINICA,
    });
  });

  it('token assinado com outro segredo é recusado', async () => {
    const outro = new JwtService({ secret: 'outro-segredo-de-teste' });
    const falso = outro.sign({ email: 'x@clinica.teste', sub: 'u-x', roles: ['ADMIN'], tenant_id: TENANT_CLINICA });
    await expect(autenticar(strategy, falso)).rejects.toThrow(/token recusado/);
  });
});
