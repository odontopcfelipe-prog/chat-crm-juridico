/**
 * F7 do laboratório — avisos internos de venda aos números da Central: "Venda feita"
 * (no fechamento e o adiado, quando o PIX online cai) e o "Resumo do dia".
 *
 * O laboratório usa o MESMO caminho da clínica (mesmo toggle, mesmos destinatários,
 * mesma dedup por venda e por dia, mesmos chips), com os nomes padrão do laboratório:
 * "o laboratório" sem nome da conta, "Cliente" sem nome do cliente, "Serviço" no item
 * sem nome e "Orçamentos aprovados" no resumo, que também tira o "Dr."/"Dra." do
 * primeiro nome. A leitura da lista de laboratórios só acontece depois do toggle ligado.
 *
 * Clínica: os textos e as operações de 9eb61bff (gerados rodando aquele código com os
 * mesmos dados), com e sem OUTRA conta laboratório cadastrada.
 *
 * Banco de teste: um gravador de operações. Dados de exemplo (repositório público).
 */
import { Logger } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { QuotesService } from './quotes.service';
import { invalidateAllSettings } from '../tenants/tenant-settings.helper';

const CLINICA = 'tenant-clinica';
const LAB = 'tenant-lab';
const AGORA = new Date('2026-10-21T15:00:00.000Z'); // quarta, 12:00 em Maceió
const NUMERO_DA_CENTRAL = '5582900000009';

