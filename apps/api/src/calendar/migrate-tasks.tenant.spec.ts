/**
 * POST /calendar/migrate-tasks — isolamento por clínica.
 *
 * Antes: o ADMIN de QUALQUER clínica convertia as tarefas órfãs de TODAS, e a
 * task sem responsável ganhava como criador o 1º ADMIN do banco (de outra
 * clínica). Agora: só a clínica de quem chama (SUPER_ADMIN varre todas), criador
 * de reserva = ADMIN da MESMA clínica da task, e sem clínica no login = 403.
 */
import { ForbiddenException } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { CalendarController } from './calendar.controller';

type T = {
  id: string;
  tenant_id: string | null;
  assigned_user_id: string | null;
  calendar_event_id: string | null;
  comments: any[];
};

function montar(tasks: T[], adminPorClinica: Record<string, string>, clinicaDoUsuario: Record<string, string | null> = {}) {
  const prisma: any = {
    task: {
      findMany: jest.fn(async ({ where }: any) =>
        tasks
          .filter((t) => (where.calendar_event_id === null ? !t.calendar_event_id : !!t.calendar_event_id))
          .filter((t) => !('tenant_id' in where) || t.tenant_id === where.tenant_id)
          .map((t) => ({
            title: t.id,
            description: null,
            due_at: null,
            created_at: new Date('2026-10-01T12:00:00Z'),
            status: 'A_FAZER',
            lead_id: null,
            conversation_id: null,
            ...t,
          })),
      ),
      update: jest.fn(async () => ({})),
    },
    user: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.id in clinicaDoUsuario ? { tenant_id: clinicaDoUsuario[where.id] } : null,
      ),
      findFirst: jest.fn(async ({ where }: any) =>
        adminPorClinica[where.tenant_id] ? { id: adminPorClinica[where.tenant_id] } : null,
      ),
    },
    calendarEvent: { create: jest.fn(async ({ data }: any) => ({ id: `ev-${data.title}`, ...data })) },
    calendarEventComment: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null) },
  };
  const svc = new CalendarService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  return { svc, prisma };
}

const orf = (id: string, tenant_id: string | null, assigned_user_id: string | null = null): T => ({
  id,
  tenant_id,
  assigned_user_id,
  calendar_event_id: null,
  comments: [],
});

