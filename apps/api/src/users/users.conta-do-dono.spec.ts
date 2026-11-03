/**
 * Conta do dono do sistema (SUPER_ADMIN): salvar a conta no editor de usuários
 * trocava SUPER_ADMIN por OPERADOR (o dono perdia o Admin SaaS e aparecia como
 * "Atendimento"). Agora o papel do dono fica, nunca é concedido pelo formulário,
 * e só o próprio dono altera ou exclui a conta dele.
 */
import { ForbiddenException } from '@nestjs/common';
import { UsersService } from './users.service';

const ROLES: Record<string, string[]> = {
  dono: ['SUPER_ADMIN', 'ADMIN'],
  recepcao: ['OPERADOR'],
  gerente: ['ADMIN'],
};
const DONO = ['SUPER_ADMIN', 'ADMIN'];
const ADMIN_DA_CLINICA = ['ADMIN'];

function montar() {
  const gravado: any[] = [];
  const prisma: any = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, tenant_id: 'a', roles: ROLES[where.id] })),
      update: jest.fn(async ({ where, data }: any) => {
        gravado.push([where.id, data.roles]);
        return { id: where.id, password_hash: 'x' };
      }),
      delete: jest.fn(async () => ({})),
    },
  };
  const svc = new UsersService(prisma, {} as any, {} as any);
  return { svc, gravado, prisma };
}

describe('Conta do dono do sistema no editor de usuários', () => {
  it('o dono salva a própria conta: continua adm master', async () => {
    const { svc, gravado } = montar();
    await svc.update('dono', { name: 'Recepção', roles: ['SUPER_ADMIN', 'ADMIN'] }, 'a', DONO);
    // Tela antiga mandava o SUPER_ADMIN já trocado por OPERADOR; mesmo sem ele no corpo, o papel fica.
    await svc.update('dono', { roles: ['ADMIN', 'DENTIST'] }, 'a', DONO);
    expect(gravado).toEqual([
      ['dono', { set: ['SUPER_ADMIN', 'ADMIN'] }],
      ['dono', { set: ['SUPER_ADMIN', 'ADMIN', 'DENTIST'] }],
    ]);
  });

  it('o formulário não concede o papel do dono a ninguém', async () => {
    const { svc, gravado } = montar();
    await svc.update('gerente', { roles: ['SUPER_ADMIN', 'ADMIN'] }, 'a', DONO);
    await svc.update('recepcao', { roles: ['SUPER_ADMIN'] }, 'a', ADMIN_DA_CLINICA);
    await svc.update('recepcao', { role: 'SUPER_ADMIN' }, 'a', ADMIN_DA_CLINICA);
    expect(gravado).toEqual([
      ['gerente', { set: ['ADMIN'] }],
      ['recepcao', undefined],
      ['recepcao', undefined],
    ]);
  });

  it('ADMIN da clínica não altera nem exclui a conta do dono (nada gravado)', async () => {
    const { svc, gravado, prisma } = montar();
    await expect(svc.update('dono', { name: 'Outro', password: 'trocada123' }, 'a', ADMIN_DA_CLINICA)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(svc.update('dono', { sector: 'recepcao' }, 'a')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.remove('dono', 'a', undefined, ADMIN_DA_CLINICA)).rejects.toBeInstanceOf(ForbiddenException);
    expect(gravado).toEqual([]);
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('demais contas: igual a antes', async () => {
    const { svc, gravado } = montar();
    await svc.update('recepcao', { roles: ['OPERADOR'] }, 'a', ADMIN_DA_CLINICA);
    await svc.update('gerente', { roles: ['ADMIN', 'DENTIST'] }, 'a', ADMIN_DA_CLINICA);
    expect(gravado).toEqual([
      ['recepcao', { set: ['OPERADOR'] }],
      ['gerente', { set: ['ADMIN', 'DENTIST'] }],
    ]);
  });
});
