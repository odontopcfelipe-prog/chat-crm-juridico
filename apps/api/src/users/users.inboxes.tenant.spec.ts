/**
 * Furo antigo achado na revisão da F0b: cadastrar/editar usuário com
 * inboxIds ligava a pessoa ao setor de OUTRA clínica (por fora da checagem
 * nova de POST /inboxes/:id/users) — ela passava a receber os avisos e a
 * entrar na sala daquele setor. Agora só setores da clínica do usuário.
 */
import { BadRequestException } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';

const INBOXES: Record<string, string | null> = { 'in-a': 'a', 'in-a2': 'a', 'in-b': 'b' };

function montar() {
  const gravado: any[] = [];
  const prisma: any = {
    tenant: { findUnique: jest.fn(async () => ({ plan: 'PRO', name: 'Clínica A' })) },
    inbox: {
      count: jest.fn(async ({ where }: any) => where.id.in.filter((id: string) => id in INBOXES && INBOXES[id] === where.tenant_id).length),
    },
    user: {
      count: jest.fn(async () => 1),
      findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, tenant_id: where.id === 'u-b' ? 'b' : 'a' })),
      create: jest.fn(async ({ data }: any) => {
        gravado.push(['create', data.inboxes]);
        return { id: 'novo', email: data.email, name: data.name, password_hash: 'x' };
      }),
      update: jest.fn(async ({ data }: any) => {
        gravado.push(['update', data.inboxes]);
        return { id: 'u-a', password_hash: 'x' };
      }),
    },
  };
  const mail: any = { send: jest.fn(async () => true), renderTemplate: jest.fn(() => ''), isConfigured: jest.fn(async () => false) };
  const svc = new UsersService(prisma, {} as any, mail);
  return { svc, gravado };
}

const base = { name: 'Nova', email: 'nova@exemplo.com', password: 'segredo1', roles: ['OPERADOR'] };

describe('Usuários — setores só da clínica do usuário', () => {
  it('cadastrar com setor de OUTRA clínica → 400, nada gravado', async () => {
    const { svc, gravado } = montar();
    await expect(svc.create({ ...base, tenant_id: 'a', inboxIds: ['in-a', 'in-b'] })).rejects.toBeInstanceOf(BadRequestException);
    expect(gravado).toEqual([]);
  });

  it('cadastrar com setores da própria clínica → grava', async () => {
    const { svc, gravado } = montar();
    await svc.create({ ...base, tenant_id: 'a', inboxIds: ['in-a', 'in-a2'] });
    expect(gravado).toEqual([['create', { connect: [{ id: 'in-a' }, { id: 'in-a2' }] }]]);
  });

  it('editar pondo setor de OUTRA clínica (ou inexistente) → 400, nada gravado', async () => {
    const { svc, gravado } = montar();
    await expect(svc.update('u-a', { inboxIds: ['in-b'] }, 'a')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update('u-a', { inboxIds: ['nao-existe'] }, 'a')).rejects.toBeInstanceOf(BadRequestException);
    expect(gravado).toEqual([]);
  });

  it('editar com setores da própria clínica, ou tirando todos → grava', async () => {
    const { svc, gravado } = montar();
    await svc.update('u-a', { inboxIds: ['in-a'] }, 'a');
    await svc.update('u-a', { inboxIds: [] }, 'a');
    expect(gravado).toEqual([['update', { set: [{ id: 'in-a' }] }], ['update', { set: [] }]]);
  });
});

describe('GET /users/online — só a clínica de quem pergunta', () => {
  it('ADMIN da clínica A vê só os online da A; sem clínica (SUPER_ADMIN) vê todos', async () => {
    const DONO: Record<string, string> = { 'u-a1': 'a', 'u-a2': 'a', 'u-b1': 'b' };
    const prisma: any = {
      user: {
        findMany: jest.fn(async ({ where }: any) =>
          where.id.in.filter((id: string) => DONO[id] === where.tenant_id).map((id: string) => ({ id })),
        ),
      },
    };
    const svc = new UsersService(prisma, {} as any, {} as any);
    const online = ['u-a1', 'u-b1', 'u-a2'];
    await expect(svc.filtrarDaClinica(online, 'a')).resolves.toEqual(['u-a1', 'u-a2']);
    await expect(svc.filtrarDaClinica(online, 'b')).resolves.toEqual(['u-b1']);
    await expect(svc.filtrarDaClinica(online, undefined)).resolves.toEqual(online);
  });

  it('a rota passa a clínica do login', async () => {
    const usersService: any = { filtrarDaClinica: jest.fn(async (ids: string[]) => ids.slice(0, 1)) };
    const gateway: any = { getOnlineUserIds: () => ['u-a1', 'u-b1'] };
    const ctrl = Object.create(UsersController.prototype);
    Object.assign(ctrl, { usersService, chatGateway: gateway });
    await expect(ctrl.getOnlineUsers({ user: { tenant_id: 'a' } })).resolves.toEqual({ onlineUserIds: ['u-a1'] });
    expect(usersService.filtrarDaClinica).toHaveBeenCalledWith(['u-a1', 'u-b1'], 'a');
  });
});
