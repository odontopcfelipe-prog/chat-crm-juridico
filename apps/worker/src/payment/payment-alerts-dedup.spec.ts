import { PaymentAlertsCronService } from './payment-alerts-cron.service';

// Caso real (Jose, out/2026): a 1ª parcela recebeu "1 dia antes" no mês passado e,
// com a trava por PACIENTE, a 2ª parcela nunca mais recebeu esse aviso.

const DAY = 86_400_000;
const hojeMaceio = new Date(Date.now() - 3 * 3_600_000);
const amanha = new Date(Date.UTC(hojeMaceio.getUTCFullYear(), hojeMaceio.getUTCMonth(), hojeMaceio.getUTCDate() + 1));

function montar(auditRows: any[]) {
  const paciente = { id: 'jose', name: 'Jose Guilherme', phone: '82999990000', no_overdue_dunning: false };
  const prisma: any = {
    paymentGatewayCharge: {
      findMany: jest.fn(async () => [{
        id: 'parcela2', external_id: 'pay_p2', gateway: 'ASAAS', created_at: new Date(Date.now() - 90 * DAY),
        tenant_id: 't1', amount: 849.51, due_date: amanha, invoice_url: 'https://inv/p2', boleto_url: 'https://pdf/p2',
        billing_type: 'BOLETO', pix_copy_paste: null, boleto_barcode: null,
        treatment_plan: { patient: paciente }, installment: null, patient: null,
      }]),
    },
    globalSetting: { findMany: jest.fn(async () => [{ key: 'BOLETO_1D_ANTES_t1', value: 'true' }]) },
    auditLog: { findMany: jest.fn(async () => auditRows) },
  };
  const svc = new PaymentAlertsCronService(prisma, {} as any) as any;
  return { svc, prisma };
}

describe('régua: trava por BOLETO (não por paciente)', () => {
  it('2ª parcela recebe "1 dia antes" mesmo o paciente já tendo recebido esse aviso na 1ª', async () => {
    const { svc } = montar([
      { entity_id: 'jose', action: 'boleto_1d_antes', created_at: new Date(Date.now() - 31 * DAY), meta_json: { charge_ids: ['parcela1'] } },
    ]);
    const pick = await svc.findNextCharge();
    expect(pick?.chargeId).toBe('parcela2');
    expect(pick?.stage).toBe('boleto_1d_antes');
  });

  it('registro ANTIGO (sem charge_ids) de um mês atrás não trava a parcela nova', async () => {
    const { svc } = montar([
      { entity_id: 'jose', action: 'boleto_1d_antes', created_at: new Date(Date.now() - 31 * DAY), meta_json: { tenant_id: 't1' } },
    ]);
    expect((await svc.findNextCharge())?.chargeId).toBe('parcela2');
  });

  it('a mesma parcela não recebe o mesmo aviso 2× (o cron roda a cada minuto)', async () => {
    const { svc } = montar([
      { entity_id: 'jose', action: 'boleto_1d_antes', created_at: new Date(Date.now() - 60_000), meta_json: { charge_ids: ['parcela2'] } },
    ]);
    expect(await svc.findNextCharge()).toBeNull();
  });

  it('registro antigo de HOJE (antes do deploy, sem charge_ids) segura o aviso do dia', async () => {
    const { svc } = montar([
      { entity_id: 'jose', action: 'boleto_1d_antes', created_at: new Date(Date.now() - 3_600_000), meta_json: { tenant_id: 't1' } },
    ]);
    expect(await svc.findNextCharge()).toBeNull();
  });

  it('o envio grava QUAIS boletos foram avisados', async () => {
    const { svc, prisma } = montar([]);
    prisma.auditLog.create = jest.fn(async () => ({}));
    await svc.logSent('jose', 'boleto_1d_antes', 't1', 'msg1', ['parcela2']);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        entity: 'PAYMENT_ALERT', entity_id: 'jose', action: 'boleto_1d_antes',
        meta_json: expect.objectContaining({ charge_ids: ['parcela2'] }),
      }),
    }));
  });
});
