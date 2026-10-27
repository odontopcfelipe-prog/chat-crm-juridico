/**
 * F3 do laboratório — criação de conta de laboratório pelo SUPER_ADMIN
 * (POST /tenants com business_type 'LABORATORIO'), a chave da plataforma que a
 * libera, o GET /tenants/me do laboratório e o cron diário das chaves desligadas.
 *
 * Prisma mockado (gravador de chamadas, com a transação marcada por `tx.`).
 * O caminho da clínica tem de continuar fazendo EXATAMENTE as mesmas chamadas.
 */
import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import {
  __limparCacheLabTenants,
  getLabTenantIds,
  isLabTenantCached,
  seedLabTenantDefaults,
} from '@crm/shared';
import { IS_SUPER_ADMIN_KEY } from '../auth/decorators/super-admin.decorator';
import { CONTROLLERS_SO_DE_CLINICA } from '../business-type/lab-route-policy';
import { CriacaoLaboratorioController } from './criacao-laboratorio.controller';
import {
  CHAVE_CRIACAO_LABORATORIO,
  CODIGO_CRIACAO_LABORATORIO_DESLIGADA,
  CriacaoLaboratorioService,
} from './criacao-laboratorio.service';
import { PadroesLaboratorioService } from './padroes-laboratorio.service';
import { SignupController, TenantsController, TenantsMeController } from './tenants.controller';
import { TenantsService } from './tenants.service';

const LAB = '1abe1abe-0000-4000-8000-0000000000f3';
const SUPER = { id: 'super-1', roles: ['SUPER_ADMIN'], tenant_id: null };
const AGORA = new Date('2026-10-27T15:00:00.000Z');

interface Chamada {
  op: string;
  args: any;
}

/**
 * Prisma falso: grava `<model>.<método>(args)` e responde pelo mapa (padrão:
 * null). `$transaction(cb)` roda o callback com um gravador-filho (prefixo
 * `tx.`) e grava `$transaction:fim` quando ele termina.
 */
function gravador(respostas: Record<string, (args: any) => any> = {}) {
  const chamadas: Chamada[] = [];
  const cliente = (prefixo: string): any =>
    new Proxy(
      {},
      {
        get(_a, modelo: string | symbol) {
          if (typeof modelo !== 'string' || modelo === 'then') return undefined;
          if (modelo === '$transaction') {
            return async (cb: any) => {
              chamadas.push({ op: `${prefixo}$transaction`, args: null });
              const r = await cb(cliente(`${prefixo}tx.`));
              chamadas.push({ op: `${prefixo}$transaction:fim`, args: null });
              return r;
            };
          }
          return new Proxy(
            {},
            {
              get(_m, metodo: string | symbol) {
                if (typeof metodo !== 'string' || metodo === 'then') return undefined;
                return async (args: any) => {
                  const op = `${modelo}.${metodo}`;
                  chamadas.push({ op: `${prefixo}${op}`, args });
                  const r = respostas[op];
                  return r ? r(args) : null;
                };
              },
            },
          );
        },
      },
    );
  return {
    prisma: cliente(''),
    chamadas,
    ops: () => chamadas.map((c) => c.op),
    de: (op: string) => chamadas.filter((c) => c.op === op).map((c) => c.args),
  };
}

/** Banco vazio que aceita a criação (slug e e-mail livres). */
function bancoDaCriacao(extra: Record<string, (args: any) => any> = {}) {
  return gravador({
    'tenant.findUnique': () => null,
    'user.findUnique': () => null,
    'tenant.create': (a: any) => ({ id: LAB, ...a.data }),
    'user.create': (a: any) => ({ id: 'admin-1', ...a.data }),
    'tenant.update': (a: any) => ({ id: LAB, name: 'Laboratório Teste', owner_user_id: a.data.owner_user_id }),
    'user.update': () => ({}),
    // seed da clínica num banco vazio
    'specialty.upsert': (a: any) => ({ id: `spec:${a.create.name}` }),
    'procedure.findUnique': () => null,
    'procedure.create': (a: any) => ({ id: `proc:${a.data.name}` }),
    'globalAnamnesisTemplate.findUnique': () => null,
    'anamnesisTemplate.upsert': () => ({ id: 'anamnese-1' }),
    'anamnesisTemplate.updateMany': () => ({ count: 0 }),
    ...extra,
  });
}

