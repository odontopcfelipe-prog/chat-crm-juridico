/**
 * F0b — o robô de admin só atende a equipe da clínica DONA do chip.
 *
 * Antes, o ADM de uma clínica que escrevia "agendar…" no chip de outra era
 * interceptado e o robô rodava o comando com os dados da clínica dele, pelo
 * chip da outra. Agora a busca da equipe leva o tenant do chip.
 */
import { AdminBotService } from './admin-bot.service';

function montar(usuarios: { id: string; phone: string; roles: string[]; tenant_id: string | null }[]) {
  const where: any[] = [];
  const prisma: any = {
    user: {
      findFirst: jest.fn(async ({ where: w }: any) => {
        where.push(w);
        return (
          usuarios.find(
            (u) =>
              w.phone.in.includes(u.phone) &&
              u.roles.some((r) => w.roles.hasSome.includes(r)) &&
              (w.tenant_id === undefined || u.tenant_id === w.tenant_id),
          ) ?? null
        );
      }),
    },
  };
  const svc = new AdminBotService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { svc, where };
}

const ADM_A = { id: 'u-a', phone: '5582999990001', roles: ['ADMIN'], tenant_id: 'tenant-a' };
const DENT_B = { id: 'u-b', phone: '5582999990002', roles: ['DENTIST'], tenant_id: 'tenant-b' };

describe('AdminBotService.findAdminByPhone — tenant do chip', () => {
  it('equipe da própria clínica no chip dela → é interceptada', async () => {
    const { svc, where } = montar([ADM_A, DENT_B]);
    await expect(svc.findAdminByPhone(ADM_A.phone, 'tenant-a')).resolves.toMatchObject({ id: 'u-a' });
    expect(where[0].tenant_id).toBe('tenant-a');
  });

  it('equipe de OUTRA clínica no chip → não é interceptada (contato comum)', async () => {
    const { svc } = montar([ADM_A, DENT_B]);
    await expect(svc.findAdminByPhone(DENT_B.phone, 'tenant-a')).resolves.toBeNull();
    await expect(svc.findAdminByPhone(ADM_A.phone, 'tenant-b')).resolves.toBeNull();
  });

  it('chip sem clínica (legado) → como antes, sem filtro de tenant (busca)', async () => {
    const { svc, where } = montar([ADM_A, DENT_B]);
    await expect(svc.findAdminByPhone(DENT_B.phone, null)).resolves.toMatchObject({ id: 'u-b' });
    expect(where[0]).not.toHaveProperty('tenant_id');
  });
});

describe('AdminBotService — ferramentas do robô na clínica do chip', () => {
  const USERS = [
    { id: 'u-a', name: 'Ana', roles: ['ADMIN'], tenant_id: 'tenant-a' },
    { id: 'u-b', name: 'Bia', roles: ['DENTIST'], tenant_id: 'tenant-b' },
  ];
  const LEADS = [
    { id: 'l-a', tenant_id: 'tenant-a' },
    { id: 'l-b', tenant_id: 'tenant-b' },
  ];
  function montarTools() {
    const prisma: any = {
      user: {
        findMany: jest.fn(async ({ where }: any) =>
          USERS.filter((u) => where.tenant_id === undefined || u.tenant_id === where.tenant_id),
        ),
        findFirst: jest.fn(async ({ where }: any) => USERS.find((u) => u.id === where.id && u.tenant_id === where.tenant_id) ?? null),
      },
      lead: { findFirst: jest.fn(async ({ where }: any) => LEADS.find((l) => l.id === where.id && l.tenant_id === where.tenant_id) ?? null) },
    };
    const tasks = { create: jest.fn(async (d: any) => ({ id: 't1', title: d.title, due_at: null })) };
    const calendar = { create: jest.fn(async (d: any) => ({ id: 'e1', title: d.title, start_at: d.start_at })) };
    const fin = { createTransaction: jest.fn(async (d: any) => ({ id: 'f1', ...d })) };
    const pg = { ensureCustomer: jest.fn(async () => ({})) };
    const svc = new AdminBotService(prisma, {} as any, tasks as any, calendar as any, fin as any, pg as any);
    const run = (name: string, args: any, tenant: string | null = 'tenant-a') => (svc as any).executeTool(name, args, 'u-a', tenant);
    return { run, tasks, calendar, fin, pg };
  }

  it('list_users só traz a equipe da clínica do chip', async () => {
    const { run } = montarTools();
    const r = await run('list_users', {});
    expect(r.users.map((u: any) => u.id)).toEqual(['u-a']);
  });

  it('criar tarefa/evento com responsável ou cliente de outra clínica → recusado, nada é criado', async () => {
    const { run, tasks, calendar, fin, pg } = montarTools();
    await expect(run('create_task', { title: 'X', assigned_user_id: 'u-b' })).resolves.toEqual({ error: 'Responsável não encontrado nesta clínica.' });
    await expect(run('create_task', { title: 'X', lead_id: 'l-b' })).resolves.toEqual({ error: 'Cliente não encontrado nesta clínica.' });
    await expect(run('create_calendar_event', { title: 'X', start_at: '2026-10-27T12:00:00Z', assigned_user_id: 'u-b' })).resolves.toHaveProperty('error');
    await expect(run('create_revenue', { description: 'X', amount: 10, lead_id: 'l-b' })).resolves.toHaveProperty('error');
    await expect(run('create_charge', { lead_id: 'l-b' })).resolves.toHaveProperty('error');
    expect(tasks.create).not.toHaveBeenCalled();
    expect(calendar.create).not.toHaveBeenCalled();
    expect(fin.createTransaction).not.toHaveBeenCalled();
    expect(pg.ensureCustomer).not.toHaveBeenCalled();
  });

  it('responsável e cliente da própria clínica → cria normalmente', async () => {
    const { run, tasks } = montarTools();
    await expect(run('create_task', { title: 'X', assigned_user_id: 'u-a', lead_id: 'l-a' })).resolves.toMatchObject({ success: true });
    expect(tasks.create).toHaveBeenCalledWith(expect.objectContaining({ assigned_user_id: 'u-a', tenant_id: 'tenant-a' }));
  });

  it('robô sem clínica (chip legado) → como antes', async () => {
    const { run, tasks } = montarTools();
    await expect(run('create_task', { title: 'X', assigned_user_id: 'u-b' }, null)).resolves.toMatchObject({ success: true });
    expect(tasks.create).toHaveBeenCalled();
  });
});
