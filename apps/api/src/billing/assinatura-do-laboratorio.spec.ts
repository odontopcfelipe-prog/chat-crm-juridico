/**
 * Mensalidade do laboratório: a mesma conta Asaas da assinatura das clínicas (lida
 * sem conta), pagamento sempre conferido no Asaas e a clínica no caminho de sempre.
 */
import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { invalidarCacheLabTenants } from '@crm/shared';
import { BillingService } from './billing.service';
import {
  AssinaturaDoLaboratorioService,
  MSG_ASAAS_FORA,
  MSG_ASSINATURA_INDISPONIVEL,
  MSG_ASSINATURA_JA_CRIADA,
} from './assinatura-do-laboratorio.service';
import {
  chamarAsaas,
  dataDoPagamento,
  ErroDoAsaas,
  lerContaDaPlataforma,
  primeiroEmAberto,
  ultimoPago,
  umMesDepois,
} from './conta-asaas-da-plataforma';

const LAB = '11111111-1111-4111-8111-111111111111';
const CLINICA = '22222222-2222-4222-8222-222222222222';
const SUB = 'sub-local-1';
const AGORA = new Date('2026-11-03T15:00:00Z');
const CHAVE = '$aact_chave_da_assinatura';
const PRODUCAO = 'https://api.asaas.com/v3';

beforeEach(() => invalidarCacheLabTenants());

/** A conta da assinatura das clínicas, como o AsaasClient devolve (sem chave: apiKey vazia). */
function contaDaAssinatura(comChave = true) {
  return {
    getConfig: jest.fn(async (..._conta: unknown[]) => ({
      apiKey: comChave ? CHAVE : '',
      baseUrl: PRODUCAO,
      sandbox: false,
      webhookToken: '',
    })),
  };
}

/**
 * fetch falso: responde por "METODO caminho-sem-base" e guarda as chamadas. A chave
 * gravada é a do cabeçalho access_token, o único em que o Asaas lê a chave.
 */
function asaasFalso(respostas: Record<string, (corpo: any) => { status?: number; json: any }>) {
  const chamadas: Array<{ metodo: string; url: string; chave: string; agente: string; corpo: any }> = [];
  const fn = jest.fn(async (url: string, init: any) => {
    const metodo = init?.method ?? 'GET';
    const corpo = init?.body ? JSON.parse(init.body) : undefined;
    chamadas.push({ metodo, url, chave: init?.headers?.access_token, agente: init?.headers?.['User-Agent'], corpo });
    const caminho = url.replace(/^https:\/\/api(-sandbox)?\.asaas\.com\/v3/, '');
    const chave = Object.keys(respostas).find((k) => `${metodo} ${caminho}`.startsWith(k));
    const r = chave ? respostas[chave](corpo) : { status: 404, json: { errors: [{ description: 'não achado' }] } };
    const status = r.status ?? 200;
    return { ok: status < 400, status, text: async () => JSON.stringify(r.json), json: async () => r.json } as any;
  });
  (global as any).fetch = fn;
  return { fn, chamadas };
}

afterEach(() => {
  delete (global as any).fetch;
});

