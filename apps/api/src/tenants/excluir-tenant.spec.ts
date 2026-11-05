/**
 * Exclusão de tenant pelo Admin SaaS: reversível (status DELETED), não apaga dado,
 * o dono não exclui a própria conta, e fica registrado no AuditLog.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TenantsService } from './tenants.service';

function montar(tenant: any) {
  const update = jest.fn(async ({ data }: any) => ({ ...tenant, ...data }));
  const create = jest.fn(async () => ({}));
  const prisma: any = {
    tenant: {
      findUnique: jest.fn(async () => tenant),
      update,
    },
    auditLog: { create },
  };
  const service = new TenantsService(prisma, {} as any);
  return { service, update, create, prisma };
}

describe('TenantsService.excluir', () => {
  it('marca DELETED (reversível), guarda motivo e registra a auditoria', async () => {
    const { service, update, create } = montar({ id: 'b', name: 'Clínica B', status: 'ACTIVE' });

    const r = await service.excluir('b', 'saiu da base', { userId: 'dono', tenantId: 'conta-dono' });

    expect(update).toHaveBeenCalledWith({
      where: { id: 'b' },
      data: expect.objectContaining({ status: 'DELETED', suspended_reason: 'saiu da base', suspended_at: expect.any(Date) }),
    });
    expect(r.status).toBe('DELETED');
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entity: 'TENANT', action: 'EXCLUIU', entity_id: 'b', actor_user_id: 'dono', tenant_id: 'b',
      }),
    });
  });

  it('NÃO deixa o dono excluir a própria conta', async () => {
    const { service, update, create } = montar({ id: 'conta-dono', name: 'Minha', status: 'ACTIVE' });

    await expect(service.excluir('conta-dono', undefined, { userId: 'dono', tenantId: 'conta-dono' }))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('conta inexistente dá 404', async () => {
    const { service } = montar(null);
    await expect(service.excluir('x', undefined, { userId: 'dono', tenantId: 'conta-dono' }))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('idempotente: já excluída não mexe de novo nem registra', async () => {
    const { service, update, create } = montar({ id: 'b', name: 'B', status: 'DELETED' });

    const r = await service.excluir('b', undefined, { userId: 'dono', tenantId: 'conta-dono' });

    expect(r.status).toBe('DELETED');
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('reativar (setStatus ACTIVE) limpa o motivo e a data', async () => {
    const { service, update } = montar({ id: 'b', name: 'B', status: 'DELETED' });

    await service.setStatus('b', 'ACTIVE');

    expect(update).toHaveBeenCalledWith({
      where: { id: 'b' },
      data: { status: 'ACTIVE', suspended_at: null, suspended_reason: null },
    });
  });
});
