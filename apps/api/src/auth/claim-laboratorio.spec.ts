/**
 * F3 do laboratório — claim `bt` no token da equipe.
 *
 * Usuário de conta de LABORATÓRIO: o login lê o tipo da conta no banco
 * (TenantBusinessProfile, na mesma leitura do tenant que o gate do login já faz)
 * e o token sai com bt:'LABORATORIO'; o JwtStrategy repassa o bt para o req.user.
 * Clínica: token e req.user com EXATAMENTE as chaves de hoje (o retrato completo
 * está em __guards__/auth-payload.spec.ts).
 *
 * Classes reais (AuthController, AuthService, UsersService, JwtStrategy) e
 * JwtService real com as opções do AuthModule; Prisma mockado, sem banco.
 */
import { ForbiddenException } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { resolveBtFromJwtPayload } from '@crm/shared';
import { AuthController } from './auth.controller';
import { AuthModule } from './auth.module';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { UsersService } from '../users/users.service';

// Só para este teste — nunca é o segredo de nenhum ambiente.
const SEGREDO_TESTE = 'claim-laboratorio-somente-teste';
const SENHA_TESTE = 'senha-de-teste-123';
const CONTA_LAB = '00000000-0000-0000-0000-0000000000a1';
const CONTA_CLINICA = '00000000-0000-0000-0000-0000000000c1';

const CHAVES_PAYLOAD_CLINICA = ['email', 'roles', 'sub', 'tenant_id'];
const CHAVES_PAYLOAD_LAB = ['bt', ...CHAVES_PAYLOAD_CLINICA].sort();
const CHAVES_REQ_USER_CLINICA = ['email', 'id', 'role', 'roles', 'tenant_id'];
const CHAVES_REQ_USER_LAB = ['bt', ...CHAVES_REQ_USER_CLINICA].sort();
const SELECT_DO_LOGIN = {
  status: true, suspended_reason: true, trial_ends_at: true, name: true,
  business_profile: { select: { business_type: true } },
};

function chaves(o: object): string[] {
  return Object.keys(o).sort();
}

