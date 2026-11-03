/**
 * Materiais do procedimento (Tabela de Preços → "Materiais"): o vínculo
 * procedimento → produto do estoque que a venda rápida usa para dar baixa.
 * Só liga procedimento e produto da própria conta; ligar o mesmo produto de novo
 * só troca a quantidade; e id de outra conta responde 404.
 */
import { NotFoundException } from '@nestjs/common';
import { ProcedureConsumablesService } from './procedure-consumables.service';

const A = 'tenant-a';
const B = 'tenant-b';

function montar() {
  const prisma: any = {
    procedure: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === 'proc-a' && where.tenant_id === A ? { id: 'proc-a', tenant_id: A } : null,
      ),
    },
    product: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === 'prod-a' && where.tenant_id === A ? { id: 'prod-a', tenant_id: A } : null,
      ),
    },
    procedureConsumable: {
      upsert: jest.fn(async ({ create }: any) => ({ id: 'vinc-1', ...create })),
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === 'vinc-a' && where.procedure?.tenant_id === A ? { id: 'vinc-a' } : null,
      ),
      delete: jest.fn(async () => ({})),
    },
  };
  const movements: any = { blocksNegativeStock: jest.fn(async () => false) };
  return { svc: new ProcedureConsumablesService(prisma, movements), prisma };
}

describe('ProcedureConsumablesService — materiais do procedimento', () => {
  it('liga produto e procedimento da própria conta (upsert: ligar de novo só troca a quantidade)', async () => {
    const m = montar();
    await m.svc.create(A, 'proc-a', { product_id: 'prod-a', quantity: 2.5 });
    const arg = m.prisma.procedureConsumable.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ procedure_id_product_id: { procedure_id: 'proc-a', product_id: 'prod-a' } });
    expect(Number(arg.create.quantity)).toBe(2.5);
    expect(Number(arg.update.quantity)).toBe(2.5);
  });

  it('procedimento de outra conta: 404 e nada gravado', async () => {
    const m = montar();
    await expect(m.svc.create(B, 'proc-a', { product_id: 'prod-a', quantity: 1 })).rejects.toBeInstanceOf(NotFoundException);
    expect(m.prisma.procedureConsumable.upsert).not.toHaveBeenCalled();
  });

  it('produto de outra conta: 404 e nada gravado', async () => {
    const m = montar();
    m.prisma.procedure.findFirst.mockResolvedValueOnce({ id: 'proc-a', tenant_id: A });
    m.prisma.product.findFirst.mockResolvedValueOnce(null);
    await expect(m.svc.create(A, 'proc-a', { product_id: 'prod-b', quantity: 1 })).rejects.toBeInstanceOf(NotFoundException);
    expect(m.prisma.procedureConsumable.upsert).not.toHaveBeenCalled();
  });

  it('lista os materiais com foto, unidade, saldo e se o produto está arquivado', async () => {
    const m = montar();
    await m.svc.findByProcedure(A, 'proc-a');
    const arg = m.prisma.procedureConsumable.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ procedure_id: 'proc-a' });
    expect(arg.include.product.select).toEqual(
      expect.objectContaining({ photo_url: true, updated_at: true, active: true, unit: true, current_stock: true }),
    );
  });

  it('listar materiais de procedimento de outra conta: 404', async () => {
    const m = montar();
    await expect(m.svc.findByProcedure(B, 'proc-a')).rejects.toBeInstanceOf(NotFoundException);
    expect(m.prisma.procedureConsumable.findMany).not.toHaveBeenCalled();
  });

  it('desliga o material da própria conta', async () => {
    const m = montar();
    await expect(m.svc.remove(A, 'vinc-a')).resolves.toEqual({ ok: true });
    expect(m.prisma.procedureConsumable.delete).toHaveBeenCalledWith({ where: { id: 'vinc-a' } });
  });

  it('vínculo de outra conta: 404 (não 400) e nada apagado', async () => {
    const m = montar();
    await expect(m.svc.remove(B, 'vinc-a')).rejects.toBeInstanceOf(NotFoundException);
    expect(m.prisma.procedureConsumable.delete).not.toHaveBeenCalled();
  });
});
