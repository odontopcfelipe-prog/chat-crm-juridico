/**
 * Fase 0 — rotas do payment-gateway:
 *   A1) só ADMIN troca a conta Asaas;
 *   B1) receive-in-cash valida D/C na cobrança LOCAL antes do Asaas; ler o Asaas é
 *       best-effort, mas cobrança cancelada LÁ barra (antes o catch engolia);
 *   B4) PUT charges/asaas só com manage_financial, com rastro;
 *   B5) cancelar exige motivo (3+ letras) no servidor.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PaymentGatewayController } from './payment-gateway.controller';
import { PermissionsGuard } from '../auth/decorators/requires-permission.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { MSG_COBRANCA_CANCELADA } from './baixa-regras';

const TENANT = 't1';
const ADMIN = { id: 'adm1', tenant_id: TENANT, roles: ['ADMIN'] };
const RECEPCAO = { id: 'rec1', tenant_id: TENANT, roles: ['OPERATOR'] };

function montar(o: { localCharge?: any } = {}) {
  const service: any = {
    assertClinicReceiptAllowed: jest.fn().mockResolvedValue(undefined),
    registerClinicReceipt: jest.fn().mockResolvedValue({ ok: true, transaction_id: 'tx1', charge_id: 'ch1' }),
    deleteCharge: jest.fn().mockResolvedValue({ deleted: true, asaasSynced: true }),
    setupAsaas: jest.fn().mockResolvedValue({ ok: true, sandbox: false }),
  };
  const asaasClient: any = {
    getCharge: jest.fn().mockResolvedValue({ id: 'pay_1', status: 'PENDING', value: 100, dueDate: '2026-10-30', description: 'x' }),
    receiveInCash: jest.fn().mockResolvedValue({ status: 'RECEIVED_IN_CASH' }),
    updateCharge: jest.fn().mockResolvedValue({ id: 'pay_1', value: 120 }),
  };
  const prisma: any = {
    paymentGatewayCharge: {
      findUnique: jest.fn().mockResolvedValue(o.localCharge === undefined ? { tenant_id: TENANT } : o.localCharge),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const ctrl = new PaymentGatewayController(service, asaasClient, prisma, {} as any);
  return { ctrl, service, asaasClient, prisma };
}

afterEach(() => jest.restoreAllMocks());

describe('PaymentGatewayController — Fase 0 (A1) setup', () => {
  it('a rota exige ADMIN/SUPER_ADMIN e repassa quem trocou', async () => {
    const roles = Reflect.getMetadata(ROLES_KEY, PaymentGatewayController.prototype.setup);
    expect(roles).toEqual(['ADMIN', 'SUPER_ADMIN']);
    const { ctrl, service } = montar();
    await ctrl.setup({ user: ADMIN }, { apiKey: 'k'.repeat(30), sandbox: true });
    expect(service.setupAsaas).toHaveBeenCalledWith(TENANT, 'k'.repeat(30), true, { userId: 'adm1' });
  });
});

describe('PaymentGatewayController.receiveInCash — Fase 0 (B1)', () => {
  it('getCharge que lança não impede a baixa local', async () => {
    const { ctrl, service, asaasClient } = montar();
    asaasClient.getCharge.mockRejectedValue(new Error('[Asaas 404]'));
    const r = await ctrl.receiveInCash('cash-plan1-AVISTA-1', { payment_method: 'DINHEIRO' }, { user: ADMIN });
    expect(asaasClient.receiveInCash).not.toHaveBeenCalled();
    expect(service.registerClinicReceipt).toHaveBeenCalledWith('cash-plan1-AVISTA-1', expect.objectContaining({
      paymentMethod: 'DINHEIRO', userId: 'adm1', origem: 'receive-in-cash',
    }));
    expect(r.caixa).toEqual(expect.objectContaining({ ok: true }));
  });

  it('remote.deleted:true lança 400 sem fechar no Asaas nem lançar no caixa', async () => {
    const { ctrl, service, asaasClient } = montar();
    asaasClient.getCharge.mockResolvedValue({ id: 'pay_1', status: 'PENDING', deleted: true, value: 100 });
    await expect(ctrl.receiveInCash('pay_1', {}, { user: ADMIN })).rejects.toThrow(MSG_COBRANCA_CANCELADA);
    expect(asaasClient.receiveInCash).not.toHaveBeenCalled();
    expect(service.registerClinicReceipt).not.toHaveBeenCalled();
  });

  it('remote estornado (REFUNDED) também barra', async () => {
    const { ctrl, asaasClient } = montar();
    asaasClient.getCharge.mockResolvedValue({ id: 'pay_1', status: 'REFUNDED', value: 100 });
    await expect(ctrl.receiveInCash('pay_1', {}, { user: ADMIN })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('regra local (D/C) barra ANTES de tocar no Asaas', async () => {
    const { ctrl, service, asaasClient } = montar();
    service.assertClinicReceiptAllowed.mockRejectedValue(new BadRequestException(MSG_COBRANCA_CANCELADA));
    const payments = [{ method: 'CARTAO', value: 10 }];
    await expect(ctrl.receiveInCash('pay_1', { payments }, { user: ADMIN })).rejects.toThrow(MSG_COBRANCA_CANCELADA);
    expect(service.assertClinicReceiptAllowed).toHaveBeenCalledWith('pay_1', { payments });
    expect(asaasClient.getCharge).not.toHaveBeenCalled();
    expect(service.registerClinicReceipt).not.toHaveBeenCalled();
  });

  it('caminho feliz fecha no Asaas com o valor remoto e lança no caixa', async () => {
    const { ctrl, service, asaasClient } = montar();
    await ctrl.receiveInCash('pay_1', { payment_method: 'PIX' }, { user: ADMIN });
    expect(asaasClient.receiveInCash).toHaveBeenCalledWith('pay_1', expect.any(String), 100, TENANT);
    expect(service.registerClinicReceipt).toHaveBeenCalledTimes(1);
  });

  it('payments fora do formato (não-lista) dá 400', async () => {
    const { ctrl, service } = montar();
    await expect(ctrl.receiveInCash('pay_1', { payments: 'x' as any }, { user: ADMIN })).rejects.toBeInstanceOf(BadRequestException);
    expect(service.registerClinicReceipt).not.toHaveBeenCalled();
  });

  it('cobrança de outra clínica continua 403', async () => {
    const { ctrl } = montar({ localCharge: { tenant_id: 'outro' } });
    await expect(ctrl.receiveInCash('pay_1', {}, { user: ADMIN })).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('PaymentGatewayController.updateAsaasCharge — Fase 0 (B4)', () => {
  it('sem manage_financial: 403 PERMISSION_DENIED e não altera no Asaas', async () => {
    jest.spyOn(PermissionsGuard, 'permissionsFor').mockResolvedValue(new Set(['operate_cash']) as any);
    const { ctrl, asaasClient } = montar();
    const err: any = await ctrl.updateAsaasCharge('pay_1', { value: 1 }, { user: RECEPCAO }).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse().code).toBe('PERMISSION_DENIED');
    expect(asaasClient.updateCharge).not.toHaveBeenCalled();
  });

  it('com permissão: altera e grava COBRANCA_ALTERADA com o antes e o depois', async () => {
    jest.spyOn(PermissionsGuard, 'permissionsFor').mockResolvedValue(new Set(['manage_financial']) as any);
    const { ctrl, asaasClient, prisma } = montar();
    const res = await ctrl.updateAsaasCharge('pay_1', { value: 120 }, { user: RECEPCAO });
    expect(res).toEqual({ id: 'pay_1', value: 120 });
    expect(asaasClient.updateCharge).toHaveBeenCalledWith('pay_1', { value: 120 }, TENANT);
    const data = prisma.auditLog.create.mock.calls[0][0].data;
    expect(data).toEqual(expect.objectContaining({
      tenant_id: TENANT, actor_user_id: 'rec1', entity: 'FINANCEIRO', entity_id: 'pay_1', action: 'COBRANCA_ALTERADA',
    }));
    expect(data.meta_json).toEqual(expect.objectContaining({
      descricao: 'Cobrança pay_1 alterada',
      valor: 120,
      before: { value: 100, dueDate: '2026-10-30', description: 'x' },
      after: { value: 120 },
    }));
  });

  it('ADMIN passa sem consultar permissões; leitura do antes que falha não impede', async () => {
    const spy = jest.spyOn(PermissionsGuard, 'permissionsFor');
    const { ctrl, asaasClient, prisma } = montar();
    asaasClient.getCharge.mockRejectedValue(new Error('rede'));
    await ctrl.updateAsaasCharge('pay_1', { dueDate: '2026-11-10' }, { user: ADMIN });
    expect(spy).not.toHaveBeenCalled();
    const meta = prisma.auditLog.create.mock.calls[0][0].data.meta_json;
    expect(meta.before).toBeNull();
    expect(meta.valor).toBe(0);
  });
});

describe('PaymentGatewayController.deleteAsaasCharge — Fase 0 (B5)', () => {
  it('sem motivo ou com menos de 3 letras: 400 e não cancela', async () => {
    const { ctrl, service } = montar();
    await expect(ctrl.deleteAsaasCharge('pay_1', { user: ADMIN })).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctrl.deleteAsaasCharge('pay_1', { user: ADMIN }, '  ab  ')).rejects.toThrow(/mínimo 3 letras/);
    expect(service.deleteCharge).not.toHaveBeenCalled();
  });

  it('motivo válido vai aparado pro service', async () => {
    const { ctrl, service } = montar();
    await ctrl.deleteAsaasCharge('pay_1', { user: ADMIN }, '  Paciente desistiu ');
    expect(service.deleteCharge).toHaveBeenCalledWith('pay_1', TENANT, { userId: 'adm1', reason: 'Paciente desistiu' });
  });
});
