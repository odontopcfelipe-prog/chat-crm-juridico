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
   * Politica de saldo negativo POR CLINICA. Key GlobalSetting
   * `INVENTORY_BLOCK_NEGATIVE_<tenant>`:
   *   'true'  = bloqueia a saida que deixaria o saldo negativo (400)
   *   ausente/'false' = deixa passar e registra (DEFAULT — nao trava o balcao
   *                     com paciente na frente; saldo errado quase sempre e
   *                     estoque desatualizado, nao falta real)
   * Decisao do dono: e um botao que cada clinica liga quando o estoque estiver
   * confiavel o bastante pra sustentar o bloqueio.
   */
  async blocksNegativeStock(tenantId: string): Promise<boolean> {
    if (!tenantId) return false;
    const row = await this.prisma.globalSetting
      .findUnique({ where: { key: `INVENTORY_BLOCK_NEGATIVE_${tenantId}` } })
      .catch(() => null);
    return row?.value === 'true';
  }

  /** Liga/desliga a trava de saldo negativo da clinica. */
  async setBlocksNegativeStock(tenantId: string, block: boolean) {
    const key = `INVENTORY_BLOCK_NEGATIVE_${tenantId}`;
    const value = String(block);
    await this.prisma.globalSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
    this.logger.log(`[ESTOQUE] Bloqueio de saida sem saldo ${block ? 'LIGADO' : 'DESLIGADO'} (tenant ${tenantId})`);
    return { block_negative: block };
  }

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

      const qty = new Prisma.Decimal(dto.quantity);

      // ATOMICO de verdade: increment/decrement deixam a soma no BANCO. Antes
      // liamos current_stock aqui e gravavamos o valor ABSOLUTO calculado — duas
      // baixas simultaneas (duas recepcoes vendendo junto) liam o mesmo saldo e a
      // segunda sobrescrevia a primeira: uma das saidas sumia do saldo, calada.
      // AJUSTE continua absoluto por definicao ("o saldo real e X").
      let updated;
      switch (dto.type) {
        case 'ENTRADA':
          updated = await tx.product.update({
            where: { id: product.id },
            data: { current_stock: { increment: qty } },
            select: { current_stock: true },
          });
          break;
        case 'SAIDA':
        case 'PERDA':
        case 'DESCARTE_VENCIMENTO':
          updated = await tx.product.update({
            where: { id: product.id },
            data: { current_stock: { decrement: qty } },
            select: { current_stock: true },
          });
          // A trava roda DEPOIS do decremento, olhando o saldo real pos-operacao:
          // dentro da transacao, lancar a excecao desfaz tudo (movimento + saldo).
          // Checar antes voltaria a ser read-then-write — a corrida que acabamos
          // de fechar.
          if (new Prisma.Decimal(updated.current_stock).isNegative()) {
            if (await this.blocksNegativeStock(tenantId)) {
              throw new BadRequestException(
                `Estoque insuficiente de "${product.name}": saldo ${product.current_stock.toString()} ` +
                `e a saida e de ${qty.toString()}. Dê entrada no produto ou desligue o bloqueio ` +
                `em Estoque → "bloquear saída sem saldo".`,
              );
            }
            this.logger.warn(
              `Estoque negativo: produto ${product.id} ficou em ${updated.current_stock.toString()}`,
            );
          }
          break;
        case 'AJUSTE':
          updated = await tx.product.update({
            where: { id: product.id },
            data: { current_stock: qty },
            select: { current_stock: true },
          });
          break;
        default:
          throw new BadRequestException(`Tipo de movimento invalido: ${dto.type}`);
      }

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