/** Mesmas opções que o AuthModule entrega ao JwtModule em runtime. */
async function opcoesDoAuthModule(): Promise<any> {
  const imports: any[] = Reflect.getMetadata('imports', AuthModule) ?? [];
  const jwtDinamico = imports.find((i) => i && i.module === JwtModule);
  const fabrica = (jwtDinamico?.providers ?? []).find((p: any) => p && typeof p.useFactory === 'function');
  return fabrica.useFactory();
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

/** Lê o payload como o web lê (useRole: atob do 2º pedaço, base64url → base64). */
function payloadComoOWebLe(token: string): any {
  const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

describe('F3 — claim bt no token da conta de laboratório', () => {
  let hash: string;
  let segredoAntes: string | undefined;
  let jwt: JwtService;
  let strategy: JwtStrategy;

  beforeAll(async () => {
    hash = await argon2.hash(SENHA_TESTE);
    segredoAntes = process.env.JWT_SECRET;
    process.env.JWT_SECRET = SEGREDO_TESTE;
    jwt = new JwtService(await opcoesDoAuthModule());
    strategy = new JwtStrategy();
  });

  afterAll(() => {
    if (segredoAntes === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = segredoAntes;
  });

  /**
   * `conta` é o que o banco devolve para o tenant do usuário. O mock só tem user
   * e tenant: qualquer consulta a outra tabela no login quebraria o teste.
   */
  function montar(usuario: Record<string, any>, conta: Record<string, any>) {
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue({ password_hash: hash, ...usuario }) },
      tenant: {
        findUnique: jest.fn().mockResolvedValue({
          status: 'ACTIVE', suspended_reason: null, trial_ends_at: null, name: 'Conta Teste', ...conta,
        }),
      },
    };
    const users = new UsersService(prisma, {} as any, {} as any);
    const mail: any = { send: jest.fn(), renderTemplate: jest.fn() };
    const auth = new AuthService(users, jwt, prisma, mail);
    return { controller: new AuthController(auth), auth, prisma };
  }

  const usuarioLab = {
    id: 'u-lab-1',
    email: 'tecnico@lab.teste',
    name: 'Técnico Teste',
    roles: ['ADMIN'],
    tenant_id: CONTA_LAB,
  };
  const usuarioClinica = {
    id: 'u-clinica-1',
    email: 'recepcao@clinica.teste',
    name: 'Recepção Teste',
    roles: ['OPERADOR'],
    tenant_id: CONTA_CLINICA,
  };
  const perfilLab = { business_profile: { business_type: 'LABORATORIO' } };

  async function entrar(controller: AuthController, email: string) {
    return controller.login({ email, password: SENHA_TESTE } as any) as Promise<any>;
  }

  describe('conta de laboratório', () => {
    it('o tipo vem da mesma leitura do tenant que o login já fazia (1 consulta, sem tabela nova no mock)', async () => {
      const { controller, prisma } = montar(usuarioLab, perfilLab);
      await entrar(controller, usuarioLab.email);

      expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.tenant.findUnique).toHaveBeenCalledWith({ where: { id: CONTA_LAB }, select: SELECT_DO_LOGIN });
    });

    it('POST /auth/login: user e JWT levam bt:"LABORATORIO" além das chaves de sempre', async () => {
      const { controller } = montar(usuarioLab, perfilLab);
      const r = await entrar(controller, usuarioLab.email);

      expect(chaves(r)).toEqual(['access_token', 'user']);
      expect(r.user).toEqual({
        email: 'tecnico@lab.teste', sub: 'u-lab-1', roles: ['ADMIN'], tenant_id: CONTA_LAB, bt: 'LABORATORIO',
      });

      const payload: any = jwt.verify(r.access_token);
      expect(chaves(payload)).toEqual([...CHAVES_PAYLOAD_LAB, 'exp', 'iat'].sort());
      expect(payload.bt).toBe('LABORATORIO');
      expect(payload.exp - payload.iat).toBe(30 * 24 * 60 * 60);
    });

    it('o web lê o claim do token como laboratório (resolveBtFromJwtPayload)', async () => {
      const { controller } = montar(usuarioLab, perfilLab);
      const r = await entrar(controller, usuarioLab.email);

      expect(resolveBtFromJwtPayload(payloadComoOWebLe(r.access_token))).toBe('LABORATORIO');
      expect(resolveBtFromJwtPayload(r.user)).toBe('LABORATORIO');
    });

    it('JwtStrategy repassa o bt para o req.user', async () => {
      const { controller } = montar(usuarioLab, perfilLab);
      const r = await entrar(controller, usuarioLab.email);

      const reqUser = await autenticar(strategy, r.access_token);
      expect(chaves(reqUser)).toEqual(CHAVES_REQ_USER_LAB);
      expect(reqUser).toEqual({
        id: 'u-lab-1', email: 'tecnico@lab.teste', roles: ['ADMIN'], role: 'ADMIN', tenant_id: CONTA_LAB, bt: 'LABORATORIO',
      });
      expect(resolveBtFromJwtPayload(reqUser)).toBe('LABORATORIO');
    });

    it('token MCP gerado a partir do req.user mantém o bt', async () => {
      const { controller } = montar(usuarioLab, perfilLab);
      const login = await entrar(controller, usuarioLab.email);
      const r = await controller.mcpToken({ user: await autenticar(strategy, login.access_token) });

      const payload: any = jwt.verify(r.mcp_token);
      expect(chaves(payload)).toEqual([...CHAVES_PAYLOAD_LAB, 'exp', 'iat'].sort());
      expect(payload.bt).toBe('LABORATORIO');
      expect((await autenticar(strategy, r.mcp_token)).bt).toBe('LABORATORIO');
    });

    it('o gate do login vale igual: conta suspensa não entra', async () => {
      const { controller } = montar(usuarioLab, { ...perfilLab, status: 'SUSPENDED' });
      await expect(entrar(controller, usuarioLab.email)).rejects.toThrow(ForbiddenException);
    });

    it('senha errada continua sem token', async () => {
      const { auth } = montar(usuarioLab, perfilLab);
      await expect(auth.validateUser(usuarioLab.email, 'senha-errada')).resolves.toBeNull();
    });
  });

  describe('conta de clínica (sem claim)', () => {
    it.each([
      ['sem perfil (null)', { business_profile: null }],
      ['resposta sem o campo do perfil', {}],
      ['perfil CLINICA', { business_profile: { business_type: 'CLINICA' } }],
      ['minúsculas', { business_profile: { business_type: 'laboratorio' } }],
      ['espaço antes', { business_profile: { business_type: ' LABORATORIO' } }],
      ['espaço depois', { business_profile: { business_type: 'LABORATORIO ' } }],
      ['texto vazio', { business_profile: { business_type: '' } }],
      ['tipo nulo', { business_profile: { business_type: null } }],
      ['número', { business_profile: { business_type: 1 } }],
      ['lista', { business_profile: { business_type: ['LABORATORIO'] } }],
    ])('%s → token e req.user com as chaves de hoje', async (_nome, conta) => {
      const { controller, prisma } = montar(usuarioClinica, conta);
      const r = await entrar(controller, usuarioClinica.email);

      expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(1);
      expect(r.user).toEqual({
        email: 'recepcao@clinica.teste', sub: 'u-clinica-1', roles: ['OPERADOR'], tenant_id: CONTA_CLINICA,
      });
      const payload: any = jwt.verify(r.access_token);
      expect(chaves(payload)).toEqual([...CHAVES_PAYLOAD_CLINICA, 'exp', 'iat'].sort());
      expect(resolveBtFromJwtPayload(payloadComoOWebLe(r.access_token))).toBe('CLINICA');

      const reqUser = await autenticar(strategy, r.access_token);
      expect(chaves(reqUser)).toEqual(CHAVES_REQ_USER_CLINICA);
    });

    it('validateUser devolve o usuário de hoje (sem senha e sem chave nova)', async () => {
      const { auth } = montar(usuarioClinica, { business_profile: null });
      const r = await auth.validateUser(usuarioClinica.email, SENHA_TESTE);
      expect(r).toEqual(usuarioClinica);
    });

    it('SUPER_ADMIN não lê a conta no login e não leva bt', async () => {
      const { controller, prisma } = montar({ ...usuarioLab, roles: ['SUPER_ADMIN'] }, perfilLab);
      const r = await entrar(controller, usuarioLab.email);

      expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
      expect(chaves(r.user)).toEqual(CHAVES_PAYLOAD_CLINICA);
    });
  });

  describe('JwtStrategy: só o valor exato vira bt no req.user', () => {
    it.each([['laboratorio'], ['CLINICA'], [''], [true], [1], [null], [{ bt: 'LABORATORIO' }]])(
      'bt %j no token → req.user sem bt',
      async (bt) => {
        const token = jwt.sign({ email: 'x@clinica.teste', sub: 'u-x', roles: ['ADMIN'], tenant_id: CONTA_CLINICA, bt });
        const reqUser = await autenticar(strategy, token);
        expect(chaves(reqUser)).toEqual(CHAVES_REQ_USER_CLINICA);
      },
    );

    it('login() não acrescenta bt quando o valor não é o exato', async () => {
      const { auth } = montar(usuarioClinica, {});
      const r: any = await auth.login({ ...usuarioClinica, bt: 'laboratorio' });
      expect(chaves(r.user)).toEqual(CHAVES_PAYLOAD_CLINICA);
    });
  });
});
