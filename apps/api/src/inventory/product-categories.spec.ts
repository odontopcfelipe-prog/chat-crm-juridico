/**
 * Categorias de produto por conta: a lista antiga (códigos fixos) vira sugestão
 * inicial da clínica, os códigos gravados nos produtos viram nome, laboratório
 * não herda a lista de clínica, e criar/renomear/remover só mexe na própria conta.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { ProductCategoriesService } from './product-categories.service';
import { CATEGORIAS_ANTIGAS, normalizarCategoria } from './product-categories';

const A = 'tenant-a';
const B = 'tenant-b';
const LAB = 'tenant-lab';

type Cat = { id: string; tenant_id: string; name: string; active: boolean };
type Prod = { id: string; tenant_id: string; category: string | null; active: boolean };

/** Banco em memória com só o que o serviço usa. */
function montar(produtos: Prod[] = [], categorias: Cat[] = []) {
  const cats = [...categorias];
  const prods = produtos.map((p) => ({ ...p }));
  let seq = 0;
  const igual = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const prisma: any = {
    tenantBusinessProfile: {
      findMany: jest.fn(async () => [{ tenant_id: LAB }]),
    },
    product: {
      findMany: jest.fn(async ({ where }: any) => {
        const vistos = new Set<string>();
        return prods
          .filter((p) => p.tenant_id === where.tenant_id && p.category && where.category.in.includes(p.category))
          .filter((p) => (vistos.has(p.category!) ? false : (vistos.add(p.category!), true)))
          .map((p) => ({ category: p.category }));
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const p of prods) {
          if (p.tenant_id === where.tenant_id && p.category === where.category) {
            p.category = data.category;
            count++;
          }
        }
        return { count };
      }),
      groupBy: jest.fn(async ({ where }: any) => {
        const m = new Map<string, number>();
        for (const p of prods) {
          if (p.tenant_id === where.tenant_id && p.active && p.category) m.set(p.category, (m.get(p.category) ?? 0) + 1);
        }
        return [...m].map(([category, n]) => ({ category, _count: { _all: n } }));
      }),
    },
    productCategory: {
      count: jest.fn(async ({ where }: any) => cats.filter((c) => c.tenant_id === where.tenant_id).length),
      createMany: jest.fn(async ({ data }: any) => {
        for (const d of data) {
          if (!cats.some((c) => c.tenant_id === d.tenant_id && c.name === d.name)) {
            cats.push({ id: `c${++seq}`, active: true, ...d });
          }
        }
        return { count: data.length };
      }),
      findMany: jest.fn(async ({ where }: any) =>
        cats
          .filter((c) => c.tenant_id === where.tenant_id && c.active === where.active)
          .sort((x, y) => x.name.localeCompare(y.name))
          .map(({ id, name }) => ({ id, name })),
      ),
      findFirst: jest.fn(async ({ where }: any) => {
        const c = cats.find((x) =>
          x.tenant_id === where.tenant_id &&
          (where.id === undefined || x.id === where.id) &&
          (where.active === undefined || x.active === where.active) &&
          (where.name === undefined || igual(x.name, where.name.equals)),
        );
        return c ? { ...c } : null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const c = { id: `c${++seq}`, active: true, ...data };
        cats.push(c);
        return { id: c.id, name: c.name };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const c = cats.find((x) => x.id === where.id)!;
        Object.assign(c, data);
        return { id: c.id, name: c.name };
      }),
      delete: jest.fn(async ({ where }: any) => {
        const i = cats.findIndex((x) => x.id === where.id);
        return cats.splice(i, 1)[0];
      }),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return { svc: new ProductCategoriesService(prisma), prisma, cats, prods };
}

beforeEach(() => __limparCacheLabTenants());

describe('normalizarCategoria', () => {
  it('apara espaços, vazio vira null e código antigo vira nome', () => {
    expect(normalizarCategoria('  Pulseira   de   prata ')).toBe('Pulseira de prata');
    expect(normalizarCategoria('   ')).toBeNull();
    expect(normalizarCategoria(null)).toBeNull();
    expect(normalizarCategoria('TOXINA_BOTULINICA')).toBe('Toxina botulínica');
  });
});

describe('ProductCategoriesService — primeira leitura da conta', () => {
  it('clínica ganha a lista antiga como sugestão e os códigos dos produtos viram nome', async () => {
    const m = montar([
      { id: 'p1', tenant_id: A, category: 'RESINA', active: true },
      { id: 'p2', tenant_id: A, category: 'RESINA', active: true },
      { id: 'p3', tenant_id: B, category: 'RESINA', active: true },
    ]);
    const lista = await m.svc.list(A);
    expect(lista.map((c) => c.name).sort()).toEqual(Object.values(CATEGORIAS_ANTIGAS).sort());
    expect(lista.find((c) => c.name === 'Resina')?.products).toBe(2);
    expect(m.prods.filter((p) => p.tenant_id === A).every((p) => p.category === 'Resina')).toBe(true);
    // Outra conta não é tocada
    expect(m.prods.find((p) => p.id === 'p3')?.category).toBe('RESINA');
    expect(m.cats.every((c) => c.tenant_id === A)).toBe(true);
  });

  it('laboratório não herda a lista de clínica: só o que os produtos dele já usavam', async () => {
    const m = montar([{ id: 'p1', tenant_id: LAB, category: 'EQUIPAMENTO', active: true }]);
    const lista = await m.svc.list(LAB);
    expect(lista.map((c) => c.name)).toEqual(['Equipamento']);
  });

  it('conta que já tem categoria (mesmo removida) não ganha a sugestão de novo', async () => {
    const m = montar([], [{ id: 'x', tenant_id: A, name: 'Pulseira', active: false }]);
    expect(await m.svc.list(A)).toEqual([]);
    expect(m.prisma.productCategory.createMany).not.toHaveBeenCalled();
  });

  it('a primeira categoria criada não pula a sugestão inicial', async () => {
    const m = montar();
    await m.svc.create(A, 'Pulseira');
    const nomes = (await m.svc.list(A)).map((c) => c.name);
    expect(nomes).toContain('Pulseira');
    expect(nomes).toContain('Resina');
  });
});

describe('ProductCategoriesService — criar, renomear, remover', () => {
  const base = (): Cat[] => [
    { id: 'c-res', tenant_id: A, name: 'Resina', active: true },
    { id: 'c-b', tenant_id: B, name: 'Joia', active: true },
  ];

  it('cria com o nome limpo; repetido (sem diferenciar maiúscula) → 400', async () => {
    const m = montar([], base());
    expect(await m.svc.create(A, '  Pulseira  ')).toMatchObject({ name: 'Pulseira' });
    await expect(m.svc.create(A, 'resina')).rejects.toBeInstanceOf(BadRequestException);
    await expect(m.svc.create(A, '   ')).rejects.toBeInstanceOf(BadRequestException);
    await expect(m.svc.create(A, 'x'.repeat(61))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('o mesmo nome em outra conta não conta como repetido', async () => {
    const m = montar([], base());
    expect(await m.svc.create(A, 'Joia')).toMatchObject({ name: 'Joia' });
  });

  it('criar o nome de uma categoria removida traz ela de volta', async () => {
    const m = montar([], [...base(), { id: 'c-old', tenant_id: A, name: 'Anel', active: false }]);
    expect(await m.svc.create(A, 'anel')).toMatchObject({ id: 'c-old', name: 'Anel' });
    expect(m.cats.find((c) => c.id === 'c-old')?.active).toBe(true);
  });

  it('renomear muda o nome nos produtos da conta, e só nela', async () => {
    const m = montar(
      [
        { id: 'p1', tenant_id: A, category: 'Resina', active: true },
        { id: 'p2', tenant_id: B, category: 'Resina', active: true },
      ],
      base(),
    );
    expect(await m.svc.rename('c-res', A, 'Resinas compostas')).toEqual({ id: 'c-res', name: 'Resinas compostas' });
    expect(m.prods.find((p) => p.id === 'p1')?.category).toBe('Resinas compostas');
    expect(m.prods.find((p) => p.id === 'p2')?.category).toBe('Resina');
  });

  it('renomear para o nome de outra categoria ativa → 400; categoria de outra conta → 404', async () => {
    const m = montar([], [...base(), { id: 'c-luva', tenant_id: A, name: 'Luva', active: true }]);
    await expect(m.svc.rename('c-res', A, 'LUVA')).rejects.toBeInstanceOf(BadRequestException);
    await expect(m.svc.rename('c-b', A, 'Outra')).rejects.toBeInstanceOf(NotFoundException);
    expect(m.cats.find((c) => c.id === 'c-b')?.name).toBe('Joia');
  });

  it('renomear para o nome de uma removida libera o nome', async () => {
    const m = montar([], [...base(), { id: 'c-old', tenant_id: A, name: 'Anel', active: false }]);
    await m.svc.rename('c-res', A, 'Anel');
    expect(m.cats.find((c) => c.id === 'c-old')).toBeUndefined();
    expect(m.cats.find((c) => c.id === 'c-res')?.name).toBe('Anel');
  });

  it('remover tira da lista e mantém o nome nos produtos; outra conta → 404', async () => {
    const m = montar([{ id: 'p1', tenant_id: A, category: 'Resina', active: true }], base());
    await expect(m.svc.remove('c-b', A)).rejects.toBeInstanceOf(NotFoundException);
    await m.svc.remove('c-res', A);
    expect(m.cats.find((c) => c.id === 'c-res')?.active).toBe(false);
    expect(m.prods[0].category).toBe('Resina');
    expect((await m.svc.list(A)).map((c) => c.name)).not.toContain('Resina');
  });
});
