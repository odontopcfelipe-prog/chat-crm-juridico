/**
 * Fase 0 — assertAnyPermission: ADMIN passa sempre (mesmo com setor diferente),
 * os demais precisam de QUALQUER uma das permissões; sem nenhuma = 403 PERMISSION_DENIED.
 */
import { ForbiddenException } from '@nestjs/common';
import type { Permission } from '@crm/shared';
import { PermissionsGuard } from './decorators/requires-permission.decorator';
import { assertAnyPermission, negarPermissao, temAlgumaPermissao } from './require-any-permission';

const prisma = {} as any;

function mockPerms(perms: Permission[]) {
  return jest.spyOn(PermissionsGuard, 'permissionsFor').mockResolvedValue(new Set<Permission>(perms));
}

async function erroDe(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('era esperado lançar');
}

describe('assertAnyPermission / temAlgumaPermissao', () => {
  afterEach(() => jest.restoreAllMocks());

  it('ADMIN passa sem consultar permissões', async () => {
    const spy = mockPerms([]);
    await expect(assertAnyPermission(prisma, { id: 'u1', roles: ['ADMIN'] }, ['operate_cash'])).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('SUPER_ADMIN passa', async () => {
    const spy = mockPerms([]);
    await expect(assertAnyPermission(prisma, { id: 'u1', roles: ['SUPER_ADMIN'] }, ['manage_financial'])).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('usuário com UMA das permissões passa (semântica OU)', async () => {
    const spy = mockPerms(['operate_cash']);
    await expect(
      assertAnyPermission(prisma, { id: 'u2', roles: ['OPERADOR'] }, ['manage_financial', 'operate_cash']),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith(prisma, 'u2', ['OPERADOR']);
    await expect(temAlgumaPermissao(prisma, { id: 'u2', roles: ['OPERADOR'] }, ['operate_cash'])).resolves.toBe(true);
  });

  it('sem nenhuma das permissões lança 403 com code PERMISSION_DENIED', async () => {
    mockPerms(['view_agenda']);
    const e = await erroDe(assertAnyPermission(prisma, { id: 'u3', roles: [] }, ['operate_cash', 'manage_financial']));
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(e.getStatus()).toBe(403);
    expect(e.getResponse()).toEqual(
      expect.objectContaining({ code: 'PERMISSION_DENIED', message: expect.stringContaining('operate_cash') }),
    );
  });

  it('usa a mensagem do chamador quando vem', async () => {
    mockPerms([]);
    const e = await erroDe(assertAnyPermission(prisma, { id: 'u3' }, ['operate_cash'], 'Só Caixa/Financeiro.'));
    expect(e.getResponse()).toEqual({ message: 'Só Caixa/Financeiro.', code: 'PERMISSION_DENIED' });
  });

  it('sem id lança 403 e não consulta permissões', async () => {
    const spy = mockPerms(['operate_cash']);
    const e1 = await erroDe(assertAnyPermission(prisma, { roles: ['ADMIN'] }, ['operate_cash']));
    expect(e1).toBeInstanceOf(ForbiddenException);
    expect(e1.getStatus()).toBe(403);
    const e2 = await erroDe(assertAnyPermission(prisma, null, ['operate_cash']));
    expect(e2.getStatus()).toBe(403);
    await expect(temAlgumaPermissao(prisma, undefined, ['operate_cash'])).resolves.toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('negarPermissao monta o 403 que o front reconhece', () => {
    const e = negarPermissao('x');
    expect(e.getStatus()).toBe(403);
    expect(e.getResponse()).toEqual({ message: 'x', code: 'PERMISSION_DENIED' });
  });
});
