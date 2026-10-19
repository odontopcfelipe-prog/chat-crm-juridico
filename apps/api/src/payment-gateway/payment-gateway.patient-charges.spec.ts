import { PaymentGatewayService } from './payment-gateway.service';

/**
 * Ficha do paciente (aba Financeiro) lista as cobranças por GET /patients/:id/charges.
 * Cobrança LOCAL (gateway CASH — cartão da maquineta, espécie, PIX na clínica) nasce
 * com treatment_plan_id e customer 'CASH', sem cliente do Asaas. Antes ela sumia da
 * ficha ("SEM COBRANÇA", sem botão "Dar baixa") enquanto o bloqueio de agendamento,
 * que casa pelo plano, a via como atraso (caso Paloma, contrato #576, out/2026).
 */
describe('PaymentGatewayService.getChargesByPatient — vínculos', () => {
  function montar(lead_id: string | null) {
    const prisma: any = {
      patient: { findUnique: jest.fn().mockResolvedValue({ lead_id, tenant_id: 't1' }) },
      paymentGatewayCustomer: { findFirst: jest.fn().mockResolvedValue(lead_id ? { external_id: 'cus_1' } : null) },
      paymentGatewayCharge: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const svc = new PaymentGatewayService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    return { svc, prisma };
  }

  it('casa por patient_id, pelo PLANO do paciente e pela cadeia do cliente Asaas', async () => {
    const { svc, prisma } = montar('lead1');
    await svc.getChargesByPatient('pat1', 't1');
    const where = prisma.paymentGatewayCharge.findMany.mock.calls[0][0].where;
    expect(where.tenant_id).toBe('t1');
    expect(where.OR).toEqual([
      { patient_id: 'pat1' },
      { treatment_plan: { patient_id: 'pat1' } },
      { customer_external_id: 'cus_1' },
    ]);
  });

  it('paciente sem lead ainda acha a cobrança local pelo plano', async () => {
    const { svc, prisma } = montar(null);
    await svc.getChargesByPatient('pat1', 't1');
    const where = prisma.paymentGatewayCharge.findMany.mock.calls[0][0].where;
    expect(where.OR).toContainEqual({ treatment_plan: { patient_id: 'pat1' } });
  });
});
