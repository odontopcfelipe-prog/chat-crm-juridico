/**
 * F5 do laboratório — venda de BALCÃO (POST venda-rapida/balcao) numa conta de
 * LABORATÓRIO, de ponta a ponta no servidor: QuotesService.vendaBalcao → approveAndBill
 * → accept (reais) → TreatmentPlanBillingService.createManualReceipt (real), com a
 * receita no caixa (registerClinicReceipt) e o TCLE (sendForSignature) espionados.
 *
 * Laboratório (cliente PJ, Protético como responsável):
 *   - notas do orçamento começam com "Venda rapida" (isVendaRapidaQuote) e dizem
 *     "recebido no laboratorio";
 *   - o trabalho (plano) nasce ACTIVE com start_date (sem TCLE);
 *   - cobrança local CASH "Trabalho de prótese — … (recebido no laboratório) [plan:<id>]",
 *     marcador -AVISTA-/-CARTAO- e a chave da venda como sempre;
 *   - a receita entra 1 vez (registerClinicReceipt), o trabalho se auto-libera;
 *   - o TCLE é recusado (VERTICAL_DENIED) e só vira log [LAB-GATE]; a comissão de venda segue a regra do vendedor.
 * Clínica: plano PENDING_SIGNATURE → ACTIVE, notas "Venda rapida — recebido na clinica:
 * Espécie" e o contrato disparado 1 vez, igual a hoje.
 *
 * Sem banco: o Prisma é um gravador; dados de exemplo (repositório público).
 */
import { BadRequestException, Logger } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { negarLaboratorio } from '../common/lab-gate.util';
import { QuotesService, isVendaRapidaQuote } from './quotes.service';
import { TreatmentPlanBillingService } from './treatment-plan-billing.service';

const LAB = 'tenant-lab-exemplo';
const CLINICA = 'tenant-clinica-exemplo';
const USER = 'u-atendimento';
const PROTETICO = 'u-protetico';
const ADMIN_SEM_ESPECIALIDADE = 'u-admin-sem-especialidade';
const PROC_A = 'proc-coroa'; // R$ 120
const PROC_B = 'proc-faceta'; // R$ 80
const PLANO = '11111111-1111-4111-8111-111111111111';
const KEY = '33333333-3333-4333-8333-333333333333';
const AGORA = new Date('2026-10-30T14:00:00.000Z');

let logs: { nivel: string; msg: string }[] = [];
const registrou = (nivel: string, trecho: string) => logs.some((l) => l.nivel === nivel && l.msg.includes(trecho));

