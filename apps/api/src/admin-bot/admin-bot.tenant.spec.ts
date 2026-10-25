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

  it('chip sem clínica (legado) → como antes, sem filtro de tenant', async () => {
    const { svc, where } = montar([ADM_A, DENT_B]);
    await expect(svc.findAdminByPhone(DENT_B.phone, null)).resolves.toMatchObject({ id: 'u-b' });
    expect(where[0]).not.toHaveProperty('tenant_id');
  });
});
