import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FileStorageService } from '../media/filesystem.service';
import { Prisma } from '@crm/shared';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';

/** Foto do produto: mesmo formato e limite da foto do paciente. */
const PHOTO_MIMES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const PHOTO_MAX_BYTES = 2 * 1024 * 1024;

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private prisma: PrismaService,
    private fileStorage: FileStorageService,
  ) {}

  async create(tenantId: string, dto: CreateProductDto) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente no contexto');

    if (dto.sku) {
      const existing = await this.prisma.product.findUnique({
        where: { tenant_id_sku: { tenant_id: tenantId, sku: dto.sku } },
      });
      if (existing) throw new BadRequestException(`Ja existe um produto com SKU "${dto.sku}"`);
    }
    await this.assertSupplierDaConta(tenantId, dto.supplier_id);

    return this.prisma.product.create({
      data: { ...dto, tenant_id: tenantId },
    });
  }

  async findAll(
    tenantId: string,
    opts: {
      search?: string;
      category?: string;
      active?: boolean;
      injectable?: boolean;
      lowStock?: boolean;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const page = Math.max(1, opts.page || 1);
    const limit = Math.min(200, Math.max(1, opts.limit || 50));
    const skip = (page - 1) * limit;

    const where: Prisma.ProductWhereInput = {
      tenant_id: tenantId,
      ...(opts.category ? { category: opts.category } : {}),
      ...(opts.active !== undefined ? { active: opts.active } : {}),
      ...(opts.injectable !== undefined ? { is_injectable: opts.injectable } : {}),
      ...(opts.search
        ? {
            OR: [
              { name: { contains: opts.search, mode: 'insensitive' } },
              { brand: { contains: opts.search, mode: 'insensitive' } },
              { sku: { contains: opts.search } },
              { barcode: { contains: opts.search } },
              { anvisa_registration: { contains: opts.search } },
            ],
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: { name: 'asc' },
        skip,
        take: limit,
        include: {
          supplier: { select: { id: true, name: true } },
          _count: { select: { movements: true, esthetic_applications: true } },
        },
      }),
      this.prisma.product.count({ where }),
    ]);

    let filtered = data;
    if (opts.lowStock) {
      // min_stock pode ser null — quando null, considerar nao monitorado
      filtered = data.filter(
        (p) => p.min_stock !== null && Number(p.current_stock) <= Number(p.min_stock),
      );
    }

    return {
      data: filtered,
      total: opts.lowStock ? filtered.length : total,
      page,
      totalPages: Math.ceil((opts.lowStock ? filtered.length : total) / limit),
    };
  }

  async findOne(id: string, tenantId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, tenant_id: tenantId },
      include: {
        supplier: { select: { id: true, name: true, phone: true, email: true } },
        consumables: {
          include: { procedure: { select: { id: true, name: true, category: true } } },
        },
        _count: { select: { movements: true, esthetic_applications: true } },
      },
    });
    if (!product) throw new NotFoundException('Produto nao encontrado');
    return product;
  }

  async update(id: string, tenantId: string, dto: UpdateProductDto) {
    const existing = await this.prisma.product.findFirst({
      where: { id, tenant_id: tenantId },
    });
    if (!existing) throw new NotFoundException('Produto nao encontrado');
    await this.assertSupplierDaConta(tenantId, dto.supplier_id);
    return this.prisma.product.update({ where: { id }, data: dto });
  }

  /** Fornecedor do produto só da própria conta (vazio/null limpa o vínculo, sem consulta). */
  private async assertSupplierDaConta(tenantId: string, supplierId?: string | null) {
    if (!tenantId || !supplierId) return;
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: supplierId, tenant_id: tenantId },
      select: { id: true },
    });
    if (!supplier) throw new NotFoundException('Fornecedor nao encontrado');
  }

  async archive(id: string, tenantId: string) {
    const existing = await this.prisma.product.findFirst({
      where: { id, tenant_id: tenantId },
    });
    if (!existing) throw new NotFoundException('Produto nao encontrado');
    return this.prisma.product.update({ where: { id }, data: { active: false } });
  }

  // ─── Foto do produto ───────────────────────────────────────────

  /** Salva a foto no filesystem (products/{id}.ext) e grava o caminho no produto. */
  async updatePhoto(id: string, tenantId: string, buffer: Buffer, mimeType: string) {
    const existing = await this.prisma.product.findFirst({
      where: { id, tenant_id: tenantId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Produto nao encontrado');

    const ext = PHOTO_MIMES[mimeType?.toLowerCase()];
    if (!ext) throw new BadRequestException('Tipo de imagem nao suportado. Use JPEG, PNG ou WebP.');
    if (buffer.length > PHOTO_MAX_BYTES) {
      throw new BadRequestException('Imagem muito grande. Maximo 2 MB.');
    }

    // Limpa a versao anterior salva em outra extensao
    for (const oldExt of Object.values(PHOTO_MIMES)) {
      if (oldExt !== ext) {
        await this.fileStorage.delete(`products/${id}.${oldExt}`).catch(() => {});
      }
    }

    const relativePath = `products/${id}.${ext}`;
    await this.fileStorage.write(relativePath, buffer);
    return this.prisma.product.update({
      where: { id },
      data: { photo_url: relativePath },
      select: { id: true, photo_url: true, updated_at: true },
    });
  }

  /** Bytes da foto, so do produto da propria conta. null = sem foto (ou arquivo sumiu do disco). */
  async getPhoto(id: string, tenantId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const product = await this.prisma.product.findFirst({
      where: { id, tenant_id: tenantId },
      select: { photo_url: true },
    });
    if (!product?.photo_url) return null;
    const buffer = await this.fileStorage.tryRead(product.photo_url);
    if (!buffer) return null;
    const ext = product.photo_url.split('.').pop()?.toLowerCase();
    const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return { buffer, mimeType };
  }

  async removePhoto(id: string, tenantId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, tenant_id: tenantId },
      select: { photo_url: true },
    });
    if (!product) throw new NotFoundException('Produto nao encontrado');
    if (product.photo_url) await this.fileStorage.delete(product.photo_url).catch(() => {});
    return this.prisma.product.update({
      where: { id },
      data: { photo_url: null },
      select: { id: true, photo_url: true, updated_at: true },
    });
  }

  /** Produtos com estoque <= min_stock (alerta de reposicao). */
  async findLowStock(tenantId: string) {
    const all = await this.prisma.product.findMany({
      where: { tenant_id: tenantId, active: true, min_stock: { not: null } },
      orderBy: { name: 'asc' },
      include: { supplier: { select: { id: true, name: true } } },
    });
    return all.filter((p) => Number(p.current_stock) <= Number(p.min_stock));
  }
}