describe('conta Asaas da assinatura (a mesma das clínicas)', () => {
  it('lida sem conta; sem chave ou com erro na leitura, null', async () => {
    const asaas = contaDaAssinatura();
    asaas.getConfig.mockResolvedValueOnce({ apiKey: `  ${CHAVE}  `, baseUrl: 'https://api-sandbox.asaas.com/v3', sandbox: true, webhookToken: '' });
    expect(await lerContaDaPlataforma(asaas)).toEqual({ apiKey: CHAVE, baseUrl: 'https://api-sandbox.asaas.com/v3', sandbox: true });
    expect(asaas.getConfig).toHaveBeenCalledWith();

    expect(await lerContaDaPlataforma(contaDaAssinatura(false))).toBeNull();
    asaas.getConfig.mockRejectedValueOnce(new Error('banco fora'));
    expect(await lerContaDaPlataforma(asaas)).toBeNull();
  });

  it('erro do Asaas vira ErroDoAsaas com status e a descrição dele', async () => {
    asaasFalso({ 'GET /customers': () => ({ status: 401, json: { errors: [{ description: 'Chave inválida' }] } }) });
    const erro = await chamarAsaas({ apiKey: CHAVE, sandbox: false, baseUrl: 'https://api.asaas.com/v3' }, 'GET', '/customers').catch((e) => e);
    expect(erro).toBeInstanceOf(ErroDoAsaas);
    expect([erro.status, erro.descricao]).toEqual([401, 'Chave inválida']);
  });

  it('pagos, em aberto e o próximo vencimento', () => {
    const lista = [
      { id: 'p1', status: 'RECEIVED', dueDate: '2026-11-04' },
      { id: 'p2', status: 'CONFIRMED', dueDate: '2026-12-04' },
      { id: 'p3', status: 'PENDING', dueDate: '2027-01-04', invoiceUrl: 'https://www.asaas.com/i/p3' },
      { id: 'p4', status: 'OVERDUE', dueDate: '2026-10-04' },
      { id: 'p5', status: 'REFUNDED', dueDate: '2027-02-04' },
      { id: '', status: 'RECEIVED', dueDate: '2030-01-01' },
      { id: 'p6', status: 'RECEIVED', dueDate: '04/11/2026' },
      null,
    ];
    expect(ultimoPago(lista)?.id).toBe('p2');
    expect(primeiroEmAberto(lista)?.id).toBe('p4');
    expect(ultimoPago([])).toBeNull();
    expect(primeiroEmAberto([{ id: 'x', status: 'RECEIVED', dueDate: '2026-11-04' }])).toBeNull();

    expect(umMesDepois('2026-11-04').toISOString()).toBe('2026-12-04T12:00:00.000Z');
    expect(umMesDepois('2026-12-15').toISOString()).toBe('2027-01-15T12:00:00.000Z');
    expect(umMesDepois('2027-01-31').toISOString()).toBe('2027-02-28T12:00:00.000Z');

    expect(dataDoPagamento({ id: 'a', status: 'RECEIVED', dueDate: '2026-11-04', clientPaymentDate: '2026-11-02' }, AGORA).toISOString()).toBe(
      '2026-11-02T12:00:00.000Z',
    );
    expect(dataDoPagamento({ id: 'a', status: 'RECEIVED', dueDate: '2026-11-04' }, AGORA)).toBe(AGORA);
  });
});

