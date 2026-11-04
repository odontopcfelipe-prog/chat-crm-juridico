/**
 * Preço promocional na venda de balcão. Ele é o preço de referência só ali: a recepção cobra
 * sem a permissão de desconto e o plano se auto-libera, porque quem definiu foi o administrador.
 * Desconto abaixo da promoção segue a regra de sempre, e os orçamentos seguem o preço de tabela.
 */
import { QuotesService } from './quotes.service';

const TENANT = 't-balcao';
const USER = 'u-recepcao';
const DENT = 'd-1';
const KEY = '44444444-4444-4444-8444-444444444444';

const procedimento = (over: Record<string, unknown> = {}) => ({
  id: 'proc-a', base_price: 120, promo_price: 100, tenant_id: TENANT, name: 'Limpeza', category: 'PROFILAXIA', specialty: null, ...over,
});

function montar(procs: unknown[] = [procedimento()]) {
  const audits: any[] = [];
  const prisma: any = {
    user: { findMany: jest.fn().mockResolvedValue([{ id: DENT, name: 'Dra. Ana', specialties: [] }]) },
    procedure: { findMany: jest.fn().mockResolvedValue(procs) },
    paymentGatewayCharge: { findUnique: jest.fn().mockResolvedValue(null) },
    treatmentPlan: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: jest.fn().mockImplementation(async ({ data }: any) => { audits.push(data); return {}; }) },
  };
  const service = new QuotesService(prisma, { get: jest.fn() } as any, undefined, undefined, undefined, undefined, {} as any);
  jest.spyOn(service as any, 'assertPatientBelongsToTenant').mockResolvedValue(undefined);
  jest.spyOn(service as any, 'ensurePatientReadyForBilling').mockResolvedValue(undefined);
  jest.spyOn(service as any, 'recusarElementoForaDoFdiNoLab').mockResolvedValue(undefined);
  const create = jest.spyOn(service, 'create').mockResolvedValue({ id: 'q-1', quote_number: 42, total_value: 100 } as any);
  jest.spyOn(service, 'approveAndBill').mockResolvedValue({
    quote_id: 'q-1', plan_id: 'plan-1', charge: { id: 'ch-1' }, manual: true, receipt: { ok: true, transaction_id: 'tx-1', charge_id: 'ch-1' },
  } as any);
  return { service, prisma, audits, create };
}

const venda = (over: Record<string, unknown> = {}): any => ({
  patient_id: 'p-1',
  dentist_id: DENT,
  items: [{ procedure_id: 'proc-a', quantity: 1 }],
  payments: [{ method: 'DINHEIRO', value: 100 }],
  expected_total: 100,
  client_request_id: KEY,
  ...over,
});

const resolver = (service: QuotesService, itens: unknown[]) =>
  (service as any).resolveItems(itens, TENANT, USER) as Promise<Array<{ unit_price: number; base_price: number; total_price: number }>>;

describe('venda de balcão com preço promocional', () => {
  it('cobra a promoção, se auto-libera e não marca "abaixo da tabela"', async () => {
    const { service, audits, create } = montar();
    const r = await service.vendaBalcao(TENANT, USER, venda());
    expect(r.total).toBe(100);
    expect(r.auto_validated).toBe(true);
    expect(audits.some((a) => a.action === 'VENDA_VALOR_ABAIXO_ESPERADO')).toBe(false);
    // O create() re-resolve os itens: a marca tem de chegar nele, senão o total diverge.
    const dados = create.mock.calls[0][3] as { items: Array<{ usar_promocao?: boolean }> };
    expect(dados.items.every((i) => i.usar_promocao === true)).toBe(true);
  });

  it('o total da tela com o preço de tabela é barrado: o preço mudou', async () => {
    const { service, create } = montar();
    await expect(service.vendaBalcao(TENANT, USER, venda({ expected_total: 120, payments: [{ method: 'DINHEIRO', value: 120 }] })))
      .rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it('desconto abaixo da promoção vai para o Validar, como qualquer desconto', async () => {
    const { service, audits, create } = montar();
    create.mockResolvedValue({ id: 'q-1', quote_number: 42, total_value: 90 } as any);
    const r = await service.vendaBalcao(TENANT, USER, venda({
      items: [{ procedure_id: 'proc-a', quantity: 1, unit_price: 90 }],
      payments: [{ method: 'DINHEIRO', value: 90 }],
      expected_total: 90,
    }));
    expect(r.auto_validated).toBe(false);
    // O Financeiro vê o preço de tabela de verdade, não só a promoção.
    const rastro = JSON.stringify(audits.find((a) => a.action === 'VENDA_VALOR_ABAIXO_ESPERADO'));
    expect(rastro).toContain('promoção R$ 100.00');
    expect(rastro).toContain('tabela R$ 120.00');
    expect(rastro).toContain('vendido R$ 90.00');
  });
});

describe('resolveItems e a promoção', () => {
  it('com a marca, a promoção vira o preço de referência: sem desconto a conferir', async () => {
    const [i] = await resolver(montar().service, [{ procedure_id: 'proc-a', quantity: 2, usar_promocao: true }]);
    expect(i).toMatchObject({ base_price: 100, unit_price: 100, total_price: 200 });
    expect(i.unit_price < i.base_price).toBe(false);
  });

  it('sem a marca (orçamentos e propostas) segue o preço de tabela', async () => {
    const [i] = await resolver(montar().service, [{ procedure_id: 'proc-a', quantity: 1 }]);
    expect(i).toMatchObject({ base_price: 120, unit_price: 120 });
  });

  it.each([[120], [150]])('promoção de %d num preço de 120 não vale', async (promo) => {
    const [i] = await resolver(montar([procedimento({ promo_price: promo })]).service, [{ procedure_id: 'proc-a', usar_promocao: true }]);
    expect(i).toMatchObject({ base_price: 120, unit_price: 120 });
  });

  it('item sem promoção fica no preço de tabela', async () => {
    const [i] = await resolver(montar([procedimento({ promo_price: null })]).service, [{ procedure_id: 'proc-a', usar_promocao: true }]);
    expect(i).toMatchObject({ base_price: 120, unit_price: 120 });
  });

  it('preço digitado acima da promoção não conta como desconto', async () => {
    const [i] = await resolver(montar().service, [{ procedure_id: 'proc-a', unit_price: 110, usar_promocao: true }]);
    expect(i.unit_price < i.base_price).toBe(false);
  });
});
