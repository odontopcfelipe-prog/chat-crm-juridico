import { ForbiddenException } from '@nestjs/common';
import { QuotesService } from './quotes.service';

/**
 * Fase 0 — F7 (Ortodontia): pausar plano PENDING_SIGNATURE é só do ADMIN. Sem a trava,
 * pausar (vira PAUSED) e retomar (activate) ativava o plano sem assinatura.
 */
describe('QuotesService.setOrthoPause — plano aguardando assinatura (Fase 0)', () => {
  const TENANT = 't-orto';

  function montar(planos: Array<{ id: string; status: string }>) {
    const prisma: any = {
      patient: { findFirst: jest.fn().mockResolvedValue({ id: 'pat1' }) },
      quote: { findMany: jest.fn().mockResolvedValue(planos.map((p) => ({ treatment_plan: p }))) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const plans: any = {
      pause: jest.fn().mockResolvedValue({}),
      activate: jest.fn().mockResolvedValue({}),
    };
    const service = new QuotesService(
      prisma, { get: jest.fn() } as any,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, plans,
    );
    return { service, prisma, plans };
  }

  it('não-admin pausando paciente com plano PENDING_SIGNATURE: 403 e nada muda', async () => {
    const { service, prisma, plans } = montar([{ id: 'pl1', status: 'PENDING_SIGNATURE' }]);
    const e: any = await service.setOrthoPause(TENANT, 'pat1', true, 'crc1').catch((x) => x);
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(e.getResponse()).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(plans.pause).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('ADMIN pausa o plano PENDING_SIGNATURE normalmente', async () => {
    const { service, plans } = montar([{ id: 'pl1', status: 'PENDING_SIGNATURE' }]);
    await service.setOrthoPause(TENANT, 'pat1', true, 'adm1', true);
    expect(plans.pause).toHaveBeenCalledWith('pl1', TENANT);
  });

  it('não-admin pausa e retoma plano ACTIVE/PAUSED como antes', async () => {
    const a = montar([{ id: 'pl1', status: 'ACTIVE' }]);
    await a.service.setOrthoPause(TENANT, 'pat1', true, 'crc1');
    expect(a.plans.pause).toHaveBeenCalledWith('pl1', TENANT);

    const b = montar([{ id: 'pl1', status: 'PAUSED' }]);
    await b.service.setOrthoPause(TENANT, 'pat1', false, 'crc1');
    expect(b.plans.activate).toHaveBeenCalledWith('pl1', TENANT);
  });

  it('retomar nunca ativa PENDING_SIGNATURE (só PAUSED)', async () => {
    const { service, plans } = montar([{ id: 'pl1', status: 'PENDING_SIGNATURE' }]);
    await service.setOrthoPause(TENANT, 'pat1', false, 'crc1');
    expect(plans.activate).not.toHaveBeenCalled();
  });
});
