/**
 * Link de aceite on-line do orçamento de trabalho (proposta-online-laboratorio.ts).
 *
 * Sem banco: o Prisma é um dublê; dados de exemplo (repositório público).
 * Confere: o token só abre o orçamento que o gerou e só em conta de laboratório; a
 * página recebe um conjunto fechado de campos (nunca o paciente do caso, documento nem
 * telefone); o aceite exige nome, respeita situação e validade e deixa rastro.
 */
import { BadRequestException, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { temPalavraDeClinica } from '../business-type/lab-vocab.interceptor';
import { PortalAuthService } from '../portal/portal-auth.service';
import { quemEnvia } from '../tenants/lab-waitlist.controller';
import { LAB_PROPOSTA_ONLINE } from './lab-proposta-online-textos';
import { PropostaOnlineLaboratorioController } from './proposta-online-laboratorio.controller';
import { aceitarPropostaPublica, criarLinkDaProposta, verPropostaPublica } from './proposta-online-laboratorio';

const LAB = 'tenant-lab-exemplo';
const CLINICA = 'tenant-clinica-exemplo';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

beforeEach(() => {
  __limparCacheLabTenants();
  for (const nivel of ['log', 'warn', 'debug', 'error', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
  }
});
afterEach(() => jest.restoreAllMocks());

function orcamento(over: Record<string, any> = {}) {
  return {
    id: 'orc-1',
    patient_id: 'cli-1',
    quote_number: 42,
    status: 'SENT',
    created_at: new Date('2026-01-10T12:00:00.000Z'),
    valid_until: new Date('2099-01-15T15:00:00.000Z'),
    deleted_at: null,
    archived_at: null,
    subtotal: 900,
    discount_percent: 10,
    discount_value: 90,
    total_value: 810,
    payment_terms: 'Boleto em 3x',
    notes: 'Entrega em 7 dias úteis',
    patient: { name: 'Clínica Parceira Exemplo', tenant_id: LAB },
    items: [
      { procedure_id: 'serv-1', quantity: 2, unit_price: 450, total_price: 900, tooth_fdi: '11', notes: null, procedure: { name: 'Coroa de zircônia' } },
    ],
    ...over,
  };
}

function montar(opts: { conta?: string; labs?: string[]; token?: Record<string, any> | null; quote?: any; aceitos?: any[]; casos?: any[] } = {}) {
  const conta = opts.conta ?? LAB;
  const labs = opts.labs ?? [LAB];
  const linha =
    opts.token === null
      ? null
      : { id: 'tk-1', tenant_id: conta, patient_id: 'cli-1', expires_at: new Date('2099-01-01T00:00:00Z'), channel: 'LAB_PROPOSTA:orc-1', ...(opts.token ?? {}) };
  const prisma: any = {
    tenantBusinessProfile: { findMany: jest.fn(async () => labs.map((tenant_id) => ({ tenant_id }))) },
    portalToken: {
      findUnique: jest.fn(async () => linha),
      findFirst: jest.fn(async () => null),
      create: jest.fn(async (a: any) => ({ id: 'tk-2', ...a.data })),
      update: jest.fn(async () => ({})),
    },
    quote: {
      findFirst: jest.fn(async () => (opts.quote === undefined ? orcamento() : opts.quote)),
      findMany: jest.fn(async () => opts.aceitos ?? []),
      update: jest.fn(async () => ({})),
    },
    quoteLabCase: { findMany: jest.fn(async () => opts.casos ?? []) },
    tenant: { findUnique: jest.fn(async () => ({ name: 'Laboratório Exemplo', logo_url: null, status: 'ACTIVE' })) },
    globalSetting: { findMany: jest.fn(async () => []) },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  return prisma;
}

describe('link de aceite do orçamento de trabalho', () => {
  it('o reenvio renova a validade do link por mais 30 dias a partir de agora', async () => {
    const prisma = montar();
    prisma.portalToken.findFirst.mockResolvedValue({ id: 'tk-1', token: TOKEN });
    const antes = Date.now();
    await criarLinkDaProposta(prisma, LAB, { id: 'orc-1', patient_id: 'cli-1' });
    const { where, data } = prisma.portalToken.update.mock.calls[0][0];
    expect(where).toEqual({ id: 'tk-1' });
    const trintaDias = 30 * 86_400_000;
    expect(data.expires_at.getTime()).toBeGreaterThanOrEqual(antes + trintaDias);
    expect(data.expires_at.getTime()).toBeLessThanOrEqual(Date.now() + trintaDias);
    expect(prisma.portalToken.create).not.toHaveBeenCalled();
  });

  it('cria o token ligado ao orçamento e à conta; o reenvio reaproveita o que ainda vale', async () => {
    const prisma = montar();
    const link = await criarLinkDaProposta(prisma, LAB, { id: 'orc-1', patient_id: 'cli-1' });
    expect(link).toMatch(/\/proposta\/[\w-]{40,}$/);
    expect(prisma.portalToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenant_id: LAB, patient_id: 'cli-1', channel: 'LAB_PROPOSTA:orc-1' }),
    });

    prisma.portalToken.create.mockClear();
    prisma.portalToken.findFirst.mockResolvedValue({ token: TOKEN });
    expect(await criarLinkDaProposta(prisma, LAB, { id: 'orc-1', patient_id: 'cli-1' })).toMatch(new RegExp(`/proposta/${TOKEN}$`));
    expect(prisma.portalToken.create).not.toHaveBeenCalled();
    // A busca do token vigente é pela conta, pelo cliente e pelo orçamento.
    expect(prisma.portalToken.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenant_id: LAB, patient_id: 'cli-1', channel: 'LAB_PROPOSTA:orc-1' }) }),
    );
  });

  it('a página recebe só o conjunto fechado de campos, no vocabulário do laboratório', async () => {
    const prisma = montar();
    const r: any = await verPropostaPublica(prisma, TOKEN);
    expect(r).toMatchObject({
      laboratorio: { nome: 'Laboratório Exemplo', logo: null },
      cliente: 'Clínica Parceira Exemplo',
      numero: '42',
      situacao: 'ABERTO',
      pode_aceitar: true,
      total: 810,
      desconto: 90,
      condicoes: 'Boleto em 3x',
    });
    expect(r.servicos).toEqual([
      { nome: 'Coroa de zircônia', elemento: '11', quantidade: 2, unitario: 450, total: 900, observacao: null },
    ]);
    // Nada do caso, do cadastro nem de contato.
    const texto = JSON.stringify(r);
    expect(texto).not.toMatch(/patient_ref|lab_case|cpf|phone|telefone|email/i);
    // O select pedido ao banco também não toca o caso.
    const pedido = JSON.stringify(prisma.quote.findFirst.mock.calls[0][0]);
    expect(pedido).not.toMatch(/patient_ref|lab_case|quoteLabCase|cpf|phone|email/i);
    // A consulta é pela conta e pelo cliente do token.
    expect(prisma.quote.findFirst.mock.calls[0][0].where).toEqual({
      id: 'orc-1',
      patient_id: 'cli-1',
      patient: { tenant_id: LAB },
    });
    expect(prisma.quote.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ portal_view_count: { increment: 1 } }) }),
    );
  });

  it.each([
    ['token que não existe', { token: null }],
    ['token de outro tipo (link da clínica)', { token: { channel: 'WHATSAPP' } }],
    ['token vencido', { token: { expires_at: new Date('2020-01-01T00:00:00Z') } }],
    ['conta de clínica', { conta: CLINICA, labs: [LAB] }],
    ['orçamento que não é da conta do token', { quote: null }],
    ['orçamento apagado', { quote: orcamento({ deleted_at: new Date('2026-01-01T00:00:00Z') }) }],
    ['orçamento recusado ou revisado', { quote: orcamento({ status: 'REJECTED' }) }],
  ])('%s: 404 igual, sem revelar o motivo', async (_n, opts) => {
    const prisma = montar(opts as any);
    const e = await verPropostaPublica(prisma, TOKEN).catch((x) => x);
    expect(e).toBeInstanceOf(NotFoundException);
    expect(e.message).toBe(LAB_PROPOSTA_ONLINE.linkInvalido);
    const a = await aceitarPropostaPublica({ prisma, aceitar: jest.fn(), logger: new Logger('t') }, TOKEN, { nome: 'Fulano de Tal' }).catch((x) => x);
    expect(a).toBeInstanceOf(NotFoundException);
  });

  it('token curto demais não chega ao banco', async () => {
    const prisma = montar();
    await expect(verPropostaPublica(prisma, 'curto')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.portalToken.findUnique).not.toHaveBeenCalled();
  });

  it('orçamento apagado ou recusado: a resposta não traz valores', async () => {
    for (const quote of [orcamento({ deleted_at: new Date() }), orcamento({ status: 'REJECTED' })]) {
      const prisma = montar({ quote });
      const e = await verPropostaPublica(prisma, TOKEN).catch((x) => x);
      expect(JSON.stringify(e.getResponse())).not.toMatch(/810|900|Coroa/);
      expect(prisma.quote.update).not.toHaveBeenCalled();
    }
  });

  it('situação: vencido, aceito e encerrado não aceitam', async () => {
    const vencido = await verPropostaPublica(montar({ quote: orcamento({ valid_until: new Date('2020-01-01T15:00:00Z') }) }), TOKEN);
    expect(vencido).toMatchObject({ situacao: 'VENCIDO', pode_aceitar: false });
    const aceito = await verPropostaPublica(montar({ quote: orcamento({ status: 'ACCEPTED' }) }), TOKEN);
    expect(aceito).toMatchObject({ situacao: 'ACEITO', pode_aceitar: false });
    const arquivado = await verPropostaPublica(montar({ quote: orcamento({ archived_at: new Date() }) }), TOKEN);
    expect(arquivado).toMatchObject({ situacao: 'ENCERRADO', pode_aceitar: false });
  });

  it('aceite: exige o nome; aceita pelo mesmo caminho da equipe e deixa rastro', async () => {
    const prisma = montar();
    const aceitar = jest.fn(async () => ({}));
    const deps = { prisma, aceitar, logger: new Logger('t') };

    const semNome = await aceitarPropostaPublica(deps, TOKEN, { nome: ' a ' }).catch((x) => x);
    expect(semNome).toBeInstanceOf(BadRequestException);
    expect(semNome.message).toBe(LAB_PROPOSTA_ONLINE.nomeObrigatorio);
    expect(aceitar).not.toHaveBeenCalled();

    const r = await aceitarPropostaPublica(deps, TOKEN, { nome: '  Fulano   de Tal ', ip: '203.0.113.9', userAgent: 'agente-exemplo' });
    expect(r).toEqual({ ok: true, situacao: 'ACEITO' });
    expect(aceitar).toHaveBeenCalledWith('orc-1', LAB);
    const auditoria = prisma.auditLog.create.mock.calls[0][0].data;
    expect(auditoria).toMatchObject({ tenant_id: LAB, entity: 'QUOTE', entity_id: 'orc-1', action: 'ACEITE_ONLINE' });
    expect(JSON.stringify(auditoria)).toContain('Fulano de Tal');
  });

  it('aceite: já aceito, vencido ou encerrado recusa sem aceitar; falha do aceite vira mensagem clara', async () => {
    const aceitar = jest.fn(async () => ({}));
    const logger = new Logger('t');
    const ja = await aceitarPropostaPublica({ prisma: montar({ quote: orcamento({ status: 'ACCEPTED' }) }), aceitar, logger }, TOKEN, { nome: 'Fulano de Tal' }).catch((x) => x);
    expect(ja.message).toBe(LAB_PROPOSTA_ONLINE.jaAceita);
    const venc = await aceitarPropostaPublica({ prisma: montar({ quote: orcamento({ valid_until: new Date('2020-01-01T15:00:00Z') }) }), aceitar, logger }, TOKEN, { nome: 'Fulano de Tal' }).catch((x) => x);
    expect(venc.message).toBe(LAB_PROPOSTA_ONLINE.vencida);
    const enc = await aceitarPropostaPublica({ prisma: montar({ quote: orcamento({ archived_at: new Date() }) }), aceitar, logger }, TOKEN, { nome: 'Fulano de Tal' }).catch((x) => x);
    expect(enc.message).toBe(LAB_PROPOSTA_ONLINE.encerrada);
    expect(aceitar).not.toHaveBeenCalled();

    const prisma = montar();
    const falha = await aceitarPropostaPublica({ prisma, aceitar: async () => { throw new Error('plano duplicado'); }, logger }, TOKEN, { nome: 'Fulano de Tal' }).catch((x) => x);
    expect(falha.message).toBe(LAB_PROPOSTA_ONLINE.erroAceite);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  describe('opções do mesmo orçamento', () => {
    const mesmaOpcao = { id: 'orc-2', items: [{ procedure_id: 'serv-1', tooth_fdi: '11', quantity: 2 }] };
    const logger = new Logger('t');
    const tentar = (prisma: any, aceitar: any) => aceitarPropostaPublica({ prisma, aceitar, logger }, TOKEN, { nome: 'Fulano de Tal' }).catch((x) => x);

    it('aceita uma, a outra deixa de aceitar: mensagem clara, sem segundo plano nem segundo rastro', async () => {
      const prisma = montar({ aceitos: [mesmaOpcao] });
      const aceitar = jest.fn(async () => ({}));
      const e = await tentar(prisma, aceitar);
      expect(e).toBeInstanceOf(BadRequestException);
      expect(e.message).toBe(LAB_PROPOSTA_ONLINE.outraOpcaoAceita);
      expect(aceitar).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      expect(await verPropostaPublica(prisma, TOKEN)).toMatchObject({ situacao: 'ENCERRADO', pode_aceitar: false });
    });

    it('a busca é do mesmo cliente, aceito depois que este orçamento já existia', async () => {
      const prisma = montar();
      await tentar(prisma, jest.fn(async () => ({})));
      expect(prisma.quote.findMany.mock.calls[0][0].where).toEqual({
        patient_id: 'cli-1',
        id: { not: 'orc-1' },
        status: 'ACCEPTED',
        deleted_at: null,
        accepted_at: { gte: new Date('2026-01-10T12:00:00.000Z') },
      });
    });

    it('a ordem dos serviços não importa', async () => {
      const quote = orcamento({
        items: [
          { procedure_id: 'serv-1', tooth_fdi: '11', quantity: 1 },
          { procedure_id: 'serv-2', tooth_fdi: null, quantity: 1 },
        ],
      });
      const aceito = { id: 'orc-2', items: [{ procedure_id: 'serv-2', tooth_fdi: null, quantity: 1 }, { procedure_id: 'serv-1', tooth_fdi: '11', quantity: 1 }] };
      expect((await tentar(montar({ quote, aceitos: [aceito] }), jest.fn())).message).toBe(LAB_PROPOSTA_ONLINE.outraOpcaoAceita);
    });

    it.each([
      ['serviços diferentes', { aceitos: [{ id: 'orc-2', items: [{ procedure_id: 'serv-9', tooth_fdi: '11', quantity: 2 }] }] }],
      ['outro elemento', { aceitos: [{ id: 'orc-2', items: [{ procedure_id: 'serv-1', tooth_fdi: '21', quantity: 2 }] }] }],
      [
        'mesmos serviços, fichas de caso com referências diferentes',
        { aceitos: [mesmaOpcao], casos: [{ quote_id: 'orc-1', patient_ref: 'Caso A' }, { quote_id: 'orc-2', patient_ref: 'Caso B' }] },
      ],
    ])('%s: é outro trabalho, o aceite segue', async (_n, opts) => {
      const aceitar = jest.fn(async () => ({}));
      const r = await tentar(montar(opts as any), aceitar);
      expect(r).toEqual({ ok: true, situacao: 'ACEITO' });
      expect(aceitar).toHaveBeenCalledTimes(1);
    });

    it('fichas com a mesma referência ou só uma preenchida: continua sendo opção', async () => {
      for (const casos of [
        [{ quote_id: 'orc-1', patient_ref: ' caso a ' }, { quote_id: 'orc-2', patient_ref: 'Caso A' }],
        [{ quote_id: 'orc-2', patient_ref: 'Caso A' }],
      ]) {
        expect((await tentar(montar({ aceitos: [mesmaOpcao], casos }), jest.fn())).message).toBe(LAB_PROPOSTA_ONLINE.outraOpcaoAceita);
      }
    });
  });

  describe('rota pública', () => {
    const proto = PropostaOnlineLaboratorioController.prototype;

    it.each([
      ['ver', proto.ver, 30],
      ['aceitar', proto.aceitar, 10],
    ])('%s: limite por visitante, pelo IP de verdade', (_n, rota, limite) => {
      const chaves = Reflect.getMetadataKeys(rota).map(String);
      expect(Reflect.getMetadata(chaves.find((k) => k.startsWith('THROTTLER:LIMIT'))!, rota)).toBe(limite);
      expect(Reflect.getMetadata(chaves.find((k) => k.startsWith('THROTTLER:TRACKER'))!, rota)).toBe(quemEnvia);
    });

    it('grava o IP que o Cloudflare passa, não o do proxy', async () => {
      const prisma = montar();
      const quotes: any = { accept: jest.fn(async () => ({})) };
      const ctl = new PropostaOnlineLaboratorioController(prisma, quotes);
      await ctl.aceitar(TOKEN, { nome: 'Fulano de Tal' }, {
        ip: '10.0.0.2',
        headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '10.0.0.2', 'user-agent': 'agente-exemplo' },
      });
      const meta = prisma.auditLog.create.mock.calls[0][0].data;
      expect(JSON.stringify(meta)).toContain('203.0.113.9');
      expect(JSON.stringify(meta)).not.toContain('10.0.0.2');
      expect(JSON.stringify(meta)).toContain('agente-exemplo');
    });
  });

  describe('troca do token por sessão do portal', () => {
    function portal(canal: string) {
      const prisma: any = {
        tenantBusinessProfile: { findMany: jest.fn(async () => []) },
        portalToken: {
          findUnique: jest.fn(async () => ({
            id: 'tk-1',
            channel: canal,
            consumed_at: null,
            expires_at: new Date('2099-01-01T00:00:00Z'),
            patient: { id: 'cli-1', name: 'Cliente Exemplo', tenant_id: LAB, status: 'ACTIVE' },
          })),
          update: jest.fn(async () => ({})),
        },
      };
      const jwt: any = { signAsync: jest.fn(async () => 'jwt-exemplo') };
      return { prisma, jwt, svc: new PortalAuthService(prisma, jwt, {} as any) };
    }

    it('link de aceite é recusado direto, mesmo com a lista de laboratórios vazia: não consome nem assina', async () => {
      const { svc, prisma, jwt } = portal('LAB_PROPOSTA:orc-1');
      await expect(svc.exchangeToken(TOKEN)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.portalToken.update).not.toHaveBeenCalled();
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    it('link de outro canal segue como sempre', async () => {
      const { svc, jwt } = portal('WHATSAPP');
      await expect(svc.exchangeToken(TOKEN)).resolves.toMatchObject({ jwt: 'jwt-exemplo' });
      expect(jwt.signAsync).toHaveBeenCalledTimes(1);
    });
  });

  it('os textos do servidor não têm vocabulário de clínica', () => {
    const textos = [
      ...(Object.values(LAB_PROPOSTA_ONLINE) as unknown[]).filter((v): v is string => typeof v === 'string'),
      LAB_PROPOSTA_ONLINE.descricaoDoAceite('42'),
    ] as string[];
    for (const t of textos) expect(temPalavraDeClinica(t)).toBe(false);
  });
});
