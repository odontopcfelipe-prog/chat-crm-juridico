import { TreatmentPlanBillingService } from './treatment-plan-billing.service';

/**
 * Venda no CARTÃO da maquineta (decisão do dono, 17/out/2026): o cartão é passado NA
 * HORA → entra como RECEBIDO (receita CARTAO), sem Asaas, sem parcelas, sem "a receber"
 * que vence. Antes: cartão parcelado no Asaas (parcelas com link vencendo e cobrando) e
 * depois "a receber" que ficava atrasado.
 */
describe('TreatmentPlanBillingService — venda no cartão (maquineta)', () => {
  const TENANT = 't1';
  function montar() {
    const created: any[] = [];
    const prisma: any = {
      treatmentPlan: {
        findUnique: jest.fn().mockResolvedValue({ id: 'plan1', patient_id: 'pat1', status: 'ACTIVE', patient: { id: 'pat1', tenant_id: TENANT, name: 'Paloma Freire' } }),
      },
      paymentGatewayCharge: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }: any) => { created.push(data); return { id: 'ch1', ...data }; }),
      },
    };
    const paymentGateway: any = { registerClinicReceipt: jest.fn().mockResolvedValue({ ok: true }) };
    const asaas: any = { createCharge: jest.fn() };
    const svc = new TreatmentPlanBillingService(prisma, paymentGateway, asaas);
    return { svc, created, paymentGateway, asaas };
  }

  it('cartão 3x recebido na hora: 1 cobrança local CARTAO, receita no caixa com as 3x, nada no Asaas', async () => {
    const { svc, created, paymentGateway, asaas } = montar();
    await svc.createManualReceipt('plan1', TENANT, { value: 700, paymentMethod: 'CARTAO', receiveNow: true, installments: 3 });

    expect(created).toHaveLength(1);
    expect(created[0].gateway).toBe('CASH');
    expect(created[0].kind).toBeUndefined(); // não é SINAL/ENTRADA/INSTALLMENT
    expect(created[0].external_id).toContain('-CARTAO-');
    expect(created[0].patient_id).toBe('pat1'); // a ficha do paciente acha a cobrança (sem isso: "SEM COBRANÇA")
    expect(created[0].description).toContain('cartão 3x na maquineta · recebido na clínica');
    expect(paymentGateway.registerClinicReceipt).toHaveBeenCalledWith(
      created[0].external_id,
      expect.objectContaining({ paymentMethod: 'CARTAO', installments: 3 }),
    );
    expect(asaas.createCharge).not.toHaveBeenCalled();
  });

  it('PIX na maquininha continua igual (recebido, marcador AVISTA, sem nº de parcelas)', async () => {
    const { svc, created, paymentGateway } = montar();
    await svc.createManualReceipt('plan1', TENANT, { value: 100, paymentMethod: 'PIX_MAQUININHA', receiveNow: true });
    expect(created[0].external_id).toContain('-AVISTA-');
    expect(created[0].description).toContain('(recebido na clínica)');
    expect(paymentGateway.registerClinicReceipt).toHaveBeenCalledWith(
      created[0].external_id,
      expect.objectContaining({ paymentMethod: 'PIX_MAQUININHA', installments: undefined }),
    );
  });
});
