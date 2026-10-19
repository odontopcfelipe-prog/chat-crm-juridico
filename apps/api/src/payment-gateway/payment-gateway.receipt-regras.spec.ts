/**
 * Fase 0 — baixa manual (recebido na clínica / confirmar cartão / cancelar):
 *   D) cobrança cancelada/estornada não recebe baixa (nada é gravado);
 *   C) a soma das formas tem que bater com o valor da cobrança;
 *   H1) a 1ª baixa fica no Log do Financeiro (tenant_id na coluna), re-clique não duplica;
 *   B5) cancelamento NOVO fica no Log com o motivo.
 */
import { BadRequestException } from '@nestjs/common';
import { PaymentGatewayService } from './payment-gateway.service';
import { MSG_COBRANCA_CANCELADA } from './baixa-regras';

const TENANT = 't1';

function cobranca(over: Record<string, any> = {}) {
  return {
    id: 'ch1',
    external_id: 'cash-plan1-AVISTA-1',
    status: 'PENDING',
    received_at: null,
    received_by_user_id: null,
    paid_at: null,
    tenant_id: TENANT,
    amount: 100,
    cancelled_at: null,
    received_in_cash: false,
    description: 'Plano de tratamento — Ana (cartão 3x · a receber) [plan:plan1]',
    ...over,
  };
}

