/**
 * F0a — retrato de comportamento "clínica idêntica": o que uma clínica nova recebe.
 *
 * Congela (jest snapshot, estrito) os defaults plantados em todo tenant de
 * clínica — especialidades, tabela de preços, anamnese padrão — e o que o
 * cadastro (POST /signup → TenantsService.create → seedTenantDefaults) grava no
 * banco. As fases do laboratório vão abrir um segundo caminho no cadastro; o
 * caminho da clínica tem que continuar gravando exatamente isto.
 *
 * Prisma mockado (gravador de chamadas) — sem banco. Se a mudança for de
 * propósito para as clínicas: `npx jest __guards__/tenant-defaults -u` em
 * apps/api e commite o .snap junto (o diff mostra o que mudou).
 */
import * as argon2 from 'argon2';
import {
  DEFAULT_ANAMNESIS_TEMPLATE,
  DEFAULT_PROCEDURES,
  DEFAULT_SPECIALTIES,
  seedTenantDefaults,
} from '@crm/shared';
import { SignupController } from '../tenants/tenants.controller';
import { TenantsService } from '../tenants/tenants.service';

const TENANT = 'tenant-clinica-nova';
const AGORA = new Date('2026-10-20T15:00:00.000Z');

interface Chamada {
  op: string;
  args: any;
}

/**
 * Prisma falso: grava toda chamada `prisma.<model>.<método>(args)` e responde
 * pelo mapa `respostas` (padrão: null). `$transaction(cb)` roda o callback com
 * um gravador-FILHO, cujas chamadas saem com o prefixo `tx.` (a resposta é a
 * mesma do mapa), e grava `$transaction:fim` quando o callback termina. Assim o
 * retrato vê o que foi feito dentro da transação e o que escapou dela.
 */
