/**
 * Fase 0 — B3: mark-cash-received por PERMISSÃO, sem tirar ninguém: ADMIN, papel
 * FINANCEIRO (mesmo com setor diferente) e quem tem operate_cash/manage_financial
 * (a recepção passa a poder). Os demais levam 403 PERMISSION_DENIED.
 */
import { ForbiddenException } from '@nestjs/common';
import { CommercialController } from './commercial.controller';
import { PermissionsGuard } from '../auth/decorators/requires-permission.decorator';

const TENANT = 't1';

// Só o handler interessa: monta o controller sem as ~20 dependências do construtor.
function montar(): { markCashReceived: CommercialController['markCashReceived']; downPaymentFlow: { markCashReceived: jest.Mock } } {
  const ctrl: any = Object.create(CommercialController.prototype);
  ctrl.prisma = {};
  ctrl.downPaymentFlow = { markCashReceived: jest.fn().mockResolvedValue({ id: 'ch1', status: 'RECEIVED' }) };
  return ctrl;
}
const user = (roles: string[]) => ({ id: 'u1', email: 'u@x', tenant_id: TENANT, roles, role: roles[0] });

afterEach(() => jest.restoreAllMocks());

describe('CommercialController.markCashReceived — Fase 0 (B3)', () => {
  it('ADMIN passa sem consultar permissões', async () => {
    const spy = jest.spyOn(PermissionsGuard, 'permissionsFor');
    const ctrl = montar();
    await ctrl.markCashReceived('ch1', user(['ADMIN']));
    expect(spy).not.toHaveBeenCalled();
    expect(ctrl.downPaymentFlow.markCashReceived).toHaveBeenCalledWith('ch1', 'u1', TENANT);
  });

  it('papel FINANCEIRO continua passando (mesmo sem a permissão no setor)', async () => {
    jest.spyOn(PermissionsGuard, 'permissionsFor').mockResolvedValue(new Set() as any);
    const ctrl = montar();
    await ctrl.markCashReceived('ch1', user(['FINANCEIRO']));
    expect(ctrl.downPaymentFlow.markCashReceived).toHaveBeenCalled();
  });

  it('recepção com operate_cash GANHA o acesso', async () => {
    jest.spyOn(PermissionsGuard, 'permissionsFor').mockResolvedValue(new Set(['operate_cash']) as any);
    const ctrl = montar();
    await ctrl.markCashReceived('ch1', user(['OPERATOR']));
    expect(ctrl.downPaymentFlow.markCashReceived).toHaveBeenCalled();
  });

  it('sem nenhuma das permissões: 403 PERMISSION_DENIED', async () => {
    jest.spyOn(PermissionsGuard, 'permissionsFor').mockResolvedValue(new Set(['manage_proposals']) as any);
    const ctrl = montar();
    const err: any = await ctrl.markCashReceived('ch1', user(['COMERCIAL'])).catch((e: any) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse().code).toBe('PERMISSION_DENIED');
    expect(ctrl.downPaymentFlow.markCashReceived).not.toHaveBeenCalled();
  });
});