function montar(charge: any) {
  const prisma: any = {
    paymentGatewayCharge: {
      findFirst: jest.fn().mockResolvedValue(charge),
      findUnique: jest.fn().mockResolvedValue(charge),
      update: jest.fn().mockResolvedValue({}),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    user: { findUnique: jest.fn().mockResolvedValue({ name: 'Admin' }) },
  };
  const asaas: any = { deleteCharge: jest.fn().mockResolvedValue({ deleted: true }), getCharge: jest.fn() };
  const svc = new PaymentGatewayService(prisma, asaas, {} as any, {} as any, {} as any, {} as any, {} as any);
  // O caixa e a promoção do lead têm testes próprios — aqui só a regra e o rastro.
  const receita = jest.spyOn(svc as any, 'ensureChargeReceita').mockResolvedValue('tx1');
  const split = jest.spyOn(svc as any, 'ensureChargeReceitaSplit').mockResolvedValue('tx-split');
  jest.spyOn(svc as any, 'promoteLeadFromCharge').mockImplementation(() => undefined);
  return { svc, prisma, asaas, receita, split };
}

describe('PaymentGatewayService.registerClinicReceipt — Fase 0 (C/D/H1)', () => {
  it('D: cobrança DELETED lança 400 e NÃO marca recebida nem lança no caixa', async () => {
    const { svc, prisma, receita } = montar(cobranca({ status: 'DELETED' }));
    await expect(svc.registerClinicReceipt('cash-plan1-AVISTA-1', { userId: 'u1' })).rejects.toThrow(MSG_COBRANCA_CANCELADA);
    expect(prisma.paymentGatewayCharge.update).not.toHaveBeenCalled();
    expect(receita).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('D: cancelled_at preenchido também barra (mesmo com status antigo)', async () => {
    const { svc, prisma } = montar(cobranca({ status: 'PENDING', cancelled_at: new Date() }));
    await expect(svc.registerClinicReceipt('cash-plan1-AVISTA-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.paymentGatewayCharge.update).not.toHaveBeenCalled();
  });

  it('C: soma das formas diferente do valor lança 400 sem update', async () => {
    const { svc, prisma, split } = montar(cobranca());
    await expect(
      svc.registerClinicReceipt('cash-plan1-AVISTA-1', {
        payments: [{ method: 'CARTAO', value: 50 }, { method: 'DINHEIRO', value: 40 }],
      }),
    ).rejects.toThrow(/soma das formas de pagamento \(R\$ 90,00\).*\(R\$ 100,00\)/);
    expect(prisma.paymentGatewayCharge.update).not.toHaveBeenCalled();
    expect(split).not.toHaveBeenCalled();
  });

  it('caminho feliz grava AuditLog com tenant_id e entity FINANCEIRO', async () => {
    const { svc, prisma } = montar(cobranca());
    const r = await svc.registerClinicReceipt('cash-plan1-AVISTA-1', { userId: 'u1', paymentMethod: 'PIX' });
    expect(r).toEqual({ ok: true, transaction_id: 'tx1', charge_id: 'ch1' });
    expect(prisma.paymentGatewayCharge.update).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const data = prisma.auditLog.create.mock.calls[0][0].data;
    expect(data).toEqual(expect.objectContaining({
      tenant_id: TENANT, actor_user_id: 'u1', entity: 'FINANCEIRO', entity_id: 'ch1', action: 'COBRANCA_BAIXA_MANUAL',
    }));
    expect(data.meta_json).toEqual(expect.objectContaining({
      descricao: 'Baixa manual — cash-plan1-AVISTA-1',
      valor: 100,
      formas: [{ method: 'PIX', value: 100 }],
      origem: 'receive-in-cash',
      before: { status: 'PENDING' },
      after: { status: 'RECEIVED', transaction_id: 'tx1' },
    }));
  });

  it('split que fecha (tolerância de 1 centavo) passa e o rastro leva as formas', async () => {
    const { svc, prisma, split } = montar(cobranca());
    const payments = [{ method: 'CARTAO', value: 60.01, installments: 3 }, { method: 'CARTAO', value: 40, debit: true }];
    const r = await svc.registerClinicReceipt('cash-plan1-AVISTA-1', { payments, origem: 'venda-balcao' });
    expect(r).toEqual(expect.objectContaining({ ok: true, transaction_id: 'tx-split', split: 2 }));
    expect(split).toHaveBeenCalledWith('ch1', payments);
    const meta = prisma.auditLog.create.mock.calls[0][0].data.meta_json;
    expect(meta.formas).toEqual(payments);
    expect(meta.origem).toBe('venda-balcao');
  });

  it('segunda chamada (já RECEIVED) não grava nova auditoria', async () => {
    const { svc, prisma } = montar(cobranca({ status: 'RECEIVED', received_in_cash: true, paid_at: new Date() }));
    await svc.registerClinicReceipt('cash-plan1-AVISTA-1', { userId: 'u1' });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('cobrança local inexistente segue o fluxo atual (charge_not_found)', async () => {
    const { svc } = montar(null);
    await expect(svc.registerClinicReceipt('nao-existe')).resolves.toEqual({ ok: false, reason: 'charge_not_found' });
  });
});

describe('PaymentGatewayService.assertClinicReceiptAllowed — Fase 0', () => {
  it('cancelada → 400; soma errada → 400; ok e inexistente passam', async () => {
    await expect(montar(cobranca({ status: 'REFUNDED' })).svc.assertClinicReceiptAllowed('x')).rejects.toThrow(MSG_COBRANCA_CANCELADA);
    await expect(
      montar(cobranca()).svc.assertClinicReceiptAllowed('x', { payments: [{ value: 99.98 }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(montar(cobranca()).svc.assertClinicReceiptAllowed('x', { payments: [{ value: 100.01 }] })).resolves.toBeUndefined();
    await expect(montar(null).svc.assertClinicReceiptAllowed('x')).resolves.toBeUndefined();
  });
});

describe('PaymentGatewayService.confirmCartaoReceipt — Fase 0 (D2)', () => {
  it('com cancelled_at lança 400 e não marca recebida', async () => {
    const { svc, prisma } = montar(cobranca({ external_id: 'cash-plan1-CARTAO-1', cancelled_at: new Date() }));
    await expect(svc.confirmCartaoReceipt('ch1', TENANT, 'u1')).rejects.toThrow(MSG_COBRANCA_CANCELADA);
    expect(prisma.paymentGatewayCharge.update).not.toHaveBeenCalled();
  });

  it('cartão a receber confirma com origem confirm-cartao no rastro', async () => {
    const { svc, prisma } = montar(cobranca({ external_id: 'cash-plan1-CARTAO-1' }));
    await svc.confirmCartaoReceipt('ch1', TENANT, 'u1');
    const meta = prisma.auditLog.create.mock.calls[0][0].data.meta_json;
    expect(meta.origem).toBe('confirm-cartao');
    expect(meta.formas).toEqual([{ method: 'CARTAO', value: 100 }]);
  });
});

describe('PaymentGatewayService.ensureChargeReceitaSplit — Fase 0 (cinto de segurança C)', () => {
  it('soma que não fecha lança 400 antes de lançar no caixa', async () => {
    const charge = { ...cobranca(), transaction_id: null, lead_honorario_payment_id: null, treatment_plan: null, patient: null };
    const prisma: any = {
      paymentGatewayCharge: { findUnique: jest.fn().mockResolvedValue(charge) },
      cashAccount: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(),
    };
    const moduleRef: any = { get: jest.fn().mockReturnValue({ ensureDefaultAccounts: jest.fn().mockResolvedValue(undefined) }) };
    const svc = new PaymentGatewayService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, moduleRef);
    await expect(
      (svc as any).ensureChargeReceitaSplit('ch1', [{ method: 'CARTAO', value: 50 }]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('PaymentGatewayService.deleteCharge — Fase 0 (B5)', () => {
  it('cancelamento novo grava COBRANCA_CANCELADA com motivo e valor', async () => {
    const { svc, prisma } = montar(cobranca({ external_id: 'pay_123', gateway: 'ASAAS', transaction_id: null }));
    await expect(svc.deleteCharge('pay_123', TENANT, { userId: 'u1', reason: 'Paciente desistiu' }))
      .resolves.toEqual({ deleted: true, asaasSynced: true });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const data = prisma.auditLog.create.mock.calls[0][0].data;
    expect(data).toEqual(expect.objectContaining({
      tenant_id: TENANT, actor_user_id: 'u1', entity: 'FINANCEIRO', entity_id: 'ch1', action: 'COBRANCA_CANCELADA',
    }));
    expect(data.meta_json).toEqual(expect.objectContaining({
      descricao: 'Cobrança cancelada — Paciente desistiu',
      valor: 100,
      motivo: 'Paciente desistiu',
      external_id: 'pay_123',
      asaas_synced: true,
      before: { status: 'PENDING' },
      after: { status: 'DELETED' },
    }));
  });

  it('re-cancelamento (já tinha cancelled_at) não gera linha nova', async () => {
    const { svc, prisma } = montar(cobranca({
      external_id: 'pay_123', gateway: 'ASAAS', transaction_id: null, status: 'DELETED', cancelled_at: new Date(),
    }));
    await svc.deleteCharge('pay_123', TENANT, { userId: 'u1', reason: 'De novo' });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
