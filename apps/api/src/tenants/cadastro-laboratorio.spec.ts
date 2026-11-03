/**
 * F11 do laboratório — cadastro de laboratório pelo /cadastrar
 * (POST /signup/laboratorio e POST /signup/laboratorio/situacao).
 *
 * Prisma de teste: gravador de chamadas, com a transação marcada por `tx.`
 * (o mesmo de criar-laboratorio.spec.ts). O POST /signup da clínica tem de
 * continuar fazendo EXATAMENTE as mesmas chamadas, com as chaves ligadas ou não.
 */
import { BadRequestException, ConflictException, ForbiddenException, HttpException, Logger, ValidationPipe } from '@nestjs/common';
import { HTTP_CODE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  __limparCacheLabTenants,
  seedLabTenantDefaults,
  toAlertPhone,
  VERSAO_POLITICA_DE_PRIVACIDADE,
  VERSAO_TERMOS_DE_USO,
} from '@crm/shared';
import { MSG_ACEITE_OBRIGATORIO } from './aceite-dos-termos';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { IS_SUPER_ADMIN_KEY } from '../auth/decorators/super-admin.decorator';
import { CONTROLLERS_SO_DE_CLINICA } from '../business-type/lab-route-policy';
import {
  CadastroLaboratorioController,
  CadastroLaboratorioDto,
  CadastroLaboratorioPlataformaController,
  SituacaoCadastroLabDto,
} from './cadastro-laboratorio.controller';
import { CadastroLaboratorioService } from './cadastro-laboratorio.service';
import { LAB_CADASTRO_MSG } from './cadastro-laboratorio.textos';
import { gerarCodigoConvite, hashDoCodigo } from './convite-laboratorio';
import { quemEnvia } from './lab-waitlist.controller';
import { SignupController } from './tenants.controller';
import { TenantsService } from './tenants.service';

const LAB = '00000000-0000-4000-8000-0000000f1100';
const CONVIDOU = '00000000-0000-4000-8000-0000000f11aa';
const CONVITE_ID = '00000000-0000-4000-8000-0000000f11c0';
const AGORA = new Date('2026-11-02T15:00:00.000Z');
const DIA = 24 * 3600_000;
/** Código gerado na hora do teste (nenhum código fica escrito no repositório). */
const { codigo: CODIGO } = gerarCodigoConvite();

interface Chamada {
  op: string;
  args: any;
}

/**
 * Prisma de teste: grava `<model>.<método>(args)` e responde pelo mapa (padrão:
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
          if (modelo === '$executeRaw') {
            return async (partes: TemplateStringsArray, ...valores: unknown[]) => {
              chamadas.push({ op: `${prefixo}$executeRaw`, args: { sql: partes.join('?'), valores } });
              return 1;
            };
          }
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

/** Linhas da GlobalSetting das duas chaves (null = sem a linha). */
function chaves(mestra: string | null, aberto: string | null) {
  const linhas: any[] = [];
  if (mestra !== null) linhas.push({ key: 'CRIACAO_LABORATORIO_LIBERADA', value: mestra, updated_at: AGORA });
  if (aberto !== null) linhas.push({ key: 'LAB_SIGNUP_ENABLED', value: aberto, updated_at: AGORA });
  return linhas;
}

const conviteValendo = (extra: Record<string, unknown> = {}) => ({
  id: CONVITE_ID,
  email: 'contato@convite.teste',
  lab_name: 'Laboratório do Convite',
  created_by_user_id: CONVIDOU,
  expires_at: new Date(AGORA.getTime() + 14 * DIA),
  used_at: null,
  revoked_at: null,
  ...extra,
});

/** Banco vazio que aceita a criação; as chaves e o convite vêm por parâmetro. */
function banco(
  o: { mestra?: string | null; aberto?: string | null; convite?: any; noDia?: number } = {},
  extra: Record<string, (args: any) => any> = {},
) {
  const mestra = o.mestra === undefined ? 'true' : o.mestra;
  const aberto = o.aberto === undefined ? 'true' : o.aberto;
  return gravador({
    'globalSetting.findMany': () => chaves(mestra, aberto),
    'globalSetting.findUnique': (a: any) => {
      const l = chaves(mestra, aberto).find((x) => x.key === a.where.key);
      return l ?? null;
    },
    'labSignupInvite.findUnique': () => (o.convite === undefined ? null : o.convite),
    'labSignupInvite.updateMany': () => ({ count: 1 }),
    'tenantBusinessProfile.count': () => o.noDia ?? 0,
    'user.findFirst': () => null,
    'auditLog.create': () => ({}),
    'tenant.findUnique': () => null,
    'user.findUnique': () => null,
    'tenant.create': (a: any) => ({ id: LAB, ...a.data }),
    'user.create': (a: any) => ({ id: 'admin-1', ...a.data }),
    'tenant.update': (a: any) => ({ id: LAB, name: 'Laboratório Sorriso', owner_user_id: a.data.owner_user_id }),
    'user.update': () => ({}),
    // seed da clínica num banco vazio (só o POST /signup da clínica usa)
    'specialty.upsert': (a: any) => ({ id: `spec:${a.create.name}` }),
    'procedure.findUnique': () => null,
    'procedure.create': (a: any) => ({ id: `proc:${a.data.name}` }),
    'globalAnamnesisTemplate.findUnique': () => null,
    'anamnesisTemplate.upsert': () => ({ id: 'anamnese-1' }),
    'anamnesisTemplate.updateMany': () => ({ count: 0 }),
    ...extra,
  });
}

