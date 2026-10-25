/**
 * F0a — retrato de comportamento "clínica idêntica": a RECEITA no caixa.
 *
 * Toda cobrança de clínica recebida (webhook do Asaas, baixa na clínica,
 * maquineta, backfill do cron) passa por PaymentGatewayService.ensureChargeReceita,
 * que lança a FinancialTransaction RECEITA PAGO, amarra na cobrança e libera as
 * comissões do plano. É o dinheiro que aparece em Entradas, no fechamento do
 * caixa e nos KPIs. As fases do laboratório NÃO podem mudar esse lançamento
 * para as clínicas — nem para cobrança legada (kind null), nem SINAL, ENTRADA ou
 * INSTALLMENT.
 *
 * Três camadas:
 *   1) ensureChargeReceita com as opções de cada caminho → payload da RECEITA;
 *   2) os caminhos reais (registerClinicReceipt, confirmCartaoReceipt, ramo
 *      RECEIVED do handleWebhook, ensureReceitaBackfillCron) → com que opções
 *      chamam o ensureChargeReceita, a marca de recebida e o AuditLog da baixa;
 *   3) os 403 PERMISSION_DENIED de receive-in-cash e confirm-cartao por setor.
 *
 * O `$transaction` do mock entrega um cliente próprio (`tx.`) e marca
 * `$transaction:fim`: escrita da RECEITA fora da trava anti-corrida (pelo
 * prisma de fora, ou depois do fim da transação) muda a sequência e reprova.
 *
 * Service real, construído com `new` e Prisma mockado (só o que cada caminho
 * usa). Relógio fixo. Se a mudança for de propósito para as clínicas:
 * `npx jest __guards__/receita-clinica -u` em apps/api e commite o .snap junto.
 */
import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@crm/shared';
import { PermissionsGuard } from '../auth/decorators/requires-permission.decorator';
import { PaymentGatewayController } from '../payment-gateway/payment-gateway.controller';
import { PaymentGatewayService } from '../payment-gateway/payment-gateway.service';

const TENANT = 'tenant-clinica-1';
const AGORA = new Date('2026-10-20T15:00:00.000Z');
const PAGO_EM = new Date('2026-10-19T13:30:00.000Z');
const DATA_PAGAMENTO = new Date('2026-10-19T00:00:00.000Z');
const FIM_TX = '$transaction:fim';

type Kind = null | 'SINAL' | 'ENTRADA' | 'INSTALLMENT';

/** Cobrança de clínica como o ensureChargeReceita lê (findUnique com include). */
function cobranca(kind: Kind, over: Record<string, any> = {}) {
  const porKind: Record<string, Record<string, any>> = {
    null: { billing_type: 'PIX', amount: new Prisma.Decimal('1200.00'), description: 'Plano de tratamento — Ana Teste [plan:plan-1]' },
    SINAL: { billing_type: 'PIX', amount: new Prisma.Decimal('300.00'), description: 'Sinal — Ana Teste [plan:plan-1]' },
    ENTRADA: { billing_type: 'BOLETO', amount: new Prisma.Decimal('700.00'), description: 'Entrada — Ana Teste [plan:plan-1]' },
    INSTALLMENT: {
      billing_type: 'BOLETO',
      amount: new Prisma.Decimal('250.00'),
      description: 'Parcelas 10x R$ 250 — Ana Teste [plan:plan-1]',
      installment_id: 'inst-3',
    },
  };
  return {
    id: `ch-${kind ?? 'legado'}`,
    tenant_id: TENANT,
    transaction_id: null,
    installment_id: null,
    external_id: `pay_${kind ?? 'legado'}_001`,
    status: 'RECEIVED',
    paid_at: PAGO_EM,
    payment_date: DATA_PAGAMENTO,
    treatment_plan_id: 'plan-1',
    patient_id: 'pac-1',
    lead_honorario_payment_id: null,
    kind,
    treatment_plan: {
      patient: { name: 'Ana Teste', lead_id: 'lead-ana' },
      quote: { created_by_user_id: 'dentista-1' },
    },
    patient: { name: 'Ana Teste', lead_id: 'lead-ana' },
    ...porKind[String(kind)],
    ...over,
  };
}

