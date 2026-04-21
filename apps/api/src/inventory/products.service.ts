import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@crm/shared';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(private prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateProductDto) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente no contexto');

    if (dto.sku) {
      const existing = await this.prisma.product.findUnique({
        where: { tenant_id_sku: { tenant_id: tenantId, sku: dto.sku } },
      });
      if (existing) throw new BadRequestException(`Ja existe um produto com SKU "${dto.sku}"`);
    }

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
    return this.prisma.product.update({ where: { id }, data: dto });
  }

  async archive(id: string, tenantId: string) {
    const existing = await this.prisma.product.findFirst({
      where: { id, tenant_id: tenantId },
    });
    if (!existing) throw new NotFoundException('Produto nao encontrado');
    return this.prisma.product.update({ where: { id }, data: { active: false } });
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