function mailFalso() {
  return {
    send: jest.fn().mockResolvedValue(true),
    renderTemplate: jest.fn((o: any) => `<html>${o.title}</html>`),
  };
}

const corpoLab = (extra: Record<string, unknown> = {}) => ({
  name: ' Laboratório Teste ',
  slug: 'Lab Teste',
  email: 'contato@lab.teste',
  phone: '82999990000',
  cpf_cnpj: '12345678000190',
  business_type: 'LABORATORIO',
  lab_cro_inscricao: '  CRO-AL TPD 123 ',
  rt_name: 'Fulano Protético',
  rt_cro: '',
  admin: { name: 'Dono do Lab', email: 'Dono@Lab.Teste', password: 'senha-de-teste-123' },
  ...extra,
});

const corpoClinica = (extra: Record<string, unknown> = {}) => ({
  name: ' Clínica Teste ',
  slug: 'Clinica Teste',
  email: 'contato@clinica.teste',
  phone: '82988880000',
  cpf_cnpj: '98765432000110',
  plan: 'PRO',
  admin: { name: 'Dona da Clínica', email: 'Dona@Clinica.Teste', password: 'senha-de-teste-123' },
  ...extra,
});

/** Troca o que é aleatório (hash da senha, token do e-mail) por marcadores. */
function semAleatorio(chamadas: Chamada[]) {
  return chamadas.map((c) => {
    const args = c.args ? JSON.parse(JSON.stringify(c.args)) : c.args;
    if (args?.data?.password_hash) args.data.password_hash = '<argon2>';
    if (args?.data?.email_verify_token) args.data.email_verify_token = '<token>';
    return { op: c.op, args };
  });
}

const ligada = { 'globalSetting.findUnique': () => ({ key: CHAVE_CRIACAO_LABORATORIO, value: 'true' }) };

beforeAll(() => {
  for (const m of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  }
});

let urlAntes: string | undefined;
beforeAll(() => {
  urlAntes = process.env.PUBLIC_WEB_URL;
  process.env.PUBLIC_WEB_URL = 'https://clinica.teste';
});
afterAll(() => {
  if (urlAntes === undefined) delete process.env.PUBLIC_WEB_URL;
  else process.env.PUBLIC_WEB_URL = urlAntes;
  __limparCacheLabTenants();
});