/** Cobrança ainda a receber, como o registerClinicReceipt / confirmCartaoReceipt leem (findFirst). */
function aReceber(kind: Kind, over: Record<string, any> = {}) {
  return cobranca(kind, {
    status: 'PENDING',
    paid_at: null,
    payment_date: null,
    received_at: null,
    received_by_user_id: null,
    received_in_cash: false,
    cancelled_at: null,
    ...over,
  });
}

/**
 * Prisma mockado que grava a sequência de operações (com os argumentos).
 * O `$transaction(cb, opts)` roda o callback com um cliente PRÓPRIO, cujas
 * operações saem com o prefixo `tx.`, e grava `$transaction:fim` ao terminar.
 */
function montar(
  charge: any,
  opts: { travaJaLancada?: string; comissoesDevidas?: string[]; asaas?: any } = {},
) {
  const ops: Array<{ op: string; args: any }> = [];
  const rec = (op: string, ret: any) => (args?: any) => {
    ops.push({ op, args });
    return Promise.resolve(typeof ret === 'function' ? ret(args) : ret);
  };
  const executeRaw = (op: string) => (sql: TemplateStringsArray, ...valores: any[]) => {
    ops.push({ op, args: { sql: sql.join('$'), valores } });
    return Promise.resolve(1);
  };
  const devidas = opts.comissoesDevidas ?? ['com-1', 'com-2'];

  // Cliente da transação: só o que o ensureChargeReceita faz dentro da trava.
  const tx: any = {
    paymentGatewayCharge: {
      // Releitura dentro da trava: só transaction_id.
      findUnique: rec('tx.paymentGatewayCharge.findUnique', { transaction_id: opts.travaJaLancada ?? null }),
      update: rec('tx.paymentGatewayCharge.update', {}),
    },
    financialTransaction: { create: rec('tx.financialTransaction.create', { id: 'receita-1' }) },
    $executeRaw: executeRaw('tx.$executeRaw'),
  };

  const prisma: any = {
    paymentGatewayCharge: {
      findUnique: rec('paymentGatewayCharge.findUnique', charge),
      findFirst: rec('paymentGatewayCharge.findFirst', charge),
      update: rec('paymentGatewayCharge.update', (a: any) => ({ ...charge, ...a.data })),
      updateMany: rec('paymentGatewayCharge.updateMany', { count: 1 }),
      count: rec('paymentGatewayCharge.count', 1),
      findMany: rec('paymentGatewayCharge.findMany', [
        { id: charge?.id, external_id: charge?.external_id, tenant_id: charge?.tenant_id },
      ]),
    },
    // Mesmo retorno do tx: a escrita pelo prisma de fora reprova pela sequência, não pelo id.
    financialTransaction: { create: rec('financialTransaction.create', { id: 'receita-1' }) },
    treatmentPlan: { findUnique: rec('treatmentPlan.findUnique', { quote_id: 'quote-1' }) },
    commission: {
      findMany: rec('commission.findMany', devidas.map((id) => ({ id }))),
      updateMany: rec('commission.updateMany', { count: devidas.length }),
    },
    auditLog: { create: rec('auditLog.create', { id: 'audit-1' }) },
    $executeRaw: executeRaw('$executeRaw'),
    $transaction: async (cb: any, txOpts: any) => {
      ops.push({ op: '$transaction', args: txOpts });
      const r = await cb(tx);
      ops.push({ op: FIM_TX, args: null });
      return r;
    },
  };
  // Só o Prisma (e o Asaas no backfill) é usado por estes caminhos.
  const svc = new PaymentGatewayService(
    prisma, (opts.asaas ?? {}) as any, {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  const ensure = (o?: any): Promise<string | null> => (svc as any).ensureChargeReceita(charge?.id ?? 'ch-x', o);
  return { svc, ensure, ops, nomes: () => ops.map((o) => o.op), de: (op: string) => ops.filter((o) => o.op === op).map((o) => o.args) };
}

// As opções que cada caminho real passa ao ensureChargeReceita. A camada 2
// confere que os caminhos passam exatamente isto.
const OPCOES = {
  webhook: undefined,
  dinheiro: { paymentMethod: 'DINHEIRO', receivedInClinic: true, installments: undefined },
  maquineta3x: { paymentMethod: 'CARTAO', receivedInClinic: true, installments: 3 },
  backfill: { dateFromCharge: true },
};
const MODOS: Array<[string, any]> = [
  ['webhook do Asaas (online)', OPCOES.webhook],
  ['recebido na clínica — dinheiro (registerClinicReceipt)', OPCOES.dinheiro],
  ['recebido na clínica — maquineta 3x', OPCOES.maquineta3x],
  ['backfill do cron (dateFromCharge)', OPCOES.backfill],
];
const KINDS: Kind[] = [null, 'SINAL', 'ENTRADA', 'INSTALLMENT'];

// Trava, releitura, create e vínculo DENTRO da transação; comissões depois dela.
const TRAVA = [
  '$transaction',
  'tx.$executeRaw',
  'tx.paymentGatewayCharge.findUnique',
  'tx.financialTransaction.create',
  'tx.paymentGatewayCharge.update',
  FIM_TX,
];
const COMISSOES = ['treatmentPlan.findUnique', 'commission.findMany', 'commission.updateMany'];
const SEQUENCIA_COMPLETA = ['paymentGatewayCharge.findUnique', ...TRAVA, ...COMISSOES];

function relogioFixo() {
  jest.useFakeTimers({
    now: AGORA,
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
}

describe('retrato: RECEITA de cobrança de clínica — ensureChargeReceita (F0a)', () => {
  beforeEach(relogioFixo);

  afterEach(() => {
    jest.useRealTimers();
  });

  describe.each(KINDS.map((k) => [String(k ?? 'null (legado)'), k] as const))('kind %s', (_nome, kind) => {
    it.each(MODOS)('%s', async (_modo, opts) => {
      const m = montar(cobranca(kind));
      const r = await m.ensure(opts);

      expect(r).toBe('receita-1');
      expect(m.nomes()).toEqual(SEQUENCIA_COMPLETA);
      const [create] = m.de('tx.financialTransaction.create');
      expect(create).toMatchSnapshot('financialTransaction.create');
      expect(m.de('tx.paymentGatewayCharge.update')).toEqual([
        { where: { id: cobranca(kind).id }, data: { transaction_id: 'receita-1' } },
      ]);
    });
  });

  it('trava anti-corrida, vínculo na cobrança e liberação das comissões do plano', async () => {
    const m = montar(cobranca('INSTALLMENT'));
    await m.ensure(undefined);

    expect(m.ops).toMatchSnapshot();
  });

  it('cartão online (CREDIT_CARD, sem forma informada) entra como CARTAO', async () => {
    const m = montar(cobranca('SINAL', { billing_type: 'CREDIT_CARD' }));
    await m.ensure(undefined);
    expect(m.de('tx.financialTransaction.create')[0].data.payment_method).toBe('CARTAO');
  });

  it('boleto importado do Asaas (sem plano): cliente pelo paciente direto, sem dentista e sem comissão', async () => {
    const m = montar(cobranca(null, {
      billing_type: 'BOLETO',
      treatment_plan: null,
      treatment_plan_id: null,
      description: 'Mensalidade importada',
      patient: { name: 'Bruno Importado', lead_id: 'lead-bruno' },
    }));
    const r = await m.ensure(undefined);

    expect(r).toBe('receita-1');
    expect(m.nomes()).toEqual(['paymentGatewayCharge.findUnique', ...TRAVA]);
    expect(m.de('tx.financialTransaction.create')[0]).toMatchSnapshot();
  });

  it('cobrança sem paciente nenhum: descrição com "Paciente" e sem cliente', async () => {
    const m = montar(cobranca(null, { treatment_plan: null, treatment_plan_id: null, patient: null, description: null }));
    await m.ensure(undefined);
    const data = m.de('tx.financialTransaction.create')[0].data;
    expect(data.description).toBe('Recebimento — Paciente');
    expect(data.lead_id).toBeNull();
    expect(data.dentist_id).toBeNull();
  });

  it('já lançada (transaction_id na cobrança): devolve a receita existente e não grava nada', async () => {
    const m = montar(cobranca('ENTRADA', { transaction_id: 'receita-antiga' }));
    await expect(m.ensure(undefined)).resolves.toBe('receita-antiga');
    expect(m.nomes()).toEqual(['paymentGatewayCharge.findUnique']);
  });

  it('corrida: outro evento lançou dentro da trava → devolve a dele, não cria nem libera comissão de novo', async () => {
    const m = montar(cobranca('SINAL'), { travaJaLancada: 'receita-do-outro-evento' });
    await expect(m.ensure(undefined)).resolves.toBe('receita-do-outro-evento');
    expect(m.nomes()).toEqual([
      'paymentGatewayCharge.findUnique', '$transaction', 'tx.$executeRaw', 'tx.paymentGatewayCharge.findUnique', FIM_TX,
    ]);
  });

  it('jurídico (lead_honorario_payment_id) tem caixa próprio: não lança aqui', async () => {
    const m = montar(cobranca(null, { lead_honorario_payment_id: 'hon-1' }));
    await expect(m.ensure(undefined)).resolves.toBeNull();
    expect(m.nomes()).toEqual(['paymentGatewayCharge.findUnique']);
  });

  it('plano sem comissão DEVIDA: não chama o updateMany', async () => {
    const m = montar(cobranca('INSTALLMENT'), { comissoesDevidas: [] });
    await m.ensure(undefined);
    expect(m.nomes()).toEqual(SEQUENCIA_COMPLETA.slice(0, -1));
  });
});

describe('retrato: caminhos reais que lançam a RECEITA da clínica (F0a)', () => {
  let ensureEspiao: jest.SpyInstance;
  let promoveEspiao: jest.SpyInstance;

  beforeEach(() => {
    relogioFixo();
    // Passa direto pro método real: o retrato pega as opções E o lançamento que sai delas.
    ensureEspiao = jest.spyOn(PaymentGatewayService.prototype as any, 'ensureChargeReceita');
    // Promoção lead → paciente é outro assunto (fire-and-forget via ModuleRef): só grava a chamada.
    promoveEspiao = jest
      .spyOn(PaymentGatewayService.prototype as any, 'promoteLeadFromCharge')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  /** Tudo o que o caminho fez: chamadas ao ensureChargeReceita, promoção e operações no banco. */
  const retrato = (m: ReturnType<typeof montar>) => ({
    ensureChargeReceita: ensureEspiao.mock.calls,
    promoteLeadFromCharge: promoveEspiao.mock.calls,
    ops: m.ops,
  });

  it('baixa na clínica em dinheiro (receive-in-cash → registerClinicReceipt): marca recebida, RECEITA e AuditLog COBRANCA_BAIXA_MANUAL', async () => {
    const c = aReceber(null);
    const m = montar(c);
    const r = await m.svc.registerClinicReceipt(c.external_id, { userId: 'recep-1', origem: 'receive-in-cash' });

    expect(r).toEqual({ ok: true, transaction_id: 'receita-1', charge_id: c.id });
    expect(ensureEspiao.mock.calls).toEqual([[c.id, OPCOES.dinheiro]]);
    expect(m.nomes()).toEqual([
      'paymentGatewayCharge.findFirst', 'paymentGatewayCharge.update', ...SEQUENCIA_COMPLETA, 'auditLog.create',
    ]);
    expect(m.de('auditLog.create')[0].data.action).toBe('COBRANCA_BAIXA_MANUAL');
    expect(retrato(m)).toMatchSnapshot();
  });

  it('baixa na clínica na maquineta 3x (registerClinicReceipt com CARTAO e 3 parcelas)', async () => {
    const c = aReceber('SINAL');
    const m = montar(c);
    await m.svc.registerClinicReceipt(c.external_id, {
      paymentMethod: 'CARTAO', installments: 3, userId: 'recep-1', origem: 'receive-in-cash',
    });

    expect(ensureEspiao.mock.calls).toEqual([[c.id, OPCOES.maquineta3x]]);
    expect(retrato(m)).toMatchSnapshot();
  });

  it('confirmar cartão a receber (confirmCartaoReceipt, pelo Validar do Financeiro): CARTAO com as parcelas da descrição', async () => {
    const c = aReceber(null, { description: 'Venda — Ana Teste (cartão 3x · a receber) [plan:plan-1]' });
    const m = montar(c);
    await m.svc.confirmCartaoReceipt(c.id, TENANT, 'fin-1');

    expect(ensureEspiao.mock.calls).toEqual([[c.id, OPCOES.maquineta3x]]);
    expect(m.de('auditLog.create')[0].data).toMatchObject({
      action: 'COBRANCA_BAIXA_MANUAL',
      meta_json: { origem: 'confirm-cartao' },
    });
    expect(retrato(m)).toMatchSnapshot();
  });

  it('re-clique na baixa (já recebida): não grava AuditLog de novo nem duplica a RECEITA', async () => {
    const c = aReceber(null, { status: 'RECEIVED', received_in_cash: true, transaction_id: 'receita-antiga' });
    const m = montar(c);
    const r = await m.svc.registerClinicReceipt(c.external_id, { userId: 'recep-1', origem: 'receive-in-cash' });

    expect(r).toEqual({ ok: true, transaction_id: 'receita-antiga', charge_id: c.id });
    expect(m.nomes()).toEqual([
      'paymentGatewayCharge.findFirst', 'paymentGatewayCharge.update', 'paymentGatewayCharge.findUnique',
    ]);
  });

  it('webhook do Asaas RECEIVED (ao vivo): chama o ensureChargeReceita só com o id (data de hoje, forma pelo billing_type)', async () => {
    const c = cobranca(null, { status: 'PENDING' });
    const m = montar(c);
    // Pagamento de 49 dias atrás: o gate de recência corta as notificações, o caixa não.
    await m.svc.handleWebhook({
      event: 'PAYMENT_RECEIVED',
      payment: { id: c.external_id, status: 'RECEIVED', paymentDate: '2026-09-01', confirmedDate: '2026-09-01', value: 1200 },
    });

    expect(ensureEspiao.mock.calls).toEqual([[c.id]]);
    expect(m.nomes()).toEqual([
      'paymentGatewayCharge.findUnique', 'paymentGatewayCharge.update',
      ...SEQUENCIA_COMPLETA,
      'paymentGatewayCharge.updateMany',
    ]);
    expect(retrato(m)).toMatchSnapshot();
  });

  it('webhook do Asaas CONFIRMED: não lança RECEITA (o caixa só entra no RECEIVED)', async () => {
    const c = cobranca('ENTRADA', { status: 'PENDING' });
    const m = montar(c);
    await m.svc.handleWebhook({
      event: 'PAYMENT_CONFIRMED',
      payment: { id: c.external_id, status: 'CONFIRMED', paymentDate: '2026-09-01', confirmedDate: '2026-09-01', value: 700 },
    });

    expect(ensureEspiao).not.toHaveBeenCalled();
    expect(m.nomes()).not.toContain('tx.financialTransaction.create');
    expect(m.nomes()).not.toContain('financialTransaction.create');
  });

  it('backfill do cron (ensureReceitaBackfillCron): reconfere no Asaas e lança com dateFromCharge', async () => {
    const c = cobranca('INSTALLMENT');
    const asaas = { getCharge: jest.fn().mockResolvedValue({ id: c.external_id, status: 'RECEIVED' }) };
    const m = montar(c, { asaas });
    const desligado = process.env.RECEITA_BACKFILL_OFF;
    delete process.env.RECEITA_BACKFILL_OFF;
    try {
      await m.svc.ensureReceitaBackfillCron();
    } finally {
      if (desligado !== undefined) process.env.RECEITA_BACKFILL_OFF = desligado;
    }

    expect(asaas.getCharge.mock.calls).toEqual([[c.external_id, TENANT]]);
    expect(ensureEspiao.mock.calls).toEqual([[c.id, OPCOES.backfill]]);
    expect(m.nomes()).toEqual(['paymentGatewayCharge.count', 'paymentGatewayCharge.findMany', ...SEQUENCIA_COMPLETA]);
    expect(retrato(m)).toMatchSnapshot();
  });
});

describe('retrato: quem dá baixa e quem confirma o cartão, por setor da clínica (F0a)', () => {
  const SETORES_CLINICA = ['recepcao', 'dentista', 'acd_asb', 'crc', 'financeiro', 'admin'];

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** 'passa' ou o 403 como o front recebe (status, code e mensagem). */
  async function tentar(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
      return 'passa';
    } catch (e: any) {
      if (!(e instanceof ForbiddenException)) throw e;
      const resp: any = e.getResponse();
      return `${e.getStatus()} ${resp?.code ?? '(sem code)'}: ${e.message}`;
    }
  }

  it('receive-in-cash e confirm-cartao com as permissões padrão de cada setor (e o papel ADMIN)', async () => {
    const tabela: Record<string, Record<string, string>> = {};
    const usuarios = [
      ...SETORES_CLINICA.map((s) => ({ chave: s, user: { id: `u-${s}`, tenant_id: TENANT, roles: ['OPERADOR'] }, sector: s })),
      { chave: '(papel ADMIN)', user: { id: 'u-papel-admin', tenant_id: TENANT, roles: ['ADMIN'] }, sector: 'recepcao' },
    ];
    for (const { chave, user, sector } of usuarios) {
      // permissionsFor real (mesmo cache e regra do guard), com o setor vindo do "banco".
      PermissionsGuard.invalidate(user.id);
      const prisma: any = {
        user: { findUnique: jest.fn().mockResolvedValue({ sector, extra_grants: [], extra_revokes: [] }) },
        paymentGatewayCharge: { findUnique: jest.fn().mockResolvedValue({ tenant_id: TENANT }) },
      };
      const service: any = {
        assertClinicReceiptAllowed: jest.fn().mockResolvedValue(undefined),
        registerClinicReceipt: jest.fn().mockResolvedValue({ ok: true }),
        confirmCartaoReceipt: jest.fn().mockResolvedValue({ ok: true }),
      };
      const asaas: any = {
        getCharge: jest.fn().mockResolvedValue({ id: 'pay_1', status: 'PENDING', value: 100 }),
        receiveInCash: jest.fn().mockResolvedValue({ status: 'RECEIVED_IN_CASH' }),
      };
      const ctrl = new PaymentGatewayController(service, asaas, prisma, {} as any);

      const baixa = await tentar(() => ctrl.receiveInCash('pay_1', { payment_method: 'DINHEIRO' }, { user }));
      const cartao = await tentar(() => ctrl.confirmCartao('ch-1', { user }));
      tabela[chave] = { 'receive-in-cash': baixa, 'confirm-cartao': cartao };

      // Negado = nada tocado (nem cobrança, nem Asaas, nem caixa).
      if (baixa !== 'passa') {
        expect(prisma.paymentGatewayCharge.findUnique).not.toHaveBeenCalled();
        expect(asaas.receiveInCash).not.toHaveBeenCalled();
        expect(service.registerClinicReceipt).not.toHaveBeenCalled();
      }
      if (cartao !== 'passa') expect(service.confirmCartaoReceipt).not.toHaveBeenCalled();
    }

    expect(tabela).toMatchSnapshot();
  });
});