/** Prisma falso do laboratório: tenant, plano, assinatura e perfis. */
function montar(opts: { conta?: boolean; sub?: any; tenant?: any; labs?: string[] } = {}) {
  const asaas = contaDaAssinatura(opts.conta !== false);
  let sub: any = opts.sub ?? null;
  const trava = jest.fn(async () => 0);
  const prisma: any = {
    $transaction: jest.fn(async (fn: any) => fn({ $executeRaw: trava })),
    tenantBusinessProfile: {
      findMany: jest.fn(async () => (opts.labs ?? [LAB]).map((t) => ({ tenant_id: t }))),
      findUnique: jest.fn(async (a: any) => ((opts.labs ?? [LAB]).includes(a.where.tenant_id) ? { business_type: 'LABORATORIO' } : null)),
    },
    tenant: {
      findUnique: jest.fn(async () =>
        opts.tenant === null
          ? null
          : { id: LAB, name: 'Laboratório Sorriso', cpf_cnpj: '11222333000181', email: 'ana@lab.teste', phone: '5582999990000', status: 'TRIAL', trial_ends_at: AGORA, ...(opts.tenant ?? {}) },
      ),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    saasPlan: {
      findUnique: jest.fn(async (a: any) =>
        a.where.slug === 'pro' ? { id: 'plano-pro', slug: 'pro', name: 'Pro', price_monthly: '90.00', active: true } : null,
      ),
    },
    saasSubscription: {
      findUnique: jest.fn(async () => sub),
      findMany: jest.fn(async () => (sub ? [{ id: sub.id }] : [])),
      upsert: jest.fn(async (a: any) => {
        sub = { id: SUB, ...a.create };
        return sub;
      }),
      updateMany: jest.fn(async (a: any) => {
        if (!sub || sub.current_charge_id !== a.where.current_charge_id) return { count: 0 };
        sub = { ...sub, ...a.data };
        return { count: 1 };
      }),
    },
  };
  return { prisma, trava, asaas, svc: new AssinaturaDoLaboratorioService(prisma, asaas as any), atual: () => sub };
}

const pagamentosDe = (lista: any[]) => () => ({ json: { data: lista } });

describe('assinatura do laboratório', () => {
  it('sem a chave da conta da assinatura: 409 e nada é criado em conta nenhuma', async () => {
    const { prisma, svc } = montar({ conta: false });
    const { fn } = asaasFalso({});
    const erro = await svc.checkout(LAB, { plan_slug: 'pro', billing_type: 'PIX' }).catch((e) => e);
    expect(erro).toBeInstanceOf(ConflictException);
    expect(erro.message).toBe(MSG_ASSINATURA_INDISPONIVEL);
    expect(fn).not.toHaveBeenCalled();
    expect(prisma.saasSubscription.upsert).not.toHaveBeenCalled();
  });

  it.each([[undefined], ['DINHEIRO'], [1]])('forma de pagamento %p → 400 sem chamar o Asaas', async (forma) => {
    const { svc } = montar();
    const { fn } = asaasFalso({});
    await expect(svc.checkout(LAB, { plan_slug: 'pro', billing_type: forma })).rejects.toBeInstanceOf(BadRequestException);
    expect(fn).not.toHaveBeenCalled();
  });

  it('é laboratório? lê o perfil direto; se a leitura falhar, lança (nunca cai no caminho da clínica)', async () => {
    const { prisma, svc } = montar();
    expect(await svc.ehLaboratorio(LAB)).toBe(true);
    expect(await svc.ehLaboratorio(CLINICA)).toBe(false);
    prisma.tenantBusinessProfile.findUnique.mockRejectedValueOnce(new Error('banco fora'));
    await expect(svc.ehLaboratorio(LAB)).rejects.toThrow('banco fora');
  });

  it('assina na conta da assinatura das clínicas, sob trava por conta: cliente, assinatura mensal, plano na conta e o link da 1ª mensalidade', async () => {
    const { prisma, trava, asaas, svc, atual } = montar();
    const { chamadas } = asaasFalso({
      'GET /customers?externalReference=': () => ({ json: { data: [] } }),
      'POST /customers': () => ({ json: { id: 'cus_1' } }),
      'POST /subscriptions': () => ({ json: { id: 'sub_asaas_1' } }),
      'GET /subscriptions/sub_asaas_1/payments': pagamentosDe([
        { id: 'pay_1', status: 'PENDING', dueDate: '2026-11-04', value: 90, invoiceUrl: 'https://www.asaas.com/i/pay_1' },
      ]),
    });

    const r = await svc.checkout(LAB, { plan_slug: 'pro', billing_type: 'BOLETO' }, AGORA);

    expect(trava).toHaveBeenCalledTimes(1);
    expect(trava.mock.calls[0]).toContain(`assinatura-lab:${LAB}`);
    expect(chamadas.every((c) => c.chave === CHAVE && c.url.startsWith('https://api.asaas.com/v3/'))).toBe(true);
    expect(chamadas.every((c) => c.agente === 'LexCRM/1.0')).toBe(true);
    // A conta é lida sempre sem conta: nunca a conta Asaas do laboratório.
    expect(asaas.getConfig).toHaveBeenCalled();
    expect(asaas.getConfig.mock.calls.every((args) => args.length === 0)).toBe(true);
    // Sem telefone: o do cadastro está no formato do WhatsApp, que o Asaas pode recusar.
    expect(chamadas.find((c) => c.metodo === 'POST' && c.url.endsWith('/customers'))!.corpo).toEqual({
      name: 'Laboratório Sorriso',
      cpfCnpj: '11222333000181',
      email: 'ana@lab.teste',
      externalReference: `saas-tenant-${LAB}`,
    });
    expect(chamadas.find((c) => c.url.endsWith('/subscriptions'))!.corpo).toEqual({
      customer: 'cus_1',
      billingType: 'BOLETO',
      value: 90,
      nextDueDate: '2026-11-04',
      cycle: 'MONTHLY',
      description: 'Mensalidade Pro - Laboratório Sorriso',
      externalReference: `saas-sub-${LAB}`,
    });
    expect(atual()).toMatchObject({
      tenant_id: LAB,
      plan_id: 'plano-pro',
      status: 'PENDING_PAYMENT',
      asaas_customer_id: 'cus_1',
      asaas_subscription_id: 'sub_asaas_1',
      current_charge_id: null,
      billing_type: 'BOLETO',
    });
    expect(prisma.tenant.update).toHaveBeenCalledWith({ where: { id: LAB }, data: { plan: 'PRO' } });
    // Assinar não ativa a conta: só o pagamento ativa.
    expect(prisma.tenant.updateMany).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, subscription_id: 'sub_asaas_1', plan: 'Pro', link_pagamento: 'https://www.asaas.com/i/pay_1' });
  });

  it('cliente já existente na plataforma (pela referência) é reaproveitado', async () => {
    const { svc } = montar();
    const { chamadas } = asaasFalso({
      'GET /customers?externalReference=': () => ({ json: { data: [{ id: 'cus_antigo' }] } }),
      'GET /subscriptions?customer=cus_antigo': () => ({ json: { data: [] } }),
      'POST /subscriptions': () => ({ json: { id: 'sub_asaas_2' } }),
      'GET /subscriptions/sub_asaas_2/payments': pagamentosDe([]),
    });
    const r = await svc.checkout(LAB, { plan_slug: 'pro', billing_type: 'PIX' }, AGORA);
    expect(chamadas.some((c) => c.metodo === 'POST' && c.url.endsWith('/customers'))).toBe(false);
    expect(chamadas.find((c) => c.url.endsWith('/subscriptions'))!.corpo.customer).toBe('cus_antigo');
    expect(r.link_pagamento).toBeNull();
  });

  it.each([['ACTIVE'], ['PAST_DUE'], ['PENDING_PAYMENT']])(
    'assinatura já criada (%s): 409, troca só com o suporte — nada muda no Asaas',
    async (status) => {
      const { svc, atual } = montar({
        sub: { id: SUB, tenant_id: LAB, status, asaas_subscription_id: 'sub_asaas_1', current_charge_id: null },
      });
      const { fn } = asaasFalso({});
      const erro = await svc.checkout(LAB, { plan_slug: 'pro', billing_type: 'PIX' }, AGORA).catch((e) => e);
      expect(erro).toBeInstanceOf(ConflictException);
      expect(erro.message).toBe(MSG_ASSINATURA_JA_CRIADA);
      expect(fn).not.toHaveBeenCalled();
      expect(atual().asaas_subscription_id).toBe('sub_asaas_1');
    },
  );

  it('assinatura que ficou no Asaas sem chegar ao banco: sem pagamento, é apagada antes de criar a nova', async () => {
    const { svc, atual } = montar();
    const { chamadas } = asaasFalso({
      'GET /customers?externalReference=': () => ({ json: { data: [{ id: 'cus_1' }] } }),
      'GET /subscriptions?customer=cus_1': () => ({ json: { data: [{ id: 'sub_solta' }] } }),
      'GET /subscriptions/sub_solta/payments': pagamentosDe([{ id: 'pay_s', status: 'PENDING', dueDate: '2026-11-04' }]),
      'DELETE /subscriptions/sub_solta': () => ({ json: { deleted: true } }),
      'POST /subscriptions': () => ({ json: { id: 'sub_nova' } }),
      'GET /subscriptions/sub_nova/payments': pagamentosDe([]),
    });
    await svc.checkout(LAB, { plan_slug: 'pro', billing_type: 'CREDIT_CARD' }, AGORA);
    const ordem = chamadas.map((c) => `${c.metodo} ${c.url.replace('https://api.asaas.com/v3', '')}`);
    expect(ordem.indexOf('DELETE /subscriptions/sub_solta')).toBeLessThan(ordem.indexOf('POST /subscriptions'));
    expect(atual()).toMatchObject({ asaas_subscription_id: 'sub_nova', status: 'PENDING_PAYMENT', billing_type: 'CREDIT_CARD' });
  });

  it('assinatura fora do banco e já paga: 409 (suporte), sem apagar nem criar', async () => {
    const { svc, atual } = montar();
    const { chamadas } = asaasFalso({
      'GET /customers?externalReference=': () => ({ json: { data: [{ id: 'cus_1' }] } }),
      'GET /subscriptions?customer=cus_1': () => ({ json: { data: [{ id: 'sub_paga' }] } }),
      'GET /subscriptions/sub_paga/payments': pagamentosDe([{ id: 'pay_p', status: 'RECEIVED', dueDate: '2026-11-04' }]),
    });
    const erro = await svc.checkout(LAB, { plan_slug: 'pro', billing_type: 'PIX' }, AGORA).catch((e) => e);
    expect(erro).toBeInstanceOf(ConflictException);
    expect(chamadas.some((c) => c.metodo !== 'GET')).toBe(false);
    expect(atual()).toBeNull();
  });

  it('erro do Asaas vira mensagem para a tela; Asaas fora do ar vira "tente de novo"', async () => {
    const { svc } = montar();
    asaasFalso({ 'GET /customers?externalReference=': () => ({ status: 400, json: { errors: [{ description: 'CPF/CNPJ inválido' }] } }) });
    const recusa = await svc.checkout(LAB, { plan_slug: 'pro', billing_type: 'PIX' }, AGORA).catch((e) => e);
    expect(recusa).toBeInstanceOf(BadRequestException);
    expect(recusa.message).toBe('O Asaas recusou: CPF/CNPJ inválido');

    (global as any).fetch = jest.fn(async () => {
      throw new Error('timeout');
    });
    const fora = await svc.checkout(LAB, { plan_slug: 'pro', billing_type: 'PIX' }, AGORA).catch((e) => e);
    expect(fora).toBeInstanceOf(ServiceUnavailableException);
    expect(fora.message).toBe(MSG_ASAAS_FORA);
  });

  it('pagamento novo no Asaas: assinatura ativa, próximo vencimento e a conta ativa de novo — uma vez só', async () => {
    const { prisma, svc, atual } = montar({
      sub: { id: SUB, tenant_id: LAB, status: 'PENDING_PAYMENT', asaas_subscription_id: 'sub_asaas_1', current_charge_id: null },
    });
    asaasFalso({
      'GET /subscriptions/sub_asaas_1/payments': pagamentosDe([
        { id: 'pay_1', status: 'CONFIRMED', dueDate: '2026-11-04', paymentDate: '2026-11-03' },
        { id: 'pay_2', status: 'PENDING', dueDate: '2026-12-04', invoiceUrl: 'https://www.asaas.com/i/pay_2' },
      ]),
    });

    const r = await svc.sincronizar(SUB, undefined, AGORA);
    expect(r.aplicado).toBe(true);
    expect(r.emAberto?.id).toBe('pay_2');
    expect(atual()).toMatchObject({ status: 'ACTIVE', current_charge_id: 'pay_1' });
    expect(atual().next_charge_date.toISOString()).toBe('2026-12-04T12:00:00.000Z');
    expect(atual().last_paid_at.toISOString()).toBe('2026-11-03T12:00:00.000Z');
    expect(prisma.tenant.updateMany).toHaveBeenCalledWith({
      where: { id: LAB, status: { not: 'DELETED' } },
      data: { status: 'ACTIVE', suspended_at: null, suspended_reason: null },
    });

    // Mesma leitura de novo (aviso repetido, passada de hora em hora): nada muda.
    const outra = await svc.sincronizar(SUB, undefined, AGORA);
    expect(outra.aplicado).toBe(false);
    expect(prisma.tenant.updateMany).toHaveBeenCalledTimes(1);
  });

  it('estorno do pagamento atual não faz o anterior valer de novo (nem reativa a conta)', async () => {
    const { prisma, svc, atual } = montar({
      sub: { id: SUB, tenant_id: LAB, status: 'ACTIVE', asaas_subscription_id: 'sub_asaas_1', current_charge_id: 'pay_2' },
    });
    asaasFalso({
      'GET /subscriptions/sub_asaas_1/payments': pagamentosDe([
        { id: 'pay_1', status: 'RECEIVED', dueDate: '2026-10-04' },
        { id: 'pay_2', status: 'REFUNDED', dueDate: '2026-11-04' },
      ]),
    });
    expect((await svc.sincronizar(SUB, undefined, AGORA)).aplicado).toBe(false);
    expect(atual().current_charge_id).toBe('pay_2');
    expect(prisma.saasSubscription.updateMany).not.toHaveBeenCalled();
    expect(prisma.tenant.updateMany).not.toHaveBeenCalled();
  });

  it('pagou a mais nova com uma antiga vencida: o próximo vencimento é a antiga; atrasada há mais de 5 dias não reativa', async () => {
    const { prisma, svc, atual } = montar({
      sub: { id: SUB, tenant_id: LAB, status: 'PAST_DUE', asaas_subscription_id: 'sub_asaas_1', current_charge_id: 'pay_1' },
    });
    asaasFalso({
      'GET /subscriptions/sub_asaas_1/payments': pagamentosDe([
        { id: 'pay_1', status: 'RECEIVED', dueDate: '2026-09-04' },
        { id: 'pay_2', status: 'OVERDUE', dueDate: '2026-10-04' },
        { id: 'pay_3', status: 'RECEIVED', dueDate: '2026-11-04' },
      ]),
    });
    expect((await svc.sincronizar(SUB, undefined, AGORA)).aplicado).toBe(true);
    expect(atual()).toMatchObject({ status: 'PAST_DUE', current_charge_id: 'pay_3' });
    expect(atual().next_charge_date.toISOString()).toBe('2026-10-04T12:00:00.000Z');
    expect(prisma.tenant.updateMany).not.toHaveBeenCalled();
  });

  it('duas leituras ao mesmo tempo: só quem troca o pagamento reativa a conta', async () => {
    const { prisma, svc } = montar({
      sub: { id: SUB, tenant_id: LAB, status: 'PENDING_PAYMENT', asaas_subscription_id: 'sub_asaas_1', current_charge_id: null },
    });
    prisma.saasSubscription.updateMany.mockResolvedValueOnce({ count: 0 });
    asaasFalso({ 'GET /subscriptions/sub_asaas_1/payments': pagamentosDe([{ id: 'pay_1', status: 'RECEIVED', dueDate: '2026-11-04' }]) });
    expect((await svc.sincronizar(SUB, undefined, AGORA)).aplicado).toBe(false);
    expect(prisma.tenant.updateMany).not.toHaveBeenCalled();
  });

  it('tela do laboratório: o pagamento em aberto (só link https) e se a assinatura está disponível', async () => {
    const { svc } = montar({
      sub: { id: SUB, tenant_id: LAB, status: 'PENDING_PAYMENT', asaas_subscription_id: 'sub_asaas_1', current_charge_id: null },
    });
    asaasFalso({
      'GET /subscriptions/sub_asaas_1/payments': pagamentosDe([
        { id: 'pay_1', status: 'PENDING', dueDate: '2026-11-04', value: 90, invoiceUrl: 'javascript:alert(1)' },
      ]),
    });
    const r = await svc.minhaAssinatura(LAB);
    expect(r.assinatura_disponivel).toBe(true);
    expect(r.pagamento_pendente).toEqual({ link: null, vencimento: '2026-11-04', valor: 90 });

    const semConta = montar({ conta: false });
    const { fn } = asaasFalso({});
    const r2 = await semConta.svc.minhaAssinatura(LAB);
    expect(r2).toMatchObject({ assinatura_disponivel: false, pagamento_pendente: null });
    expect(fn).not.toHaveBeenCalled();
  });

  it('passada de hora em hora: sem a chave da conta da assinatura ou sem laboratório, não lê nada', async () => {
    const semConta = montar({ conta: false });
    expect(await semConta.svc.sincronizarPendentes(AGORA)).toBe(0);
    expect(semConta.prisma.saasSubscription.findMany).not.toHaveBeenCalled();

    const semLab = montar({ labs: [] });
    expect(await semLab.svc.sincronizarPendentes(AGORA)).toBe(0);
    expect(semLab.prisma.saasSubscription.findMany).not.toHaveBeenCalled();
  });

  it('passada de hora em hora: só assinaturas de laboratório e aplica o pagamento novo', async () => {
    const { prisma, svc } = montar({
      sub: { id: SUB, tenant_id: LAB, status: 'PENDING_PAYMENT', asaas_subscription_id: 'sub_asaas_1', current_charge_id: null },
    });
    asaasFalso({ 'GET /subscriptions/sub_asaas_1/payments': pagamentosDe([{ id: 'pay_1', status: 'RECEIVED', dueDate: '2026-11-04' }]) });
    expect(await svc.sincronizarPendentes(AGORA)).toBe(1);
    expect(prisma.saasSubscription.findMany.mock.calls[0][0].where.tenant_id).toEqual({ in: [LAB] });
  });
});

