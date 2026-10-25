/**
 * F0b — setor (inbox), chip e equipe só mudam dentro da própria clínica.
 *
 * Antes: o ADM de uma clínica conseguia, pelo id, renomear/apagar o setor de
 * outra, pôr gente nele, e puxar para o seu setor o chip de outra clínica (que
 * levava junto as conversas dela). Agora setor de outra clínica responde "não
 * encontrada", chip de outra clínica é recusado e só entra equipe da clínica.
 * SUPER_ADMIN segue mexendo em qualquer uma.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { InboxesController } from './inboxes.controller';
import { InboxesService } from './inboxes.service';

const INBOXES: Record<string, { id: string; tenant_id: string | null }> = {
  'in-a': { id: 'in-a', tenant_id: 'a' },
  'in-b': { id: 'in-b', tenant_id: 'b' },
};
const USERS: Record<string, { id: string; tenant_id: string | null }> = {
  'u-a': { id: 'u-a', tenant_id: 'a' },
  'u-b': { id: 'u-b', tenant_id: 'b' },
};

function montar(instancias: Record<string, { name: string; tenant_id: string | null; inbox_id: string | null }> = {}) {
  const escritas: string[] = [];
  const prisma: any = {
    inbox: {
      findUnique: jest.fn(async ({ where }: any) => INBOXES[where.id] ?? null),
      update: jest.fn(async ({ where }: any) => {
        escritas.push(`inbox.update:${where.id}`);
        return INBOXES[where.id];
      }),
      delete: jest.fn(async ({ where }: any) => {
        escritas.push(`inbox.delete:${where.id}`);
        return INBOXES[where.id];
      }),
      create: jest.fn(),
    },
    instance: {
      findUnique: jest.fn(async ({ where }: any) => instancias[where.name] ?? null),
      upsert: jest.fn(async ({ where }: any) => {
        escritas.push(`instance.upsert:${where.name}`);
        return {};
      }),
      update: jest.fn(async ({ where }: any) => {
        escritas.push(`instance.update:${where.name}`);
        return {};
      }),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    user: {
      findUnique: jest.fn(async ({ where }: any) => USERS[where.id] ?? null),
      findMany: jest.fn(async ({ where }: any) =>
        Object.values(USERS).filter((u) => where.id.in.includes(u.id) && u.tenant_id === where.tenant_id),
      ),
    },
    conversation: { updateMany: jest.fn(async () => ({ count: 0 })) },
    lead: { updateMany: jest.fn(async () => ({ count: 0 })) },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const svc = new InboxesService(prisma);
  const ctrl = new InboxesController(svc);
  return { svc, ctrl, prisma, escritas };
}

const req = (tenant_id: string | null, roles = ['ADMIN']) => ({ user: { id: 'x', tenant_id, roles } });

describe('Inboxes — tenant do chamador', () => {
  it('editar/apagar setor de OUTRA clínica → não encontrada, nada é escrito', async () => {
    // chip-b está mesmo no setor da B: sem a checagem de clínica, removeInstance o soltaria
    const { ctrl, escritas } = montar({ 'chip-b': { name: 'chip-b', tenant_id: 'b', inbox_id: 'in-b' } });
    await expect(ctrl.update('in-b', { name: 'X' }, req('a'))).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctrl.remove('in-b', req('a'))).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctrl.findOne('in-b', req('a'))).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctrl.removeUser('in-b', 'u-b', req('a'))).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctrl.removeInstance('in-b', 'chip-b', req('a'))).rejects.toBeInstanceOf(NotFoundException);
    expect(escritas).toEqual([]);
  });

  it('a própria clínica edita o setor dela; SUPER_ADMIN edita qualquer um', async () => {
    const { ctrl, escritas } = montar();
    await ctrl.update('in-a', { name: 'X' }, req('a'));
    await ctrl.update('in-b', { name: 'Y' }, req('a', ['SUPER_ADMIN']));
    expect(escritas).toEqual(['inbox.update:in-a', 'inbox.update:in-b']);
  });

  it('pôr no setor gente de outra clínica → recusado', async () => {
    const { ctrl, escritas } = montar();
    await expect(ctrl.addUser('in-a', { userId: 'u-b' }, req('a'))).rejects.toBeInstanceOf(NotFoundException);
    await ctrl.addUser('in-a', { userId: 'u-a' }, req('a'));
    expect(escritas).toEqual(['inbox.update:in-a']);
  });

  it('puxar para o setor o chip de OUTRA clínica → recusado, conversas dela intactas', async () => {
    const { ctrl, prisma, escritas } = montar({ 'chip-b': { name: 'chip-b', tenant_id: 'b', inbox_id: null } });
    await expect(ctrl.addInstance('in-a', { name: 'chip-b', type: 'whatsapp' }, req('a'))).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(escritas).toEqual([]);
    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
  });

  it('chip da própria clínica (ou novo) entra; só conversas dela ou legadas mudam de setor', async () => {
    const { ctrl, prisma, escritas } = montar({ 'chip-a': { name: 'chip-a', tenant_id: 'a', inbox_id: null } });
    await ctrl.addInstance('in-a', { name: 'chip-a', type: 'whatsapp' }, req('a'));
    await ctrl.addInstance('in-a', { name: 'chip-novo', type: 'whatsapp' }, req('a'));
    expect(escritas).toEqual(['instance.upsert:chip-a', 'instance.upsert:chip-novo']);
    expect(prisma.conversation.updateMany.mock.calls[0][0].where).toEqual({
      instance_name: 'chip-a',
      OR: [{ tenant_id: 'a' }, { tenant_id: null }],
    });
  });

  it('criar setor completo: chip de outra clínica recusado e operadores de outra clínica ignorados', async () => {
    const { ctrl, prisma } = montar({ 'chip-b': { name: 'chip-b', tenant_id: 'b', inbox_id: null } });
    await expect(
      ctrl.createFull({ name: 'S', instanceName: 'chip-b' }, req('a')),
    ).rejects.toBeInstanceOf(ConflictException);

    prisma.inbox.create.mockResolvedValue({ id: 'novo' });
    await ctrl.createFull({ name: 'S', operatorIds: ['u-a', 'u-b'] }, req('a'));
    expect(prisma.inbox.create.mock.calls[0][0].data.users).toEqual({ connect: [{ id: 'u-a' }] });
  });
});
