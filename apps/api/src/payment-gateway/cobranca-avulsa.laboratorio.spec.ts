/**
 * Cobrança avulsa do laboratório (painel do contato): cada parcela gera uma cobrança
 * própria no Asaas, da conta do laboratório, ligada à sua LeadHonorarioPayment.
 *
 * Confere: sem carnê; gerar de novo só cria para a parcela sem cobrança viva; clique duplo
 * não duplica; o pagamento (webhook e reconciliação) baixa só aquela parcela e lança a
 * receita uma vez; cancelar exige a confirmação do Asaas. A clínica segue com o carnê.
 *
 * Banco em memória e Asaas de mentira; dados de exemplo (repositório público).
 */
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { PaymentGatewayService } from './payment-gateway.service';

const LAB = 'conta-lab-exemplo';
const CLINICA = 'conta-clinica-exemplo';
const AGORA = new Date('2027-01-12T15:00:00.000Z');
const HOJE = '2027-01-12';

type Parcela = { id: string; amount: number; due_date: Date | null; status: string; paid_at?: Date | null; payment_method?: string | null };

function mundo(o: { conta?: string; parcelas?: Parcela[]; charges?: any[]; lancamentos?: any[] } = {}) {
  const conta = o.conta ?? LAB;
  const parcelas: Parcela[] = o.parcelas ?? [
    { id: 'par-1', amount: 100, due_date: new Date('2027-02-01T00:00:00.000Z'), status: 'PENDENTE' },
    { id: 'par-2', amount: 100, due_date: new Date('2027-03-01T00:00:00.000Z'), status: 'PENDENTE' },
    { id: 'par-3', amount: 100.5, due_date: new Date('2027-04-01T00:00:00.000Z'), status: 'PENDENTE' },
  ];
  const charges: any[] = [...(o.charges ?? [])];
  const lancamentos: any[] = [...(o.lancamentos ?? [])];
  const honorario = { id: 'hon-1', tenant_id: conta, lead_id: 'lead-1', type: 'CONTRATUAL', notes: null };
  const lead = { id: 'lead-1', name: 'Dra. Ana Souza', phone: '5582900000001', email: null, tenant_id: conta };
  let proxima = 0;

  // Serializa como o advisory lock: a segunda transação só entra quando a primeira sai.
  let fila: Promise<unknown> = Promise.resolve();
  const travas: unknown[][] = [];
  const tx = { $executeRaw: jest.fn(async (...a: unknown[]) => { travas.push(a); return 1; }) };

  const acharCharge = (w: any) => charges.find((c) =>
    (w.id === undefined || c.id === w.id) &&
    (w.external_id === undefined || c.external_id === w.external_id) &&
    (w.lead_honorario_payment_id === undefined || c.lead_honorario_payment_id === w.lead_honorario_payment_id));
  const casaStatus = (filtro: any, s: string) =>
    filtro === undefined || (typeof filtro === 'string' ? filtro === s : filtro.not !== undefined ? filtro.not !== s : filtro.in ? filtro.in.includes(s) : true);

  const prisma: any = {
    tenantBusinessProfile: { findMany: jest.fn(async () => (conta === LAB ? [{ tenant_id: LAB }] : [])) },
    leadHonorario: {
      findUnique: jest.fn(async ({ where }: any) => (where.id !== honorario.id ? null : {
        ...honorario,
        lead,
        payments: parcelas.filter((p) => ['PENDENTE', 'ATRASADO'].includes(p.status)).map((p) => ({ ...p })),
      })),
    },
    leadHonorarioPayment: {
      findMany: jest.fn(async () => parcelas.map((p) => ({ id: p.id }))),
      findUnique: jest.fn(async ({ where }: any) => {
        const p = parcelas.find((x) => x.id === where.id);
        return p ? { ...p, lead_honorario: { ...honorario, lead, lead_id: lead.id, tenant_id: conta } } : null;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const p of parcelas) {
          if (p.id === where.id && casaStatus(where.status, p.status)) { Object.assign(p, data); count++; }
        }
        return { count };
      }),
    },
    paymentGatewayCharge: {
      // Cópia, como o banco: mudar a linha depois não muda o que já foi lido.
      findUnique: jest.fn(async ({ where }: any) => { const c = acharCharge(where); return c ? { ...c } : null; }),
      findFirst: jest.fn(async ({ where }: any) => { const c = acharCharge(where); return c ? { ...c } : null; }),
      findMany: jest.fn(async () => charges),
      count: jest.fn(async () => charges.length),
      create: jest.fn(async ({ data }: any) => {
        const dupla = data.lead_honorario_payment_id && charges.some((c) => c.lead_honorario_payment_id === data.lead_honorario_payment_id);
        if (dupla) throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
        const c = { id: `cob-${++proxima}`, transaction_id: null, received_in_cash: false, paid_at: null, payment_date: null, cancelled_at: null, treatment_plan: null, patient: null, installment_id: null, treatment_plan_id: null, kind: null, ...data };
        charges.push(c);
        return c;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const c = charges.find((x) => x.id === where.id);
        Object.assign(c, data);
        return c;
      }),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    paymentGatewayCustomer: { findFirst: jest.fn(async () => ({ id: 'cus-local' })) },
    lead: { findUnique: jest.fn(async () => ({ cpf_cnpj: '00000000000' })) },
    financialTransaction: {
      findUnique: jest.fn(async ({ where }: any) => lancamentos.find((l) => l.lead_honorario_payment_id === where.lead_honorario_payment_id) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const l = { id: `lanc-${lancamentos.length + 1}`, ...data };
        lancamentos.push(l);
        return l;
      }),
      update: jest.fn(async () => ({})),
    },
    paymentNotifyDedup: { create: jest.fn(async () => ({})) },
    user: { findUnique: jest.fn(async () => ({ name: 'Admin Exemplo' })) },
    auditLog: { create: jest.fn(async () => ({})) },
    $executeRaw: tx.$executeRaw,
    $transaction: jest.fn((cb: any, _opcoes?: any) => {
      const vez = fila.then(() => cb({ ...prisma, ...tx }));
      fila = vez.catch(() => undefined);
      return vez;
    }),
  };

  let id = 0;
  const asaas: any = {
    createCharge: jest.fn(async (d: any) => {
      const n = ++id;
      return { id: `pay_${n}`, status: 'PENDING', description: d.description, bankSlipUrl: `https://boleto.exemplo.test/${n}`, invoiceUrl: `https://fatura.exemplo.test/${n}`, nossoNumero: `${n}` };
    }),
    listCharges: jest.fn(async () => ({ data: [] })),
    getCharge: jest.fn(),
    deleteCharge: jest.fn(async () => ({ deleted: true })),
    receiveInCash: jest.fn(async () => ({})),
    getPixQrCode: jest.fn(),
    getConfig: jest.fn(async () => ({ webhookToken: '' })),
  };
  const moduleRef: any = { get: jest.fn(() => ({ handleChargePaid: jest.fn(), notifyVendaFeitaOnPaid: jest.fn() })) };
  const whatsapp: any = { sendText: jest.fn(), sendMedia: jest.fn(), getInstanceForPurpose: jest.fn(async () => null) };
  const email: any = { dispatch: jest.fn(async () => true) };
  const svc = new PaymentGatewayService(prisma, asaas, {} as any, {} as any, whatsapp, email, moduleRef);

  jest.spyOn(svc, 'ensureCustomer').mockResolvedValue({ external_id: 'cus_1' } as any);
  const avisaPagamento = jest.spyOn(svc as any, 'notifyClientPaymentReceived').mockResolvedValue(undefined);
  const avisaCancelada = jest.spyOn(svc as any, 'notifyClientChargeDeleted').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'promoteLeadFromCharge').mockImplementation(() => undefined);
  jest.spyOn(svc as any, 'sendPaymentConfirmedEmail').mockResolvedValue(undefined);

  const parcela = (pid: string) => parcelas.find((p) => p.id === pid) as Parcela;
  const cobrancaDe = (pid: string) => charges.find((c) => c.lead_honorario_payment_id === pid);
  const gerar = () => svc.createInstallmentCharge('hon-1', 'BOLETO', conta) as Promise<any>;
  const webhook = (c: any, status: string, silent?: boolean) =>
    svc.handleWebhook(
      { event: `PAYMENT_${status}`, payment: { id: c.external_id, status, customer: 'cus_1', value: Number(c.amount), paymentDate: HOJE, confirmedDate: HOJE } },
      silent === undefined ? undefined : { silent },
    );
  return { svc, prisma, asaas, whatsapp, email, parcelas, charges, lancamentos, parcela, cobrancaDe, gerar, webhook, travas, avisaPagamento, avisaCancelada };
}

