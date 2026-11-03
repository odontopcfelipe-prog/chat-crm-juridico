/**
 * F11 do laboratório — convites do cadastro de laboratório e a chave do cadastro
 * aberto (LAB_SIGNUP_ENABLED), só do SUPER_ADMIN.
 *
 * O código do convite sai UMA vez (na resposta do criar); o banco guarda só o
 * sha256 e nenhum log, auditoria ou listagem leva o código, o hash ou o e-mail.
 */
import { BadRequestException, ConflictException, ForbiddenException, Logger, NotFoundException, ValidationPipe } from '@nestjs/common';
import { createHash } from 'crypto';
import { eGlobalDaPlataforma } from '@crm/shared';
import { publicWebUrl } from '../common/mail/mail.service';
import { SettingsController } from '../settings/settings.controller';
import { isClinicScopedSettingKey } from '../settings/settings-scope';
import {
  CadastroLaboratorioPlataformaController,
  ChaveCadastroLaboratorioDto,
  NovoConviteLaboratorioDto,
} from './cadastro-laboratorio.controller';
import { LAB_CONVITE_MSG } from './cadastro-laboratorio.textos';
import {
  CHAVE_CADASTRO_LABORATORIO,
  codigoNoFormato,
  gerarCodigoConvite,
  hashDoCodigo,
  linkDoConvite,
  situacaoDoConvite,
} from './convite-laboratorio';
import { ConvitesLaboratorioService } from './convites-laboratorio.service';

const AGORA = new Date('2026-11-02T15:00:00.000Z');
const DIA = 24 * 3600_000;
const SUPER = '00000000-0000-4000-8000-0000000f1150';
const CONVITE = '00000000-0000-4000-8000-0000000f11c1';
const INSCRICAO = '00000000-0000-4000-8000-0000000f11e1';
const CONTA = '00000000-0000-4000-8000-0000000f1101';

interface Chamada {
  op: string;
  args: any;
}

/** Prisma de teste que grava as chamadas (transação marcada por `tx.`). */
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

/** O que o banco devolve depois do create (as colunas do select). */
const linhaCriada = (a: any) => ({
  id: CONVITE,
  email: a.data.email,
  lab_name: a.data.lab_name,
  waitlist_entry_id: a.data.waitlist_entry_id,
  created_by_user_id: a.data.created_by_user_id,
  created_at: AGORA,
  expires_at: a.data.expires_at,
  used_at: null,
  revoked_at: null,
  tenant_id: null,
});

const COLUNAS_DO_ITEM = [
  'id', 'email', 'lab_name', 'waitlist_entry_id', 'created_by_user_id', 'criado_por_nome', 'created_at',
  'expires_at', 'used_at', 'revoked_at', 'tenant_id', 'tenant_nome', 'situacao',
];

function bancoDoCriar(extra: Record<string, (args: any) => any> = {}) {
  return gravador({
    'labSignupInvite.create': linhaCriada,
    'labSignupInvite.updateMany': () => ({ count: 0 }),
    'labSignupInvite.findFirst': () => null,
    'auditLog.create': () => ({}),
    'user.findMany': () => [{ id: SUPER, name: 'Dono da Plataforma' }],
    ...extra,
  });
}

const logs = () =>
  JSON.stringify(
    (['log', 'warn', 'debug', 'error'] as const).map((m) => (Logger.prototype[m] as unknown as jest.Mock).mock.calls),
  );

beforeAll(() => {
  for (const m of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  }
});

let urlAntes: string | undefined;
beforeAll(() => {
  urlAntes = process.env.PUBLIC_WEB_URL;
  process.env.PUBLIC_WEB_URL = 'https://clinica.teste/';
});
afterAll(() => {
  if (urlAntes === undefined) delete process.env.PUBLIC_WEB_URL;
  else process.env.PUBLIC_WEB_URL = urlAntes;
});