beforeAll(() => {
  for (const nivel of ['log', 'warn', 'debug', 'error', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
  }
});
beforeEach(() => {
  __limparCacheLabTenants();
  invalidateAllSettings();
  // Só o relógio é fixo; promessas e timers seguem reais.
  jest.useFakeTimers({
    now: AGORA,
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
});
afterEach(() => jest.useRealTimers());

// ─── Banco de teste (gravador) ───────────────────────────────────────────────

type Op = [string, any];
function banco(labs: string[], respostas: Record<string, (a: any) => any> = {}) {
  __limparCacheLabTenants();
  const ops: Op[] = [];
  const perfis = jest.fn(async () => labs.map((tenant_id) => ({ tenant_id })));
  const modelos: Record<string, any> = {};
  const prisma: any = new Proxy(
    {},
    {
      get(_a, modelo: string | symbol) {
        if (typeof modelo !== 'string' || modelo === 'then') return undefined;
        if (modelo === 'tenantBusinessProfile') return { findMany: perfis };
        modelos[modelo] ??= new Proxy(
          {},
          {
            get(_m, metodo: string | symbol) {
              if (typeof metodo !== 'string' || metodo === 'then') return undefined;
              return async (args: any) => {
                const op = `${modelo}.${metodo}`;
                ops.push([op, args]);
                const r = respostas[op];
                if (r) return r(args);
                if (metodo === 'findMany' || metodo === 'groupBy') return [];
                if (metodo === 'count') return 0;
                if (metodo === 'create') return { id: `novo-${modelo}`, ...(args?.data ?? {}) };
                return null;
              };
            },
          },
        );
        return modelos[modelo];
      },
    },
  );
  const nomes = () => ops.map(([o]) => o);
  return { prisma, ops, perfis, nomes };
}

function zap() {
  const envios: { tel: string; texto: string; inst?: string }[] = [];
  const whatsapp = {
    getInstanceForPurpose: jest.fn(async (_t: string, p: string) => `chip-${p.toLowerCase()}`),
    sendText: jest.fn(async (tel: string, texto: string, inst?: string) => {
      envios.push({ tel, texto, inst });
      return { key: { id: `wamid-${envios.length}` } };
    }),
  };
  return { envios, whatsapp };
}

// ─── Venda feita ─────────────────────────────────────────────────────────────

describe('Venda feita (aviso interno) — o laboratório com os nomes dele; a clínica igual', () => {
  const ITENS_SEM_NOME = [{ quantity: 2, procedure: null }, { quantity: 1, procedure: { name: 'Clareamento dental' } }];
  function montar(conta: string, labs: string[], o: { ligado?: boolean; nomeConta?: string | null; itens?: any[] } = {}) {
    const b = banco(labs, {
      'globalSetting.findUnique': ({ where }) =>
        where.key === `VENDA_FEITA_ENABLED_${conta}`
          ? { value: o.ligado === false ? 'false' : 'true' }
          : where.key === `VENDA_FEITA_PHONE_${conta}`
            ? { value: NUMERO_DA_CENTRAL }
            : null,
      'tenant.findUnique': () => ({ name: o.nomeConta ?? null }),
      'treatmentPlanItem.findMany': () => o.itens ?? ITENS_SEM_NOME,
      'user.findFirst': () => ({ name: 'Vendedora Exemplo' }),
      'instance.findMany': () => [{ name: 'chip-fin', purpose: 'FINANCEIRO' }],
    });
    const z = zap();
    const svc: any = new QuotesService(b.prisma, {} as any, z.whatsapp as any);
    return { svc, ...z, ...b };
  }
  const vender = (m: ReturnType<typeof montar>, conta: string, nome: string | null) =>
    m.svc.sendVendaFeita(conta, `plano-${conta}`, { name: nome }, { valor: 1234.5, forma: 'PIX', vendedorId: 'u-1' });

  it('clínica sem nome de conta, de cliente e de item: o texto de 9eb61bff, com e sem OUTRA conta laboratório', async () => {
    const esperado = [
      {
        tel: NUMERO_DA_CENTRAL,
        texto:
          '🎉 *Venda realizada!*\n_a clínica_\n\n👤 Paciente\n💰 R$ 1.234,50 · PIX\n🦷 Procedimento (2x), Clareamento dental\n' +
          '🧑‍⚕️ Vendedor(a): Vendedora Exemplo',
        inst: 'chip-fin',
      },
    ];
    const antes = montar(CLINICA, []);
    await vender(antes, CLINICA, null);
    expect(antes.envios).toEqual(esperado);
    expect(antes.nomes()).toEqual([
      'globalSetting.findUnique',
      'globalSetting.findUnique',
      'globalSetting.findUnique',
      'user.findMany',
      'auditLog.findFirst',
      'tenant.findUnique',
      'treatmentPlanItem.findMany',
      'user.findFirst',
      'instance.findMany',
      'dispatchLog.create',
      'auditLog.create',
    ]);
    const depois = montar(CLINICA, [LAB]);
    await vender(depois, CLINICA, null);
    expect(depois.envios).toEqual(esperado);
    expect(depois.ops).toEqual(antes.ops);
  });

  it('clínica com nomes: o texto de 9eb61bff', async () => {
    const m = montar(CLINICA, [LAB], { nomeConta: 'Clínica Exemplo', itens: [{ quantity: 1, procedure: { name: 'Limpeza' } }] });
    await vender(m, CLINICA, 'Maria Exemplo da Silva');
    expect(m.envios.map((e) => e.texto)).toEqual([
      '🎉 *Venda realizada!*\n_Clínica Exemplo_\n\n👤 Maria Exemplo da Silva\n💰 R$ 1.234,50 · PIX\n🦷 Limpeza\n🧑‍⚕️ Vendedor(a): Vendedora Exemplo',
    ]);
  });

  it('toggle desligado (clínica e laboratório): nada sai e a lista de laboratórios nem é lida', async () => {
    for (const conta of [CLINICA, LAB]) {
      const m = montar(conta, [LAB], { ligado: false });
      await vender(m, conta, null);
      expect(m.nomes()).toEqual(['globalSetting.findUnique']);
      expect(m.perfis).not.toHaveBeenCalled();
      expect(m.envios).toEqual([]);
    }
  });

  it('laboratório sem nome de conta, de cliente e de item: "o laboratório", "Cliente" e "Serviço", pelo mesmo caminho', async () => {
    const m = montar(LAB, [LAB]);
    await vender(m, LAB, null);
    expect(m.envios).toEqual([
      {
        tel: NUMERO_DA_CENTRAL,
        texto:
          '🎉 *Venda realizada!*\n_o laboratório_\n\n👤 Cliente\n💰 R$ 1.234,50 · PIX\n🦷 Serviço (2x), Clareamento dental\n' +
          '🧑‍⚕️ Vendedor(a): Vendedora Exemplo',
        inst: 'chip-fin',
      },
    ]);
    // As mesmas operações da clínica (destinatários, dedup por venda, registro e marca).
    const clinica = montar(CLINICA, []);
    await vender(clinica, CLINICA, null);
    expect(m.nomes()).toEqual(clinica.nomes());
    expect(m.ops.find(([o]) => o === 'auditLog.findFirst')).toEqual([
      'auditLog.findFirst',
      { where: { entity: 'VENDA_FEITA', entity_id: `plano-${LAB}` }, select: { id: true } },
    ]);
  });

  it('laboratório com nomes: o nome da conta e o do cliente como estão no cadastro', async () => {
    const m = montar(LAB, [LAB], { nomeConta: 'Laboratório Exemplo', itens: [{ quantity: 2, procedure: { name: 'Coroa em zircônia' } }] });
    await vender(m, LAB, 'Dr. Carlos Lima');
    expect(m.envios.map((e) => e.texto)).toEqual([
      '🎉 *Venda realizada!*\n_Laboratório Exemplo_\n\n👤 Dr. Carlos Lima\n💰 R$ 1.234,50 · PIX\n🦷 Coroa em zircônia (2x)\n' +
        '🧑‍⚕️ Vendedor(a): Vendedora Exemplo',
    ]);
  });

  it('laboratório, venda rápida com PIX online: o aviso adiado sai quando o pagamento cai, com o texto do laboratório', async () => {
    const b = banco([LAB], {
      'paymentGatewayCharge.findUnique': () => ({
        tenant_id: LAB, treatment_plan_id: 'plano-lab', description: null, billing_type: 'PIX', amount: 200,
      }),
      'auditLog.findFirst': ({ where }) =>
        where.entity === 'VENDA_FEITA_DEFERRED' ? { meta_json: { valor: 200, forma: 'PIX', vendedorId: null } } : null,
      'treatmentPlan.findUnique': () => ({ patient: { name: null, tenant_id: LAB } }),
      'globalSetting.findUnique': ({ where }) =>
        where.key === `VENDA_FEITA_ENABLED_${LAB}` ? { value: 'true' } : where.key === `VENDA_FEITA_PHONE_${LAB}` ? { value: NUMERO_DA_CENTRAL } : null,
      'tenant.findUnique': () => ({ name: null }),
      'treatmentPlanItem.findMany': () => [{ quantity: 1, procedure: { name: 'Placa miorrelaxante' } }],
      'instance.findMany': () => [{ name: 'chip-atendimento', purpose: 'CLINICA' }],
    });
    const z = zap();
    const svc = new QuotesService(b.prisma, {} as any, z.whatsapp as any);
    await svc.notifyVendaFeitaOnPaid('cobranca-1');
    expect(z.envios).toEqual([
      {
        tel: NUMERO_DA_CENTRAL,
        texto: '🎉 *Venda realizada!*\n_o laboratório_\n\n👤 Cliente\n💰 R$ 200,00 · PIX\n🦷 Placa miorrelaxante',
        inst: 'chip-atendimento',
      },
    ]);
  });
});

// ─── Resumo do dia ───────────────────────────────────────────────────────────

describe('Resumo do dia (aviso interno) — o laboratório com os nomes dele; a clínica igual', () => {
  const INICIO = new Date('2026-10-20T03:00:00.000Z');
  const FIM = new Date('2026-10-21T03:00:00.000Z');
  // Os mesmos dados usados para gerar o texto da clínica em 9eb61bff.
  const DADOS: Record<string, (a: any) => any> = {
    'financialTransaction.findMany': ({ where }) =>
      where.type === 'RECEITA'
        ? [
            { amount: 100, payment_method: 'PIX', description: 'Recebimento', lead: { name: 'Dr. Carlos Lima' } },
            { amount: 50, payment_method: null, description: null, lead: null },
          ]
        : [{ amount: 30, payment_method: 'DINHEIRO', description: 'Material', category: 'Insumos', source: null }],
    'paymentGatewayCharge.findMany': ({ where, take }) =>
      take === 15
        ? [{ amount: 80, customer_external_id: null, treatment_plan: null, due_date: new Date('2026-10-10T00:00:00.000Z') }]
        : where.status && where.status.in
          ? [{ amount: 70, customer_external_id: 'cus_1', treatment_plan: null }]
          : [{ amount: 200, customer_external_id: null, treatment_plan: { patient: { name: 'Ana Souza' } } }],
    'paymentGatewayCharge.aggregate': () => ({ _sum: { amount: 80 }, _count: { _all: 1 } }),
    'quote.findMany': () => [
      { total_value: 900, patient: { name: null } },
      { total_value: 300, patient: { name: 'Dra. Beatriz Melo' } },
    ],
    'paymentGatewayCustomer.findMany': () => [],
    'tenant.findUnique': () => ({ name: null }),
  };
  const montarResumo = (labs: string[]) => {
    const b = banco(labs, DADOS);
    return { svc: new QuotesService(b.prisma, {} as any, zap().whatsapp as any) as any, ...b };
  };

  const DA_CLINICA =
    '📊 *Resumo do dia — 20/10/2026*\n_a clínica_\n\n💰 *Entradas:* R$ 150,00\n  • Dr. — R$ 100,00 · PIX\n  • Entrada — R$ 50,00\n\n' +
    '💸 *Saídas:* R$ 30,00\n  • Material — R$ 30,00 · Dinheiro\n\n📈 *Saldo do dia:* R$ 120,00\n\n' +
    '📄 *Vendas em boleto:* 1 — R$ 200,00\n  • Ana: R$ 200,00\n\n✅ *Boletos compensados:* 1 — R$ 70,00\n  • Paciente: R$ 70,00\n\n' +
    '⚠️ *Boletos em atraso:* 1 — R$ 80,00\n  • Paciente: R$ 80,00 · 11d\n\n🤝 *Negociações fechadas:* 2 — R$ 1.200,00\n' +
    '  • Paciente: R$ 900,00\n  • Dra.: R$ 300,00\n\n_Resumo automático do fechamento do dia._';

  it('clínica: o texto de 9eb61bff (sem o 5º argumento e com false; com e sem OUTRA conta laboratório)', async () => {
    const antes = montarResumo([]);
    expect(await antes.svc.buildDailySummary(CLINICA, INICIO, FIM, '20/10/2026')).toBe(DA_CLINICA);
    expect(antes.nomes()).toEqual([
      'financialTransaction.findMany',
      'financialTransaction.findMany',
      'paymentGatewayCharge.findMany',
      'paymentGatewayCharge.findMany',
      'paymentGatewayCharge.aggregate',
      'paymentGatewayCharge.findMany',
      'quote.findMany',
      'paymentGatewayCustomer.findMany',
      'tenant.findUnique',
    ]);
    const depois = montarResumo([LAB]);
    expect(await depois.svc.buildDailySummary(CLINICA, INICIO, FIM, '20/10/2026', false)).toBe(DA_CLINICA);
    expect(depois.ops).toEqual(antes.ops);
    expect(depois.perfis).not.toHaveBeenCalled();
  });

  it('laboratório: "o laboratório", "Cliente", o primeiro nome sem "Dr."/"Dra." e "Orçamentos aprovados"', async () => {
    const m = montarResumo([LAB]);
    const texto = await m.svc.buildDailySummary(LAB, INICIO, FIM, '20/10/2026', true);
    expect(texto).toBe(
      '📊 *Resumo do dia — 20/10/2026*\n_o laboratório_\n\n💰 *Entradas:* R$ 150,00\n  • Carlos — R$ 100,00 · PIX\n  • Entrada — R$ 50,00\n\n' +
        '💸 *Saídas:* R$ 30,00\n  • Material — R$ 30,00 · Dinheiro\n\n📈 *Saldo do dia:* R$ 120,00\n\n' +
        '📄 *Vendas em boleto:* 1 — R$ 200,00\n  • Ana: R$ 200,00\n\n✅ *Boletos compensados:* 1 — R$ 70,00\n  • Cliente: R$ 70,00\n\n' +
        '⚠️ *Boletos em atraso:* 1 — R$ 80,00\n  • Cliente: R$ 80,00 · 11d\n\n🤝 *Orçamentos aprovados:* 2 — R$ 1.200,00\n' +
        '  • Cliente: R$ 900,00\n  • Beatriz: R$ 300,00\n\n_Resumo automático do fechamento do dia._',
    );
    expect(texto).not.toMatch(/paciente|negocia/i);
    // As mesmas consultas da clínica, na conta do laboratório.
    const clinica = montarResumo([]);
    await clinica.svc.buildDailySummary(CLINICA, INICIO, FIM, '20/10/2026');
    expect(m.nomes()).toEqual(clinica.nomes());
  });

  describe('cron (todo minuto, no horário de cada conta)', () => {
    function montarCron(labs: string[], contas: string[]) {
      const b = banco(labs, {
        'globalSetting.findMany': ({ where }) =>
          where.key?.startsWith === 'DAILY_SUMMARY_TIME_' ? contas.map((t) => ({ key: `DAILY_SUMMARY_TIME_${t}`, value: '12:00' })) : [],
        'globalSetting.findUnique': ({ where }) =>
          contas.some((t) => where.key === `DAILY_SUMMARY_ENABLED_${t}`)
            ? { value: 'true' }
            : contas.some((t) => where.key === `DAILY_SUMMARY_PHONE_${t}`)
              ? { value: NUMERO_DA_CENTRAL }
              : null,
        'instance.findMany': ({ where }) => [{ name: `chip-${where.tenant_id}`, purpose: 'FINANCEIRO' }],
      });
      const z = zap();
      const svc: any = new QuotesService(b.prisma, {} as any, z.whatsapp as any);
      const montarTexto = jest.spyOn(svc, 'buildDailySummary').mockImplementation(async (t: any) => `resumo de ${t}`);
      return { svc, montarTexto, ...z, ...b };
    }

    it('clínica: as mesmas operações e o mesmo envio com e sem OUTRA conta laboratório; o texto sai com lab = false', async () => {
      const antes = montarCron([], [CLINICA]);
      await antes.svc.cronDailySummary();
      const depois = montarCron([LAB], [CLINICA]);
      await depois.svc.cronDailySummary();
      expect(depois.ops).toEqual(antes.ops);
      expect(depois.envios).toEqual(antes.envios);
      expect(antes.envios).toEqual([{ tel: NUMERO_DA_CENTRAL, texto: `resumo de ${CLINICA}`, inst: `chip-${CLINICA}` }]);
      expect(depois.montarTexto.mock.calls).toEqual([[CLINICA, expect.any(Date), expect.any(Date), '20/10/2026', false]]);
    });

    it('laboratório: a mesma dedup do dia e o mesmo registro da clínica; o texto sai com lab = true', async () => {
      const m = montarCron([LAB], [CLINICA, LAB]);
      await m.svc.cronDailySummary();
      expect(m.montarTexto.mock.calls).toEqual([
        [CLINICA, expect.any(Date), expect.any(Date), '20/10/2026', false],
        [LAB, expect.any(Date), expect.any(Date), '20/10/2026', true],
      ]);
      expect(m.envios.map((e) => [e.texto, e.inst])).toEqual([
        [`resumo de ${CLINICA}`, `chip-${CLINICA}`],
        [`resumo de ${LAB}`, `chip-${LAB}`],
      ]);
      const doLab = m.ops.filter(([, a]) => JSON.stringify(a).includes(LAB));
      expect(doLab.map(([o]) => o)).toEqual([
        'globalSetting.findUnique', // DAILY_SUMMARY_ENABLED_<conta>
        'globalSetting.findUnique', // DAILY_SUMMARY_PHONE_<conta>
        'user.findMany',
        'dispatchLog.findFirst', // dedup do dia, igual à clínica
        'instance.findMany',
        'dispatchLog.create',
      ]);
      expect(doLab[3][1].where).toMatchObject({ tenant_id: LAB, type: 'daily_summary' });
    });
  });
});
