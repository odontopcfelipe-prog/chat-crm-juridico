/**
 * Novo produto com quantidade em estoque: o saldo não entra calado — vira uma
 * ENTRADA "Estoque inicial" em Movimentações (quem lançou e quando), na mesma
 * transação do cadastro, com as regras de lote/validade de uma entrada comum.
 */
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/product.dto';

const A = 'tenant-a';

function montar() {
  const criados: any[] = [];
  const movimentos: any[] = [];
  const tx: any = {
    product: {
      create: jest.fn(async ({ data }: any) => {
        const p = { id: 'prod-novo', ...data };
        criados.push(p);
        return p;
      }),
    },
    stockMovement: {
      create: jest.fn(async ({ data }: any) => {
        movimentos.push(data);
        return { id: 'mov-1', ...data };
      }),
    },
  };
  const prisma: any = {
    product: {
      findUnique: jest.fn(async () => null),
      create: tx.product.create,
    },
    supplier: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === 'forn-a' && where.tenant_id === A ? { id: 'forn-a' } : null,
      ),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  return { svc: new ProductsService(prisma, {} as any), prisma, criados, movimentos };
}

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const validar = (body: any) =>
  pipe.transform(body, { type: 'body', metatype: CreateProductDto }) as Promise<CreateProductDto>;

describe('ProductsService.create — quantidade em estoque no cadastro', () => {
  it('sem quantidade: cria só o produto, sem movimento', async () => {
    const m = montar();
    await m.svc.create(A, { name: 'Resina A2' } as any, 'user-1');
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
    expect(m.movimentos).toHaveLength(0);
    expect(m.criados[0]).toMatchObject({ name: 'Resina A2', tenant_id: A });
    expect(m.criados[0]).not.toHaveProperty('current_stock');
  });

  it('com quantidade: produto nasce com o saldo e a ENTRADA "Estoque inicial" fica no histórico', async () => {
    const m = montar();
    await m.svc.create(A, { name: 'Luva M', current_stock: 10, cost_price: 2.5 } as any, 'user-1');
    expect(m.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(Number(m.criados[0].current_stock)).toBe(10);
    expect(m.movimentos).toHaveLength(1);
    const mov = m.movimentos[0];
    expect(mov).toMatchObject({
      tenant_id: A,
      product_id: 'prod-novo',
      type: 'ENTRADA',
      notes: 'Estoque inicial (cadastro do produto)',
      performed_by_user_id: 'user-1',
    });
    expect(Number(mov.quantity)).toBe(10);
    expect(Number(mov.unit_cost)).toBe(2.5);
    expect(Number(mov.total_cost)).toBe(25);
  });

  it('campos da entrada inicial não vão pro produto', async () => {
    const m = montar();
    await m.svc.create(A, {
      name: 'Toxina', current_stock: 2, requires_lot_tracking: true,
      initial_batch_number: ' L123 ', initial_expiration_date: '2027-05-01',
    } as any, 'user-1');
    expect(m.criados[0]).not.toHaveProperty('initial_batch_number');
    expect(m.criados[0]).not.toHaveProperty('initial_expiration_date');
    expect(m.movimentos[0].batch_number).toBe('L123');
    expect(m.movimentos[0].expiration_date).toEqual(new Date('2027-05-01'));
  });

  it('produto com lote obrigatório e quantidade sem lote: 400 e nada é criado', async () => {
    const m = montar();
    await expect(
      m.svc.create(A, { name: 'Toxina', current_stock: 2, requires_lot_tracking: true } as any, 'user-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(m.criados).toHaveLength(0);
  });

  it('lote obrigatório sem quantidade: cadastra normal (lote só vale pra entrada)', async () => {
    const m = montar();
    await m.svc.create(A, { name: 'Toxina', requires_lot_tracking: true } as any, 'user-1');
    expect(m.criados).toHaveLength(1);
    expect(m.movimentos).toHaveLength(0);
  });

  it('produto com validade e quantidade sem validade: 400', async () => {
    const m = montar();
    await expect(
      m.svc.create(A, { name: 'Anestésico', current_stock: 5, has_expiration: true } as any, 'user-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(m.criados).toHaveLength(0);
  });
});

describe('CreateProductDto — corpo do formulário Novo produto', () => {
  it('aceita quantidade e lote da entrada inicial', async () => {
    const dto = await validar({
      name: 'Toxina', unit: 'UN', is_injectable: true, requires_lot_tracking: true,
      cost_price: 900, sale_price: 1500, current_stock: 3, initial_batch_number: 'L123',
    });
    expect(dto.current_stock).toBe(3);
    expect(dto.initial_batch_number).toBe('L123');
  });

  it('quantidade negativa: 400', async () => {
    await expect(validar({ name: 'Luva', current_stock: -1 })).rejects.toBeInstanceOf(BadRequestException);
  });
});
