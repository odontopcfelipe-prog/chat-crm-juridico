import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@crm/shared';
import { CreateSupplierDto, UpdateSupplierDto } from './dto/supplier.dto';

@Injectable()
export class SuppliersService {
  private readonly logger = new Logger(SuppliersService.name);

  constructor(private prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateSupplierDto) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente no contexto');
    return this.prisma.supplier.create({
      data: { ...dto, tenant_id: tenantId },
    });
  }

  async findAll(
    tenantId: string,
    opts: { search?: string; category?: string; active?: boolean; page?: number; limit?: number } = {},
  ) {
    const page = Math.max(1, opts.page || 1);
    const limit = Math.min(100, Math.max(1, opts.limit || 50));
    const skip = (page - 1) * limit;

    const where: Prisma.SupplierWhereInput = {
      tenant_id: tenantId,
      ...(opts.category ? { category: opts.category } : {}),
      ...(opts.active !== undefined ? { active: opts.active } : {}),
      ...(opts.search
        ? {
            OR: [
              { name: { contains: opts.search, mode: 'insensitive' } },
              { cnpj: { contains: opts.search } },
              { contact_name: { contains: opts.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.supplier.findMany({
        where,
        orderBy: { name: 'asc' },
        skip,
        take: limit,
        include: { _count: { select: { products: true, movements: true } } },
      }),
      this.prisma.supplier.count({ where }),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  async findOne(id: string, tenantId: string) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id, tenant_id: tenantId },
      include: {
        products: { where: { active: true }, orderBy: { name: 'asc' } },
        _count: { select: { products: true, movements: true } },
      },
    });
    if (!supplier) throw new NotFoundException('Fornecedor nao encontrado');
    return supplier;
  }

  async update(id: string, tenantId: string, dto: UpdateSupplierDto) {
    const existing = await this.prisma.supplier.findFirst({
      where: { id, tenant_id: tenantId },
    });
    if (!existing) throw new NotFoundException('Fornecedor nao encontrado');
    return this.prisma.supplier.update({ where: { id }, data: dto });
  }

  /** Soft delete via active=false. Mantem historico de StockMovement intacto. */
  async archive(id: string, tenantId: string) {
    const existing = await this.prisma.supplier.findFirst({
      where: { id, tenant_id: tenantId },
    });
    if (!existing) throw new NotFoundException('Fornecedor nao encontrado');
    return this.prisma.supplier.update({ where: { id }, data: { active: false } });
  }
}