function mailDeTeste() {
  return {
    send: jest.fn().mockResolvedValue(true),
    renderTemplate: jest.fn((o: any) => `<html>${o.title}</html>`),
  };
}

function montar(g: ReturnType<typeof gravador>) {
  const mail = mailDeTeste();
  const service = new CadastroLaboratorioService(g.prisma, new TenantsService(g.prisma, mail as any));
  return { mail, service, ctl: new CadastroLaboratorioController(service) };
}

const corpo = (extra: Record<string, unknown> = {}) => ({
  lab_name: '  Laboratório   Sorriso ',
  cpf_cnpj: '11.222.333/0001-81',
  phone: '(82) 99999-0000',
  admin_name: ' Ana   Teste ',
  admin_email: ' Ana@Lab.Teste ',
  admin_password: 'senha-de-teste-123',
  aceite_termos: true,
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

const depoisDasBoasVindas = () => new Promise((res) => setImmediate(res));

/** Erro HTTP que a promessa devolveu (falha o teste se ela resolveu). */
async function erroDe(p: Promise<unknown>): Promise<HttpException> {
  const r = await p.then(
    (v) => ({ ok: true as const, v }),
    (e) => ({ ok: false as const, e }),
  );
  if (r.ok) throw new Error(`esperava erro, veio ${JSON.stringify(r.v)}`);
  return r.e as HttpException;
}

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
  // Só o relógio fica parado; promessas e o argon2 seguem reais.
  jest.useFakeTimers({
    now: AGORA,
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
});
afterEach(() => jest.useRealTimers());

describe('POST /signup da clínica não muda com as chaves do laboratório', () => {
  const corpoClinica = {
    clinic_name: '  Clínica Sorriso Teste ',
    cpf_cnpj: '12.345.678/0001-90',
    phone: '(82) 99999-0000',
    admin_name: ' Maria Teste ',
    admin_email: ' Maria@Clinica.Teste ',
    admin_password: 'senha-de-teste-123',
    aceite_termos: true,
  };

  async function signup(g: ReturnType<typeof gravador>) {
    const mail = mailDeTeste();
    const r = await new SignupController(new TenantsService(g.prisma, mail as any)).signup({ ...corpoClinica });
    await depoisDasBoasVindas();
    return { r, mail };
  }

  it('as duas chaves ligadas: as mesmas chamadas, na mesma ordem e com os mesmos argumentos; nenhuma leitura de chave', async () => {
    const desligadas = banco({ mestra: null, aberto: null });
    const antes = await signup(desligadas);

    const ligadas = banco({ mestra: 'true', aberto: 'true' });
    const depois = await signup(ligadas);

    expect(semAleatorio(ligadas.chamadas)).toEqual(semAleatorio(desligadas.chamadas));
    expect(depois.r).toEqual(antes.r);
    expect(ligadas.ops().some((op) => op.includes('globalSetting.'))).toBe(false);
    expect(ligadas.ops().some((op) => op.includes('labSignupInvite') || op.includes('tenantBusinessProfile'))).toBe(false);
    expect(ligadas.de('tx.tenant.create')[0].data).toMatchObject({ status: 'TRIAL', plan: 'STARTER' });
    expect(depois.mail.send).toHaveBeenCalledTimes(1);
    expect(depois.mail.send.mock.calls[0][0]).toEqual(antes.mail.send.mock.calls[0][0]);
  });

  it('a rota da clínica continua sendo /signup e a do laboratório é outra', () => {
    expect(Reflect.getMetadata(PATH_METADATA, SignupController)).toBe('signup');
    expect(Reflect.getMetadata(PATH_METADATA, CadastroLaboratorioController)).toBe('signup/laboratorio');
    expect(Reflect.getMetadata(PATH_METADATA, CadastroLaboratorioController.prototype.cadastrar)).toBe('/');
    expect(Reflect.getMetadata(PATH_METADATA, CadastroLaboratorioController.prototype.situacao)).toBe('situacao');
  });
});

describe('POST /signup/laboratorio — portões (nada é criado)', () => {
  it('sem convite e com o cadastro aberto desligado: 403 CADASTRO_LABORATORIO_FECHADO, só a leitura das chaves', async () => {
    const g = banco({ mestra: 'true', aberto: 'false' });
    const { ctl, mail } = montar(g);
    const erro = await erroDe(ctl.cadastrar(corpo() as any));
    await depoisDasBoasVindas();

    expect(erro).toBeInstanceOf(ForbiddenException);
    expect(erro.getResponse()).toEqual({ statusCode: 403, message: LAB_CADASTRO_MSG.fechado, code: 'CADASTRO_LABORATORIO_FECHADO' });
    expect(g.ops()).toEqual(['globalSetting.findMany']);
    expect(g.de('globalSetting.findMany')).toEqual([
      { where: { key: { in: ['CRIACAO_LABORATORIO_LIBERADA', 'LAB_SIGNUP_ENABLED'] } } },
    ]);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it.each([
    ['chave mestra desligada', 'false'],
    ['chave mestra sem a linha', null],
    ["chave mestra 'TRUE'", 'TRUE'],
  ])('%s + convite válido + cadastro aberto ligado: 403 FECHADO; o convite nem é lido', async (_n, mestra) => {
    const g = banco({ mestra, aberto: 'true', convite: conviteValendo() });
    const { ctl } = montar(g);
    const erro = await erroDe(ctl.cadastrar(corpo({ convite: CODIGO }) as any));
    expect(erro.getStatus()).toBe(403);
    expect(erro.getResponse()).toMatchObject({ code: 'CADASTRO_LABORATORIO_FECHADO' });
    expect(g.ops()).toEqual(['globalSetting.findMany']);
  });

  it('leitura das chaves falhou: 403 FECHADO', async () => {
    const g = banco({}, { 'globalSetting.findMany': () => { throw new Error('banco fora'); } });
    const erro = await erroDe(montar(g).ctl.cadastrar(corpo() as any));
    expect(erro.getResponse()).toMatchObject({ code: 'CADASTRO_LABORATORIO_FECHADO' });
    expect(g.ops()).toEqual(['globalSetting.findMany']);
  });

  it.each([
    ['usado', conviteValendo({ used_at: new Date(AGORA.getTime() - DIA) })],
    ['revogado', conviteValendo({ revoked_at: new Date(AGORA.getTime() - DIA) })],
    ['vencido (vence agora)', conviteValendo({ expires_at: AGORA })],
    ['inexistente', null],
  ])('convite %s + cadastro aberto desligado: 403 CONVITE_INVALIDO e nada criado', async (_n, linha) => {
    const g = banco({ aberto: 'false', convite: linha });
    const erro = await erroDe(montar(g).ctl.cadastrar(corpo({ convite: CODIGO }) as any));
    expect(erro.getResponse()).toEqual({ statusCode: 403, message: LAB_CADASTRO_MSG.conviteInvalido, code: 'CONVITE_INVALIDO' });
    expect(g.ops()).toEqual(['globalSetting.findMany', 'labSignupInvite.findUnique']);
    expect(g.de('labSignupInvite.findUnique')[0].where).toEqual({ token_hash: hashDoCodigo(CODIGO) });
  });

  it('código fora do formato + cadastro aberto desligado: 403 CONVITE_INVALIDO sem ir ao banco atrás do convite', async () => {
    const g = banco({ aberto: 'false', convite: conviteValendo() });
    const erro = await erroDe(montar(g).ctl.cadastrar(corpo({ convite: 'curto-demais' }) as any));
    expect(erro.getResponse()).toMatchObject({ code: 'CONVITE_INVALIDO' });
    expect(g.ops()).toEqual(['globalSetting.findMany']);
  });

  it('campo escondido preenchido (robô): {ok:true} e nenhuma operação', async () => {
    const g = banco();
    const { ctl, mail } = montar(g);
    await expect(ctl.cadastrar(corpo({ website: 'http://spam.teste' }) as any)).resolves.toEqual({ ok: true });
    expect(g.chamadas).toEqual([]);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('teto: 20 contas de laboratório em 24 h → 429 CADASTRO_LABORATORIO_TETO e nada criado', async () => {
    const g = banco({ noDia: 20 });
    const erro = await erroDe(montar(g).ctl.cadastrar(corpo() as any));
    expect(erro.getStatus()).toBe(429);
    expect(erro.getResponse()).toEqual({ statusCode: 429, code: 'CADASTRO_LABORATORIO_TETO', message: LAB_CADASTRO_MSG.teto });
    expect(g.ops()).toEqual(['globalSetting.findMany', 'tenantBusinessProfile.count']);
    const [{ where }] = g.de('tenantBusinessProfile.count');
    expect(where).toEqual({ business_type: 'LABORATORIO', created_at: { gte: new Date(AGORA.getTime() - DIA) } });

    const umAbaixo = banco({ noDia: 19 });
    await expect(montar(umAbaixo).ctl.cadastrar(corpo() as any)).resolves.toEqual({ ok: true });
  });

  it('teto conferido de novo dentro da transação, sob a trava: quem chega junto e passa do teto não cria a conta', async () => {
    // Fora da trava ainda havia 19; dentro, outro cadastro já entrou (20).
    let leituras = 0;
    const g = banco({}, { 'tenantBusinessProfile.count': () => (++leituras === 1 ? 19 : 20) });
    const erro = await erroDe(montar(g).ctl.cadastrar(corpo() as any));
    expect(erro.getStatus()).toBe(429);
    expect(erro.getResponse()).toEqual({ statusCode: 429, code: 'CADASTRO_LABORATORIO_TETO', message: LAB_CADASTRO_MSG.teto });
    const ops = g.ops();
    expect(ops.indexOf('tx.$executeRaw')).toBeLessThan(ops.indexOf('tx.tenantBusinessProfile.count'));
    expect(ops).not.toContain('tx.tenantBusinessProfile.create');
    expect(ops).not.toContain('tx.auditLog.create');
    expect(g.de('tx.tenantBusinessProfile.count')[0].where).toEqual(g.de('tenantBusinessProfile.count')[0].where);
  });

  it('teto não vale para o convite (o SUPER_ADMIN controla)', async () => {
    const g = banco({ aberto: 'false', noDia: 999, convite: conviteValendo() });
    await expect(montar(g).ctl.cadastrar(corpo({ convite: CODIGO }) as any)).resolves.toEqual({ ok: true });
    expect(g.ops()).not.toContain('tenantBusinessProfile.count');
    expect(g.ops()).not.toContain('tx.tenantBusinessProfile.count');
    expect(g.ops()).not.toContain('tx.$executeRaw');
  });
});

describe('POST /signup/laboratorio — validação (sem banco)', () => {
  it.each([
    [{ lab_name: ' A ' }, LAB_CADASTRO_MSG.nomeLab],
    [{ lab_name: 'x'.repeat(121) }, LAB_CADASTRO_MSG.nomeLab],
    [{ admin_name: 'B' }, LAB_CADASTRO_MSG.nomeResponsavel],
    [{ admin_email: 'sem-arroba' }, LAB_CADASTRO_MSG.email],
    [{ admin_password: '  1234567  ' }, LAB_CADASTRO_MSG.senha],
    [{ cpf_cnpj: ' ./- ' }, LAB_CADASTRO_MSG.documento],
    [{ cpf_cnpj: '11.222.333/0001-80' }, 'CNPJ inválido'],
    [{ cpf_cnpj: '529.982.247-24' }, 'CPF inválido'],
    [{ cpf_cnpj: '1234' }, 'Faltam 7 dígito(s)'],
    [{ phone: '9999-0000' }, LAB_CADASTRO_MSG.whatsapp],
    [{ phone: '' }, LAB_CADASTRO_MSG.whatsapp],
    [{ aceite_termos: undefined }, MSG_ACEITE_OBRIGATORIO],
    [{ aceite_termos: false }, MSG_ACEITE_OBRIGATORIO],
    [{ aceite_termos: 'true' }, MSG_ACEITE_OBRIGATORIO],
  ])('dado errado → 400 com a mensagem certa e nenhuma operação (%#)', async (extra, mensagem) => {
    const g = banco();
    const erro = await erroDe(montar(g).ctl.cadastrar(corpo(extra) as any));
    expect(erro).toBeInstanceOf(BadRequestException);
    expect(erro.message).toBe(mensagem);
    expect(g.chamadas).toEqual([]);
  });
});

describe('POST /signup/laboratorio — cadastro aberto (sem convite)', () => {
  async function cadastrar(extra: Record<string, unknown> = {}, o: Parameters<typeof banco>[0] = {}) {
    const g = banco(o);
    const { ctl, mail } = montar(g);
    const r = await ctl.cadastrar(corpo(extra) as any);
    await depoisDasBoasVindas();
    return { g, mail, r };
  }

  it('cria a conta igual à da F3: ordem, tipo antes do seed, seed do laboratório e resposta {ok:true}', async () => {
    const { g, mail, r } = await cadastrar();
    const ops = g.ops();
    expect(r).toEqual({ ok: true });

    expect(ops.slice(0, 15)).toEqual([
      'globalSetting.findMany',
      'tenantBusinessProfile.count',
      'user.findFirst',
      'globalSetting.findUnique',
      'user.findUnique',
      '$transaction',
      'tx.tenant.create',
      'tx.user.create',
      'tx.tenant.update',
      'tx.termsAcceptance.create',
      'tx.$executeRaw',
      'tx.tenantBusinessProfile.count',
      'tx.auditLog.create',
      'tx.tenantBusinessProfile.create',
      'tx.specialty.createMany',
    ]);
    // A trava do cadastro aberto é por transação e por nome fixo.
    expect(g.de('tx.$executeRaw')).toEqual([{ sql: 'SELECT pg_advisory_xact_lock(hashtext(?))', valores: ['cadastro-laboratorio-aberto'] }]);
    expect(ops).not.toContain('labSignupInvite.findUnique');
    expect(ops).not.toContain('tx.labSignupInvite.updateMany');
    const fim = ops.indexOf('$transaction:fim');
    expect(ops.filter((op) => op === '$transaction:fim')).toHaveLength(1);
    expect(ops.slice(6, fim).filter((op) => !op.startsWith('tx.'))).toEqual([]);
    // Depois do commit: nada (sem e-mail de boas-vindas, sem token de confirmação).
    expect(ops.slice(fim + 1)).toEqual([]);
    expect(mail.send).not.toHaveBeenCalled();

    // O seed dentro do tx é exatamente o seedLabTenantDefaults.
    const direto = gravador();
    await seedLabTenantDefaults(direto.prisma, LAB);
    expect(g.chamadas.slice(14, fim).map((c) => ({ op: c.op.replace(/^tx\./, ''), args: c.args }))).toEqual(direto.chamadas);
    expect(ops.some((op) => /anamnesis/i.test(op))).toBe(false);
  });

  it('conta ACTIVE, plano CUSTOM, sem teste, sem slug; documento e WhatsApp normalizados', async () => {
    const { g } = await cadastrar();
    expect(g.de('tx.tenant.create')).toEqual([
      {
        data: {
          name: 'Laboratório Sorriso',
          slug: null,
          email: 'ana@lab.teste',
          phone: toAlertPhone('(82) 99999-0000'),
          cpf_cnpj: '11222333000181',
          plan: 'CUSTOM',
          status: 'ACTIVE',
          trial_ends_at: null,
        },
      },
    ]);
    const [admin] = g.de('tx.user.create');
    expect(admin.data).toMatchObject({ tenant_id: LAB, name: 'Ana Teste', email: 'ana@lab.teste', phone: '5582999990000', roles: ['ADMIN'] });
    expect(g.de('user.findFirst')).toEqual([{ where: { email: { equals: 'ana@lab.teste', mode: 'insensitive' } }, select: { id: true } }]);
    expect(g.ops()).not.toContain('tenant.findUnique');
  });

  it('aceite dos termos na transação: o admin novo, as versões em vigor e a origem do pedido', async () => {
    const g = banco();
    const r = await montar(g).ctl.cadastrar(corpo() as any, {
      headers: { 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'Navegador de teste' },
    });
    expect(r).toEqual({ ok: true });
    expect(g.de('tx.termsAcceptance.create')).toEqual([
      {
        data: {
          tenant_id: LAB,
          user_id: 'admin-1',
          email: 'ana@lab.teste',
          source: 'CADASTRO_LABORATORIO',
          terms_version: VERSAO_TERMOS_DE_USO,
          privacy_version: VERSAO_POLITICA_DE_PRIVACIDADE,
          ip: '203.0.113.7',
          user_agent: 'Navegador de teste',
        },
      },
    ]);
  });

  it('perfil LABORATORIO sem quem convidou; CRO e RT opcionais aparados', async () => {
    const { g } = await cadastrar({ lab_cro_inscricao: '  CRO-AL TPD 123 ', rt_name: 'Fulano Protético', rt_cro: '' });
    expect(g.de('tx.tenantBusinessProfile.create')).toEqual([
      {
        data: {
          tenant_id: LAB,
          business_type: 'LABORATORIO',
          lab_cro_inscricao: 'CRO-AL TPD 123',
          rt_name: 'Fulano Protético',
          rt_cro: null,
          created_by_user_id: null,
        },
      },
    ]);
  });

  it('auditoria PLATAFORMA CADASTRO_LABORATORIO com a via, na conta nova e pelo admin novo', async () => {
    const { g } = await cadastrar();
    expect(g.de('tx.auditLog.create')).toEqual([
      {
        data: {
          tenant_id: LAB,
          actor_user_id: 'admin-1',
          entity: 'PLATAFORMA',
          entity_id: LAB,
          action: 'CADASTRO_LABORATORIO',
          meta_json: { via: 'ABERTO', convite_id: null, before: null, after: null },
        },
      },
    ]);
  });

  it('CNPJ alfanumérico válido é gravado com as letras', async () => {
    const { g } = await cadastrar({ cpf_cnpj: '12.abc.345/01de-35' });
    expect(g.de('tx.tenant.create')[0].data.cpf_cnpj).toBe('12ABC34501DE35');
  });

  it('CPF válido também serve', async () => {
    const { g } = await cadastrar({ cpf_cnpj: '529.982.247-25' });
    expect(g.de('tx.tenant.create')[0].data.cpf_cnpj).toBe('52998224725');
  });

  it("convite inválido com o cadastro aberto: segue pelo aberto e o convite não é gasto", async () => {
    const { g } = await cadastrar({ convite: CODIGO }, { convite: conviteValendo({ used_at: AGORA }) });
    expect(g.ops()).toContain('labSignupInvite.findUnique');
    expect(g.ops()).toContain('tenantBusinessProfile.count');
    expect(g.ops()).not.toContain('tx.labSignupInvite.updateMany');
    expect(g.de('tx.auditLog.create')[0].data.meta_json).toMatchObject({ via: 'ABERTO', convite_id: null });
    expect(g.de('tx.tenantBusinessProfile.create')[0].data.created_by_user_id).toBeNull();
  });
});

describe('POST /signup/laboratorio — pelo convite', () => {
  it.each([
    ["cadastro aberto desligado", 'false'],
    ['cadastro aberto ligado', 'true'],
  ])('%s: gasta o convite na transação, perfil com quem convidou e auditoria com o convite', async (_n, aberto) => {
    const g = banco({ aberto, convite: conviteValendo() });
    const r = await montar(g).ctl.cadastrar(corpo({ convite: CODIGO }) as any);
    expect(r).toEqual({ ok: true });

    const ops = g.ops();
    expect(ops.slice(0, 12)).toEqual([
      'globalSetting.findMany',
      'labSignupInvite.findUnique',
      'user.findFirst',
      'globalSetting.findUnique',
      'user.findUnique',
      '$transaction',
      'tx.tenant.create',
      'tx.user.create',
      'tx.tenant.update',
      'tx.termsAcceptance.create',
      'tx.labSignupInvite.updateMany',
      'tx.auditLog.create',
    ]);
    expect(ops[12]).toBe('tx.tenantBusinessProfile.create');
    expect(g.de('labSignupInvite.findUnique')).toEqual([
      {
        where: { token_hash: hashDoCodigo(CODIGO) },
        select: { id: true, email: true, lab_name: true, created_by_user_id: true, expires_at: true, used_at: true, revoked_at: true },
      },
    ]);
    expect(g.de('tx.labSignupInvite.updateMany')).toEqual([
      {
        where: { id: CONVITE_ID, used_at: null, revoked_at: null, expires_at: { gt: AGORA } },
        data: { used_at: AGORA, tenant_id: LAB },
      },
    ]);
    expect(g.de('tx.tenantBusinessProfile.create')[0].data.created_by_user_id).toBe(CONVIDOU);
    expect(g.de('tx.auditLog.create')[0].data.meta_json).toEqual({ via: 'CONVITE', convite_id: CONVITE_ID, before: null, after: null });
    expect(ops).toContain('$transaction:fim');
  });

  it('dois cadastros com o mesmo convite: o 2º perde (403 CONVITE_INVALIDO) e a transação dele não termina', async () => {
    let gastos = 0;
    const updateMany = () => ({ count: gastos++ === 0 ? 1 : 0 });
    const primeiro = banco({ aberto: 'false', convite: conviteValendo() }, { 'labSignupInvite.updateMany': updateMany });
    const segundo = banco({ aberto: 'false', convite: conviteValendo() }, { 'labSignupInvite.updateMany': updateMany });

    await expect(montar(primeiro).ctl.cadastrar(corpo({ convite: CODIGO }) as any)).resolves.toEqual({ ok: true });
    const erro = await erroDe(montar(segundo).ctl.cadastrar(corpo({ convite: CODIGO, admin_email: 'outra@lab.teste' }) as any));

    expect(erro).toBeInstanceOf(ForbiddenException);
    expect(erro.getResponse()).toEqual({ statusCode: 403, message: LAB_CADASTRO_MSG.conviteInvalido, code: 'CONVITE_INVALIDO' });
    const ops = segundo.ops();
    expect(ops).not.toContain('$transaction:fim');
    expect(ops).not.toContain('tx.auditLog.create');
    expect(ops).not.toContain('tx.tenantBusinessProfile.create');
    expect(ops[ops.length - 1]).toBe('tx.labSignupInvite.updateMany');
  });
});

describe('POST /signup/laboratorio — e-mail já usado e chave mestra desligada no meio', () => {
  async function recusaDaClinica() {
    const g = gravador({ 'user.findUnique': () => ({ id: 'ja-existe' }) });
    const e = await erroDe(
      new TenantsService(g.prisma, mailDeTeste() as any).create({
        name: 'Clínica',
        admin: { name: 'Fulano', email: 'ana@lab.teste', password: 'senha-de-teste-123' },
      }),
    );
    return e.getResponse();
  }

  it('e-mail de outra conta (sem diferença de maiúsculas): 409 com a mesma recusa da clínica, nada criado', async () => {
    const g = banco({}, { 'user.findFirst': () => ({ id: 'ja-existe' }) });
    const erro = await erroDe(montar(g).ctl.cadastrar(corpo() as any));
    expect(erro).toBeInstanceOf(ConflictException);
    expect(erro.getResponse()).toEqual(await recusaDaClinica());
    expect(g.ops()).not.toContain('$transaction');
  });

  it('corrida no e-mail (P2002 na criação): 409 com a mesma recusa (não 503)', async () => {
    const g = banco({}, {
      'user.create': () => {
        throw Object.assign(new Error('Unique constraint failed on the fields: (`email`)'), { code: 'P2002' });
      },
    });
    const erro = await erroDe(montar(g).ctl.cadastrar(corpo() as any));
    expect(erro).toBeInstanceOf(ConflictException);
    expect(erro.getStatus()).toBe(409);
    expect(erro.getResponse()).toEqual(await recusaDaClinica());
    expect(g.ops()).not.toContain('$transaction:fim');
  });

  it('a criação recusou por CRIACAO_LABORATORIO_DESLIGADA: o visitante recebe 403 FECHADO (nunca o texto do /admin)', async () => {
    const g = banco({}, { 'globalSetting.findUnique': () => ({ key: 'CRIACAO_LABORATORIO_LIBERADA', value: 'false' }) });
    const erro = await erroDe(montar(g).ctl.cadastrar(corpo() as any));
    expect(erro).toBeInstanceOf(ForbiddenException);
    expect(erro.getResponse()).toEqual({ statusCode: 403, message: LAB_CADASTRO_MSG.fechado, code: 'CADASTRO_LABORATORIO_FECHADO' });
    expect(JSON.stringify(erro.getResponse())).not.toMatch(/painel do administrador/);
    expect(g.ops()).not.toContain('$transaction');
  });

  it('outro erro da criação sobe como veio', async () => {
    const g = banco({}, { 'tenantBusinessProfile.create': () => { throw new Error('falha no perfil'); } });
    await expect(montar(g).ctl.cadastrar(corpo() as any)).rejects.toThrow('falha no perfil');
    expect(g.ops()).not.toContain('$transaction:fim');
  });
});

describe('POST /signup/laboratorio/situacao', () => {
  const nulo = { email: null, lab_name: null };
  it.each([
    // [nome, mestra, aberto, código, convite no banco, esperado]
    ['tudo ligado, sem convite', 'true', 'true', undefined, undefined, { modo: 'ABERTO', convite: 'AUSENTE', ...nulo }],
    ['só a mestra, sem convite', 'true', 'false', undefined, undefined, { modo: 'LISTA_ESPERA', convite: 'AUSENTE', ...nulo }],
    ['só a mestra, código vazio', 'true', null, '   ', undefined, { modo: 'LISTA_ESPERA', convite: 'AUSENTE', ...nulo }],
    ['só a mestra, convite válido', 'true', null, 'C', 'valendo', { modo: 'CONVITE', convite: 'VALIDO', email: 'contato@convite.teste', lab_name: 'Laboratório do Convite' }],
    ['tudo ligado, convite válido', 'true', 'true', 'C', 'valendo', { modo: 'CONVITE', convite: 'VALIDO', email: 'contato@convite.teste', lab_name: 'Laboratório do Convite' }],
    ['tudo ligado, convite usado', 'true', 'true', 'C', 'usado', { modo: 'ABERTO', convite: 'INVALIDO', ...nulo }],
    ['só a mestra, convite vencido', 'true', 'false', 'C', 'vencido', { modo: 'LISTA_ESPERA', convite: 'INVALIDO', ...nulo }],
    ['só a mestra, convite revogado', 'true', 'false', 'C', 'revogado', { modo: 'LISTA_ESPERA', convite: 'INVALIDO', ...nulo }],
    ['só a mestra, convite inexistente', 'true', 'false', 'C', null, { modo: 'LISTA_ESPERA', convite: 'INVALIDO', ...nulo }],
    ['mestra desligada, convite válido', 'false', 'true', 'C', 'valendo', { modo: 'LISTA_ESPERA', convite: 'INVALIDO', ...nulo }],
    ['mestra sem a linha, sem convite', null, 'true', undefined, undefined, { modo: 'LISTA_ESPERA', convite: 'AUSENTE', ...nulo }],
    ["mestra 'TRUE'", 'TRUE', 'true', undefined, undefined, { modo: 'LISTA_ESPERA', convite: 'AUSENTE', ...nulo }],
    ["aberto 'true ' (espaço)", 'true', 'true ', undefined, undefined, { modo: 'LISTA_ESPERA', convite: 'AUSENTE', ...nulo }],
    ["aberto 'TRUE'", 'true', 'TRUE', undefined, undefined, { modo: 'LISTA_ESPERA', convite: 'AUSENTE', ...nulo }],
  ] as const)('%s', async (_n, mestra, aberto, codigo, noBanco, esperado) => {
    const linhas: Record<string, any> = {
      valendo: conviteValendo(),
      usado: conviteValendo({ used_at: AGORA }),
      vencido: conviteValendo({ expires_at: AGORA }),
      revogado: conviteValendo({ revoked_at: AGORA }),
    };
    const g = banco({ mestra, aberto, convite: noBanco === undefined ? undefined : noBanco === null ? null : linhas[noBanco] });
    const enviado = codigo === 'C' ? CODIGO : codigo;
    const r = await montar(g).ctl.situacao(enviado === undefined ? {} : { convite: enviado });
    expect(r).toEqual(esperado);
    expect(Object.keys(r).sort()).toEqual(['convite', 'email', 'lab_name', 'modo']);
    const leuConvite = g.ops().includes('labSignupInvite.findUnique');
    expect(leuConvite).toBe(codigo === 'C' && mestra === 'true');
    expect(g.ops().filter((op) => op !== 'labSignupInvite.findUnique')).toEqual(['globalSetting.findMany']);
  });

  it('código fora do formato: INVALIDO sem ir ao banco atrás do convite', async () => {
    for (const ruim of ['abc', `${CODIGO}x`, CODIGO.slice(1), `${CODIGO.slice(0, 31)}+`]) {
      const g = banco({ aberto: 'false', convite: conviteValendo() });
      expect(await montar(g).ctl.situacao({ convite: ruim })).toEqual({ modo: 'LISTA_ESPERA', convite: 'INVALIDO', ...nulo });
      expect(g.ops()).toEqual(['globalSetting.findMany']);
    }
  });

  it('leitura das chaves falhou: lista de espera (e o convite não é lido)', async () => {
    const g = banco({ convite: conviteValendo() }, { 'globalSetting.findMany': () => { throw new Error('banco fora'); } });
    expect(await montar(g).ctl.situacao({ convite: CODIGO })).toEqual({ modo: 'LISTA_ESPERA', convite: 'INVALIDO', ...nulo });
    const g2 = banco({}, { 'globalSetting.findMany': () => { throw new Error('banco fora'); } });
    expect(await montar(g2).ctl.situacao({})).toEqual({ modo: 'LISTA_ESPERA', convite: 'AUSENTE', ...nulo });
    expect(g.ops()).toEqual(['globalSetting.findMany']);
  });

  it('a resposta nunca traz id, validade nem hash do convite', async () => {
    const g = banco({ convite: { ...conviteValendo(), token_hash: hashDoCodigo(CODIGO) } });
    const r = await montar(g).ctl.situacao({ convite: CODIGO });
    expect(JSON.stringify(r)).not.toContain(CONVITE_ID);
    expect(JSON.stringify(r)).not.toContain(hashDoCodigo(CODIGO));
    expect(JSON.stringify(r)).not.toContain(CONVIDOU);
  });
});

describe('DTOs (ValidationPipe da API: whitelist + forbidNonWhitelisted + transform)', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const meta = (metatype: any) => ({ type: 'body' as const, metatype, data: '' });
  // O /cadastrar manda o e-mail já aparado e em minúsculas.
  const valido = corpo({ admin_email: 'ana@lab.teste', lab_cro_inscricao: 'CRO-AL TPD 1', rt_name: 'Fulano', rt_cro: 'CRO-AL 2', convite: 'x', website: '' });

  it('cadastro: aceita o corpo do /cadastrar', async () => {
    await expect(pipe.transform(valido, meta(CadastroLaboratorioDto))).resolves.toBeInstanceOf(CadastroLaboratorioDto);
  });

  it.each([
    [{ plan: 'PRO' }],
    [{ status: 'ACTIVE' }],
    [{ business_type: 'LABORATORIO' }],
    [{ tenant_id: LAB }],
    [{ admin_email: 'nao-e-email' }],
    [{ admin_password: '1234567' }],
    [{ admin_password: 'x'.repeat(129) }],
    [{ lab_name: 'x'.repeat(121) }],
    [{ convite: 'x'.repeat(129) }],
    [{ cpf_cnpj: 123 }],
  ])('cadastro: recusa %j', async (extra) => {
    await expect(pipe.transform({ ...valido, ...extra }, meta(CadastroLaboratorioDto))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cadastro: sem documento ou sem WhatsApp → 400', async () => {
    const { cpf_cnpj: _d, ...semDoc } = valido;
    const { phone: _p, ...semFone } = valido;
    await expect(pipe.transform(semDoc, meta(CadastroLaboratorioDto))).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform(semFone, meta(CadastroLaboratorioDto))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('situação: só o convite (texto até 128)', async () => {
    await expect(pipe.transform({}, meta(SituacaoCadastroLabDto))).resolves.toBeInstanceOf(SituacaoCadastroLabDto);
    await expect(pipe.transform({ convite: 'abc' }, meta(SituacaoCadastroLabDto))).resolves.toBeInstanceOf(SituacaoCadastroLabDto);
    for (const ruim of [{ convite: 1 }, { convite: 'x'.repeat(129) }, { outro: 'x' }]) {
      await expect(pipe.transform(ruim, meta(SituacaoCadastroLabDto))).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});

describe('rotas: públicas com limite por visitante; as da plataforma só do SUPER_ADMIN', () => {
  const limite = (fn: any) => {
    const k = Reflect.getMetadataKeys(fn).map(String);
    return {
      limit: Reflect.getMetadata(k.find((x) => x.startsWith('THROTTLER:LIMIT'))!, fn),
      ttl: Reflect.getMetadata(k.find((x) => x.startsWith('THROTTLER:TTL'))!, fn),
      tracker: Reflect.getMetadata(k.find((x) => x.startsWith('THROTTLER:TRACKER'))!, fn),
    };
  };

  it('cadastrar (5/min) e situacao (20/min): públicas, 200, por quemEnvia', () => {
    const p = CadastroLaboratorioController.prototype;
    for (const [fn, n] of [[p.cadastrar, 5], [p.situacao, 20]] as const) {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, fn)).toBe(true);
      expect(Reflect.getMetadata(IS_SUPER_ADMIN_KEY, fn)).toBeUndefined();
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, fn)).toBe(200);
      expect(limite(fn)).toEqual({ limit: n, ttl: 60000, tracker: quemEnvia });
    }
  });

  it('os 5 handlers da plataforma: SUPER_ADMIN e nunca públicos', () => {
    const p = CadastroLaboratorioPlataformaController.prototype;
    for (const fn of [p.lerChave, p.definirChave, p.listarConvites, p.criarConvite, p.revogarConvite]) {
      expect(Reflect.getMetadata(IS_SUPER_ADMIN_KEY, fn)).toBe(true);
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, fn)).toBeUndefined();
    }
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, p.revogarConvite)).toBe(200);
    expect(Reflect.getMetadata(PATH_METADATA, CadastroLaboratorioPlataformaController)).toBe('plataforma/cadastro-laboratorio');
  });

  it('os 2 controllers são negados à conta de laboratório', () => {
    expect(CONTROLLERS_SO_DE_CLINICA.has('CadastroLaboratorioController')).toBe(true);
    expect(CONTROLLERS_SO_DE_CLINICA.has('CadastroLaboratorioPlataformaController')).toBe(true);
  });

  it('o controller repassa o corpo e o convite ao service', async () => {
    const svc: any = { situacao: jest.fn(async () => ({})), cadastrar: jest.fn(async () => ({ ok: true })) };
    const ctl = new CadastroLaboratorioController(svc);
    await ctl.situacao({ convite: 'abc' });
    await ctl.situacao({});
    const body = corpo() as any;
    await ctl.cadastrar(body, { headers: { 'cf-connecting-ip': '203.0.113.7' } });
    expect(svc.situacao.mock.calls).toEqual([['abc'], [undefined]]);
    expect(svc.cadastrar.mock.calls[0][0]).toBe(body);
    expect(svc.cadastrar.mock.calls[0][1]).toEqual({ ip: '203.0.113.7', user_agent: null });
  });
});
