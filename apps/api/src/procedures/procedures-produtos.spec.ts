/**
 * Aba Produtos da Venda Rápida: estoque calculado, promoção, rastro de preço e foto.
 * A promoção é o que a recepção cobra sem passar pelo Validar: a regra tem de ficar presa aqui.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProceduresService, estoqueDoItem } from './procedures.service';

const A = 'tenant-a';
const B = 'tenant-b';

function montar(item: { base_price?: number; promo_price?: number | null; photo_url?: string | null } = {}) {
  const linha = { id: 'proc-a', tenant_id: A, base_price: 150, promo_price: null as number | null, photo_url: null as string | null, ...item };
  const arquivos = new Map<string, Buffer>();
  const prisma: any = {
    procedure: {
      findUnique: jest.fn(async ({ where }: any) => (where.id === linha.id ? linha : null)),
      findFirst: jest.fn(async ({ where }: any) => (where.id === linha.id && where.tenant_id === linha.tenant_id ? linha : null)),
      findMany: jest.fn(async () => []),
      update: jest.fn(async ({ data }: any) => ({ ...linha, ...data, updated_at: new Date() })),
    },
    auditLog: { create: jest.fn(async () => ({})) },
    specialty: { findUnique: jest.fn(async () => null) },
  };
  const fileStorage: any = {
    write: jest.fn(async (p: string, b: Buffer) => { arquivos.set(p, b); }),
    delete: jest.fn(async (p: string) => { arquivos.delete(p); }),
    tryRead: jest.fn(async (p: string) => arquivos.get(p) ?? null),
  };
  return { svc: new ProceduresService(prisma, fileStorage), prisma, fileStorage, arquivos };
}

const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

describe('estoqueDoItem', () => {
  it('sem material ligado é infinito', () => {
    expect(estoqueDoItem([])).toEqual({ infinito: true });
  });

  it('manda o material que acaba primeiro', () => {
    expect(estoqueDoItem([
      { quantity: '5', product: { name: 'Pasta', current_stock: '480' } },
      { quantity: '1', product: { name: 'Moldeira', current_stock: '30' } },
    ])).toEqual({ infinito: false, quantidade: 30, limitado_por: 'Moldeira' });
  });

  it('arredonda para baixo e não fica negativo', () => {
    expect(estoqueDoItem([{ quantity: '2', product: { name: 'Gel', current_stock: '5' } }])).toMatchObject({ quantidade: 2 });
    expect(estoqueDoItem([{ quantity: '1', product: { name: 'Gel', current_stock: '-3' } }])).toMatchObject({ quantidade: 0 });
  });

  it.each([['0.3', '0.1', 3], ['0.6', '0.2', 3], ['1.2', '0.4', 3], ['0.7', '0.1', 7]])('saldo %s, gasto %s: %d vendas', (saldo, gasto, vendas) => {
    expect(estoqueDoItem([{ quantity: gasto, product: { name: 'Gel', current_stock: saldo } }])).toMatchObject({ quantidade: vendas });
  });

  it('quantidade zero não divide por zero', () => {
    expect(estoqueDoItem([{ quantity: '0', product: { name: 'Gel', current_stock: '5' } }])).toEqual({ infinito: true });
  });
});

describe('catalogo', () => {
  it('só a conta do usuário e só itens ativos; números de verdade na resposta', async () => {
    const m = montar();
    m.prisma.procedure.findMany.mockResolvedValueOnce([{
      id: 'p1', name: 'Limpeza', base_price: '150.00', promo_price: '120.00', photo_url: null, updated_at: new Date(), quick_sale: true,
      consumables: [{ quantity: '1', product: { name: 'Pasta', current_stock: '10' } }],
    }]);
    const [item] = await m.svc.catalogo(A);
    expect(m.prisma.procedure.findMany.mock.calls[0][0].where).toEqual({ tenant_id: A, active: true });
    expect(item).toMatchObject({ base_price: 150, promo_price: 120, qtd_materiais: 1, estoque: { infinito: false, quantidade: 10 } });
    expect(item).not.toHaveProperty('consumables');
  });
});

describe('preço promocional', () => {
  it('grava promoção menor que o preço', async () => {
    const m = montar();
    await m.svc.update('proc-a', A, { promo_price: 120 }, 'adm');
    expect(m.prisma.procedure.update.mock.calls[0][0].data).toEqual({ promo_price: 120 });
  });

  it.each([[150], [200]])('recusa promoção de %d num preço de 150', async (promo) => {
    const m = montar();
    await expect(m.svc.update('proc-a', A, { promo_price: promo })).rejects.toThrow(BadRequestException);
    expect(m.prisma.procedure.update).not.toHaveBeenCalled();
  });

  it('confere a promoção contra o preço novo quando os dois vêm juntos', async () => {
    const m = montar();
    await expect(m.svc.update('proc-a', A, { base_price: 100, promo_price: 120 })).rejects.toThrow(BadRequestException);
    await m.svc.update('proc-a', A, { base_price: 300, promo_price: 200 });
    expect(m.prisma.procedure.update).toHaveBeenCalledTimes(1);
  });

  it('null tira a promoção', async () => {
    const m = montar({ promo_price: 120 });
    await m.svc.update('proc-a', A, { promo_price: null });
    expect(m.prisma.procedure.update.mock.calls[0][0].data).toEqual({ promo_price: null });
  });

  it('preço baixando até a promoção apaga a promoção (reajuste em massa não trava)', async () => {
    const m = montar({ promo_price: 120 });
    await m.svc.update('proc-a', A, { base_price: 110 });
    expect(m.prisma.procedure.update.mock.calls[0][0].data).toEqual({ base_price: 110, promo_price: null });
  });

  it('preço mudando sem encostar na promoção mantém a promoção', async () => {
    const m = montar({ promo_price: 120 });
    await m.svc.update('proc-a', A, { base_price: 180 });
    expect(m.prisma.procedure.update.mock.calls[0][0].data).toEqual({ base_price: 180 });
  });

  it('item de outra conta: recusa antes de gravar', async () => {
    const m = montar();
    await expect(m.svc.update('proc-a', B, { promo_price: 100 })).rejects.toThrow(ForbiddenException);
    await expect(m.svc.update('nao-existe', A, { promo_price: 100 })).rejects.toThrow(NotFoundException);
    expect(m.prisma.procedure.update).not.toHaveBeenCalled();
  });
});

describe('rastro de preço', () => {
  it('registra quem mudou o preço ou a promoção, com o antes e o depois', async () => {
    const m = montar();
    await m.svc.update('proc-a', A, { promo_price: 120 }, 'adm');
    expect(m.prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const { data } = m.prisma.auditLog.create.mock.calls[0][0];
    expect(data).toMatchObject({ entity: 'PROCEDURE', entity_id: 'proc-a', action: 'PRECO_ALTERADO' });
    expect(JSON.stringify(data)).toContain('adm');
    expect(JSON.stringify(data)).toContain('120');
  });

  it('mudança que não mexe em preço não registra', async () => {
    const m = montar();
    await m.svc.update('proc-a', A, { quick_sale: false }, 'adm');
    expect(m.prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('foto do item', () => {
  it('grava só no item da própria conta', async () => {
    const m = montar();
    const r = await m.svc.updatePhoto('proc-a', A, JPG, 'image/jpeg');
    expect(r.photo_url).toBe('procedures/proc-a.jpg');
    expect(m.arquivos.get('procedures/proc-a.jpg')).toEqual(JPG);
    await expect(m.svc.updatePhoto('proc-a', B, JPG, 'image/jpeg')).rejects.toThrow(ForbiddenException);
  });

  it.each([['application/pdf'], ['image/svg+xml'], ['']])('recusa o tipo "%s"', async (tipo) => {
    const m = montar();
    await expect(m.svc.updatePhoto('proc-a', A, JPG, tipo)).rejects.toThrow(BadRequestException);
    expect(m.fileStorage.write).not.toHaveBeenCalled();
  });

  it('recusa imagem acima de 2 MB', async () => {
    const m = montar();
    await expect(m.svc.updatePhoto('proc-a', A, Buffer.alloc(2 * 1024 * 1024 + 1), 'image/png')).rejects.toThrow(BadRequestException);
  });

  it('trocar de formato apaga o arquivo antigo', async () => {
    const m = montar();
    await m.svc.updatePhoto('proc-a', A, JPG, 'image/jpeg');
    await m.svc.updatePhoto('proc-a', A, JPG, 'image/png');
    expect(m.arquivos.has('procedures/proc-a.jpg')).toBe(false);
    expect(m.arquivos.has('procedures/proc-a.png')).toBe(true);
  });

  it('outra conta não lê nem apaga', async () => {
    const m = montar({ photo_url: 'procedures/proc-a.jpg' });
    m.arquivos.set('procedures/proc-a.jpg', JPG);
    expect(await m.svc.getPhoto('proc-a', B)).toBeNull();
    expect((await m.svc.getPhoto('proc-a', A))?.mimeType).toBe('image/jpeg');
    await expect(m.svc.removePhoto('proc-a', B)).rejects.toThrow(NotFoundException);
    expect(m.arquivos.has('procedures/proc-a.jpg')).toBe(true);
    await m.svc.removePhoto('proc-a', A);
    expect(m.arquivos.has('procedures/proc-a.jpg')).toBe(false);
  });

  it('arquivo sumido do disco devolve null, não erro', async () => {
    const m = montar({ photo_url: 'procedures/proc-a.png' });
    expect(await m.svc.getPhoto('proc-a', A)).toBeNull();
  });
});