beforeEach(() => {
  logs = [];
  __limparCacheLabTenants();
  jest.useFakeTimers({
    now: AGORA,
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
  for (const nivel of ['log', 'warn', 'debug', 'error', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation((msg: any) => {
      logs.push({ nivel, msg: String(msg) });
    });
  }
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const drenar = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

type Op = [string, any];

/** Conta (lab ou clínica) com o cliente, os serviços e a equipe de exemplo. */
function montar(conta: string, labs: string[]) {
  __limparCacheLabTenants();
  const ops: Op[] = [];
  const equipe = [
    { id: PROTETICO, name: 'Protético Exemplo', roles: ['DENTIST'], specialties: [] as string[] },
    { id: ADMIN_SEM_ESPECIALIDADE, name: 'Admin Exemplo', roles: ['ADMIN'], specialties: [] as string[] },
  ];
  const cliente = { id: 'cli-1', tenant_id: conta, name: 'Clínica Parceira Exemplo', cpf: '11.222.333/0001-81', phone: '5582988887777', lead_id: 'lead-1' };
  let quote: any = null;
  let plano: any = null;
  const cobrancas: any[] = [];

  const respostas: Record<string, (a: any) => any> = {
    // Mesma regra de GET /users/lawyers: DENTIST, ou ADMIN com especialidade.
    'user.findMany': () =>
      equipe
        .filter((u) => u.roles.includes('DENTIST') || (u.roles.includes('ADMIN') && u.specialties.length > 0))
        .map(({ id, name, specialties }) => ({ id, name, specialties })),
    'procedure.findMany': () => [
      { id: PROC_A, base_price: 120, tenant_id: conta, name: 'Coroa', category: 'PROTESE', specialty: null },
      { id: PROC_B, base_price: 80, tenant_id: conta, name: 'Faceta', category: 'PROTESE', specialty: null },
    ],
    // Idempotência da venda (chave) e releitura da compensação do createManualReceipt.
    'paymentGatewayCharge.findUnique': (a) => (a.where?.id ? { transaction_id: null } : null),
    'paymentGatewayCharge.findFirst': () => null,
    'paymentGatewayCharge.create': (a) => {
      const row = { id: `cob-${cobrancas.length + 1}`, ...a.data };
      cobrancas.push(row);
      return row;
    },
    'quote.update': (a) => Object.assign(quote, a.data),
    'quote.findUnique': () => (quote ? { status: quote.status } : null),
    'treatmentPlan.create': (a) => {
      const { items, ...dados } = a.data;
      plano = { id: PLANO, ...dados, items: items.create };
      return plano;
    },
    'treatmentPlan.findFirst': () => plano,
    'treatmentPlan.findUnique': () => (plano ? { ...plano, patient: cliente } : null),
    'treatmentPlan.update': (a) => Object.assign(plano, a.data),
    'treatmentPlan.updateMany': (a) => {
      if (plano && a.where.status === plano.status && !plano.validated_by_financial_at) {
        Object.assign(plano, a.data);
        return { count: 1 };
      }
      return { count: 0 };
    },
  };
  const perfis = jest.fn(async () => labs.map((tenant_id) => ({ tenant_id })));
  const modelos: Record<string, any> = {};
  const prisma: any = new Proxy(
    {},
    {
      get(_a, modelo: string | symbol) {
        if (typeof modelo !== 'string' || modelo === 'then') return undefined;
        if (modelo === 'tenantBusinessProfile') return { findMany: perfis };
        if (modelo === '$transaction') {
          return async (cb: any) => {
            ops.push(['$transaction', null]);
            const r = await cb(prisma);
            ops.push(['$transaction:fim', null]);
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
                ops.push([op, args]);
                const r = respostas[op];
                if (r) return r(args);
                if (metodo === 'findMany') return [];
                if (metodo === 'count') return 0;
                if (metodo === 'updateMany' || metodo === 'deleteMany') return { count: 0 };
                if (metodo === 'create') return { id: `${modelo}-1`, ...(args?.data ?? {}) };
                return null;
              };
            },
          },
        );
        return modelos[modelo];
      },
    },
  );

  // TCLE: no laboratório o serviço de contrato recusa (função de clínica).
  const contrato = {
    sendForSignature: jest.fn(async () => {
      if (labs.includes(conta)) throw negarLaboratorio('TCLE');
      return { signingUrl: 'https://exemplo.invalid/assinar' };
    }),
  };
  const caixa = { registerClinicReceipt: jest.fn(async () => ({ ok: true, transaction_id: 'receita-1' })) };
  const billing = new TreatmentPlanBillingService(prisma, caixa as any, {} as any);
  const service = new QuotesService(prisma, { get: jest.fn() } as any, undefined, undefined, undefined, contrato as any, billing);

  // O que esta venda não cobre (fica para os specs de cada parte): dono do cliente,
  // documento, montagem do orçamento no create() e os avisos depois da venda.
  jest.spyOn(service as any, 'assertPatientBelongsToTenant').mockResolvedValue(undefined);
  const pronto = jest.spyOn(service as any, 'ensurePatientReadyForBilling').mockResolvedValue(undefined);
  jest.spyOn(service as any, 'shadowCheckApproveValue').mockResolvedValue(undefined);
  jest.spyOn(service as any, 'recordAffiliateReferral').mockImplementation(() => undefined);
  jest.spyOn(service as any, 'sendComprovantePagamento').mockResolvedValue(undefined);
  jest.spyOn(service as any, 'sendVendaFeita').mockResolvedValue(undefined);
  jest.spyOn(service as any, 'tryGraduateLeadToClientByQuote').mockImplementation(() => undefined);
  const comissao = jest.spyOn(service as any, 'generateSaleCommission');
  const create = jest.spyOn(service, 'create').mockImplementation(async (patientId: string, _t: string, _u: any, data: any) => {
    quote = {
      id: 'q-1',
      quote_number: 42,
      status: 'DRAFT',
      sent_at: null,
      patient_id: patientId,
      total_value: 200,
      notes: data.notes,
      items: data.items.map((i: any) => ({
        procedure_id: i.procedure_id,
        tooth_fdi: i.tooth_fdi ?? null,
        quantity: i.quantity,
        unit_price: i.procedure_id === PROC_A ? 120 : 80,
        total_price: i.procedure_id === PROC_A ? 120 : 80,
        notes: null,
        dentist_id: i.dentist_id,
      })),
      patient: cliente,
    };
    return quote;
  });
  jest.spyOn(service, 'findOne').mockImplementation(async () => quote);
  const remove = jest.spyOn(service, 'remove').mockResolvedValue({} as any);
  const approve = jest.spyOn(service, 'approveAndBill');
  const de = (op: string) => ops.filter(([o]) => o === op).map(([, a]) => a);
  return { service, ops, de, contrato, caixa, comissao, create, remove, approve, pronto, cobrancas, plano: () => plano };
}

const dto = (over: Record<string, unknown> = {}): any => ({
  patient_id: 'cli-1',
  dentist_id: PROTETICO,
  items: [{ procedure_id: PROC_A, quantity: 1 }, { procedure_id: PROC_B, quantity: 1 }],
  payments: [{ method: 'DINHEIRO', value: 200 }],
  expected_total: 200,
  client_request_id: KEY,
  ...over,
});

describe('venda de balcão no laboratório (F5) — de ponta a ponta no servidor', () => {
  it('(a) cliente PJ e Protético: notas "Venda rapida", trabalho ACTIVE, cobrança local do laboratório, 1 receita, sem TCLE', async () => {
    const m = montar(LAB, [LAB]);
    const r: any = await m.service.vendaBalcao(LAB, USER, dto());
    await drenar();

    // Orçamento: notas do laboratório com a marca da venda rápida; o Protético em todos os itens.
    const [, , , dados] = m.create.mock.calls[0] as any[];
    expect(dados.notes).toBe('Venda rapida — recebido no laboratorio: Espécie');
    expect(isVendaRapidaQuote({ notes: dados.notes })).toBe(true);
    expect(dados.items.every((i: any) => i.dentist_id === PROTETICO)).toBe(true);

    // Trabalho nasce ACTIVE (sem TCLE) com start_date; não precisa de ativação depois.
    expect(m.de('treatmentPlan.create')[0].data).toMatchObject({ status: 'ACTIVE', start_date: AGORA, quote_id: 'q-1' });
    expect(m.de('treatmentPlan.update')).toEqual([]);

    // Cobrança local CASH com o texto do laboratório e a tag do plano.
    expect(m.cobrancas).toHaveLength(1);
    const cob = m.cobrancas[0];
    expect(cob).toMatchObject({ gateway: 'CASH', billing_type: 'CASH', tenant_id: LAB, amount: 200, idempotency_key: KEY });
    expect(cob.description).toBe(`Trabalho de prótese — Clínica Parceira Exemplo (recebido no laboratório) [plan:${PLANO}]`);
    expect(cob.description).not.toMatch(/plano de tratamento|cl[ií]nica\b(?! Parceira)/i);
    expect(cob.external_id).toContain('-AVISTA-');
    expect(cob.description.match(/\[plan:([0-9a-f-]{36})\]/i)?.[1]).toBe(PLANO);

    // Receita no caixa 1 vez; trabalho auto-liberado para a produção.
    expect(m.caixa.registerClinicReceipt).toHaveBeenCalledTimes(1);
    expect(m.caixa.registerClinicReceipt).toHaveBeenCalledWith(cob.external_id, expect.objectContaining({ paymentMethod: 'DINHEIRO', origem: 'venda-balcao' }));
    expect(m.de('treatmentPlan.updateMany')).toEqual([
      { where: { id: PLANO, validated_by_financial_at: null, status: 'ACTIVE' }, data: { validated_by_financial_at: AGORA, validated_by_financial_id: null } },
    ]);
    expect(r).toMatchObject({ quote_id: 'q-1', plan_id: PLANO, total: 200, charge_id: cob.id, transaction_id: 'receita-1', auto_validated: true });

    // TCLE: o serviço de contrato recusa e o QuotesService só registra o [LAB-GATE].
    expect(m.contrato.sendForSignature).toHaveBeenCalledTimes(1);
    expect(registrou('log', '[LAB-GATE] tcle')).toBe(true);
    expect(registrou('warn', '[ACCEPT→CLICKSIGN]')).toBe(false);

    // Comissão de venda: a regra é a do cadastro do vendedor (aqui sem regra), igual à clínica; nada grava.
    expect(registrou('log', '[LAB-GATE] comissao-venda')).toBe(false);
    expect(m.de('commission.create')).toEqual([]);
    expect(m.comissao).toHaveBeenCalledTimes(1);

    // Documento do cliente: opcional no balcão do laboratório (na venda e no approveAndBill).
    expect(m.pronto.mock.calls).toEqual([['cli-1', LAB, true], ['cli-1', LAB, true]]);
  });

  it('(b) clínica, com e sem outra conta de laboratório: plano PENDING_SIGNATURE → ACTIVE, notas de hoje e o contrato 1 vez', async () => {
    for (const labs of [[], [LAB]]) {
      jest.restoreAllMocks();
      logs = [];
      for (const nivel of ['log', 'warn', 'debug', 'error', 'verbose'] as const) {
        jest.spyOn(Logger.prototype, nivel).mockImplementation((msg: any) => {
          logs.push({ nivel, msg: String(msg) });
        });
      }
      const m = montar(CLINICA, labs);
      const r: any = await m.service.vendaBalcao(CLINICA, USER, dto());
      await drenar();

      expect((m.create.mock.calls[0] as any[])[3].notes).toBe('Venda rapida — recebido na clinica: Espécie');
      expect(m.de('treatmentPlan.create')[0].data.status).toBe('PENDING_SIGNATURE');
      expect(m.de('treatmentPlan.create')[0].data.start_date).toBeUndefined();
      expect(m.de('treatmentPlan.update')).toEqual([{ where: { id: PLANO }, data: { status: 'ACTIVE', start_date: AGORA } }]);
      expect(m.cobrancas[0].description).toBe(`Plano de tratamento — Clínica Parceira Exemplo (recebido na clínica) [plan:${PLANO}]`);
      expect(m.contrato.sendForSignature).toHaveBeenCalledTimes(1);
      expect(m.contrato.sendForSignature).toHaveBeenCalledWith(PLANO, CLINICA);
      expect(m.caixa.registerClinicReceipt).toHaveBeenCalledTimes(1);
      expect(r.auto_validated).toBe(true);
      expect(registrou('log', '[LAB-GATE]')).toBe(false);
      // Clínica: o CPF continua obrigatório na venda e no approveAndBill.
      expect(m.pronto.mock.calls).toEqual([['cli-1', CLINICA, false], ['cli-1', CLINICA, false]]);
    }
  });

  it('(c) responsável ADMIN sem especialidade: 400 e nada gravado', async () => {
    const m = montar(LAB, [LAB]);
    const e = await m.service.vendaBalcao(LAB, USER, dto({ dentist_id: ADMIN_SEM_ESPECIALIDADE })).catch((x) => x);
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.message).toBe('Dentista responsável inválido para esta clínica.');
    expect(m.create).not.toHaveBeenCalled();
    expect(m.cobrancas).toEqual([]);
  });

  it('(d) 2 cartões no laboratório: o split vai no 5º argumento, a cobrança leva -CARTAO- e o texto do laboratório', async () => {
    const m = montar(LAB, [LAB]);
    const payments = [
      { method: 'CARTAO', value: 150, installments: 3, debit: false },
      { method: 'CARTAO', value: 50, debit: true },
    ];
    await m.service.vendaBalcao(LAB, USER, dto({ payments }));
    await drenar();

    expect(m.approve).toHaveBeenCalledWith(
      'q-1', LAB, USER,
      expect.objectContaining({ manual_payment_method: 'CARTAO', installment_count: undefined, received_in_clinic: true, quick_sale: true }),
      { payments, idempotencyKey: KEY, origem: 'venda-balcao' },
    );
    expect((m.create.mock.calls[0] as any[])[3].notes).toBe('Venda rapida — recebido no laboratorio: Maquineta (2 cartões)');
    expect(m.cobrancas[0].external_id).toContain('-CARTAO-');
    expect(m.cobrancas[0].description).toBe(`Trabalho de prótese — Clínica Parceira Exemplo (cartão na maquineta · recebido no laboratório) [plan:${PLANO}]`);
    expect(m.caixa.registerClinicReceipt).toHaveBeenCalledWith(m.cobrancas[0].external_id, expect.objectContaining({ payments }));
  });

  it('várias formas no laboratório (PIX do laboratório + espécie): notas e cobrança "· 2 formas"', async () => {
    const m = montar(LAB, [LAB]);
    const payments = [{ method: 'PIX', value: 120 }, { method: 'DINHEIRO', value: 80 }];
    await m.service.vendaBalcao(LAB, USER, dto({ payments }));
    await drenar();

    expect((m.create.mock.calls[0] as any[])[3].notes).toBe(
      'Venda rapida — recebido no laboratorio (varias formas): PIX do laboratório R$ 120.00 + Espécie R$ 80.00',
    );
    expect(m.cobrancas[0].description).toBe(`Trabalho de prótese — Clínica Parceira Exemplo (recebido no laboratório · 2 formas) [plan:${PLANO}]`);
    expect(m.cobrancas[0].external_id).toContain('-AVISTA-');
  });
});

describe('documento do cliente na cobrança (F5)', () => {
  function montarDocumento(cpf: string | null) {
    const prisma: any = {
      patient: {
        findUnique: jest.fn(async () => ({ id: 'cli-2', name: 'Dentista Exemplo', phone: '5582988887777', cpf, lead_id: 'lead-2' })),
      },
    };
    const service = new QuotesService(prisma, { get: jest.fn() } as any);
    const contato = jest.spyOn(service as any, 'ensurePatientLead').mockResolvedValue(undefined);
    const pronto = (opcional?: boolean) => (service as any).ensurePatientReadyForBilling('cli-2', LAB, opcional);
    return { contato, pronto };
  }

  it('sem documento: a cobrança comum recusa com a mensagem de hoje e não mexe no contato', async () => {
    const m = montarDocumento(null);
    await expect(m.pronto()).rejects.toThrow('Paciente sem CPF cadastrado. Edite o paciente e adicione o CPF antes de gerar cobranca.');
    await expect(m.pronto(false)).rejects.toBeInstanceOf(BadRequestException);
    expect(m.contato).not.toHaveBeenCalled();
  });

  it('balcão do laboratório (documento opcional): segue sem documento e garante o contato', async () => {
    const m = montarDocumento(null);
    await expect(m.pronto(true)).resolves.toBeUndefined();
    expect(m.contato).toHaveBeenCalledWith('cli-2', LAB, 'cobranca');
  });

  it('com documento: segue nos dois casos', async () => {
    for (const opcional of [false, true]) {
      const m = montarDocumento('11.222.333/0001-81');
      await expect(m.pronto(opcional)).resolves.toBeUndefined();
      expect(m.contato).toHaveBeenCalledTimes(1);
    }
  });
});