function gravador(respostas: Record<string, (args: any) => any> = {}) {
  const chamadas: Chamada[] = [];
  const cliente = (prefixo: string): any => {
    const modelos: Record<string, any> = {};
    const db: any = new Proxy(
      {},
      {
        get(_alvo, modelo: string | symbol) {
          // Não é Promise nem tem símbolos (inspect/toPrimitive).
          if (typeof modelo !== 'string' || modelo === 'then') return undefined;
          if (modelo === '$transaction') {
            return async (cb: any) => {
              chamadas.push({ op: `${prefixo}$transaction`, args: null });
              const r = await cb(cliente(`${prefixo}tx.`));
              chamadas.push({ op: `${prefixo}$transaction:fim`, args: null });
              return r;
            };
          }
          modelos[modelo] ??= new Proxy(
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
          return modelos[modelo];
        },
      },
    );
    return db;
  };
  const prisma = cliente('');
  const contagem = () =>
    chamadas.reduce<Record<string, number>>((acc, c) => {
      acc[c.op] = (acc[c.op] ?? 0) + 1;
      return acc;
    }, {});
  const de = (op: string) => chamadas.filter((c) => c.op === op).map((c) => c.args);
  return { prisma, chamadas, contagem, de };
}

/** Respostas de um banco vazio (tenant novo, sem anamnese master). */
function bancoVazio(extra: Record<string, (args: any) => any> = {}) {
  return {
    'specialty.upsert': (a: any) => ({ id: `spec:${a.create.name}` }),
    'procedure.findUnique': () => null,
    'procedure.create': (a: any) => ({ id: `proc:${a.data.name}` }),
    'globalAnamnesisTemplate.findUnique': () => null,
    'anamnesisTemplate.upsert': () => ({ id: 'anamnese-1' }),
    'anamnesisTemplate.updateMany': () => ({ count: 0 }),
    ...extra,
  };
}

/** O schema da anamnese é retratado à parte; aqui só diz de onde veio. */
function semSchema(args: any) {
  const troca = (bloco: any) =>
    bloco && {
      ...bloco,
      schema: bloco.schema === DEFAULT_ANAMNESIS_TEMPLATE ? '<DEFAULT_ANAMNESIS_TEMPLATE>' : bloco.schema,
    };
  return { ...args, create: troca(args.create), update: troca(args.update) };
}

describe('retrato: defaults de uma clínica nova (F0a)', () => {
  it('especialidades padrão', () => {
    expect(DEFAULT_SPECIALTIES.length).toBe(9);
    expect(DEFAULT_SPECIALTIES).toMatchSnapshot();
  });

  it('tabela de preços padrão (nome, especialidade, preço, duração, raio-x, anestesia)', () => {
    expect(DEFAULT_PROCEDURES.length).toBe(30);
    const nomesEsp = new Set<string>(DEFAULT_SPECIALTIES.map((s) => s.name));
    for (const p of DEFAULT_PROCEDURES) expect([p.name, nomesEsp.has(p.specialty)]).toEqual([p.name, true]);
    expect(
      DEFAULT_PROCEDURES.map((p) => ({
        name: p.name,
        specialty: p.specialty,
        price: p.price,
        duration: p.duration,
        xray: p.xray ?? false,
        anesthesia: p.anesthesia ?? false,
      })),
    ).toMatchSnapshot();
  });

  it('anamnese padrão: seções e perguntas', () => {
    const secoes = DEFAULT_ANAMNESIS_TEMPLATE.sections.map((s: any) => s.id);
    expect(secoes.length).toBe(9);
    expect(secoes).toMatchSnapshot('ids das seções');
    expect(DEFAULT_ANAMNESIS_TEMPLATE).toMatchSnapshot('template completo');
  });
});

describe('retrato: seedTenantDefaults num Prisma mockado (F0a)', () => {
  it('tenant novo, sem anamnese master: o que grava, em que ordem e quantas linhas', async () => {
    const g = gravador(bancoVazio());
    const r = await seedTenantDefaults(g.prisma, TENANT);

    expect(r).toEqual({ specialties: 9, procedures: 30, anamnesis_template: true });
    expect(g.contagem()).toMatchSnapshot('chamadas por model');
    // Ordem em que cada operação aparece pela 1ª vez (especialidades → procedimentos → anamnese).
    expect([...new Set(g.chamadas.map((c) => c.op))]).toMatchSnapshot('ordem');
    expect(g.de('specialty.upsert')).toMatchSnapshot('specialty.upsert');
    expect(g.de('procedure.create')).toMatchSnapshot('procedure.create');

    const upsert = g.de('anamnesisTemplate.upsert');
    expect(upsert).toHaveLength(1);
    expect(upsert[0].create.schema).toBe(DEFAULT_ANAMNESIS_TEMPLATE);
    expect(upsert[0].update.schema).toBe(DEFAULT_ANAMNESIS_TEMPLATE);
    expect(semSchema(upsert[0])).toMatchSnapshot('anamnesisTemplate.upsert');
    expect(g.de('anamnesisTemplate.updateMany')).toMatchSnapshot('anamnesisTemplate.updateMany');
  });

  it('com anamnese master (GlobalAnamnesisTemplate id=1): planta o schema da master', async () => {
    const master = { id: 1, version: 7, schema: { sections: [{ id: 'master', title: 'Master', questions: [] }] } };
    const g = gravador(bancoVazio({ 'globalAnamnesisTemplate.findUnique': () => master }));
    await seedTenantDefaults(g.prisma, TENANT);

    expect(g.de('globalAnamnesisTemplate.findUnique')).toEqual([{ where: { id: 1 } }]);
    expect(g.de('anamnesisTemplate.upsert')).toMatchSnapshot();
  });

  it('re-seed num tenant que já tem a tabela: não cria nem mexe em preço; só vincula especialidade vazia', async () => {
    // Metade dos procedimentos já existe sem especialidade, metade já vinculada.
    const g = gravador(
      bancoVazio({
        'procedure.findUnique': (a: any) => {
          const nome = a.where.tenant_id_name.name;
          const i = DEFAULT_PROCEDURES.findIndex((p) => p.name === nome);
          return { id: `proc-existente-${i}`, specialty_id: i % 2 === 0 ? null : 'spec-do-tenant' };
        },
      }),
    );
    await seedTenantDefaults(g.prisma, TENANT);

    expect(g.contagem()).toMatchSnapshot('chamadas por model');
    const updates = g.de('procedure.update');
    expect(updates).toHaveLength(15);
    for (const u of updates) expect(Object.keys(u.data)).toEqual(['specialty_id']);
    expect(updates).toMatchSnapshot('procedure.update');
  });
});

describe('retrato: POST /signup de clínica (F0a)', () => {
  let urlAntes: string | undefined;

  beforeAll(() => {
    // O link do e-mail de boas-vindas usa PUBLIC_WEB_URL; fixa para o retrato.
    urlAntes = process.env.PUBLIC_WEB_URL;
    process.env.PUBLIC_WEB_URL = 'https://clinica.teste';
  });

  afterAll(() => {
    if (urlAntes === undefined) delete process.env.PUBLIC_WEB_URL;
    else process.env.PUBLIC_WEB_URL = urlAntes;
  });

  beforeEach(() => {
    // Só o relógio é falso (trial de 14 dias e carimbos de data); promessas e o argon2 seguem reais.
    jest.useFakeTimers({
      now: AGORA,
      doNotFake: [
        'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
        'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
      ],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('cria tenant TRIAL + admin ADMIN + defaults na mesma transação, e manda as boas-vindas', async () => {
    const g = gravador(
      bancoVazio({
        'tenant.findUnique': () => null,
        'user.findUnique': () => null,
        'tenant.create': (a: any) => ({ id: TENANT, ...a.data }),
        'user.create': (a: any) => ({ id: 'admin-1', ...a.data }),
        'tenant.update': (a: any) => ({ id: TENANT, name: 'Clínica Sorriso Teste', owner_user_id: a.data.owner_user_id }),
        'user.update': () => ({}),
      }),
    );
    const mail: any = {
      send: jest.fn().mockResolvedValue(true),
      renderTemplate: jest.fn((o: any) => `<html>${o.title}</html>`),
    };
    const controller = new SignupController(new TenantsService(g.prisma, mail));

    const r = await controller.signup({
      clinic_name: '  Clínica Sorriso Teste ',
      cpf_cnpj: '12.345.678/0001-90',
      phone: '(82) 99999-0000',
      admin_name: ' Maria Teste ',
      admin_email: ' Maria@Clinica.Teste ',
      admin_password: 'senha-de-teste-123',
    });
    // As boas-vindas saem depois da transação (sem await no service).
    await new Promise((res) => setImmediate(res));

    expect(r).toMatchSnapshot('resposta do POST /signup');
    expect(g.contagem()).toMatchSnapshot('chamadas por model');

    // Ordem: checa slug e e-mail, abre a transação, cria tenant → admin → owner → defaults.
    const ops = g.chamadas.map((c) => c.op);
    expect(ops.slice(0, 6)).toEqual([
      'tenant.findUnique', 'user.findUnique', '$transaction', 'tx.tenant.create', 'tx.user.create', 'tx.tenant.update',
    ]);
    expect(ops[6]).toBe('tx.specialty.upsert');

    // Tudo entre a abertura e o fim da transação passa pelo tx (nada pelo prisma de
    // fora): se o seed falhar, o tenant é revertido e não fica meio criado. Depois do
    // fim, só as boas-vindas (user.update), que são de propósito fora da transação.
    expect(ops.filter((op) => op === '$transaction:fim')).toHaveLength(1);
    const fim = ops.indexOf('$transaction:fim');
    expect(ops.slice(3, fim).filter((op) => !op.startsWith('tx.'))).toEqual([]);
    expect(ops.slice(fim + 1)).toEqual(['user.update']);

    // Os defaults gravados pelo signup são EXATAMENTE os do seed direto (mesmas
    // chamadas, mesma ordem, mesmos argumentos), só que dentro do tx.
    const direto = gravador(bancoVazio());
    await seedTenantDefaults(direto.prisma, TENANT);
    const seedNoSignup = g.chamadas.slice(6, fim).map((c) => ({ op: c.op.replace(/^tx\./, ''), args: c.args }));
    expect(seedNoSignup).toEqual(direto.chamadas);

    expect(g.de('tenant.findUnique')).toMatchSnapshot('tenant.findUnique (slug)');
    expect(g.de('user.findUnique')).toMatchSnapshot('user.findUnique (e-mail)');
    expect(g.de('tx.tenant.create')).toMatchSnapshot('tenant.create');
    expect(g.de('tx.tenant.create')[0].data.trial_ends_at.getTime() - AGORA.getTime()).toBe(14 * 24 * 60 * 60 * 1000);

    const [userCreate] = g.de('tx.user.create');
    expect(await argon2.verify(userCreate.data.password_hash, 'senha-de-teste-123')).toBe(true);
    expect({ ...userCreate, data: { ...userCreate.data, password_hash: '<argon2>' } }).toMatchSnapshot('user.create');
    expect(g.de('tx.tenant.update')).toMatchSnapshot('tenant.update');

    expect(g.de('tx.procedure.create')).toHaveLength(30);
    expect(g.de('tx.specialty.upsert')).toHaveLength(9);
    expect(g.de('tx.anamnesisTemplate.upsert').map(semSchema)).toMatchSnapshot('anamnesisTemplate.upsert');

    // Boas-vindas: grava o token de confirmação e manda o e-mail.
    const [userUpdate] = g.de('user.update');
    expect(userUpdate.data.email_verify_token).toMatch(/^[0-9a-f]{64}$/);
    const token = userUpdate.data.email_verify_token;
    expect({ ...userUpdate, data: { ...userUpdate.data, email_verify_token: '<token>' } }).toMatchSnapshot('user.update (boas-vindas)');
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mail.send.mock.calls[0][0]).toMatchSnapshot('mail.send');
    const tpl = mail.renderTemplate.mock.calls[0][0];
    expect(tpl.ctaUrl).toBe(`https://clinica.teste/verificar-email?token=${token}`);
    expect({ ...tpl, ctaUrl: '<link de confirmação>' }).toMatchSnapshot('mail.renderTemplate');
  });
});
