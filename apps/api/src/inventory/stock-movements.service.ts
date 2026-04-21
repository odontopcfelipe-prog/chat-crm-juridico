import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@crm/shared';
import { CreateStockMovementDto } from './dto/stock-movement.dto';

@Injectable()
export class StockMovementsService {
  private readonly logger = new Logger(StockMovementsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Cria movimento e atualiza current_stock atomicamente em transacao.
   * - Para produtos com requires_lot_tracking, batch_number e expiration_date sao obrigatorios.
   * - SAIDA/PERDA/DESCARTE_VENCIMENTO descontam estoque; ENTRADA soma; AJUSTE substitui.
   */
  async create(tenantId: string, userId: string | undefined, dto: CreateStockMovementDto) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente no contexto');

    const product = await this.prisma.product.findFirst({
      where: { id: dto.product_id, tenant_id: tenantId },
    });
    if (!product) throw new NotFoundException('Produto nao encontrado');

    if (product.requires_lot_tracking && !dto.batch_number) {
      throw new BadRequestException(
        `Produto "${product.name}" exige rastreabilidade de lote (ANVISA). Informe batch_number.`,
      );
    }
    if (product.has_expiration && !dto.expiration_date && dto.type === 'ENTRADA') {
      throw new BadRequestException(
        `Produto "${product.name}" exige data de validade na entrada.`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const movement = await tx.stockMovement.create({
        data: {
          tenant_id: tenantId,
          product_id: dto.product_id,
          supplier_id: dto.supplier_id,
          type: dto.type,
          quantity: new Prisma.Decimal(dto.quantity),
          unit_cost: dto.unit_cost ? new Prisma.Decimal(dto.unit_cost) : undefined,
          total_cost: dto.total_cost ? new Prisma.Decimal(dto.total_cost) : undefined,
          batch_number: dto.batch_number,
          expiration_date: dto.expiration_date ? new Date(dto.expiration_date) : undefined,
          appointment_id: dto.appointment_id,
          notes: dto.notes,
          performed_by_user_id: userId,
        },
      });

      const currentStock = new Prisma.Decimal(product.current_stock);
      const qty = new Prisma.Decimal(dto.quantity);
      let newStock: Prisma.Decimal;

      switch (dto.type) {
        case 'ENTRADA':
          newStock = currentStock.plus(qty);
          break;
        case 'SAIDA':
        case 'PERDA':
        case 'DESCARTE_VENCIMENTO':
          newStock = currentStock.minus(qty);
          if (newStock.isNegative()) {
            // Permite estoque negativo mas loga (clinica pode usar p/ acerto retroativo)
            this.logger.warn(
              `Estoque negativo: produto ${product.id} ficou em ${newStock.toString()}`,
            );
          }
          break;
        case 'AJUSTE':
          newStock = qty; // ajuste substitui
          break;
        default:
          throw new BadRequestException(`Tipo de movimento invalido: ${dto.type}`);
      }

      await tx.product.update({
        where: { id: product.id },
        data: { current_stock: newStock },
      });

      return movement;
    });
  }

  async findAll(
    tenantId: string,
    opts: {
      product_id?: string;
      type?: string;
      from?: string;
      to?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const page = Math.max(1, opts.page || 1);
    const limit = Math.min(200, Math.max(1, opts.limit || 50));
    const skip = (page - 1) * limit;

    const where: Prisma.StockMovementWhereInput = {
      tenant_id: tenantId,
      ...(opts.product_id ? { product_id: opts.product_id } : {}),
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.from || opts.to
        ? {
            performed_at: {
              ...(opts.from ? { gte: new Date(opts.from) } : {}),
              ...(opts.to ? { lte: new Date(opts.to) } : {}),
            },
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.stockMovement.findMany({
        where,
        orderBy: { performed_at: 'desc' },
        skip,
        take: limit,
        include: {
          product: { select: { id: true, name: true, brand: true, unit: true } },
          supplier: { select: { id: true, name: true } },
        },
      }),
      this.prisma.stockMovement.count({ where }),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Rastreabilidade reversa ANVISA: dado um lote, retorna todos os
   * movimentos + aplicacoes esteticas que usaram esse lote.
   * Critico em caso de recall ou investigacao de reacao adversa.
   */
  async findByBatch(tenantId: string, batchNumber: string) {
    if (!batchNumber || batchNumber.length < 1) {
      throw new BadRequestException('batch_number e obrigatorio');
    }

    const [movements, applications] = await Promise.all([
      this.prisma.stockMovement.findMany({
        where: { tenant_id: tenantId, batch_number: batchNumber },
        orderBy: { performed_at: 'desc' },
        include: {
          product: { select: { id: true, name: true, brand: true, anvisa_registration: true } },
          supplier: { select: { id: true, name: true } },
        },
      }),
      this.prisma.estheticApplication.findMany({
        where: { tenant_id: tenantId, batch_number: batchNumber },
        orderBy: { applied_at: 'desc' },
        include: {
          patient: { select: { id: true, name: true, phone: true, email: true } },
          product: { select: { id: true, name: true, brand: true } },
          adverse_reactions: { select: { id: true, severity: true, reaction_type: true } },
        },
      }),
    ]);

    return {
      batch_number: batchNumber,
      movements,
      esthetic_applications: applications,
      summary: {
        movements_count: movements.length,
        applications_count: applications.length,
        patients_affected: new Set(applications.map((a) => a.patient_id)).size,
        adverse_reactions_count: applications.reduce(
          (sum, a) => sum + a.adverse_reactions.length,
          0,
        ),
      },
    };
  }

  /** Produtos vencendo nos proximos N dias (default 60). */
  async findExpiring(tenantId: string, daysAhead = 60) {
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + daysAhead);

    return this.prisma.stockMovement.findMany({
      where: {
        tenant_id: tenantId,
        type: 'ENTRADA',
        expiration_date: { lte: horizon, gte: new Date() },
      },
      orderBy: { expiration_date: 'asc' },
      include: {
        product: { select: { id: true, name: true, brand: true } },
      },
    });
  }
}
