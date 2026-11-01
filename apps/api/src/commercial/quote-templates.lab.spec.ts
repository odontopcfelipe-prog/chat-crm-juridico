/**
 * F6 do laboratório — modelos de orçamento (QuoteTemplatesService), liberados ao
 * laboratório com uma regra a mais: o modelo só leva serviço da PRÓPRIA conta.
 *   - laboratório: criar/editar com serviço de outra conta = 400; aplicar o modelo copia
 *     só os itens com serviço da conta (order_index e totais seguem os copiados);
 *   - clínica: as mesmas operações de hoje (com e sem outra conta de laboratório), sem a
 *     leitura dos serviços.
 *
 * Sem banco: o Prisma é um gravador; dados de exemplo (repositório público).
 */
import { BadRequestException, Logger } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { QuoteTemplatesService } from './quote-templates.service';

const LAB = 'tenant-lab-exemplo';
const CLINICA = 'tenant-clinica-exemplo';

beforeEach(() => {
  __limparCacheLabTenants();
  for (const nivel of ['log', 'warn', 'debug', 'error', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
  }
});
afterEach(() => jest.restoreAllMocks());

type Op = [string, any];

/** Serviços: dois da conta e um de outra conta. */
function montar(conta: string, labs: string[]) {
  __limparCacheLabTenants();
  const ops: Op[] = [];
  const servicos = [
    { id: 'proc-da-conta-1', tenant_id: conta, base_price: 100 },
    { id: 'proc-da-conta-2', tenant_id: conta, base_price: 50 },
    { id: 'proc-de-outra-conta', tenant_id: 'tenant-outra-conta', base_price: 999 },
  ];
  const modelo = {
    id: 'tpl-1',
    tenant_id: conta,
    items: [
      { procedure_id: 'proc-da-conta-1', quantity: 1, unit_price: null, notes: null, procedure: { id: 'proc-da-conta-1', base_price: 100 } },
      { procedure_id: 'proc-de-outra-conta', quantity: 2, unit_price: null, notes: 'x', procedure: { id: 'proc-de-outra-conta', base_price: 999 } },
      { procedure_id: 'proc-da-conta-2', quantity: 3, unit_price: 40, notes: null, procedure: { id: 'proc-da-conta-2', base_price: 50 } },
    ],
  };
  let criados: any[] = [];
  const respostas: Record<string, (a: any) => any> = {
    'quoteTemplate.findUnique': () => modelo,
    'quoteTemplate.create': (a) => ({ id: 'tpl-novo', ...a.data }),
    'quoteTemplate.update': (a) => ({ id: a.where.id, ...a.data }),
    'quote.findUnique': () => ({ id: 'q-1', status: 'DRAFT', discount_percent: 10, patient: { tenant_id: conta } }),
    'quoteItem.count': () => 2,
    'quoteItem.createMany': (a) => {
      criados = a.data;
      return { count: a.data.length };
    },
    'quoteItem.findMany': () => [{ total_price: 30 }, ...criados.map((c) => ({ total_price: c.total_price }))],
    'procedure.findMany': (a) =>
      servicos.filter((s) => a.where.id.in.includes(s.id) && s.tenant_id === a.where.tenant_id).map((s) => ({ id: s.id })),
  };
  const perfis = jest.fn(async () => labs.map((tenant_id) => ({ tenant_id })));
  const modelos: Record<string, any> = {};
  const prisma: any = new Proxy(
    {},
    {
      get(_a, nome: string | symbol) {
        if (typeof nome !== 'string' || nome === 'then') return undefined;
        if (nome === 'tenantBusinessProfile') return { findMany: perfis };
        if (nome === '$transaction') return async (cb: any) => cb(prisma);
        modelos[nome] ??= new Proxy(
          {},
          {
            get(_m, metodo: string | symbol) {
              if (typeof metodo !== 'string' || metodo === 'then') return undefined;
              return async (args: any) => {
                const op = `${nome}.${metodo}`;
                ops.push([op, args]);
                const r = respostas[op];
                if (r) return r(args);
                if (metodo === 'deleteMany' || metodo === 'createMany') return { count: 0 };
                return null;
              };
            },
          },
        );
        return modelos[nome];
      },
    },
  );
  const svc = new QuoteTemplatesService(prisma);
  const de = (op: string) => ops.filter(([o]) => o === op).map(([, a]) => a);
  return { svc, ops, de, perfis };
}

const ITENS_COM_OUTRA_CONTA = [
  { procedure_id: 'proc-da-conta-1', quantity: 1 },
  { procedure_id: 'proc-de-outra-conta', quantity: 1 },
];

describe('modelos de orçamento no laboratório: só serviço da própria conta (F6)', () => {
  it('criar com serviço de outra conta: 400 e nada gravado', async () => {
    const m = montar(LAB, [LAB]);
    const e = await m.svc.create(LAB, { name: 'Coroa + placa', items: ITENS_COM_OUTRA_CONTA }).catch((x) => x);
    expect(e).toBeInstanceOf(BadRequestException);
    expect(m.de('quoteTemplate.create')).toEqual([]);
    expect(m.de('procedure.findMany')).toEqual([
      { where: { id: { in: ['proc-da-conta-1', 'proc-de-outra-conta'] }, tenant_id: LAB }, select: { id: true } },
    ]);
  });

  it('editar com serviço de outra conta: 400 e os itens não são trocados', async () => {
    const m = montar(LAB, [LAB]);
    const e = await m.svc.update('tpl-1', LAB, { items: ITENS_COM_OUTRA_CONTA }).catch((x) => x);
    expect(e).toBeInstanceOf(BadRequestException);
    expect(m.de('quoteTemplateItem.deleteMany')).toEqual([]);
    expect(m.de('quoteTemplate.update')).toEqual([]);
  });

  it('criar e editar só com serviços da conta: grava como sempre', async () => {
    const m = montar(LAB, [LAB]);
    const itens = [{ procedure_id: 'proc-da-conta-1', quantity: 1 }, { procedure_id: 'proc-da-conta-2', quantity: 2 }];
    await m.svc.create(LAB, { name: 'Modelo', items: itens });
    await m.svc.update('tpl-1', LAB, { items: itens });
    expect(m.de('quoteTemplate.create')).toHaveLength(1);
    expect(m.de('quoteTemplateItem.createMany')).toHaveLength(1);
  });

  it('aplicar: copia só os itens da conta, order_index em seguida e totais pelos copiados', async () => {
    const m = montar(LAB, [LAB]);
    const r = await m.svc.applyToQuote('q-1', 'tpl-1', LAB);
    expect(r).toEqual({ added: 2 });
    const [{ data }] = m.de('quoteItem.createMany');
    expect(data.map((d: any) => [d.procedure_id, d.order_index, d.total_price])).toEqual([
      ['proc-da-conta-1', 2, 100],
      ['proc-da-conta-2', 3, 120],
    ]);
    // 30 (já no orçamento) + 100 + 120 = 250; 10% de desconto.
    expect(m.de('quote.update')).toEqual([{ where: { id: 'q-1' }, data: { subtotal: 250, discount_value: 25, total_value: 225 } }]);
  });
});

describe('modelos de orçamento na clínica: como hoje (F6)', () => {
  it('criar e editar com qualquer serviço: grava, sem ler os serviços', async () => {
    for (const labs of [[], [LAB]]) {
      const m = montar(CLINICA, labs);
      await m.svc.create(CLINICA, { name: 'Implante', items: ITENS_COM_OUTRA_CONTA });
      await m.svc.update('tpl-1', CLINICA, { items: ITENS_COM_OUTRA_CONTA });
      expect(m.de('quoteTemplate.create')).toHaveLength(1);
      expect(m.de('quoteTemplateItem.createMany')).toHaveLength(1);
      expect(m.de('procedure.findMany')).toEqual([]);
    }
  });

  it('aplicar: os mesmos itens, order_index e totais, com e sem outra conta de laboratório', async () => {
    const antes = montar(CLINICA, []);
    const r1 = await antes.svc.applyToQuote('q-1', 'tpl-1', CLINICA);
    const depois = montar(CLINICA, [LAB]);
    const r2 = await depois.svc.applyToQuote('q-1', 'tpl-1', CLINICA);
    expect(r1).toEqual({ added: 3 });
    expect(r2).toEqual(r1);
    expect(depois.ops).toEqual(antes.ops);
    const [{ data }] = antes.de('quoteItem.createMany');
    expect(data.map((d: any) => [d.procedure_id, d.order_index, d.total_price])).toEqual([
      ['proc-da-conta-1', 2, 100],
      ['proc-de-outra-conta', 3, 1998],
      ['proc-da-conta-2', 4, 120],
    ]);
    expect(antes.de('procedure.findMany')).toEqual([]);
  });

  it('o modelo de outra conta continua recusado como hoje', async () => {
    const m = montar(CLINICA, []);
    await expect(m.svc.applyToQuote('q-1', 'tpl-1', 'tenant-terceira')).rejects.toThrow('Acesso negado');
  });
});