const aberta = (over: any = {}) => ({
  id: 'cob-viva', tenant_id: LAB, lead_honorario_payment_id: 'par-1', gateway: 'ASAAS', external_id: 'pay_vivo', customer_external_id: 'cus_1',
  billing_type: 'BOLETO', amount: 100, due_date: new Date('2027-02-01T00:00:00.000Z'), status: 'PENDING', description: 'Cobrança avulsa - Ana (parcela 1/3)',
  transaction_id: null, received_in_cash: false, paid_at: null, payment_date: null, cancelled_at: null, cancelled_by_user_id: null, cancelled_by_name: null, cancel_reason: null,
  treatment_plan: null, patient: null, installment_id: null, treatment_plan_id: null, kind: null,
  ...over,
});

beforeEach(() => {
  __limparCacheLabTenants();
  for (const nivel of ['log', 'warn', 'debug', 'error', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
  }
  jest.useFakeTimers({ now: AGORA, doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'queueMicrotask'] });
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('gerar as cobranças', () => {
  it('cada parcela vira uma cobrança própria, sem carnê, ligada à sua parcela e na conta do laboratório', async () => {
    const m = mundo();
    const r = await m.gerar();

    expect(m.asaas.createCharge).toHaveBeenCalledTimes(3);
    for (const [args, conta] of m.asaas.createCharge.mock.calls) {
      expect(args).not.toHaveProperty('installmentCount');
      expect(args).not.toHaveProperty('installmentValue');
      expect(conta).toBe(LAB);
    }
    expect(m.asaas.createCharge.mock.calls.map(([a]: any[]) => [a.externalReference, a.value, a.dueDate, a.description])).toEqual([
      ['par-1', 100, '2027-02-01', 'Cobrança avulsa - Dra. Ana Souza (parcela 1/3)'],
      ['par-2', 100, '2027-03-01', 'Cobrança avulsa - Dra. Ana Souza (parcela 2/3)'],
      ['par-3', 100.5, '2027-04-01', 'Cobrança avulsa - Dra. Ana Souza (parcela 3/3)'],
    ]);
    expect(m.charges.map((c) => [c.lead_honorario_payment_id, c.amount, c.external_id, c.tenant_id])).toEqual([
      ['par-1', 100, 'pay_1', LAB],
      ['par-2', 100, 'pay_2', LAB],
      ['par-3', 100.5, 'pay_3', LAB],
    ]);
    expect(r.criadas).toBe(3);
    expect(r.erro).toBeNull();
    expect(r.parcelas[1]).toMatchObject({ id: 'par-2', criada: true, boleto_url: 'https://boleto.exemplo.test/2', invoice_url: 'https://fatura.exemplo.test/2' });
  });

  it('gerar não manda nada ao cliente', async () => {
    const m = mundo();
    await m.gerar();
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
    expect(m.whatsapp.sendMedia).not.toHaveBeenCalled();
    expect(m.email.dispatch).not.toHaveBeenCalled();
  });

  it('clique duplo: duas chamadas ao mesmo tempo criam uma cobrança por parcela, nunca duas', async () => {
    const m = mundo();
    const [a, b] = await Promise.all([m.gerar(), m.gerar()]);
    expect(m.asaas.createCharge).toHaveBeenCalledTimes(3);
    expect(m.charges).toHaveLength(3);
    expect(a.criadas + b.criadas).toBe(3);
    expect(a.erro).toBeNull();
    expect(b.erro).toBeNull();
    expect(m.travas).toHaveLength(6); // a trava é por parcela, nas duas chamadas
  });

  it('gerar de novo só cria para a parcela sem cobrança viva', async () => {
    const m = mundo({
      parcelas: [
        { id: 'par-1', amount: 100, due_date: new Date('2027-02-01T00:00:00.000Z'), status: 'PAGO' },
        { id: 'par-2', amount: 100, due_date: new Date('2027-03-01T00:00:00.000Z'), status: 'PENDENTE' },
        { id: 'par-3', amount: 100, due_date: new Date('2027-04-01T00:00:00.000Z'), status: 'PENDENTE' },
      ],
      charges: [aberta({ id: 'cob-2', lead_honorario_payment_id: 'par-2', external_id: 'pay_vivo_2' })],
    });
    const r = await m.gerar();
    expect(m.asaas.createCharge).toHaveBeenCalledTimes(1);
    expect(m.asaas.createCharge.mock.calls[0][0].externalReference).toBe('par-3');
    expect(r.criadas).toBe(1);
    expect(m.cobrancaDe('par-2').external_id).toBe('pay_vivo_2');
    expect(m.cobrancaDe('par-1')).toBeUndefined();
  });

  it('recarregar e gerar de novo, com tudo gerado: nenhum boleto novo', async () => {
    const m = mundo();
    await m.gerar();
    const r = await m.gerar();
    expect(m.asaas.createCharge).toHaveBeenCalledTimes(3);
    expect(r.criadas).toBe(0);
    expect(r.parcelas.every((p: any) => p.criada === false)).toBe(true);
  });

  it.each(['DELETED', 'REFUNDED', 'CANCELLED'])('cobrança %s: a parcela ganha outra e a antiga fica no histórico sem o vínculo', async (status) => {
    const m = mundo({
      parcelas: [{ id: 'par-1', amount: 100, due_date: new Date('2027-02-01T00:00:00.000Z'), status: 'PENDENTE' }],
      charges: [aberta({ status, cancel_reason: 'motivo' })],
    });
    await m.gerar();
    expect(m.asaas.createCharge).toHaveBeenCalledTimes(1);
    expect(m.charges).toHaveLength(2);
    const antiga = m.charges.find((c) => c.id === 'cob-viva');
    expect(antiga.lead_honorario_payment_id).toBeNull();
    expect(antiga.cancel_reason).toBe('motivo');
    expect(m.cobrancaDe('par-1').external_id).toBe('pay_1');
  });

  it('boleto em aberto que uma tentativa anterior deixou no Asaas é adotado, sem criar outro', async () => {
    const m = mundo({ parcelas: [{ id: 'par-1', amount: 100, due_date: new Date('2027-02-01T00:00:00.000Z'), status: 'PENDENTE' }] });
    m.asaas.listCharges.mockResolvedValue({
      data: [
        { id: 'pay_apagado', status: 'PENDING', deleted: true },
        { id: 'pay_orfao', status: 'PENDING', description: 'x', bankSlipUrl: 'https://boleto.exemplo.test/orfao', invoiceUrl: 'https://fatura.exemplo.test/orfao' },
      ],
    });
    const r = await m.gerar();
    expect(m.asaas.listCharges).toHaveBeenCalledWith({ externalReference: 'par-1' }, LAB);
    expect(m.asaas.createCharge).not.toHaveBeenCalled();
    expect(m.cobrancaDe('par-1')).toMatchObject({ external_id: 'pay_orfao', boleto_url: 'https://boleto.exemplo.test/orfao' });
    expect(r.criadas).toBe(1);
  });

  it('parcela atrasada ou sem data vence hoje (o Asaas não aceita vencimento no passado)', async () => {
    const m = mundo({
      parcelas: [
        { id: 'par-1', amount: 100, due_date: new Date('2026-12-01T00:00:00.000Z'), status: 'ATRASADO' },
        { id: 'par-2', amount: 100, due_date: null, status: 'PENDENTE' },
      ],
    });
    await m.gerar();
    expect(m.asaas.createCharge.mock.calls.map(([a]: any[]) => a.dueDate)).toEqual([HOJE, HOJE]);
  });

  it('falha no meio: devolve o que saiu e o motivo; gerar de novo completa sem duplicar', async () => {
    const m = mundo();
    m.asaas.createCharge
      .mockResolvedValueOnce({ id: 'pay_a', status: 'PENDING' })
      .mockRejectedValueOnce(new Error('[Asaas 400] invalid_value: valor inválido'));
    const r = await m.gerar();
    expect(r.criadas).toBe(1);
    expect(r.erro).toContain('valor inválido');
    expect(m.charges.map((c) => c.lead_honorario_payment_id)).toEqual(['par-1']);

    const r2 = await m.gerar();
    expect(r2.criadas).toBe(2);
    expect(r2.erro).toBeNull();
    expect(m.charges.map((c) => c.lead_honorario_payment_id).sort()).toEqual(['par-1', 'par-2', 'par-3']);
  });

  it('falha logo na primeira: recusa com a mensagem clara e não grava nada', async () => {
    const m = mundo();
    m.asaas.createCharge.mockRejectedValue(new Error('[Asaas 400] invalid_customer'));
    await expect(m.gerar()).rejects.toBeInstanceOf(BadRequestException);
    expect(m.charges).toHaveLength(0);
    expect(m.asaas.createCharge).toHaveBeenCalledTimes(1);
  });

  it('contato sem documento nem cliente no Asaas: recusa antes de falar com o Asaas', async () => {
    const m = mundo();
    m.prisma.paymentGatewayCustomer.findFirst.mockResolvedValue(null);
    m.prisma.lead.findUnique.mockResolvedValue({ cpf_cnpj: null });
    await expect(m.gerar()).rejects.toBeInstanceOf(BadRequestException);
    expect(m.asaas.createCharge).not.toHaveBeenCalled();
  });

  it('cobrança de outra conta responde como inexistente', async () => {
    const m = mundo();
    await expect(m.svc.createInstallmentCharge('hon-1', 'BOLETO', 'outra-conta')).rejects.toBeInstanceOf(NotFoundException);
    expect(m.asaas.createCharge).not.toHaveBeenCalled();
  });
});

describe('o pagamento baixa a parcela e lança a receita', () => {
  async function gerado() {
    const m = mundo();
    await m.gerar();
    return m;
  }

  it('webhook RECEIVED: só aquela parcela fica paga; a receita entra no caixa, ligada à cobrança e à parcela', async () => {
    const m = await gerado();
    await m.webhook(m.cobrancaDe('par-2'), 'RECEIVED');

    expect(m.parcela('par-2')).toMatchObject({ status: 'PAGO', payment_method: 'BOLETO' });
    expect(m.parcela('par-2').paid_at).toBeTruthy();
    expect(m.parcela('par-1').status).toBe('PENDENTE');
    expect(m.parcela('par-3').status).toBe('PENDENTE');

    expect(m.lancamentos).toHaveLength(1);
    expect(m.lancamentos[0]).toMatchObject({
      tenant_id: LAB, type: 'RECEITA', status: 'PAGO', amount: 100, lead_id: 'lead-1', lead_honorario_payment_id: 'par-2', reference_id: 'pay_2', payment_method: 'BOLETO',
    });
    expect(m.lancamentos[0].description).toContain('Dra. Ana Souza');
    expect(m.cobrancaDe('par-2').transaction_id).toBe(m.lancamentos[0].id);
    expect(m.avisaPagamento).toHaveBeenCalledTimes(1);
  });

  it('CONFIRMED e depois RECEIVED: paga já no CONFIRMED; a receita entra uma vez, no RECEIVED', async () => {
    const m = await gerado();
    await m.webhook(m.cobrancaDe('par-1'), 'CONFIRMED');
    expect(m.parcela('par-1').status).toBe('PAGO');
    expect(m.lancamentos).toHaveLength(0);

    await m.webhook(m.cobrancaDe('par-1'), 'RECEIVED');
    expect(m.lancamentos).toHaveLength(1);
    await m.webhook(m.cobrancaDe('par-1'), 'RECEIVED'); // reentrega
    expect(m.lancamentos).toHaveLength(1);
  });

  it('reconciliação (cron): o pagamento perdido baixa a parcela e lança a receita, sem avisar o cliente', async () => {
    const m = await gerado();
    const viva = m.cobrancaDe('par-1');
    m.asaas.getCharge.mockImplementation(async (id: string) =>
      id === viva.external_id
        ? { id, status: 'RECEIVED', customer: 'cus_1', value: 100, dueDate: '2026-12-01', paymentDate: '2026-12-01', confirmedDate: '2026-12-01' }
        : { id, status: 'PENDING', customer: 'cus_1', value: 100 },
    );
    viva.due_date = new Date('2026-12-01T00:00:00.000Z'); // vencida: reconciliação silenciosa
    m.prisma.paymentGatewayCharge.findMany.mockResolvedValue([viva]);
    await m.svc.reconcileOverdueCron();

    expect(m.parcela('par-1').status).toBe('PAGO');
    expect(m.parcela('par-2').status).toBe('PENDENTE');
    expect(m.lancamentos).toHaveLength(1);
    expect(m.lancamentos[0].lead_honorario_payment_id).toBe('par-1');
    expect(m.avisaPagamento).not.toHaveBeenCalled();
  });

  it('receita perdida: o cron de cura alcança a cobrança da parcela do laboratório', async () => {
    const m = await gerado();
    const c = m.cobrancaDe('par-1');
    Object.assign(c, { status: 'RECEIVED', paid_at: AGORA });
    m.asaas.getCharge.mockResolvedValue({ id: c.external_id, status: 'RECEIVED' });
    m.prisma.paymentGatewayCharge.findMany.mockResolvedValue([c]);
    await m.svc.ensureReceitaBackfillCron();

    const where = m.prisma.paymentGatewayCharge.count.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('lead_honorario_payment_id');
    expect(where.OR).toEqual([{ lead_honorario_payment_id: null }, { tenant_id: { in: [LAB] } }]);
    expect(m.lancamentos).toHaveLength(1);
    expect(m.parcela('par-1').status).toBe('PAGO');
  });

  it('a parcela já tem lançamento: liga a ele, sem outra receita', async () => {
    const m = mundo({
      parcelas: [{ id: 'par-1', amount: 100, due_date: new Date('2027-02-01T00:00:00.000Z'), status: 'PAGO' }],
      charges: [aberta()],
      lancamentos: [{ id: 'lanc-manual', lead_honorario_payment_id: 'par-1', amount: 100 }],
    });
    await m.webhook(m.cobrancaDe('par-1'), 'RECEIVED');
    expect(m.lancamentos).toHaveLength(1);
    expect(m.cobrancaDe('par-1').transaction_id).toBe('lanc-manual');
  });

  it('OVERDUE: a parcela fica atrasada, e não volta para atrasada depois de paga', async () => {
    const m = await gerado();
    await m.webhook(m.cobrancaDe('par-1'), 'OVERDUE');
    expect(m.parcela('par-1').status).toBe('ATRASADO');

    await m.webhook(m.cobrancaDe('par-2'), 'RECEIVED');
    await m.webhook(m.cobrancaDe('par-2'), 'OVERDUE'); // reentrega fora de ordem
    expect(m.parcela('par-2').status).toBe('PAGO');
  });

  it('apagada no painel do Asaas: a parcela segue aberta e pode ganhar outra cobrança', async () => {
    const m = await gerado();
    await m.webhook(m.cobrancaDe('par-1'), 'DELETED');
    expect(m.parcela('par-1').status).toBe('PENDENTE');
    const r = await m.gerar();
    expect(r.criadas).toBe(1);
    expect(m.asaas.createCharge).toHaveBeenCalledTimes(4);
  });

  it('estornada: a parcela paga volta a ficar aberta', async () => {
    const m = await gerado();
    await m.webhook(m.cobrancaDe('par-1'), 'RECEIVED');
    await m.webhook(m.cobrancaDe('par-1'), 'REFUNDED');
    expect(m.parcela('par-1')).toMatchObject({ status: 'PENDENTE', paid_at: null, payment_method: null });
  });
});

describe('cancelar a cobrança da parcela', () => {
  const uma = () => mundo({
    parcelas: [{ id: 'par-1', amount: 100, due_date: new Date('2027-02-01T00:00:00.000Z'), status: 'PENDENTE' }],
    charges: [aberta()],
  });
  const cancelar = (m: ReturnType<typeof mundo>) =>
    m.svc.cancelarCobrancaDaParcelaDoLab('par-1', LAB, { userId: 'u-1', reason: 'Parcela excluída' });

  it('cancela no Asaas da conta e grava o rastro', async () => {
    const m = uma();
    await cancelar(m);
    expect(m.asaas.deleteCharge).toHaveBeenCalledWith('pay_vivo', LAB);
    expect(m.cobrancaDe('par-1')).toMatchObject({ status: 'DELETED', cancelled_by_user_id: 'u-1', cancelled_by_name: 'Admin Exemplo', cancel_reason: 'Parcela excluída' });
    expect(m.avisaCancelada).not.toHaveBeenCalled();
  });

  it('o Asaas não confirma: desfaz, recusa e o boleto continua valendo para a parcela', async () => {
    const m = uma();
    m.asaas.deleteCharge.mockRejectedValue(new Error('[Asaas] Falha na tentativa 2: timeout'));
    m.asaas.getCharge.mockRejectedValue(new Error('timeout'));
    await expect(cancelar(m)).rejects.toBeInstanceOf(BadRequestException);
    expect(m.cobrancaDe('par-1')).toMatchObject({ status: 'PENDING', cancelled_at: null, cancelled_by_user_id: null, cancel_reason: null });
    // Sem o motivo gravado e sem linha no log: o cancelamento não aconteceu.
    expect(m.prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('já não existe no Asaas (404): segue como cancelada', async () => {
    const m = uma();
    m.asaas.deleteCharge.mockRejectedValue(new Error('[Asaas 404] not found'));
    await cancelar(m);
    expect(m.cobrancaDe('par-1').status).toBe('DELETED');
  });

  it('paga: recusa; encerrada ou sem cobrança: não fala com o Asaas', async () => {
    const paga = uma();
    paga.cobrancaDe('par-1').status = 'RECEIVED';
    await expect(cancelar(paga)).rejects.toBeInstanceOf(BadRequestException);
    expect(paga.asaas.deleteCharge).not.toHaveBeenCalled();

    const encerrada = uma();
    encerrada.cobrancaDe('par-1').status = 'DELETED';
    await cancelar(encerrada);
    expect(encerrada.asaas.deleteCharge).not.toHaveBeenCalled();

    const sem = mundo();
    await sem.svc.cancelarCobrancaDaParcelaDoLab('par-1', LAB, { reason: 'x' });
    expect(sem.asaas.deleteCharge).not.toHaveBeenCalled();
  });
});

describe('parcela paga por fora com boleto em aberto', () => {
  const uma = () => mundo({
    parcelas: [{ id: 'par-1', amount: 100, due_date: new Date('2027-02-01T00:00:00.000Z'), status: 'PENDENTE' }],
    charges: [aberta()],
  });

  it('dá baixa no Asaas, marca a parcela e lança a receita uma vez', async () => {
    const m = uma();
    m.asaas.getCharge.mockResolvedValue({ id: 'pay_vivo', status: 'PENDING', value: 100 });
    await m.svc.baixarCobrancaDaParcelaDoLab('par-1', LAB, { userId: 'u-1', paymentMethod: 'PIX' });
    expect(m.asaas.receiveInCash).toHaveBeenCalledWith('pay_vivo', HOJE, 100, LAB);
    expect(m.cobrancaDe('par-1')).toMatchObject({ status: 'RECEIVED', received_in_cash: true });
    expect(m.parcela('par-1')).toMatchObject({ status: 'PAGO', payment_method: 'PIX' });
    expect(m.lancamentos).toHaveLength(1);
    expect(m.lancamentos[0]).toMatchObject({ lead_honorario_payment_id: 'par-1', payment_method: 'PIX' });

    // O webhook do Asaas chega depois: não duplica nada nem avisa o cliente de novo.
    await m.webhook(m.cobrancaDe('par-1'), 'RECEIVED');
    expect(m.lancamentos).toHaveLength(1);
    expect(m.avisaPagamento).not.toHaveBeenCalled();
  });

  it('o Asaas não responde: nada muda aqui (o cliente não pode acabar pagando duas vezes)', async () => {
    const m = uma();
    m.asaas.getCharge.mockRejectedValue(new Error('timeout'));
    await expect(m.svc.baixarCobrancaDaParcelaDoLab('par-1', LAB, {})).rejects.toThrow('timeout');
    expect(m.parcela('par-1').status).toBe('PENDENTE');
    expect(m.lancamentos).toHaveLength(0);

    m.asaas.getCharge.mockResolvedValue({ id: 'pay_vivo', status: 'PENDING', value: 100 });
    m.asaas.receiveInCash.mockRejectedValue(new Error('[Asaas 400] recusado'));
    await expect(m.svc.baixarCobrancaDaParcelaDoLab('par-1', LAB, {})).rejects.toThrow('recusado');
    expect(m.parcela('par-1').status).toBe('PENDENTE');
    expect(m.lancamentos).toHaveLength(0);
  });

  it('já paga no Asaas (webhook perdido): só reflete o pagamento, sem receber em dinheiro', async () => {
    const m = uma();
    m.asaas.getCharge.mockResolvedValue({ id: 'pay_vivo', status: 'RECEIVED', value: 100, customer: 'cus_1', paymentDate: HOJE });
    await m.svc.baixarCobrancaDaParcelaDoLab('par-1', LAB, {});
    expect(m.asaas.receiveInCash).not.toHaveBeenCalled();
    expect(m.parcela('par-1').status).toBe('PAGO');
    expect(m.lancamentos).toHaveLength(1);
    expect(m.avisaPagamento).not.toHaveBeenCalled();
  });

  it('cancelada no Asaas: recusa', async () => {
    const m = uma();
    m.asaas.getCharge.mockResolvedValue({ id: 'pay_vivo', status: 'PENDING', deleted: true, value: 100 });
    await expect(m.svc.baixarCobrancaDaParcelaDoLab('par-1', LAB, {})).rejects.toBeInstanceOf(BadRequestException);
    expect(m.asaas.receiveInCash).not.toHaveBeenCalled();
  });
});

describe('clínica continua igual', () => {
  it('honorário parcelado: um carnê só, ligado à 1ª parcela, sem olhar parcela por parcela', async () => {
    const m = mundo({ conta: CLINICA });
    const r: any = await m.svc.createInstallmentCharge('hon-1', 'BOLETO', CLINICA);
    expect(m.asaas.createCharge).toHaveBeenCalledTimes(1);
    expect(m.asaas.createCharge).toHaveBeenCalledWith(
      {
        customer: 'cus_1',
        billingType: 'BOLETO',
        value: 300.5,
        dueDate: '2027-02-01',
        description: 'Honorário Contratuais - Dra. Ana Souza (3x)',
        externalReference: 'hon-1',
        installmentCount: 3,
        installmentValue: 100,
      },
      CLINICA,
    );
    expect(m.charges).toHaveLength(1);
    expect(m.charges[0]).toMatchObject({ lead_honorario_payment_id: 'par-1', amount: 300.5 });
    expect(r).toMatchObject({ installmentCount: 3, installmentValue: 100, totalValue: 300.5 });
    expect(m.asaas.listCharges).not.toHaveBeenCalled();
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('honorário com cobrança já gerada: a mesma recusa', async () => {
    const m = mundo({ conta: CLINICA, charges: [aberta({ tenant_id: CLINICA })] });
    m.prisma.paymentGatewayCharge.findMany.mockResolvedValue(m.charges);
    await expect(m.svc.createInstallmentCharge('hon-1', 'BOLETO', CLINICA)).rejects.toThrow('Já existem 1 cobrança(s) gerada(s) para este honorário');
    expect(m.asaas.createCharge).not.toHaveBeenCalled();
  });

  it('uma parcela só (POST charges): os mesmos argumentos ao Asaas, sem procurar boleto antes', async () => {
    const m = mundo({ conta: CLINICA });
    await m.svc.createChargeForLeadPayment('par-1', 'BOLETO', CLINICA);
    expect(m.asaas.listCharges).not.toHaveBeenCalled();
    expect(m.asaas.createCharge).toHaveBeenCalledWith(
      { customer: 'cus_1', billingType: 'BOLETO', value: 100, dueDate: '2027-02-01', description: 'Honorário Contratuais - Lead Dra. Ana Souza', externalReference: 'par-1' },
      CLINICA,
    );
  });

  it('pagamento de honorário: o webhook não mexe na parcela nem lança receita por aqui', async () => {
    const m = mundo({ conta: CLINICA, charges: [aberta({ tenant_id: CLINICA })] });
    await m.webhook(m.cobrancaDe('par-1'), 'RECEIVED');
    expect(m.parcela('par-1').status).toBe('PENDENTE');
    expect(m.prisma.leadHonorarioPayment.updateMany).not.toHaveBeenCalled();
    expect(m.prisma.financialTransaction.create).not.toHaveBeenCalled();
  });

  it('cancelar sem a exigência do laboratório: Asaas fora do ar mantém o apagamento (best-effort)', async () => {
    const m = mundo({ conta: CLINICA, charges: [aberta({ tenant_id: CLINICA })] });
    m.asaas.deleteCharge.mockRejectedValue(new Error('[Asaas] Falha: timeout'));
    m.asaas.getCharge.mockRejectedValue(new Error('timeout'));
    const r = await m.svc.deleteCharge('pay_vivo', CLINICA, { userId: 'u-1', reason: 'motivo' });
    expect(r).toEqual({ deleted: true, asaasSynced: false });
    expect(m.cobrancaDe('par-1').status).toBe('DELETED');
  });

  it('cura da receita sem laboratório: o where de sempre', async () => {
    const m = mundo({ conta: CLINICA });
    await m.svc.ensureReceitaBackfillCron();
    expect(m.prisma.paymentGatewayCharge.count.mock.calls[0][0].where).toEqual({
      gateway: 'ASAAS',
      status: 'RECEIVED',
      transaction_id: null,
      lead_honorario_payment_id: null,
      paid_at: { gte: expect.any(Date) },
    });
  });
});
