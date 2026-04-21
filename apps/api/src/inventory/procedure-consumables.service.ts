import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@crm/shared';
import { CreateProcedureConsumableDto } from './dto/procedure-consumable.dto';

@Injectable()
export class ProcedureConsumablesService {
  private readonly logger = new Logger(ProcedureConsumablesService.name);

  constructor(private prisma: PrismaService) {}

  async create(tenantId: string, procedureId: string, dto: CreateProcedureConsumableDto) {
    const procedure = await this.prisma.procedure.findFirst({
      where: { id: procedureId, tenant_id: tenantId },
    });
    if (!procedure) throw new NotFoundException('Procedimento nao encontrado');

    const product = await this.prisma.product.findFirst({
      where: { id: dto.product_id, tenant_id: tenantId },
    });
    if (!product) throw new NotFoundException('Produto nao encontrado');

    return this.prisma.procedureConsumable.upsert({
      where: { procedure_id_product_id: { procedure_id: procedureId, product_id: dto.product_id } },
      create: {
        procedure_id: procedureId,
        product_id: dto.product_id,
        quantity: new Prisma.Decimal(dto.quantity),
        notes: dto.notes,
      },
      update: {
        quantity: new Prisma.Decimal(dto.quantity),
        notes: dto.notes,
      },
    });
  }

  async findByProcedure(tenantId: string, procedureId: string) {
    const procedure = await this.prisma.procedure.findFirst({
      where: { id: procedureId, tenant_id: tenantId },
    });
    if (!procedure) throw new NotFoundException('Procedimento nao encontrado');

    return this.prisma.procedureConsumable.findMany({
      where: { procedure_id: procedureId },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            brand: true,
            unit: true,
            current_stock: true,
            cost_price: true,
          },
        },
      },
    });
  }

  async remove(tenantId: string, id: string) {
    const consumable = await this.prisma.procedureConsumable.findUnique({
      where: { id },
      include: { procedure: { select: { tenant_id: true } } },
    });
    if (!consumable) throw new NotFoundException('Vinculo nao encontrado');
    if (consumable.procedure.tenant_id !== tenantId) {
      throw new BadRequestException('Vinculo pertence a outro tenant');
    }
    await this.prisma.procedureConsumable.delete({ where: { id } });
    return { ok: true };
  }
}
