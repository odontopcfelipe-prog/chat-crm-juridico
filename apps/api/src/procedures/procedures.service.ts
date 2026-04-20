import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@crm/shared';

@Injectable()
export class ProceduresService {
  constructor(private prisma: PrismaService) {}

  async create(tenantId: string, data: Omit<Prisma.ProcedureUncheckedCreateInput, 'tenant_id'>) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.prisma.procedure.create({ data: { ...data, tenant_id: tenantId } });
  }

  async findAll(
    tenantId: string,
    opts: { specialtyId?: string; includeInactive?: boolean; search?: string } = {},
  ) {
    return this.prisma.procedure.findMany({
      where: {
        tenant_id: tenantId,
        ...(opts.includeInactive ? {} : { active: true }),
        ...(opts.specialtyId ? { specialty_id: opts.specialtyId } : {}),
        ...(opts.search
          ? {
              OR: [
                { name: { contains: opts.search, mode: 'insensitive' } },
                { code_tuss: { contains: opts.search } },
                { internal_code: { contains: opts.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ specialty_id: 'asc' }, { name: 'asc' }],
      include: {
        specialty: { select: { id: true, name: true, icon: true } },
      },
    });
  }

  async findOne(id: string, tenantId: string) {
    const proc = await this.prisma.procedure.findUnique({
      where: { id },
      include: { specialty: { select: { id: true, name: true } } },
    });
    if (!proc) throw new NotFoundException('Procedimento nao encontrado');
    if (proc.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    return proc;
  }

  async update(id: string, tenantId: string, data: Prisma.ProcedureUncheckedUpdateInput) {
    await this.assertBelongsToTenant(id, tenantId);
    return this.prisma.procedure.update({ where: { id }, data });
  }

  async remove(id: string, tenantId: string) {
    await this.assertBelongsToTenant(id, tenantId);
    // Soft delete para preservar referencias em QuoteItem/TreatmentPlanItem
    return this.prisma.procedure.update({ where: { id }, data: { active: false } });
  }

  private async assertBelongsToTenant(id: string, tenantId: string) {
    const row = await this.prisma.procedure.findUnique({
      where: { id },
      select: { tenant_id: true },
    });
    if (!row) throw new NotFoundException('Procedimento nao encontrado');
    if (row.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
  }
}
