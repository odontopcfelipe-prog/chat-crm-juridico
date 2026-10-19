/**
 * Fase 0 — Grupo 3, rotas de plano: /execute com ator (F1), finalize e /complete só
 * ADMIN (F4/F6), PATCH de plano com status só ADMIN (F6), STAND BY com permissão,
 * trava de PENDING_SIGNATURE e registro (F7).
 */
import { ForbiddenException } from '@nestjs/common';
import { CommercialController } from './commercial.controller';
import { PermissionsGuard, REQUIRES_PERMISSION_KEY } from '../auth/decorators/requires-permission.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';

const TENANT = 't1';

function montar(planStatus = 'ACTIVE', depois?: string) {
  const ctrl: any = Object.create(CommercialController.prototype);
  ctrl.logger = { warn: jest.fn(), log: jest.fn() };
  ctrl.prisma = { auditLog: { create: jest.fn(async () => ({})) } };
  ctrl.plansService = {
    findOne: jest.fn(async (id: string) => ({ id, status: planStatus })),
    pause: jest.fn(async (id: string) => ({ id, status: depois ?? 'PAUSED' })),
    activate: jest.fn(async (id: string) => ({ id, status: depois ?? 'ACTIVE' })),
    complete: jest.fn(async (id: string) => ({ id, status: 'COMPLETED' })),
    update: jest.fn(async (id: string) => ({ id })),
    executeItemAsActor: jest.fn(async () => ({ id: 'item1', status: 'DONE' })),
  };
  return ctrl;
}
const req = (roles: string[], id = 'u1') => ({ user: { id, tenant_id: TENANT, roles } });

afterEach(() => jest.restoreAllMocks());

