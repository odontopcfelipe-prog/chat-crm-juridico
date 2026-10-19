/**
 * Fase 0 — D3: mark-cash-received (sinal/entrada em espécie)
 *   - não ressuscita cobrança cancelada/estornada;
 *   - claim atômico: clique duplo marca UMA vez (e só a 1ª grava rastro e dispara o trigger);
 *   - a baixa vai pro Log do Financeiro com tenant_id na coluna.
 */
jest.mock('../leads/clinic-transfer-guard', () => ({
  leadIdForCharge: jest.fn().mockResolvedValue(null),
  promoteLeadInBackground: jest.fn(),
}));

import { BadRequestException } from '@nestjs/common';
import { DownPaymentFlowService } from './down-payment-flow.service';
import { MSG_COBRANCA_CANCELADA } from '../payment-gateway/baixa-regras';

const TENANT = 't1';

function montar(charge: any, claimCount = 1) {
  const depois = { ...charge, status: 'RECEIVED', received_in_cash: true };
  const prisma: any = {
    paymentGatewayCharge: {
      findUnique: jest.fn()
        .mockResolvedValueOnce(charge) // leitura inicial
        .mockResolvedValue(depois), // depois do claim
      updateMany: jest.fn().mockResolvedValue({ count: claimCount }),
      update: jest.fn(),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const svc = new DownPaymentFlowService(prisma, {} as any, {} as any, {} as any);
  const trigger = jest.spyOn(svc, 'handleChargePaid').mockResolvedValue(undefined as any);
  return { svc, prisma, trigger, depois };
}

const sinal = (over: Record<string, any> = {}) => ({
  id: 'ch1', tenant_id: TENANT, gateway: 'CASH', status: 'PENDING', received_in_cash: false,
  cancelled_at: null, amount: 250, ...over,
});

describe('DownPaymentFlowService.markCashReceived — Fase 0 (D3)', () => {
  it('cobrança cancelada dá 400 e não marca nada', async () => {
    const { svc, prisma, trigger } = montar(sinal({ status: 'DELETED', cancelled_at: new Date() }));
    await expect(svc.markCashReceived('ch1', 'u1', TENANT)).rejects.toThrow(MSG_COBRANCA_CANCELADA);
    expect(prisma.paymentGatewayCharge.updateMany).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
  });

  it('cobrança CANCELLED (status) também barra', async () => {
    const { svc } = montar(sinal({ status: 'CANCELLED' }));
    await expect(svc.markCashReceived('ch1', 'u1', TENANT)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('updateMany.count === 0 (outro clique ganhou) não grava auditoria nem dispara o trigger', async () => {
    const { svc, prisma, trigger, depois } = montar(sinal(), 0);
    await expect(svc.markCashReceived('ch1', 'u1', TENANT)).resolves.toEqual(depois);
    expect(prisma.paymentGatewayCharge.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'ch1', received_in_cash: false },
    }));
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
  });

  it('1ª baixa: claim, rastro com tenant_id e trigger', async () => {
    const { svc, prisma, trigger, depois } = montar(sinal());
    await expect(svc.markCashReceived('ch1', 'u1', TENANT)).resolves.toEqual(depois);
    expect(prisma.paymentGatewayCharge.update).not.toHaveBeenCalled();
    const data = prisma.auditLog.create.mock.calls[0][0].data;
    expect(data).toEqual(expect.objectContaining({
      tenant_id: TENANT, actor_user_id: 'u1', entity: 'FINANCEIRO', entity_id: 'ch1', action: 'COBRANCA_BAIXA_MANUAL',
    }));
    expect(data.meta_json).toEqual(expect.objectContaining({
      descricao: 'Baixa em espécie (sinal/entrada)', valor: 250, origem: 'mark-cash-received',
      before: { status: 'PENDING' }, after: { status: 'RECEIVED' },
    }));
    expect(trigger).toHaveBeenCalledWith('ch1');
  });

  it('já recebida continua idempotente (devolve como está, sem claim)', async () => {
    const ja = sinal({ status: 'RECEIVED', received_in_cash: true });
    const { svc, prisma } = montar(ja);
    await expect(svc.markCashReceived('ch1', 'u1', TENANT)).resolves.toEqual(ja);
    expect(prisma.paymentGatewayCharge.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
