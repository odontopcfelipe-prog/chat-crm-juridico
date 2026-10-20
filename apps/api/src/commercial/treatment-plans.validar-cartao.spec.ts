/**
 * Venda no CARTÃO da maquineta (decisão do dono, 20/out/2026): o cartão é passado NA HORA,
 * então ninguém "dá baixa" — quem confirma o recebimento é o Validar do Financeiro. Cartão
 * ainda "a receber" (legado de out/2026, ex.: Paloma #576) entra na fila do Validar mesmo
 * com o plano já liberado, e validar confirma (receita CARTÃO nas Entradas).
 */
import { BadRequestException } from '@nestjs/common';
import { TreatmentPlansService } from './treatment-plans.service';
import { isCartaoMaquineta, MSG_CARTAO_VALIDAR } from '../payment-gateway/baixa-regras';

const TENANT = 't1';

function montar(opts: { validado?: Date | null; cartoes?: Array<{ id: string; treatment_plan_id: string; amount: number }> } = {}) {
  const cartoes = opts.cartoes ?? [];
  const plano = {
    id: 'plan1',
    status: 'ACTIVE',
    start_date: null,
    validated_by_financial_at: opts.validado ?? null,
    patient: { id: 'pat1', name: 'Paloma', tenant_id: TENANT },
    items: [],
  };
  const prisma: any = {
    treatmentPlan: {
      findUnique: jest.fn().mockResolvedValue(plano),
      update: jest.fn(async ({ data }: any) => ({ ...plano, ...data })),
      findMany: jest.fn().mockResolvedValue([]),
    },
    paymentGatewayCharge: {
      findMany: jest.fn(async ({ where }: any) =>
        cartoes.filter((c) => !where.treatment_plan_id || typeof where.treatment_plan_id !== 'string' || c.treatment_plan_id === where.treatment_plan_id),
      ),
    },
  };
  const pg = { confirmCartaoReceipt: jest.fn().mockResolvedValue({ ok: true }) };
  const moduleRef: any = { get: jest.fn().mockReturnValue(pg) };
  const svc = new TreatmentPlansService(prisma, moduleRef);
  return { svc, prisma, pg };
}

describe('TreatmentPlansService.validate — cartão da maquineta', () => {
  it('plano não validado com cartão a receber: confirma o cartão e libera', async () => {
    const { svc, prisma, pg } = montar({ cartoes: [{ id: 'ch1', treatment_plan_id: 'plan1', amount: 700 }] });
    const r: any = await svc.validate('plan1', TENANT, 'fin1');
    expect(pg.confirmCartaoReceipt).toHaveBeenCalledWith('ch1', TENANT, 'fin1', 'validar-financeiro');
    expect(prisma.treatmentPlan.update).toHaveBeenCalled();
    expect(r.cartao_confirmado).toBe(1);
    // Só busca cartão a receber, do plano, da clínica.
    const where = prisma.paymentGatewayCharge.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      tenant_id: TENANT,
      treatment_plan_id: 'plan1',
      external_id: { contains: '-CARTAO-' },
      status: { in: ['PENDING', 'OVERDUE'] },
      received_in_cash: false,
      cancelled_at: null,
    });
  });

  it('plano JÁ liberado com cartão a receber (Paloma): confirma o cartão sem mexer na liberação', async () => {
    const { svc, prisma, pg } = montar({
      validado: new Date('2026-10-15T12:00:00Z'),
      cartoes: [{ id: 'ch1', treatment_plan_id: 'plan1', amount: 700 }],
    });
    const r: any = await svc.validate('plan1', TENANT, 'fin1');
    expect(pg.confirmCartaoReceipt).toHaveBeenCalledTimes(1);
    expect(prisma.treatmentPlan.update).not.toHaveBeenCalled();
    expect(r.cartao_confirmado).toBe(1);
  });

  it('sem cartão pendente: validar segue igual (não chama o gateway)', async () => {
    const { svc, prisma, pg } = montar();
    await svc.validate('plan1', TENANT, 'fin1');
    expect(pg.confirmCartaoReceipt).not.toHaveBeenCalled();
    expect(prisma.treatmentPlan.update).toHaveBeenCalled();
  });
});

describe('TreatmentPlansService.findPendingFinancialValidation — fila do Validar', () => {
  it('inclui plano já liberado que tem cartão a confirmar, com o valor', async () => {
    const { svc, prisma } = montar({ cartoes: [{ id: 'ch1', treatment_plan_id: 'plan9', amount: 700 }] });
    prisma.treatmentPlan.findMany.mockResolvedValue([
      {
        id: 'plan9', total_value: 700, validated_by_financial_at: new Date(),
        patient: { id: 'pat1', name: 'Paloma', phone: null }, quote: null, _count: { items: 1 },
      },
    ]);
    const rows = await svc.findPendingFinancialValidation(TENANT);
    const where = prisma.treatmentPlan.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { status: 'ACTIVE', validated_by_financial_at: null },
      { id: { in: ['plan9'] }, status: { not: 'CANCELLED' } },
    ]);
    expect(rows[0]).toMatchObject({ plan_id: 'plan9', cartao_a_confirmar: 700, ja_liberado: true });
  });

  it('sem cartão pendente: fila é só a de sempre (não validados)', async () => {
    const { svc, prisma } = montar();
    await svc.findPendingFinancialValidation(TENANT);
    const where = prisma.treatmentPlan.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ status: 'ACTIVE', validated_by_financial_at: null }]);
  });
});

describe('baixa-regras — cartão da maquineta não recebe baixa', () => {
  it('reconhece a cobrança local do cartão', () => {
    expect(isCartaoMaquineta('cash-plan1-CARTAO-1760000000000')).toBe(true);
    expect(isCartaoMaquineta('cash-plan1-AVISTA-1760000000000')).toBe(false);
    expect(isCartaoMaquineta('pay_abc123')).toBe(false);
    expect(isCartaoMaquineta(null)).toBe(false);
  });

  it('receive-in-cash recusa o cartão (o Financeiro confirma no Validar)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PaymentGatewayService } = require('../payment-gateway/payment-gateway.service');
    const prisma: any = { paymentGatewayCharge: { findFirst: jest.fn() } };
    const svc = new PaymentGatewayService(prisma, {}, {}, {}, {}, {}, {});
    await expect(svc.assertClinicReceiptAllowed('cash-plan1-CARTAO-1')).rejects.toThrow(new BadRequestException(MSG_CARTAO_VALIDAR));
    expect(prisma.paymentGatewayCharge.findFirst).not.toHaveBeenCalled();
  });
});