describe('BillingService: laboratório desvia, clínica no caminho de sempre', () => {
  function servico(ehLab: boolean) {
    const lab: any = {
      ehLaboratorio: jest.fn(async () => ehLab),
      checkout: jest.fn(async () => ({ ok: true, lab: true })),
      minhaAssinatura: jest.fn(async () => ({ lab: true })),
      sincronizar: jest.fn(async () => ({ aplicado: true, emAberto: null })),
    };
    const asaas: any = { createCustomer: jest.fn(async () => ({ id: 'cus_global' })), getConfig: jest.fn() };
    const prisma: any = {
      tenant: {
        findUnique: jest.fn(async () => ({ id: CLINICA, name: 'Clínica', cpf_cnpj: '1', email: 'c@c.c' })),
        update: jest.fn(async () => ({})),
      },
      saasPlan: { findUnique: jest.fn(async () => null) },
      saasSubscription: {
        findUnique: jest.fn(async () => null),
        findFirst: jest.fn(async () => ({ id: SUB, tenant_id: ehLab ? LAB : CLINICA, next_charge_date: AGORA })),
        update: jest.fn(async () => ({})),
      },
    };
    return { lab, asaas, prisma, svc: new BillingService(prisma, asaas, lab) };
  }

  it('laboratório: checkout e tela vão para a assinatura do laboratório (não passam pelo caminho da clínica)', async () => {
    const { lab, asaas, svc } = servico(true);
    expect(await svc.checkout(LAB, { plan_slug: 'pro', billing_type: 'PIX' })).toEqual({ ok: true, lab: true });
    expect(await svc.getSubscriptionForTenant(LAB)).toEqual({ lab: true });
    expect(lab.checkout).toHaveBeenCalledWith(LAB, { plan_slug: 'pro', billing_type: 'PIX' });
    expect(asaas.createCustomer).not.toHaveBeenCalled();
  });

  it('laboratório: o aviso de pagamento só pede a leitura no Asaas; o corpo do aviso não ativa nada', async () => {
    const { lab, prisma, svc } = servico(true);
    await svc.handlePaymentReceived({ id: 'pay_x', subscription: 'sub_asaas_1' });
    expect(lab.sincronizar).toHaveBeenCalledWith(SUB);
    expect(prisma.saasSubscription.update).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();

    lab.sincronizar.mockRejectedValueOnce(new Error('Asaas fora'));
    await expect(svc.handlePaymentReceived({ id: 'pay_x', subscription: 'sub_asaas_1' })).resolves.toBeUndefined();
  });

  it('clínica: o mesmo de antes (conta global, aviso ativa a conta)', async () => {
    const { lab, asaas, prisma, svc } = servico(false);
    await expect(svc.checkout(CLINICA, { plan_slug: 'pro', billing_type: 'PIX' })).rejects.toThrow('Plano invalido');
    expect(lab.checkout).not.toHaveBeenCalled();

    await svc.handlePaymentReceived({ id: 'pay_c', subscription: 'sub_c' });
    expect(lab.sincronizar).not.toHaveBeenCalled();
    expect(prisma.saasSubscription.update).toHaveBeenCalled();
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: CLINICA },
      data: { status: 'ACTIVE', suspended_at: null, suspended_reason: null },
    });
    expect(asaas.createCustomer).not.toHaveBeenCalled();
  });

  it('clínica: a assinatura vai ao Asaas com a chave em access_token, na mesma conta (lida sem conta)', async () => {
    const { asaas, prisma, svc } = servico(false);
    prisma.saasPlan.findUnique.mockResolvedValueOnce({ id: 'plano-pro', slug: 'pro', name: 'Pro', price_monthly: '90.00', active: true });
    prisma.saasSubscription.create = jest.fn(async () => ({}));
    asaas.getConfig.mockResolvedValue({ apiKey: CHAVE, baseUrl: PRODUCAO, sandbox: false, webhookToken: '' });
    const { chamadas } = asaasFalso({ 'POST /subscriptions': () => ({ json: { id: 'sub_c' } }) });

    expect(await svc.checkout(CLINICA, { plan_slug: 'pro', billing_type: 'PIX' })).toMatchObject({ ok: true, subscription_id: 'sub_c' });
    expect(chamadas).toHaveLength(1);
    expect([chamadas[0].url, chamadas[0].chave, chamadas[0].agente]).toEqual([`${PRODUCAO}/subscriptions`, CHAVE, 'LexCRM/1.0']);
    expect(asaas.getConfig.mock.calls.every((args: unknown[]) => args.length === 0)).toBe(true);
    expect(prisma.saasSubscription.create).toHaveBeenCalled();
  });
});
