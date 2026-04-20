import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@crm/shared';

@Injectable()
export class SpecialtiesService {
  constructor(private prisma: PrismaService) {}

  async create(tenantId: string, data: Omit<Prisma.SpecialtyUncheckedCreateInput, 'tenant_id'>) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.prisma.specialty.create({ data: { ...data, tenant_id: tenantId } });
  }

  async findAll(tenantId: string, includeInactive = false) {
    return this.prisma.specialty.findMany({
      where: {
        tenant_id: tenantId,
        ...(includeInactive ? {} : { active: true }),
      },
      orderBy: { name: 'asc' },
      include: { _count: { select: { procedures: true, dentists: true } } },
    });
  }

  async findOne(id: string, tenantId: string) {
    const spec = await this.prisma.specialty.findUnique({
      where: { id },
      include: {
        procedures: { where: { active: true }, orderBy: { name: 'asc' } },
        dentists: { select: { id: true, name: true, email: true } },
      },
    });
    if (!spec) throw new NotFoundException('Especialidade nao encontrada');
    if (spec.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    return spec;
  }

  async update(id: string, tenantId: string, data: Prisma.SpecialtyUncheckedUpdateInput) {
    await this.assertBelongsToTenant(id, tenantId);
    return this.prisma.specialty.update({ where: { id }, data });
  }

  async remove(id: string, tenantId: string) {
    await this.assertBelongsToTenant(id, tenantId);
    // Soft delete via active=false para preservar historico de procedimentos
    return this.prisma.specialty.update({ where: { id }, data: { active: false } });
  }

  /** Associa dentista a uma especialidade (M:N) */
  async addDentist(specialtyId: string, userId: string, tenantId: string) {
    await this.assertBelongsToTenant(specialtyId, tenantId);
    return this.prisma.specialty.update({
      where: { id: specialtyId },
      data: { dentists: { connect: { id: userId } } },
    });
  }

  async removeDentist(specialtyId: string, userId: string, tenantId: string) {
    await this.assertBelongsToTenant(specialtyId, tenantId);
    return this.prisma.specialty.update({
      where: { id: specialtyId },
      data: { dentists: { disconnect: { id: userId } } },
    });
  }

  private async assertBelongsToTenant(id: string, tenantId: string) {
    const row = await this.prisma.specialty.findUnique({
      where: { id },
      select: { tenant_id: true },
    });
    if (!row) throw new NotFoundException('Especialidade nao encontrada');
    if (row.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
  }
}
