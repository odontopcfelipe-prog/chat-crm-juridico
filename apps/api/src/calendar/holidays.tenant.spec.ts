/**
 * Feriado GLOBAL (Holiday.tenant_id NULL) vale para todas as clínicas (agenda,
 * IA, ponto, disparos): só o SUPER_ADMIN cria, edita ou apaga. Antes o ADMIN de
 * QUALQUER clínica apagava o "Natal" de todas. Feriado da clínica e listar: igual.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CalendarService, MSG_FERIADO_GLOBAL_SO_SUPER } from './calendar.service';
import { CalendarController } from './calendar.controller';

function montar(existente: { tenant_id: string | null } | null) {
  const prisma: any = {
    holiday: {
      findUnique: jest.fn(async () => existente),
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: any) => ({ id: 'novo', ...data })),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
      delete: jest.fn(async () => ({})),
    },
  };
  return {
    svc: new CalendarService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any),
    prisma,
  };
}

const ADMIN = ['ADMIN'];
const SUPER = ['SUPER_ADMIN'];
const negado = (e: any) => {
  expect(e).toBeInstanceOf(ForbiddenException);
  expect(e.getResponse()).toEqual({ message: MSG_FERIADO_GLOBAL_SO_SUPER, code: 'PERMISSION_DENIED' });
};

describe('Feriado global: só SUPER_ADMIN altera', () => {
  it('ADMIN de clínica não edita global: 403 PERMISSION_DENIED, nada gravado', async () => {
    const { svc, prisma } = montar({ tenant_id: null });
    negado(await svc.updateHoliday('h1', { name: 'X' }, 'A', ADMIN).catch((e) => e));
    expect(prisma.holiday.update).not.toHaveBeenCalled();
  });

  it('ADMIN de clínica não apaga global', async () => {
    const { svc, prisma } = montar({ tenant_id: null });
    negado(await svc.deleteHoliday('h1', 'A', ADMIN).catch((e) => e));
    expect(prisma.holiday.delete).not.toHaveBeenCalled();
  });

  it('ADMIN sem clínica no login também não mexe no global (fail-closed, sem papéis = negado)', async () => {
    const { svc, prisma } = montar({ tenant_id: null });
    negado(await svc.deleteHoliday('h1', undefined, ADMIN).catch((e) => e));
    negado(await svc.deleteHoliday('h1', undefined, undefined).catch((e) => e));
    negado(await svc.updateHoliday('h1', { name: 'X' }, undefined, []).catch((e) => e));
    expect(prisma.holiday.delete).not.toHaveBeenCalled();
    expect(prisma.holiday.update).not.toHaveBeenCalled();
  });

  it('sem clínica no login, ADMIN também não mexe em feriado DE CLÍNICA (antes alcançava qualquer uma)', async () => {
    const { svc, prisma } = montar({ tenant_id: 'B' });
    for (const e of [
      await svc.deleteHoliday('h1', undefined, ADMIN).catch((x) => x),
      await svc.updateHoliday('h1', { name: 'X' }, undefined, ADMIN).catch((x) => x),
    ]) {
      expect(e).toBeInstanceOf(ForbiddenException);
      expect(e.getResponse()).toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    expect(prisma.holiday.delete).not.toHaveBeenCalled();
    expect(prisma.holiday.update).not.toHaveBeenCalled();
    await svc.deleteHoliday('h1', undefined, SUPER);
    expect(prisma.holiday.delete).toHaveBeenCalledTimes(1);
  });

  it('SUPER_ADMIN edita e apaga global', async () => {
    const { svc, prisma } = montar({ tenant_id: null });
    await svc.updateHoliday('h1', { name: 'Natal' }, undefined, SUPER);
    await svc.deleteHoliday('h1', undefined, SUPER);
    expect(prisma.holiday.update).toHaveBeenCalledWith({ where: { id: 'h1' }, data: { name: 'Natal' } });
    expect(prisma.holiday.delete).toHaveBeenCalledWith({ where: { id: 'h1' } });
  });

  it('ADMIN edita e apaga feriado DA clínica (igual hoje)', async () => {
    const { svc, prisma } = montar({ tenant_id: 'A' });
    await svc.updateHoliday('h1', { name: 'Aniversário' }, 'A', ADMIN);
    await svc.deleteHoliday('h1', 'A', ADMIN);
    expect(prisma.holiday.update).toHaveBeenCalled();
    expect(prisma.holiday.delete).toHaveBeenCalled();
  });

  it('feriado de outra clínica: 404 (igual hoje)', async () => {
    const { svc, prisma } = montar({ tenant_id: 'B' });
    await expect(svc.deleteHoliday('h1', 'A', ADMIN)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.updateHoliday('h1', { name: 'x' }, 'A', ADMIN)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.holiday.delete).not.toHaveBeenCalled();
    expect(prisma.holiday.update).not.toHaveBeenCalled();
  });

  it('id inexistente: 404 também sem clínica no login', async () => {
    const { svc } = montar(null);
    await expect(svc.updateHoliday('nada', { name: 'x' }, undefined, SUPER)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('criar: ADMIN com clínica cria NA clínica; sem clínica (global) só SUPER_ADMIN', async () => {
    const { svc, prisma } = montar(null);
    await svc.createHoliday({ date: '2026-12-08', name: 'Aniversário', tenant_id: 'A' }, ADMIN);
    expect(prisma.holiday.create.mock.calls[0][0].data.tenant_id).toBe('A');
    negado(await svc.createHoliday({ date: '2026-12-08', name: 'X' }, ADMIN).catch((e) => e));
    negado(await svc.createHoliday({ date: '2026-12-08', name: 'X' }).catch((e) => e));
    await svc.createHoliday({ date: '2026-12-08', name: 'Nacional' }, SUPER);
    expect(prisma.holiday.create).toHaveBeenCalledTimes(2);
    expect(prisma.holiday.create.mock.calls[1][0].data.tenant_id).toBeUndefined();
  });

  it('listar continua igual: clínica vê os dela + globais', async () => {
    const { svc, prisma } = montar(null);
    await svc.findHolidays('A');
    expect(prisma.holiday.findMany).toHaveBeenCalledWith({
      where: { OR: [{ tenant_id: 'A' }, { tenant_id: null }] },
      orderBy: { date: 'asc' },
    });
  });
});

describe('CalendarController — feriados repassam os papéis', () => {
  it('create/update/delete levam req.user.roles ao service', async () => {
    const svc: any = {
      createHoliday: jest.fn(async () => ({})),
      updateHoliday: jest.fn(async () => ({})),
      deleteHoliday: jest.fn(async () => ({ deleted: true })),
    };
    const ctl = new CalendarController(svc);
    const req = { user: { tenant_id: 'A', roles: ['ADMIN'] } };
    await ctl.createHoliday({ date: '2026-12-08', name: 'Aniversário' } as any, req);
    await ctl.updateHoliday('h1', { name: 'X' } as any, req);
    await ctl.deleteHoliday('h1', req);
    expect(svc.createHoliday).toHaveBeenCalledWith({ date: '2026-12-08', name: 'Aniversário', tenant_id: 'A' }, ['ADMIN']);
    expect(svc.updateHoliday).toHaveBeenCalledWith('h1', { name: 'X' }, 'A', ['ADMIN']);
    expect(svc.deleteHoliday).toHaveBeenCalledWith('h1', 'A', ['ADMIN']);
  });
});
