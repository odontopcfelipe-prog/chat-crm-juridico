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
 * Service real, construído com `new` e Prisma mockado (só o que o método usa);
 * as outras dependências não são tocadas por este caminho. Relógio fixo.
 * Se a mudança for de propósito para as clínicas: `npx jest __guards__/receita-clinica -u`
 * em apps/api e commite o .snap junto.
 */
import { Prisma } from '@crm/shared';
import { PaymentGatewayService } from '../payment-gateway/payment-gateway.service';

const TENANT = 'tenant-clinica-1';
const AGORA = new Date('2026-10-20T15:00:00.000Z');
const PAGO_EM = new Date('2026-10-19T13:30:00.000Z');
const DATA_PAGAMENTO = new Date('2026-10-19T00:00:00.000Z');

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

/** Prisma mockado que grava a sequência de operações (com os argumentos). */
function montar(charge: any, opts: { travaJaLancada?: string; comissoesDevidas?: string[] } = {}) {
  const ops: Array<{ op: string; args: any }> = [];
  const rec = (op: string, ret: any) => (args?: any) => {
    ops.push({ op, args });
    return Promise.resolve(typeof ret === 'function' ? ret(args) : ret);
  };
  let leituras = 0;
  const prisma: any = {
    paymentGatewayCharge: {
      // 1ª leitura: a cobrança completa; 2ª (dentro da trava): só transaction_id.
      findUnique: rec('paymentGatewayCharge.findUnique', () =>
        leituras++ === 0 ? charge : { transaction_id: opts.travaJaLancada ?? null },
      ),
      update: rec('paymentGatewayCharge.update', {}),
    },
    financialTransaction: { create: rec('financialTransaction.create', { id: 'receita-1' }) },
    treatmentPlan: { findUnique: rec('treatmentPlan.findUnique', { quote_id: 'quote-1' }) },
    commission: {
      findMany: rec('commission.findMany', (opts.comissoesDevidas ?? ['com-1', 'com-2']).map((id) => ({ id }))),
      updateMany: rec('commission.updateMany', { count: (opts.comissoesDevidas ?? ['com-1', 'com-2']).length }),
    },
    $executeRaw: (sql: TemplateStringsArray, ...valores: any[]) => {
      ops.push({ op: '$executeRaw', args: { sql: sql.join('$'), valores } });
      return Promise.resolve(1);
    },
    $transaction: (cb: any, txOpts: any) => {
      ops.push({ op: '$transaction', args: txOpts });
      return cb(prisma);
    },
  };
  // Só o Prisma é usado por este caminho (asaas, whatsapp, financeiro, socket, e-mail e moduleRef não).
  const svc = new PaymentGatewayService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  const ensure = (o?: any): Promise<string | null> => (svc as any).ensureChargeReceita(charge?.id ?? 'ch-x', o);
  return { ensure, ops, nomes: () => ops.map((o) => o.op), de: (op: string) => ops.filter((o) => o.op === op).map((o) => o.args) };
}

// Como cada caminho real chama o ensureChargeReceita.
const MODOS: Array<[string, any]> = [
  ['webhook do Asaas (online)', undefined],
  ['recebido na clínica — dinheiro (registerClinicReceipt)', { paymentMethod: 'DINHEIRO', receivedInClinic: true, installments: undefined }],
  ['recebido na clínica — maquineta 3x', { paymentMethod: 'CARTAO', receivedInClinic: true, installments: 3 }],
  ['backfill do cron (dateFromCharge)', { dateFromCharge: true }],
];
const KINDS: Kind[] = [null, 'SINAL', 'ENTRADA', 'INSTALLMENT'];

const SEQUENCIA_COMPLETA = [
  'paymentGatewayCharge.findUnique',
  '$transaction',
  '$executeRaw',
  'paymentGatewayCharge.findUnique',
  'financialTransaction.create',
  'paymentGatewayCharge.update',
  'treatmentPlan.findUnique',
  'commission.findMany',
  'commission.updateMany',
];

describe('retrato: RECEITA de cobrança de clínica — ensureChargeReceita (F0a)', () => {
  beforeEach(() => {
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

  describe.each(KINDS.map((k) => [String(k ?? 'null (legado)'), k] as const))('kind %s', (_nome, kind) => {
    it.each(MODOS)('%s', async (_modo, opts) => {
      const m = montar(cobranca(kind));
      const r = await m.ensure(opts);

      expect(r).toBe('receita-1');
      expect(m.nomes()).toEqual(SEQUENCIA_COMPLETA);
      const [create] = m.de('financialTransaction.create');
      expect(create).toMatchSnapshot('financialTransaction.create');
      expect(m.de('paymentGatewayCharge.update')).toEqual([
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
    expect(m.de('financialTransaction.create')[0].data.payment_method).toBe('CARTAO');
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
    expect(m.nomes()).toEqual(SEQUENCIA_COMPLETA.slice(0, 6));
    expect(m.de('financialTransaction.create')[0]).toMatchSnapshot();
  });

  it('cobrança sem paciente nenhum: descrição com "Paciente" e sem cliente', async () => {
    const m = montar(cobranca(null, { treatment_plan: null, treatment_plan_id: null, patient: null, description: null }));
    await m.ensure(undefined);
    const data = m.de('financialTransaction.create')[0].data;
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
    expect(m.nomes()).toEqual(SEQUENCIA_COMPLETA.slice(0, 4));
  });

  it('jurídico (lead_honorario_payment_id) tem caixa próprio: não lança aqui', async () => {
    const m = montar(cobranca(null, { lead_honorario_payment_id: 'hon-1' }));
    await expect(m.ensure(undefined)).resolves.toBeNull();
    expect(m.nomes()).toEqual(['paymentGatewayCharge.findUnique']);
  });

  it('plano sem comissão DEVIDA: não chama o updateMany', async () => {
    const m = montar(cobranca('INSTALLMENT'), { comissoesDevidas: [] });
    await m.ensure(undefined);
    expect(m.nomes()).toEqual(SEQUENCIA_COMPLETA.slice(0, 8));
  });
});