describe('CommercialController — rotas de plano (Fase 0, Grupo 3)', () => {
  it('F4/F6: finalize e /complete exigem papel ADMIN/SUPER_ADMIN (e não mais manage_proposals)', () => {
    const proto = CommercialController.prototype as any;
    for (const h of ['finalizePlans', 'completePlan']) {
      expect(Reflect.getMetadata(ROLES_KEY, proto[h])).toEqual(['ADMIN', 'SUPER_ADMIN']);
      expect(Reflect.getMetadata(REQUIRES_PERMISSION_KEY, proto[h])).toBeUndefined();
    }
  });

  it('F1: /execute passa o ATOR (id + papéis) pro service', async () => {
    const ctrl = montar();
    await ctrl.executePlanItem('item1', { appointment_id: 'ev1' }, { id: 'dent1', tenant_id: TENANT, roles: ['DENTIST'] });
    expect(ctrl.plansService.executeItemAsActor).toHaveBeenCalledWith(
      'item1', TENANT, { id: 'dent1', roles: ['DENTIST'] }, { appointment_id: 'ev1' },
    );
  });

  it('F6: PATCH com status vindo de não-admin leva 403; sem status passa; ADMIN passa com o ator', async () => {
    const ctrl = montar();
    const e = await ctrl.updatePlan('p1', { status: 'CANCELLED' }, req(['COMERCIAL'])).catch((x: any) => x);
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(e.getResponse().code).toBe('PERMISSION_DENIED');
    expect(ctrl.plansService.update).not.toHaveBeenCalled();

    await ctrl.updatePlan('p1', { notes: 'x' }, req(['COMERCIAL']));
    expect(ctrl.plansService.update).toHaveBeenCalledWith('p1', TENANT, { notes: 'x' }, 'u1');

    await ctrl.updatePlan('p1', { status: 'CANCELLED' }, req(['ADMIN'], 'adm1'));
    expect(ctrl.plansService.update).toHaveBeenLastCalledWith('p1', TENANT, { status: 'CANCELLED' }, 'adm1');
  });

  it('F6: /complete audita CONCLUIDO com o antes e o depois', async () => {
    const ctrl = montar('ACTIVE');
    await ctrl.completePlan('p1', req(['ADMIN'], 'adm1'));
    expect(ctrl.prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
      tenant_id: TENANT, actor_user_id: 'adm1', entity: 'TREATMENT_PLAN', entity_id: 'p1', action: 'CONCLUIDO',
      meta_json: { before: { status: 'ACTIVE' }, after: { status: 'COMPLETED' } },
    });
  });

  it('F7: pausar sem manage_proposals/manage_financial leva 403', async () => {
    jest.spyOn(PermissionsGuard, 'permissionsFor').mockResolvedValue(new Set(['operate_cash']) as any);
    const ctrl = montar();
    const e = await ctrl.pausePlan('p1', req(['OPERADOR'])).catch((x: any) => x);
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(e.getResponse().code).toBe('PERMISSION_DENIED');
    expect(ctrl.plansService.pause).not.toHaveBeenCalled();
  });

  it('F7: CRC (manage_proposals) pausa e fica registrado PAUSADO via progresso', async () => {
    jest.spyOn(PermissionsGuard, 'permissionsFor').mockResolvedValue(new Set(['manage_proposals']) as any);
    const ctrl = montar('ACTIVE');
    await ctrl.pausePlan('p1', req(['COMERCIAL']));
    expect(ctrl.plansService.pause).toHaveBeenCalledWith('p1', TENANT);
    expect(ctrl.prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
      tenant_id: TENANT, actor_user_id: 'u1', entity: 'TREATMENT_PLAN', action: 'PAUSADO',
      meta_json: { via: 'progresso', before: { status: 'ACTIVE' }, after: { status: 'PAUSED' } },
    });
  });

  it('F7: pausa que não muda nada (já PAUSED) não gera registro', async () => {
    jest.spyOn(PermissionsGuard, 'permissionsFor').mockResolvedValue(new Set(['manage_financial']) as any);
    const ctrl = montar('PAUSED', 'PAUSED');
    await ctrl.pausePlan('p1', req(['FINANCEIRO']));
    expect(ctrl.prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('F7: plano aguardando assinatura — só o ADMIN ativa', async () => {
    jest.spyOn(PermissionsGuard, 'permissionsFor').mockResolvedValue(new Set(['manage_proposals']) as any);
    const ctrl = montar('PENDING_SIGNATURE');
    const e = await ctrl.activatePlan('p1', req(['COMERCIAL'])).catch((x: any) => x);
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(e.getResponse()).toMatchObject({ code: 'PERMISSION_DENIED', message: 'Plano aguardando assinatura — só o administrador ativa.' });
    expect(ctrl.plansService.activate).not.toHaveBeenCalled();

    const adm = montar('PENDING_SIGNATURE');
    await adm.activatePlan('p1', req(['ADMIN'], 'adm1'));
    expect(adm.plansService.activate).toHaveBeenCalledWith('p1', TENANT);
    expect(adm.prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: 'REATIVADO', actor_user_id: 'adm1' });
  });

  it('F7: plano aguardando assinatura — só o ADMIN pausa (pausar+retomar ativaria sem assinatura)', async () => {
    jest.spyOn(PermissionsGuard, 'permissionsFor').mockResolvedValue(new Set(['manage_proposals']) as any);
    const ctrl = montar('PENDING_SIGNATURE');
    const e = await ctrl.pausePlan('p1', req(['COMERCIAL'])).catch((x: any) => x);
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(e.getResponse()).toMatchObject({ code: 'PERMISSION_DENIED', message: 'Plano aguardando assinatura — só o administrador pausa ou ativa.' });
    expect(ctrl.plansService.pause).not.toHaveBeenCalled();
    expect(ctrl.prisma.auditLog.create).not.toHaveBeenCalled();

    const adm = montar('PENDING_SIGNATURE');
    await adm.pausePlan('p1', req(['ADMIN'], 'adm1'));
    expect(adm.plansService.pause).toHaveBeenCalledWith('p1', TENANT);
  });

  it('F7: stand by da Ortodontia repassa se o ator é ADMIN (trava de PENDING_SIGNATURE no service)', () => {
    const ctrl = montar();
    ctrl.quotesService = { setOrthoPause: jest.fn(async () => ({ ok: true })) };
    ctrl.orthoPausa({ patient_id: 'pat1', pausar: true }, { id: 'u1', tenant_id: TENANT, roles: ['COMERCIAL'] });
    expect(ctrl.quotesService.setOrthoPause).toHaveBeenLastCalledWith(TENANT, 'pat1', true, 'u1', false);
    ctrl.orthoPausa({ patient_id: 'pat1', pausar: false }, { id: 'adm1', tenant_id: TENANT, roles: ['SUPER_ADMIN'] });
    expect(ctrl.quotesService.setOrthoPause).toHaveBeenLastCalledWith(TENANT, 'pat1', false, 'adm1', true);
  });

  it('F7: CRC retoma plano PAUSED normalmente', async () => {
    jest.spyOn(PermissionsGuard, 'permissionsFor').mockResolvedValue(new Set(['manage_proposals']) as any);
    const ctrl = montar('PAUSED');
    await ctrl.activatePlan('p1', req(['COMERCIAL']));
    expect(ctrl.plansService.activate).toHaveBeenCalled();
    expect(ctrl.prisma.auditLog.create.mock.calls[0][0].data.action).toBe('REATIVADO');
  });
});
