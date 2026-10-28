/**
 * Foto do produto do estoque: grava em products/{id}.ext, só no produto da
 * própria conta, só imagem (JPEG/PNG/WebP até 2 MB), e a troca/remoção limpa
 * o arquivo anterior.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProductsService } from './products.service';

const A = 'tenant-a';
const B = 'tenant-b';

function montar(photo_url: string | null = null) {
  const arquivos = new Map<string, Buffer>();
  const prisma: any = {
    product: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === 'prod-a' && where.tenant_id === A ? { id: 'prod-a', photo_url } : null,
      ),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data, updated_at: new Date() })),
    },
  };
  const fileStorage: any = {
    write: jest.fn(async (p: string, b: Buffer) => { arquivos.set(p, b); }),
    delete: jest.fn(async (p: string) => { arquivos.delete(p); }),
    tryRead: jest.fn(async (p: string) => arquivos.get(p) ?? null),
  };
  return { svc: new ProductsService(prisma, fileStorage), prisma, fileStorage, arquivos };
}

const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

describe('ProductsService — foto do produto', () => {
  it('grava a foto do produto da própria conta e devolve o caminho', async () => {
    const m = montar();
    const r = await m.svc.updatePhoto('prod-a', A, JPG, 'image/jpeg');
    expect(r.photo_url).toBe('products/prod-a.jpg');
    expect(m.arquivos.get('products/prod-a.jpg')).toEqual(JPG);
    expect(m.prisma.product.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'prod-a' }, data: { photo_url: 'products/prod-a.jpg' } }),
    );
  });

  it('produto de outra conta → 404 e nada é gravado', async () => {
    const m = montar();
    await expect(m.svc.updatePhoto('prod-a', B, JPG, 'image/jpeg')).rejects.toBeInstanceOf(NotFoundException);
    expect(m.fileStorage.write).not.toHaveBeenCalled();
    expect(m.prisma.product.update).not.toHaveBeenCalled();
  });

  it('arquivo que não é imagem → 400', async () => {
    const m = montar();
    await expect(m.svc.updatePhoto('prod-a', A, JPG, 'application/pdf')).rejects.toBeInstanceOf(BadRequestException);
    expect(m.fileStorage.write).not.toHaveBeenCalled();
  });

  it('imagem acima de 2 MB → 400', async () => {
    const m = montar();
    const grande = Buffer.alloc(2 * 1024 * 1024 + 1);
    await expect(m.svc.updatePhoto('prod-a', A, grande, 'image/png')).rejects.toBeInstanceOf(BadRequestException);
    expect(m.fileStorage.write).not.toHaveBeenCalled();
  });

  it('trocar JPG por PNG apaga o arquivo antigo', async () => {
    const m = montar();
    await m.svc.updatePhoto('prod-a', A, JPG, 'image/jpeg');
    await m.svc.updatePhoto('prod-a', A, JPG, 'image/png');
    expect(m.arquivos.has('products/prod-a.jpg')).toBe(false);
    expect(m.arquivos.has('products/prod-a.png')).toBe(true);
  });

  it('servir: só para a própria conta, com o tipo certo', async () => {
    const m = montar('products/prod-a.png');
    m.arquivos.set('products/prod-a.png', JPG);
    expect(await m.svc.getPhoto('prod-a', B)).toBeNull();
    expect(await m.svc.getPhoto('prod-a', A)).toEqual({ buffer: JPG, mimeType: 'image/png' });
  });

  it('servir: arquivo sumiu do disco → null (vira 404, não 500)', async () => {
    const m = montar('products/prod-a.jpg');
    expect(await m.svc.getPhoto('prod-a', A)).toBeNull();
  });

  it('remover apaga o arquivo e zera o campo; outra conta → 404', async () => {
    const m = montar('products/prod-a.jpg');
    m.arquivos.set('products/prod-a.jpg', JPG);
    await expect(m.svc.removePhoto('prod-a', B)).rejects.toBeInstanceOf(NotFoundException);
    expect(m.arquivos.has('products/prod-a.jpg')).toBe(true);
    const r = await m.svc.removePhoto('prod-a', A);
    expect(r.photo_url).toBeNull();
    expect(m.arquivos.has('products/prod-a.jpg')).toBe(false);
  });
});