beforeEach(() => {
  __limparCacheLabTenants();
  // Só o relógio é falso (teste de 14 dias); promessas e o argon2 seguem reais.
  jest.useFakeTimers({
    now: AGORA,
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
});
afterEach(() => jest.useRealTimers());

const depoisDasBoasVindas = () => new Promise((res) => setImmediate(res));

describe('POST /tenants com business_type LABORATORIO — chave da plataforma desligada', () => {
  it.each([
    ['sem a linha', () => null],
    ["valor 'false'", () => ({ value: 'false' })],
    ["valor 'TRUE'", () => ({ value: 'TRUE' })],
    ["valor 'true ' (espaço)", () => ({ value: 'true ' })],
    ['leitura falhou', () => { throw new Error('banco fora'); }],
  ])('%s → 409 com mensagem em português e nada criado', async (_nome, resposta) => {
    const g = bancoDaCriacao({ 'globalSetting.findUnique': resposta });
    const mail = mailFalso();
    const ctl = new TenantsController(new TenantsService(g.prisma, mail as any));

    const erro = await ctl.create(corpoLab() as any, { user: SUPER }).catch((e) => e);
    await depoisDasBoasVindas();

    expect(erro).toBeInstanceOf(ConflictException);
    expect(erro.getStatus()).toBe(409);
    expect(erro.getResponse()).toMatchObject({ code: CODIGO_CRIACAO_LABORATORIO_DESLIGADA });
    expect(erro.getResponse().message).toMatch(/criação de laboratório está desligada/);
    // Só a leitura da chave: nem a checagem de slug/e-mail, nem transação, nem e-mail.
    expect(g.ops()).toEqual(['globalSetting.findUnique']);
    expect(g.de('globalSetting.findUnique')).toEqual([{ where: { key: 'CRIACAO_LABORATORIO_LIBERADA' } }]);
    expect(mail.send).not.toHaveBeenCalled();
  });
});

describe('POST /tenants com business_type LABORATORIO — chave ligada', () => {
  async function criar(corpo = corpoLab()) {
    const g = bancoDaCriacao(ligada);
    const mail = mailFalso();
    const ctl = new TenantsController(new TenantsService(g.prisma, mail as any));
    const r = await ctl.create(corpo as any, { user: SUPER });
    await depoisDasBoasVindas();
    return { g, mail, r };
  }

  it('perfil gravado dentro da transação ANTES do seed; seed de laboratório no lugar do da clínica', async () => {
    const { g } = await criar();
    const ops = g.ops();

    expect(ops.slice(0, 9)).toEqual([
      'globalSetting.findUnique',
      'tenant.findUnique',
      'user.findUnique',
      '$transaction',
      'tx.tenant.create',
      'tx.user.create',
      'tx.tenant.update',
      'tx.tenantBusinessProfile.create',
      'tx.specialty.createMany',
    ]);
    const fim = ops.indexOf('$transaction:fim');
    expect(ops.slice(4, fim).filter((op) => !op.startsWith('tx.'))).toEqual([]);
    // Depois do commit: nada (sem e-mail de boas-vindas, sem token de confirmação).
    expect(ops.slice(fim + 1)).toEqual([]);

    // O seed dentro do tx é exatamente o seedLabTenantDefaults.
    const direto = gravador();
    await seedLabTenantDefaults(direto.prisma, LAB);
    expect(g.chamadas.slice(8, fim).map((c) => ({ op: c.op.replace(/^tx\./, ''), args: c.args }))).toEqual(direto.chamadas);

    // Nada da clínica: sem anamnese, sem os 30 procedimentos, sem as 9 especialidades.
    expect(ops.some((op) => /anamnesis/i.test(op))).toBe(false);
    expect(ops).not.toContain('tx.procedure.create');
    expect(ops).not.toContain('tx.specialty.upsert');
  });

  it('perfil: LABORATORIO exato, quem criou, CRO e RT aparados (vazio vira null)', async () => {
    const { g } = await criar();
    expect(g.de('tx.tenantBusinessProfile.create')).toEqual([
      {
        data: {
          tenant_id: LAB,
          business_type: 'LABORATORIO',
          lab_cro_inscricao: 'CRO-AL TPD 123',
          rt_name: 'Fulano Protético',
          rt_cro: null,
          created_by_user_id: 'super-1',
        },
      },
    ]);
  });

  it('nasce ACTIVE, plano CUSTOM e sem teste, mesmo que o corpo peça outra coisa', async () => {
    const { g } = await criar(corpoLab({ plan: 'STARTER', status: 'TRIAL', trial_ends_at: '2030-01-01' }));
    const [{ data }] = g.de('tx.tenant.create');
    expect(data).toEqual({
      name: 'Laboratório Teste',
      slug: 'lab-teste',
      email: 'contato@lab.teste',
      phone: '82999990000',
      cpf_cnpj: '12345678000190',
      plan: 'CUSTOM',
      status: 'ACTIVE',
      trial_ends_at: null,
    });
    const [admin] = g.de('tx.user.create');
    expect(admin.data.roles).toEqual(['ADMIN']);
    expect(admin.data.tenant_id).toBe(LAB);
  });

  it('sem e-mail de boas-vindas; a resposta diz que é laboratório', async () => {
    const { mail, r } = await criar();
    expect(mail.send).not.toHaveBeenCalled();
    expect(r).toMatchObject({ business_type: 'LABORATORIO', tenant: { id: LAB }, admin: { id: 'admin-1', email: 'dono@lab.teste' } });
  });

  it('depois do commit, a lista de laboratórios do processo é relida (sem esperar 60 s)', async () => {
    const vazio = { tenantBusinessProfile: { findMany: jest.fn(async () => []) } };
    await getLabTenantIds(vazio);
    expect(isLabTenantCached(LAB)).toBe(false);

    await criar();

    const comLab = { tenantBusinessProfile: { findMany: jest.fn(async () => [{ tenant_id: LAB }]) } };
    expect((await getLabTenantIds(comLab)).has(LAB)).toBe(true);
    expect(comLab.tenantBusinessProfile.findMany).toHaveBeenCalledTimes(1);
  });

  it('seed falhou → erro sobe, nada depois da transação (o banco desfaz a conta)', async () => {
    const g = bancoDaCriacao({ ...ligada, 'procedure.createMany': () => { throw new Error('falha no seed'); } });
    const mail = mailFalso();
    const svc = new TenantsService(g.prisma, mail as any);
    await expect(new TenantsController(svc).create(corpoLab() as any, { user: SUPER })).rejects.toThrow('falha no seed');
    expect(g.ops()).not.toContain('$transaction:fim');
    expect(mail.send).not.toHaveBeenCalled();
  });
});

describe('POST /tenants sem o tipo exato LABORATORIO — a clínica de sempre', () => {
  /** O que o POST /tenants fazia antes da F3: service.create(body), sem opções. */
  async function hoje(corpo: any) {
    const g = bancoDaCriacao();
    const mail = mailFalso();
    const r = await new TenantsService(g.prisma, mail as any).create(corpo);
    await depoisDasBoasVindas();
    return { g, mail, r };
  }

  it.each([
    ['sem business_type', undefined],
    ["'CLINICA'", 'CLINICA'],
    ["'laboratorio'", 'laboratorio'],
    ["' LABORATORIO'", ' LABORATORIO'],
    ["'LABORATORIO '", 'LABORATORIO '],
    ['null', null],
    ['número', 1],
    ['objeto', { tipo: 'LABORATORIO' }],
  ])('%s → chamadas, argumentos, resposta e e-mail IDÊNTICOS aos de hoje', async (_nome, tipo) => {
    const corpo = tipo === undefined ? corpoClinica() : corpoClinica({ business_type: tipo });

    const antes = await hoje(corpoClinica(tipo === undefined ? {} : { business_type: tipo }));

    const g = bancoDaCriacao();
    const mail = mailFalso();
    const r = await new TenantsController(new TenantsService(g.prisma, mail as any)).create(corpo as any, { user: SUPER });
    await depoisDasBoasVindas();

    expect(semAleatorio(g.chamadas)).toEqual(semAleatorio(antes.g.chamadas));
    expect(r).toEqual(antes.r);
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mail.send.mock.calls[0][0]).toEqual(antes.mail.send.mock.calls[0][0]);

    // Nem leitura da chave da plataforma nem perfil de laboratório; seed da clínica.
    const ops = g.ops();
    expect(ops).not.toContain('globalSetting.findUnique');
    expect(ops.some((op) => op.includes('tenantBusinessProfile'))).toBe(false);
    expect(ops[6]).toBe('tx.specialty.upsert');
    expect(g.de('tx.procedure.create')).toHaveLength(30);
    expect(g.de('tx.anamnesisTemplate.upsert')).toHaveLength(1);
    expect(r).not.toHaveProperty('business_type');
  });

  it('o corpo da clínica chega ao service sem alteração (o mesmo objeto)', async () => {
    const svc: any = { create: jest.fn(async () => ({ ok: true })) };
    const corpo = corpoClinica({ business_type: 'CLINICA' });
    await new TenantsController(svc).create(corpo as any, { user: SUPER });
    expect(svc.create).toHaveBeenCalledTimes(1);
    expect(svc.create.mock.calls[0]).toEqual([corpo]);
    expect(svc.create.mock.calls[0][0]).toBe(corpo);
  });
});

describe('POST /signup continua ignorando o tipo', () => {
  it("business_type 'LABORATORIO' no cadastro público: clínica em teste, sem chave da plataforma nem perfil", async () => {
    const g = bancoDaCriacao();
    const mail = mailFalso();
    await new SignupController(new TenantsService(g.prisma, mail as any)).signup({
      clinic_name: 'Lab que tentou pelo signup',
      admin_name: 'Fulano',
      admin_email: 'fulano@lab.teste',
      admin_password: 'senha-de-teste-123',
      business_type: 'LABORATORIO',
    } as any);
    await depoisDasBoasVindas();

    const ops = g.ops();
    expect(ops).not.toContain('globalSetting.findUnique');
    expect(ops.some((op) => op.includes('tenantBusinessProfile'))).toBe(false);
    expect(g.de('tx.tenant.create')[0].data).toMatchObject({ status: 'TRIAL', plan: 'STARTER' });
    expect(ops[6]).toBe('tx.specialty.upsert');
    expect(mail.send).toHaveBeenCalledTimes(1);
  });
});

describe('GET /tenants/me do laboratório', () => {
  const linha = {
    id: LAB, name: 'Laboratório Teste', slug: 'lab-teste', logo_url: null, theme_color: null, phone: null,
    email: null, cpf_cnpj: null, custom_domain: null, status: 'ACTIVE', plan: 'CUSTOM', trial_ends_at: null,
    owner_user_id: 'admin-1', zip_code: null, address: null, address_number: null, address_complement: null,
    neighborhood: null, city: null, state: null, responsible_name: null, responsible_cro: null, business_hours: null,
  };
  const montar = (perfil: any) => {
    const prisma: any = {
      tenant: { findUnique: jest.fn(async () => ({ ...linha })) },
      tenantBusinessProfile: { findUnique: jest.fn(async () => perfil) },
    };
    return { prisma, ctl: new TenantsMeController(new TenantsService(prisma, {} as any)) };
  };
  const perfilLab = { business_type: 'LABORATORIO', lab_cro_inscricao: 'CRO-AL TPD 123', rt_name: 'Fulano', rt_cro: 'CRO-AL 999' };

  it('token de laboratório: as chaves de sempre + tipo, CRO e RT no fim', async () => {
    const { prisma, ctl } = montar(perfilLab);
    const r: any = await ctl.getMyTenant({ user: { id: 'u', roles: ['ADMIN'], tenant_id: LAB, bt: 'LABORATORIO' } });
    expect(Object.keys(r).slice(-4)).toEqual(['business_type', 'lab_cro_inscricao', 'rt_name', 'rt_cro']);
    expect(r).toMatchObject({ business_type: 'LABORATORIO', lab_cro_inscricao: 'CRO-AL TPD 123', rt_name: 'Fulano', rt_cro: 'CRO-AL 999' });
    expect(prisma.tenantBusinessProfile.findUnique).toHaveBeenCalledWith({
      where: { tenant_id: LAB },
      select: { business_type: true, lab_cro_inscricao: true, rt_name: true, rt_cro: true },
    });
  });

  it('conta na lista de laboratórios já carregada (token sem claim): também traz o tipo', async () => {
    await getLabTenantIds({ tenantBusinessProfile: { findMany: async () => [{ tenant_id: LAB }] } });
    const { ctl } = montar(perfilLab);
    const r: any = await ctl.getMyTenant({ user: { id: 'u', roles: ['ADMIN'], tenant_id: LAB } });
    expect(r.business_type).toBe('LABORATORIO');
  });

  it('token de clínica: nenhuma consulta ao perfil e nenhuma chave nova', async () => {
    const { prisma, ctl } = montar(perfilLab);
    const r: any = await ctl.getMyTenant({ user: { id: 'u', roles: ['ADMIN'], tenant_id: LAB } });
    expect(prisma.tenantBusinessProfile.findUnique).not.toHaveBeenCalled();
    expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(1);
    expect(r).not.toHaveProperty('business_type');
    expect(r).not.toHaveProperty('rt_name');
  });

  it.each([
    ['perfil de clínica', { business_type: 'CLINICA', lab_cro_inscricao: null, rt_name: null, rt_cro: null }],
    ['sem perfil', null],
  ])('claim de laboratório mas %s no banco: resposta de clínica', async (_n, perfil) => {
    const { ctl } = montar(perfil);
    const r: any = await ctl.getMyTenant({ user: { id: 'u', roles: ['ADMIN'], tenant_id: LAB, bt: 'LABORATORIO' } });
    expect(r).not.toHaveProperty('business_type');
  });
});

describe('cron diário das chaves desligadas (PadroesLaboratorioService.garantir)', () => {
  const A = '1abe1abe-0000-4000-8000-00000000000a';
  const B = '1abe1abe-0000-4000-8000-00000000000b';
  let offAntes: string | undefined;
  beforeEach(() => {
    offAntes = process.env.PADROES_LABORATORIO_OFF;
    delete process.env.PADROES_LABORATORIO_OFF;
  });
  afterEach(() => {
    if (offAntes === undefined) delete process.env.PADROES_LABORATORIO_OFF;
    else process.env.PADROES_LABORATORIO_OFF = offAntes;
  });

  it('sem laboratório: uma leitura e nada gravado', async () => {
    const g = gravador({ 'tenantBusinessProfile.findMany': () => [] });
    expect(await new PadroesLaboratorioService(g.prisma).garantir()).toEqual({ laboratorios: 0, gravadas: 0 });
    expect(g.ops()).toEqual(['tenantBusinessProfile.findMany']);
    expect(g.de('tenantBusinessProfile.findMany')).toEqual([{ where: { business_type: 'LABORATORIO' }, select: { tenant_id: true } }]);
  });

  it('com laboratórios: só createMany com skipDuplicates, cada chave na conta certa', async () => {
    const g = gravador({
      'tenantBusinessProfile.findMany': () => [{ tenant_id: A }, { tenant_id: B }],
      'tenantSetting.createMany': (a: any) => ({ count: a.data.length }),
      'globalSetting.createMany': (a: any) => ({ count: a.data.length }),
    });
    const r = await new PadroesLaboratorioService(g.prisma).garantir();

    expect(g.ops()).toEqual([
      'tenantBusinessProfile.findMany',
      'tenantSetting.createMany', 'globalSetting.createMany',
      'tenantSetting.createMany', 'globalSetting.createMany',
    ]);
    const [tsA, tsB] = g.de('tenantSetting.createMany');
    const [gsA, gsB] = g.de('globalSetting.createMany');
    for (const [ts, gs, id] of [[tsA, gsA, A], [tsB, gsB, B]] as const) {
      expect(ts.skipDuplicates).toBe(true);
      expect(gs.skipDuplicates).toBe(true);
      expect(ts.data.every((l: any) => l.tenant_id === id)).toBe(true);
      expect(gs.data.every((l: any) => l.key.endsWith(`_${id}`))).toBe(true);
    }
    expect(r.laboratorios).toBe(2);
    expect(r.gravadas).toBe(tsA.data.length + gsA.data.length + tsB.data.length + gsB.data.length);
  });

  it('idempotente: 2ª rodada não grava nada e nunca atualiza o que a conta mudou', async () => {
    const g = gravador({
      'tenantBusinessProfile.findMany': () => [{ tenant_id: A }],
      'tenantSetting.createMany': () => ({ count: 0 }),
      'globalSetting.createMany': () => ({ count: 0 }),
    });
    const svc = new PadroesLaboratorioService(g.prisma);
    expect(await svc.garantir()).toEqual({ laboratorios: 1, gravadas: 0 });
    expect(await svc.garantir()).toEqual({ laboratorios: 1, gravadas: 0 });
    expect(g.ops().some((op) => /\.(update|updateMany|upsert|delete|deleteMany)$/.test(op))).toBe(false);
  });

  it('falha numa conta não para as outras; falha na leitura não derruba', async () => {
    let primeira = true;
    const g = gravador({
      'tenantBusinessProfile.findMany': () => [{ tenant_id: A }, { tenant_id: B }],
      'tenantSetting.createMany': (a: any) => {
        if (primeira) { primeira = false; throw new Error('falhou'); }
        return { count: a.data.length };
      },
      'globalSetting.createMany': (a: any) => ({ count: a.data.length }),
    });
    const r = await new PadroesLaboratorioService(g.prisma).garantir();
    expect(r.laboratorios).toBe(2);
    expect(g.de('globalSetting.createMany')).toHaveLength(1);
    expect(g.de('globalSetting.createMany')[0].data.every((l: any) => l.key.endsWith(`_${B}`))).toBe(true);

    const quebrado = gravador({ 'tenantBusinessProfile.findMany': () => { throw new Error('banco fora'); } });
    await expect(new PadroesLaboratorioService(quebrado.prisma).garantir()).resolves.toEqual({ laboratorios: 0, gravadas: 0 });
  });

  it('PADROES_LABORATORIO_OFF=1 desliga (nem lê)', async () => {
    process.env.PADROES_LABORATORIO_OFF = '1';
    const g = gravador({ 'tenantBusinessProfile.findMany': () => [{ tenant_id: A }] });
    await new PadroesLaboratorioService(g.prisma).garantir();
    expect(g.chamadas).toEqual([]);
  });
});

describe('chave da plataforma CRIACAO_LABORATORIO_LIBERADA', () => {
  it('rotas só do SUPER_ADMIN e negadas à conta de laboratório', () => {
    expect(Reflect.getMetadata(IS_SUPER_ADMIN_KEY, CriacaoLaboratorioController.prototype.ler)).toBe(true);
    expect(Reflect.getMetadata(IS_SUPER_ADMIN_KEY, CriacaoLaboratorioController.prototype.definir)).toBe(true);
    expect(Reflect.getMetadata(IS_SUPER_ADMIN_KEY, TenantsController.prototype.create)).toBe(true);
    expect(CONTROLLERS_SO_DE_CLINICA.has('CriacaoLaboratorioController')).toBe(true);
  });

  it('ler: desligada sem a linha; liberada só com o texto exato true', async () => {
    const quando = new Date('2026-10-27T12:00:00.000Z');
    for (const [linha, esperado] of [
      [null, false],
      [{ value: 'false', updated_at: quando }, false],
      [{ value: 'TRUE', updated_at: quando }, false],
      [{ value: 'true', updated_at: quando }, true],
    ] as const) {
      const prisma: any = { globalSetting: { findUnique: jest.fn(async () => linha) } };
      const r = await new CriacaoLaboratorioService(prisma).ler();
      expect(r.liberada).toBe(esperado);
      expect(r.atualizado_em).toEqual(linha ? quando : null);
    }
  });

  it('definir: grava true/false, registra quem mudou; valor que não é booleano → 400 sem gravar', async () => {
    const prisma: any = {
      globalSetting: { upsert: jest.fn(async (a: any) => ({ key: a.where.key, value: a.create.value, updated_at: AGORA })) },
      auditLog: { create: jest.fn(async () => ({})) },
    };
    const svc = new CriacaoLaboratorioService(prisma);

    expect(await svc.definir(true, 'super-1')).toEqual({ liberada: true, atualizado_em: AGORA });
    expect(prisma.globalSetting.upsert).toHaveBeenLastCalledWith({
      where: { key: 'CRIACAO_LABORATORIO_LIBERADA' },
      create: { key: 'CRIACAO_LABORATORIO_LIBERADA', value: 'true' },
      update: { value: 'true' },
    });
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
      tenant_id: null, actor_user_id: 'super-1', entity: 'PLATAFORMA', action: 'CRIACAO_LABORATORIO_LIGADA',
    });

    expect(await svc.definir(false, 'super-1')).toEqual({ liberada: false, atualizado_em: AGORA });
    expect(prisma.globalSetting.upsert.mock.calls[1][0].update).toEqual({ value: 'false' });

    for (const ruim of ['true', 1, null, undefined]) {
      await expect(svc.definir(ruim, 'super-1')).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(prisma.globalSetting.upsert).toHaveBeenCalledTimes(2);
  });

  it('controller repassa o booleano e quem pediu', async () => {
    const svc: any = { ler: jest.fn(async () => ({ liberada: false })), definir: jest.fn(async () => ({ liberada: true })) };
    const ctl = new CriacaoLaboratorioController(svc);
    await ctl.ler();
    await ctl.definir({ liberada: true }, { user: SUPER });
    expect(svc.definir).toHaveBeenCalledWith(true, 'super-1');
  });
});
