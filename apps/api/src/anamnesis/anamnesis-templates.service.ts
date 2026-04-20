import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@crm/shared';

@Injectable()
export class AnamnesisTemplatesService {
  constructor(private prisma: PrismaService) {}

  async findAll(tenantId: string) {
    return this.prisma.anamnesisTemplate.findMany({
      where: { tenant_id: tenantId },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        active: true,
        notes: true,
        created_at: true,
        updated_at: true,
        _count: { select: { anamneses: true } },
      },
    });
  }

  async findActive(tenantId: string) {
    const tpl = await this.prisma.anamnesisTemplate.findFirst({
      where: { tenant_id: tenantId, active: true },
      orderBy: { version: 'desc' },
    });
    if (!tpl) throw new NotFoundException('Nenhum template ativo — admin precisa criar um.');
    return tpl;
  }

  async findOne(id: string, tenantId: string) {
    const tpl = await this.prisma.anamnesisTemplate.findUnique({ where: { id } });
    if (!tpl) throw new NotFoundException('Template nao encontrado');
    if (tpl.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    return tpl;
  }

  /** Cria nova versao. Desativa versao anterior ativa automaticamente. */
  async create(tenantId: string, schema: any, notes?: string) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!schema || typeof schema !== 'object') throw new BadRequestException('schema obrigatorio');

    // Pega proxima versao
    const lastVersion = await this.prisma.anamnesisTemplate.findFirst({
      where: { tenant_id: tenantId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const nextVersion = (lastVersion?.version ?? 0) + 1;

    // Transaction: desativa versao atual ativa + cria nova
    return this.prisma.$transaction(async (tx) => {
      await tx.anamnesisTemplate.updateMany({
        where: { tenant_id: tenantId, active: true },
        data: { active: false },
      });
      return tx.anamnesisTemplate.create({
        data: {
          tenant_id: tenantId,
          version: nextVersion,
          schema,
          notes: notes || null,
          active: true,
        },
      });
    });
  }

  async update(id: string, tenantId: string, data: Prisma.AnamnesisTemplateUncheckedUpdateInput) {
    const tpl = await this.findOne(id, tenantId);

    // Se ativando, desativa outras versoes
    if (data.active === true && !tpl.active) {
      await this.prisma.anamnesisTemplate.updateMany({
        where: { tenant_id: tenantId, active: true, NOT: { id } },
        data: { active: false },
      });
    }

    return this.prisma.anamnesisTemplate.update({ where: { id }, data });
  }
}
