/**
 * Editar produto (Estoque → Produtos → lápis): só o produto da própria conta,
 * campo apagado chega como null e limpa, nome em branco e SKU repetido são
 * recusados com mensagem (antes o SKU repetido virava erro 500).
 */
import { BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { ProductsService } from './products.service';
import { UpdateProductDto } from './dto/product.dto';

const A = 'tenant-a';
const B = 'tenant-b';

function montar() {
  const produtos = [
    { id: 'prod-a', tenant_id: A, name: 'Resina A2', sku: 'RES-A2' },
    { id: 'prod-b', tenant_id: A, name: 'Resina A3', sku: 'RES-A3' },
  ];
  const prisma: any = {
    product: {
      findFirst: jest.fn(async ({ where }: any) =>
        produtos.find((p) => p.id === where.id && p.tenant_id === where.tenant_id) ?? null,
      ),
      findUnique: jest.fn(async ({ where }: any) => {
        const { tenant_id, sku } = where.tenant_id_sku;
        return produtos.find((p) => p.tenant_id === tenant_id && p.sku === sku) ?? null;
      }),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    supplier: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === 'forn-a' && where.tenant_id === A ? { id: 'forn-a' } : null,
      ),
    },
  };
  return { svc: new ProductsService(prisma, {} as any), prisma };
}

/** Mesmo ValidationPipe global da API (whitelist + recusa campo desconhecido). */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const validar = (body: any) =>
  pipe.transform(body, { type: 'body', metatype: UpdateProductDto }) as Promise<UpdateProductDto>;

describe('ProductsService.update — editar produto', () => {
  it('salva os campos e normaliza a categoria antiga', async () => {
    const m = montar();
    await m.svc.update('prod-a', A, { name: '  Resina A2 Z350 ', category: 'RESINA', min_stock: 3 } as any);
    expect(m.prisma.product.update).toHaveBeenCalledWith({
      where: { id: 'prod-a' },
      data: { name: 'Resina A2 Z350', category: 'Resina', min_stock: 3 },
    });
  });

  it('campos apagados (null) limpam no banco: categoria, fornecedor, mínimo e custo', async () => {
    const m = montar();
    await m.svc.update('prod-a', A, {
      category: null, supplier_id: null, min_stock: null, cost_price: null, brand: null,
    } as any);
    expect(m.prisma.product.update).toHaveBeenCalledWith({
      where: { id: 'prod-a' },
      data: { category: null, supplier_id: null, min_stock: null, cost_price: null, brand: null },
    });
    // fornecedor vazio não consulta nada
    expect(m.prisma.supplier.findFirst).not.toHaveBeenCalled();
  });

  it('produto de outra conta → 404 e nada muda', async () => {
    const m = montar();
    await expect(m.svc.update('prod-a', B, { name: 'X' } as any)).rejects.toBeInstanceOf(NotFoundException);
    expect(m.prisma.product.update).not.toHaveBeenCalled();
  });

  it('nome em branco → 400', async () => {
    const m = montar();
    await expect(m.svc.update('prod-a', A, { name: '   ' } as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(m.prisma.product.update).not.toHaveBeenCalled();
  });

  it('SKU de outro produto da conta → 400 com mensagem', async () => {
    const m = montar();
    await expect(m.svc.update('prod-a', A, { sku: 'RES-A3' } as any)).rejects.toThrow('Ja existe um produto com SKU "RES-A3"');
    expect(m.prisma.product.update).not.toHaveBeenCalled();
  });

  it('manter o próprio SKU não acusa repetido', async () => {
    const m = montar();
    await m.svc.update('prod-a', A, { sku: 'RES-A2', name: 'Resina A2' } as any);
    expect(m.prisma.product.findUnique).not.toHaveBeenCalled();
    expect(m.prisma.product.update).toHaveBeenCalled();
  });

  it('fornecedor de outra conta → 404', async () => {
    const m = montar();
    await expect(
      m.svc.update('prod-a', A, { supplier_id: '0f8fad5b-d9cb-469f-a165-70867728950e' } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(m.prisma.product.update).not.toHaveBeenCalled();
  });
});

describe('UpdateProductDto — o corpo que a tela de edição manda', () => {
  it('aceita o formulário inteiro com campos apagados como null', async () => {
    const dto = await validar({
      name: 'Pulseira Reviera',
      brand: null,
      sku: null,
      category: 'Joias',
      unit: 'UN',
      anvisa_registration: null,
      is_injectable: false,
      requires_lot_tracking: false,
      min_stock: null,
      cost_price: 12.5,
      supplier_id: null,
    });
    expect(dto.min_stock).toBeNull();
    expect(dto.supplier_id).toBeNull();
    expect(dto.cost_price).toBe(12.5);
  });

  it('não aceita mudar o estoque atual pela edição (só por movimentação)', async () => {
    await expect(validar({ name: 'X', current_stock: 10 })).rejects.toBeInstanceOf(BadRequestException);
  });
});