describe('migrateOrphanTasks — isolamento por clínica', () => {
  it('ADMIN de A varre só A e usa ADMIN de A como criador', async () => {
    const { svc, prisma } = montar([orf('tA', 'A'), orf('tB', 'B')], { A: 'admA', B: 'admB' });
    const r = await svc.migrateOrphanTasks({ tenantId: 'A', superAdmin: false });
    expect(prisma.task.findMany.mock.calls[0][0].where).toEqual({ calendar_event_id: null, tenant_id: 'A' });
    expect(prisma.task.findMany.mock.calls[1][0].where).toEqual({ calendar_event_id: { not: null }, tenant_id: 'A' });
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { tenant_id: 'A', roles: { has: 'ADMIN' } },
      select: { id: true },
    });
    expect(prisma.calendarEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.calendarEvent.create.mock.calls[0][0].data).toMatchObject({ tenant_id: 'A', created_by_id: 'admA' });
    expect(r).toEqual({ orphanTasksMigrated: 1, commentsMigrated: 0, skippedNoCreator: 0, skippedNoClinic: 0 });
  });

  it('clínica sem ADMIN: pula e conta, nunca usa ADMIN de outra', async () => {
    const { svc, prisma } = montar([orf('tB', 'B')], { A: 'admA' });
    const r = await svc.migrateOrphanTasks({ tenantId: 'B', superAdmin: false });
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { tenant_id: 'B', roles: { has: 'ADMIN' } },
      select: { id: true },
    });
    expect(prisma.calendarEvent.create).not.toHaveBeenCalled();
    expect(prisma.task.update).not.toHaveBeenCalled();
    expect(r.skippedNoCreator).toBe(1);
    expect(r.orphanTasksMigrated).toBe(0);
  });

  it('SUPER_ADMIN varre todas; cada task usa o ADMIN da própria clínica (1 consulta por clínica)', async () => {
    const { svc, prisma } = montar([orf('tA1', 'A'), orf('tA2', 'A'), orf('tB', 'B')], { A: 'admA', B: 'admB' });
    await svc.migrateOrphanTasks({ tenantId: null, superAdmin: true });
    expect(prisma.task.findMany.mock.calls[0][0].where).toEqual({ calendar_event_id: null });
    expect(prisma.task.findMany.mock.calls[1][0].where).toEqual({ calendar_event_id: { not: null } });
    expect(
      prisma.calendarEvent.create.mock.calls.map((c: any) => [c[0].data.tenant_id, c[0].data.created_by_id]),
    ).toEqual([
      ['A', 'admA'],
      ['A', 'admA'],
      ['B', 'admB'],
    ]);
    expect(prisma.user.findFirst).toHaveBeenCalledTimes(2);
  });

  it('task sem clínica e sem responsável: pulada sem consultar ADMIN nenhum', async () => {
    const { svc, prisma } = montar([orf('tNull', null)], { A: 'admA' });
    const r = await svc.migrateOrphanTasks({ tenantId: null, superAdmin: true });
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.calendarEvent.create).not.toHaveBeenCalled();
    expect(r.skippedNoClinic).toBe(1);
  });

  it('task sem clínica com responsável: herda a clínica dele (nunca vira evento "de todas")', async () => {
    const { svc, prisma } = montar([orf('tNull', null, 'dentB')], {}, { dentB: 'B' });
    const r = await svc.migrateOrphanTasks({ tenantId: null, superAdmin: true });
    expect(prisma.calendarEvent.create.mock.calls[0][0].data).toMatchObject({ tenant_id: 'B', created_by_id: 'dentB' });
    expect(prisma.task.update).toHaveBeenCalledWith({ where: { id: 'tNull' }, data: { calendar_event_id: 'ev-tNull', tenant_id: 'B' } });
    expect(r).toMatchObject({ orphanTasksMigrated: 1, skippedNoClinic: 0 });
  });

  it('task sem clínica cujo responsável também não tem clínica: pulada', async () => {
    const { svc, prisma } = montar([orf('tNull', null, 'semClinica')], {}, { semClinica: null });
    const r = await svc.migrateOrphanTasks({ tenantId: null, superAdmin: true });
    expect(prisma.calendarEvent.create).not.toHaveBeenCalled();
    expect(r.skippedNoClinic).toBe(1);
  });

  it('task com responsável mantém o responsável como criador (igual hoje)', async () => {
    const { svc, prisma } = montar([orf('tA', 'A', 'dentA')], {});
    await svc.migrateOrphanTasks({ tenantId: 'A', superAdmin: false });
    expect(prisma.calendarEvent.create.mock.calls[0][0].data.created_by_id).toBe('dentA');
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.task.update).toHaveBeenCalledWith({ where: { id: 'tA' }, data: { calendar_event_id: 'ev-tA' } });
  });

  it('ADMIN sem clínica no login: 403 PERMISSION_DENIED e não lê nenhuma task', async () => {
    const { svc, prisma } = montar([orf('tA', 'A')], { A: 'admA' });
    const e = await svc.migrateOrphanTasks({ tenantId: null, superAdmin: false }).catch((x) => x);
    expect(e).toBeInstanceOf(ForbiddenException);
    expect((e as ForbiddenException).getResponse()).toMatchObject({ code: 'PERMISSION_DENIED' });
    // tenant_id vazio também não vira "todas as clínicas"
    await expect(svc.migrateOrphanTasks({ tenantId: '', superAdmin: false })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.task.findMany).not.toHaveBeenCalled();
  });

  it('comentários de tasks vinculadas: só da clínica de quem chama', async () => {
    const vA: T = {
      id: 'vA',
      tenant_id: 'A',
      assigned_user_id: null,
      calendar_event_id: 'evA',
      comments: [{ user_id: 'u1', text: 'oi', created_at: new Date('2026-10-01T12:00:00Z') }],
    };
    const { svc, prisma } = montar([vA, { ...vA, id: 'vB', tenant_id: 'B', calendar_event_id: 'evB' }], {});
    const r = await svc.migrateOrphanTasks({ tenantId: 'A', superAdmin: false });
    expect(prisma.calendarEventComment.create).toHaveBeenCalledTimes(1);
    expect(prisma.calendarEventComment.create.mock.calls[0][0].data.event_id).toBe('evA');
    expect(r.commentsMigrated).toBe(1);
  });
});

describe('CalendarController.migrateTasks', () => {
  it('repassa a clínica e a flag de SUPER_ADMIN', async () => {
    const svc: any = { migrateOrphanTasks: jest.fn(async () => ({})) };
    const ctl = new CalendarController(svc);
    await ctl.migrateTasks({ user: { roles: ['ADMIN'], tenant_id: 'A' } });
    expect(svc.migrateOrphanTasks).toHaveBeenLastCalledWith({ tenantId: 'A', superAdmin: false });
    await ctl.migrateTasks({ user: { roles: ['SUPER_ADMIN'], tenant_id: null } });
    expect(svc.migrateOrphanTasks).toHaveBeenLastCalledWith({ tenantId: null, superAdmin: true });
    await ctl.migrateTasks({ user: { roles: ['ADMIN'] } });
    expect(svc.migrateOrphanTasks).toHaveBeenLastCalledWith({ tenantId: null, superAdmin: false });
  });
});