beforeEach(() => {
  jest.clearAllMocks();
  // Só o relógio fica parado; promessas seguem reais.
  jest.useFakeTimers({
    now: AGORA,
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
});
afterEach(() => jest.useRealTimers());

describe('código do convite', () => {
  it('32 caracteres [A-Za-z0-9_-], um diferente a cada vez, e o hash é o sha256 hex', () => {
    const vistos = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { codigo, token_hash } = gerarCodigoConvite();
      expect(codigo).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(codigoNoFormato(codigo)).toBe(true);
      expect(token_hash).toBe(createHash('sha256').update(codigo, 'utf8').digest('hex'));
      expect(hashDoCodigo(codigo)).toBe(token_hash);
      expect(token_hash).not.toContain(codigo);
      vistos.add(codigo);
    }
    expect(vistos.size).toBe(50);
  });

  it('fora do formato: 31/33 caracteres, +, /, espaço e o que não é texto', () => {
    const { codigo } = gerarCodigoConvite();
    for (const ruim of [codigo.slice(1), `${codigo}A`, `${codigo.slice(1)}+`, `${codigo.slice(1)}/`, `${codigo.slice(1)} `, '', 123, null, undefined, {}]) {
      expect(codigoNoFormato(ruim)).toBe(false);
    }
  });

  it('situação: USADO > REVOGADO > VENCIDO (vence quando expires_at <= agora) > VALIDO', () => {
    const futuro = new Date(AGORA.getTime() + DIA);
    expect(situacaoDoConvite({ expires_at: futuro }, AGORA)).toBe('VALIDO');
    expect(situacaoDoConvite({ expires_at: AGORA }, AGORA)).toBe('VENCIDO');
    expect(situacaoDoConvite({ expires_at: futuro, revoked_at: AGORA }, AGORA)).toBe('REVOGADO');
    expect(situacaoDoConvite({ expires_at: AGORA, revoked_at: AGORA }, AGORA)).toBe('REVOGADO');
    expect(situacaoDoConvite({ expires_at: AGORA, revoked_at: AGORA, used_at: AGORA }, AGORA)).toBe('USADO');
  });

  it('link: endereço público do web + /cadastrar?tipo=laboratorio&convite=', () => {
    const { codigo } = gerarCodigoConvite();
    expect(linkDoConvite(codigo)).toBe(`${publicWebUrl()}/cadastrar?tipo=laboratorio&convite=${codigo}`);
    expect(linkDoConvite(codigo)).toBe(`https://clinica.teste/cadastrar?tipo=laboratorio&convite=${codigo}`);
  });
});

describe('criar convite avulso', () => {
  it('o banco guarda só o hash; a resposta traz o código e o link uma vez', async () => {
    const g = bancoDoCriar();
    const r = await new ConvitesLaboratorioService(g.prisma).criar({}, SUPER);

    expect(g.ops()).toEqual(['$transaction', 'tx.labSignupInvite.create', 'tx.auditLog.create', '$transaction:fim', 'user.findMany']);
    const [criar] = g.de('tx.labSignupInvite.create');
    expect(criar.data).toEqual({
      token_hash: hashDoCodigo(r.codigo),
      email: null,
      lab_name: null,
      waitlist_entry_id: null,
      created_by_user_id: SUPER,
      expires_at: new Date(AGORA.getTime() + 14 * DIA),
    });
    expect(Object.keys(criar.select)).not.toContain('token_hash');
    expect(JSON.stringify(g.chamadas)).not.toContain(r.codigo);

    expect(Object.keys(r).sort()).toEqual(['codigo', 'convite', 'link']);
    expect(r.codigo).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(r.link).toBe(`${publicWebUrl()}/cadastrar?tipo=laboratorio&convite=${r.codigo}`);
    expect(Object.keys(r.convite)).toEqual(COLUNAS_DO_ITEM);
    expect(r.convite).toMatchObject({ id: CONVITE, situacao: 'VALIDO', criado_por_nome: 'Dono da Plataforma', tenant_nome: null, used_at: null });
  });

  it('validade de N dias', async () => {
    const g = bancoDoCriar();
    await new ConvitesLaboratorioService(g.prisma).criar({ dias: 30 }, SUPER);
    expect(g.de('tx.labSignupInvite.create')[0].data.expires_at).toEqual(new Date(AGORA.getTime() + 30 * DIA));
  });

  it.each([0, 61, 1.5, '10', -1])('validade %p → 400 sem gravar', async (dias) => {
    const g = bancoDoCriar();
    const erro = await new ConvitesLaboratorioService(g.prisma).criar({ dias: dias as any }, SUPER).catch((e) => e);
    expect(erro).toBeInstanceOf(BadRequestException);
    expect(erro.message).toBe(LAB_CONVITE_MSG.validade);
    expect(g.chamadas).toEqual([]);
  });

  it('auditoria PLATAFORMA sem código, hash nem e-mail; o log também não', async () => {
    const g = bancoDoCriar();
    const r = await new ConvitesLaboratorioService(g.prisma).criar({ email: ' Contato@Lab.Teste ', lab_name: '  Lab   Novo ' }, SUPER);
    const hash = hashDoCodigo(r.codigo);

    expect(g.de('tx.labSignupInvite.create')[0].data).toMatchObject({ email: 'contato@lab.teste', lab_name: 'Lab Novo' });
    const [audit] = g.de('tx.auditLog.create');
    expect(audit.data).toEqual({
      tenant_id: null,
      actor_user_id: SUPER,
      entity: 'PLATAFORMA',
      entity_id: CONVITE,
      action: 'CONVITE_LABORATORIO_CRIADO',
      meta_json: {
        waitlist_entry_id: null,
        expires_at: new Date(AGORA.getTime() + 14 * DIA).toISOString(),
        revogados: 0,
        before: null,
        after: null,
      },
    });
    for (const segredo of [r.codigo, hash, 'contato@lab.teste']) {
      expect(JSON.stringify(audit)).not.toContain(segredo);
      expect(logs()).not.toContain(segredo);
    }
    expect(logs()).toContain(CONVITE);
  });
});

describe('criar convite a partir da inscrição da lista de espera', () => {
  const inscricao = { id: INSCRICAO, email: ' Contato@Lista.Teste ', lab_name: '  Lab   da Lista ' };

  it('preenche e-mail e nome com os da inscrição e revoga os válidos anteriores dela na mesma transação', async () => {
    const g = bancoDoCriar({
      'labWaitlistEntry.findUnique': () => inscricao,
      'labSignupInvite.updateMany': () => ({ count: 1 }),
    });
    await new ConvitesLaboratorioService(g.prisma).criar({ waitlist_entry_id: INSCRICAO }, SUPER);

    expect(g.ops()).toEqual([
      'labWaitlistEntry.findUnique',
      'labSignupInvite.findFirst',
      '$transaction',
      'tx.labSignupInvite.updateMany',
      'tx.labSignupInvite.create',
      'tx.auditLog.create',
      '$transaction:fim',
      'user.findMany',
    ]);
    expect(g.de('labWaitlistEntry.findUnique')).toEqual([{ where: { id: INSCRICAO }, select: { id: true, email: true, lab_name: true } }]);
    expect(g.de('labSignupInvite.findFirst')).toEqual([
      { where: { waitlist_entry_id: INSCRICAO, used_at: { not: null } }, select: { id: true } },
    ]);
    expect(g.de('tx.labSignupInvite.updateMany')).toEqual([
      {
        where: { waitlist_entry_id: INSCRICAO, used_at: null, revoked_at: null, expires_at: { gt: AGORA } },
        data: { revoked_at: AGORA },
      },
    ]);
    expect(g.de('tx.labSignupInvite.create')[0].data).toMatchObject({
      email: 'contato@lista.teste',
      lab_name: 'Lab da Lista',
      waitlist_entry_id: INSCRICAO,
    });
    expect(g.de('tx.auditLog.create')[0].data.meta_json).toMatchObject({ waitlist_entry_id: INSCRICAO, revogados: 1 });
  });

  it('o corpo vence o que veio da inscrição', async () => {
    const g = bancoDoCriar({ 'labWaitlistEntry.findUnique': () => inscricao });
    await new ConvitesLaboratorioService(g.prisma).criar(
      { waitlist_entry_id: INSCRICAO, email: 'outro@lab.teste', lab_name: 'Outro Nome' },
      SUPER,
    );
    expect(g.de('tx.labSignupInvite.create')[0].data).toMatchObject({ email: 'outro@lab.teste', lab_name: 'Outro Nome' });
  });

  it('inscrição inexistente: 404 e nada gravado', async () => {
    const g = bancoDoCriar({ 'labWaitlistEntry.findUnique': () => null });
    const erro = await new ConvitesLaboratorioService(g.prisma).criar({ waitlist_entry_id: INSCRICAO }, SUPER).catch((e) => e);
    expect(erro).toBeInstanceOf(NotFoundException);
    expect(erro.message).toBe(LAB_CONVITE_MSG.inscricaoNaoEncontrada);
    expect(g.ops()).toEqual(['labWaitlistEntry.findUnique']);
  });

  it('inscrição que já usou convite: 409 e nada gravado', async () => {
    const g = bancoDoCriar({ 'labWaitlistEntry.findUnique': () => inscricao, 'labSignupInvite.findFirst': () => ({ id: 'usado' }) });
    const erro = await new ConvitesLaboratorioService(g.prisma).criar({ waitlist_entry_id: INSCRICAO }, SUPER).catch((e) => e);
    expect(erro).toBeInstanceOf(ConflictException);
    expect(erro.message).toBe(LAB_CONVITE_MSG.inscricaoJaVirouConta);
    expect(g.ops()).not.toContain('$transaction');
  });
});

describe('listar convites', () => {
  const futuro = new Date(AGORA.getTime() + DIA);
  const base = { email: null, lab_name: 'Lab', waitlist_entry_id: null, created_by_user_id: SUPER, created_at: AGORA, used_at: null, revoked_at: null, tenant_id: null };
  const linhas = [
    { ...base, id: 'a', expires_at: futuro },
    { ...base, id: 'b', expires_at: AGORA },
    { ...base, id: 'c', expires_at: AGORA, used_at: AGORA, revoked_at: AGORA, tenant_id: CONTA },
    { ...base, id: 'd', expires_at: futuro, revoked_at: AGORA, created_by_user_id: null },
  ];

  it('até 500, do mais novo, sem token_hash; situação, nome da conta e de quem convidou', async () => {
    const g = gravador({
      'labSignupInvite.findMany': () => linhas,
      'tenant.findMany': () => [{ id: CONTA, name: 'Laboratório Criado' }],
      'user.findMany': () => [{ id: SUPER, name: 'Dono da Plataforma' }],
    });
    const r = await new ConvitesLaboratorioService(g.prisma).listar(AGORA);

    const [busca] = g.de('labSignupInvite.findMany');
    expect(busca.orderBy).toEqual({ created_at: 'desc' });
    expect(busca.take).toBe(500);
    expect(Object.keys(busca.select)).not.toContain('token_hash');
    expect(g.de('tenant.findMany')).toEqual([{ where: { id: { in: [CONTA] } }, select: { id: true, name: true } }]);
    expect(g.de('user.findMany')).toEqual([{ where: { id: { in: [SUPER] } }, select: { id: true, name: true } }]);

    expect(r.map((c) => c.situacao)).toEqual(['VALIDO', 'VENCIDO', 'USADO', 'REVOGADO']);
    for (const c of r) {
      expect(Object.keys(c)).toEqual(COLUNAS_DO_ITEM);
      expect(Object.keys(c)).not.toEqual(expect.arrayContaining(['token_hash']));
      expect(c).not.toHaveProperty('codigo');
      expect(c).not.toHaveProperty('link');
    }
    expect(r[2]).toMatchObject({ tenant_id: CONTA, tenant_nome: 'Laboratório Criado', criado_por_nome: 'Dono da Plataforma' });
    expect(r[3]).toMatchObject({ created_by_user_id: null, criado_por_nome: null, tenant_nome: null });
  });

  it('sem conta criada nem autor: não consulta tenant nem user', async () => {
    const g = gravador({ 'labSignupInvite.findMany': () => [{ ...base, id: 'a', expires_at: futuro, created_by_user_id: null }] });
    await new ConvitesLaboratorioService(g.prisma).listar(AGORA);
    expect(g.ops()).toEqual(['labSignupInvite.findMany']);
  });
});

describe('revogar convite', () => {
  const linha = (extra: Record<string, unknown> = {}) => ({
    id: CONVITE, email: null, lab_name: 'Lab', waitlist_entry_id: null, created_by_user_id: null, created_at: AGORA,
    expires_at: new Date(AGORA.getTime() + DIA), used_at: null, revoked_at: null, tenant_id: null, ...extra,
  });

  it('válido: grava revoked_at e a auditoria', async () => {
    const g = gravador({
      'labSignupInvite.updateMany': () => ({ count: 1 }),
      'labSignupInvite.findUnique': () => linha({ revoked_at: AGORA }),
      'auditLog.create': () => ({}),
    });
    const r = await new ConvitesLaboratorioService(g.prisma).revogar(CONVITE, SUPER);
    expect(g.de('labSignupInvite.updateMany')).toEqual([
      { where: { id: CONVITE, used_at: null, revoked_at: null }, data: { revoked_at: AGORA } },
    ]);
    expect(g.de('auditLog.create')).toHaveLength(1);
    expect(g.de('auditLog.create')[0].data).toMatchObject({
      tenant_id: null, actor_user_id: SUPER, entity: 'PLATAFORMA', entity_id: CONVITE, action: 'CONVITE_LABORATORIO_REVOGADO',
    });
    expect(r).toEqual({ convite: expect.objectContaining({ id: CONVITE, situacao: 'REVOGADO' }) });
  });

  it('já revogado: 200 com o convite e sem auditoria nova', async () => {
    const g = gravador({
      'labSignupInvite.updateMany': () => ({ count: 0 }),
      'labSignupInvite.findUnique': () => linha({ revoked_at: AGORA }),
    });
    const r = await new ConvitesLaboratorioService(g.prisma).revogar(CONVITE, SUPER);
    expect(r.convite.situacao).toBe('REVOGADO');
    expect(g.ops()).not.toContain('auditLog.create');
  });

  it('usado: 409', async () => {
    const g = gravador({
      'labSignupInvite.updateMany': () => ({ count: 0 }),
      'labSignupInvite.findUnique': () => linha({ used_at: AGORA, tenant_id: CONTA }),
    });
    const erro = await new ConvitesLaboratorioService(g.prisma).revogar(CONVITE, SUPER).catch((e) => e);
    expect(erro).toBeInstanceOf(ConflictException);
    expect(erro.message).toBe(LAB_CONVITE_MSG.conviteJaUsado);
    expect(g.ops()).not.toContain('auditLog.create');
  });

  it('inexistente: 404', async () => {
    const g = gravador({ 'labSignupInvite.updateMany': () => ({ count: 0 }) });
    const erro = await new ConvitesLaboratorioService(g.prisma).revogar(CONVITE, SUPER).catch((e) => e);
    expect(erro).toBeInstanceOf(NotFoundException);
    expect(erro.message).toBe(LAB_CONVITE_MSG.conviteNaoEncontrado);
  });
});

describe('chave do cadastro aberto (LAB_SIGNUP_ENABLED)', () => {
  function montarChave(mestra: string | null = null) {
    const prisma: any = {
      globalSetting: {
        upsert: jest.fn(async (a: any) => ({ key: a.where.key, value: a.create.value, updated_at: AGORA })),
        findUnique: jest.fn(async () => (mestra === null ? null : { key: 'CRIACAO_LABORATORIO_LIBERADA', value: mestra })),
        findMany: jest.fn(async () => []),
      },
      auditLog: { create: jest.fn(async () => ({})) },
    };
    return { prisma, svc: new ConvitesLaboratorioService(prisma) };
  }

  it('definir: grava true/false com auditoria PLATAFORMA; a resposta tem o formato do ler', async () => {
    const { prisma, svc } = montarChave();
    expect(await svc.definirChave(true, SUPER)).toEqual({ aberto: true, criacao_liberada: false, atualizado_em: AGORA });
    expect(prisma.globalSetting.upsert).toHaveBeenLastCalledWith({
      where: { key: 'LAB_SIGNUP_ENABLED' },
      create: { key: 'LAB_SIGNUP_ENABLED', value: 'true' },
      update: { value: 'true' },
    });
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
      tenant_id: null, actor_user_id: SUPER, entity: 'PLATAFORMA', entity_id: 'LAB_SIGNUP_ENABLED', action: 'CADASTRO_LABORATORIO_ABERTO',
    });

    expect(await svc.definirChave(false, SUPER)).toEqual({ aberto: false, criacao_liberada: false, atualizado_em: AGORA });
    expect(prisma.globalSetting.upsert.mock.calls[1][0].update).toEqual({ value: 'false' });
    expect(prisma.auditLog.create.mock.calls[1][0].data.action).toBe('CADASTRO_LABORATORIO_FECHADO');

    const comMestra = montarChave('true');
    expect((await comMestra.svc.definirChave(true, SUPER)).criacao_liberada).toBe(true);
  });

  it("valor que não é booleano ('true', 1, null, undefined) → 400 sem gravar", async () => {
    const { prisma, svc } = montarChave();
    for (const ruim of ['true', 1, null, undefined]) {
      const erro = await svc.definirChave(ruim, SUPER).catch((e) => e);
      expect(erro).toBeInstanceOf(BadRequestException);
      expect(erro.message).toBe(LAB_CONVITE_MSG.aberto);
    }
    expect(prisma.globalSetting.upsert).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("ler: sem a linha = fechado; só o texto exato 'true' liga", async () => {
    const casos: Array<[any[], { aberto: boolean; criacao_liberada: boolean; atualizado_em: Date | null }]> = [
      [[], { aberto: false, criacao_liberada: false, atualizado_em: null }],
      [[{ key: 'LAB_SIGNUP_ENABLED', value: 'TRUE', updated_at: AGORA }], { aberto: false, criacao_liberada: false, atualizado_em: AGORA }],
      [
        [
          { key: 'LAB_SIGNUP_ENABLED', value: 'true', updated_at: AGORA },
          { key: 'CRIACAO_LABORATORIO_LIBERADA', value: 'true', updated_at: AGORA },
        ],
        { aberto: true, criacao_liberada: true, atualizado_em: AGORA },
      ],
      [[{ key: 'CRIACAO_LABORATORIO_LIBERADA', value: 'true' }], { aberto: false, criacao_liberada: true, atualizado_em: null }],
    ];
    for (const [linhas, esperado] of casos) {
      const { prisma, svc } = montarChave();
      prisma.globalSetting.findMany.mockResolvedValueOnce(linhas);
      expect(await svc.lerChave()).toEqual(esperado);
      expect(prisma.globalSetting.findMany).toHaveBeenCalledWith({
        where: { key: { in: ['CRIACAO_LABORATORIO_LIBERADA', 'LAB_SIGNUP_ENABLED'] } },
      });
    }
  });

  it('ler com o banco fora: o erro sobe (a tela mostra "não foi possível ler")', async () => {
    const { prisma, svc } = montarChave();
    prisma.globalSetting.findMany.mockRejectedValueOnce(new Error('banco fora'));
    await expect(svc.lerChave()).rejects.toThrow('banco fora');
  });

  it('a chave não é de clínica nem global lida pela conta de laboratório; o ADMIN de clínica não grava pelo /settings', async () => {
    expect(CHAVE_CADASTRO_LABORATORIO).toBe('LAB_SIGNUP_ENABLED');
    expect(isClinicScopedSettingKey('LAB_SIGNUP_ENABLED')).toBe(false);
    expect(eGlobalDaPlataforma('LAB_SIGNUP_ENABLED')).toBe(false);

    const service: any = { upsert: jest.fn(async () => ({})) };
    const ctl = new SettingsController(service, {} as any, {} as any, {} as any, {} as any);
    const admin = { id: 'u-a', roles: ['ADMIN'], tenant_id: '0a0a0a0a-0000-4000-8000-00000000000a' };
    const erro = await ctl.upsert({ user: admin }, { key: 'LAB_SIGNUP_ENABLED', value: 'true' }).catch((e) => e);
    expect(erro).toBeInstanceOf(ForbiddenException);
    expect(erro.getResponse()).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(service.upsert).not.toHaveBeenCalled();
  });
});

describe('controller da plataforma e DTOs', () => {
  it('repassa o corpo, o id e quem pediu', async () => {
    const svc: any = {
      lerChave: jest.fn(async () => ({})),
      definirChave: jest.fn(async () => ({})),
      listar: jest.fn(async () => []),
      criar: jest.fn(async () => ({})),
      revogar: jest.fn(async () => ({})),
    };
    const ctl = new CadastroLaboratorioPlataformaController(svc);
    const req = { user: { id: SUPER, roles: ['SUPER_ADMIN'] } };
    await ctl.lerChave();
    await ctl.definirChave({ aberto: true }, req);
    await ctl.listarConvites();
    await ctl.criarConvite({ waitlist_entry_id: INSCRICAO }, req);
    await ctl.revogarConvite(CONVITE, req);
    await ctl.definirChave({ aberto: false }, {});
    expect(svc.lerChave).toHaveBeenCalledTimes(1);
    expect(svc.definirChave.mock.calls).toEqual([[true, SUPER], [false, null]]);
    expect(svc.listar).toHaveBeenCalledWith();
    expect(svc.criar).toHaveBeenCalledWith({ waitlist_entry_id: INSCRICAO }, SUPER);
    expect(svc.revogar).toHaveBeenCalledWith(CONVITE, SUPER);
  });

  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const meta = (metatype: any) => ({ type: 'body' as const, metatype, data: '' });

  it('novo convite: vazio e completo passam', async () => {
    await expect(pipe.transform({}, meta(NovoConviteLaboratorioDto))).resolves.toBeInstanceOf(NovoConviteLaboratorioDto);
    await expect(
      pipe.transform({ waitlist_entry_id: INSCRICAO, email: 'lab@lab.teste', lab_name: 'Lab', dias: 30 }, meta(NovoConviteLaboratorioDto)),
    ).resolves.toBeInstanceOf(NovoConviteLaboratorioDto);
  });

  it.each([
    [{ dias: 0 }],
    [{ dias: 61 }],
    [{ dias: 1.5 }],
    [{ waitlist_entry_id: 'abc' }],
    [{ email: '' }],
    [{ email: 'nao-e-email' }],
    [{ lab_name: 'x'.repeat(121) }],
    [{ codigo: 'x' }],
    [{ token_hash: 'x' }],
  ])('novo convite: recusa %j', async (corpo) => {
    await expect(pipe.transform(corpo, meta(NovoConviteLaboratorioDto))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('chave: só booleano', async () => {
    await expect(pipe.transform({ aberto: true }, meta(ChaveCadastroLaboratorioDto))).resolves.toBeInstanceOf(ChaveCadastroLaboratorioDto);
    for (const ruim of [{ aberto: 'true' }, {}, { aberto: 1 }, { aberto: true, outro: 1 }]) {
      await expect(pipe.transform(ruim, meta(ChaveCadastroLaboratorioDto))).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
