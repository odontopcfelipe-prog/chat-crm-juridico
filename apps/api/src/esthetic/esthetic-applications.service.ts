import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@crm/shared';
import {
  CreateEstheticApplicationDto,
  UpdateEstheticApplicationDto,
} from './dto/esthetic-application.dto';
import { MaintenanceService } from '../maintenance/maintenance.service';

const DELETE_WINDOW_HOURS = 24;

@Injectable()
export class EstheticApplicationsService {
  private readonly logger = new Logger(EstheticApplicationsService.name);

  constructor(
    private prisma: PrismaService,
    // Onda 5 (Fase 25) — auto-cria task de manutencao apos aplicacao
    private maintenance: MaintenanceService,
  ) {}

  /**
   * Registra aplicacao estetica.
   *
   * Regras criticas (ANVISA):
   * - Se product.requires_lot_tracking=true, batch_number e expiration_date sao obrigatorios.
   * - Snapshot de product_name e brand para preservar historico (produto pode ser
   *   descontinuado depois).
   * - Calcula expected_revisit_at = applied_at + expected_duration_months (ou
   *   procedure.default_revisit_months se nao informado).
   * - Se product_id + volume informados: gera StockMovement de SAIDA automatica
   *   e decrementa current_stock atomicamente.
   */
  async create(
    tenantId: string,
    patientId: string,
    userId: string | undefined,
    dto: CreateEstheticApplicationDto,
  ) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente no contexto');

    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, tenant_id: tenantId },
    });
    if (!patient) throw new NotFoundException('Paciente nao encontrado');

    let productSnapshot: { name: string; brand: string | null } | null = null;
    let product: { id: string; name: string; brand: string | null; current_stock: Prisma.Decimal; requires_lot_tracking: boolean } | null = null;

    if (dto.product_id) {
      const p = await this.prisma.product.findFirst({
        where: { id: dto.product_id, tenant_id: tenantId },
      });
      if (!p) throw new NotFoundException('Produto nao encontrado');
      product = p;
      productSnapshot = { name: p.name, brand: p.brand };

      if (p.requires_lot_tracking && !dto.batch_number) {
        throw new BadRequestException(
          `Produto "${p.name}" exige rastreabilidade de lote (ANVISA). Informe batch_number.`,
        );
      }
    }

    let procedure: { id: string; default_revisit_months: number | null } | null = null;
    if (dto.procedure_id) {
      const proc = await this.prisma.procedure.findFirst({
        where: { id: dto.procedure_id, tenant_id: tenantId },
      });
      if (!proc) throw new NotFoundException('Procedimento nao encontrado');
      procedure = { id: proc.id, default_revisit_months: proc.default_revisit_months };
    }

    const appliedBy = dto.applied_by_user_id || userId;
    if (!appliedBy) {
      throw new BadRequestException('applied_by_user_id ausente — informe ou faca login');
    }

    const appliedAt = dto.applied_at ? new Date(dto.applied_at) : new Date();

    // Calcula expected_revisit_at
    const durationMonths = dto.expected_duration_months ?? procedure?.default_revisit_months ?? null;
    let expectedRevisitAt: Date | null = null;
    if (durationMonths) {
      expectedRevisitAt = new Date(appliedAt);
      expectedRevisitAt.setMonth(expectedRevisitAt.getMonth() + durationMonths);
    }

    return this.prisma.$transaction(async (tx) => {
      const application = await tx.estheticApplication.create({
        data: {
          tenant_id: tenantId,
          patient_id: patientId,
          procedure_id: dto.procedure_id,
          clinical_note_id: dto.clinical_note_id,
          appointment_id: dto.appointment_id,
          treatment_plan_item_id: dto.treatment_plan_item_id,
          application_point: dto.application_point,
          side: dto.side,
          product_id: dto.product_id,
          product_name_snapshot: productSnapshot?.name,
          brand_snapshot: productSnapshot?.brand,
          batch_number: dto.batch_number,
          expiration_date: dto.expiration_date ? new Date(dto.expiration_date) : undefined,
          volume: dto.volume !== undefined ? new Prisma.Decimal(dto.volume) : undefined,
          unit: dto.unit,
          dilution: dto.dilution,
          needle_gauge: dto.needle_gauge,
          technique: dto.technique,
          depth: dto.depth,
          notes: dto.notes,
          expected_duration_months: durationMonths,
          expected_revisit_at: expectedRevisitAt,
          applied_by_user_id: appliedBy,
          applied_at: appliedAt,
        },
      });

      // Baixa automatica de estoque se product_id + volume
      if (product && dto.volume !== undefined && dto.volume > 0) {
        const qty = new Prisma.Decimal(dto.volume);
        await tx.stockMovement.create({
          data: {
            tenant_id: tenantId,
            product_id: product.id,
            type: 'SAIDA',
            quantity: qty,
            batch_number: dto.batch_number,
            expiration_date: dto.expiration_date ? new Date(dto.expiration_date) : undefined,
            appointment_id: dto.appointment_id,
            notes: `Aplicacao estetica em ponto ${dto.application_point} (paciente ${patient.name})`,
            performed_by_user_id: appliedBy,
            performed_at: appliedAt,
          },
        });
        await tx.product.update({
          where: { id: product.id },
          data: { current_stock: new Prisma.Decimal(product.current_stock).minus(qty) },
        });
      }

      return application;
    }).then(async (application) => {
      // Onda 5.2 (Fase 25) — apos commit, cria maintenance task se ha
      // expected_revisit_at calculado. Falha nao-critica (log + segue).
      if (expectedRevisitAt) {
        try {
          await this.maintenance.createFromEstheticApplication({
            tenantId,
            patientId,
            estheticApplicationId: application.id,
            procedureId: dto.procedure_id || null,
            procedureName: productSnapshot?.name,
            expectedRevisitAt,
            createdByUserId: appliedBy,
          });
        } catch (e: any) {
          this.logger.warn(`[MAINTENANCE] Falha ao criar task auto: ${e?.message}`);
        }
      }
      return application;
    });
  }

  async findByPatient(
    tenantId: string,
    patientId: string,
    opts: { page?: number; limit?: number } = {},
  ) {
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, tenant_id: tenantId },
    });
    if (!patient) throw new NotFoundException('Paciente nao encontrado');

    const page = Math.max(1, opts.page || 1);
    const limit = Math.min(200, Math.max(1, opts.limit || 50));
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.estheticApplication.findMany({
        where: { tenant_id: tenantId, patient_id: patientId },
        orderBy: { applied_at: 'desc' },
        skip,
        take: limit,
        include: {
          procedure: { select: { id: true, name: true, category: true } },
          product: { select: { id: true, name: true, brand: true } },
          applied_by: { select: { id: true, name: true } },
          _count: { select: { adverse_reactions: true } },
        },
      }),
      this.prisma.estheticApplication.count({
        where: { tenant_id: tenantId, patient_id: patientId },
      }),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  async findOne(tenantId: string, id: string) {
    const application = await this.prisma.estheticApplication.findFirst({
      where: { id, tenant_id: tenantId },
      include: {
        patient: { select: { id: true, name: true, phone: true, email: true } },
        procedure: { select: { id: true, name: true, category: true, post_procedure_instructions: true } },
        product: { select: { id: true, name: true, brand: true, anvisa_registration: true } },
        applied_by: { select: { id: true, name: true, email: true } },
        clinical_note: { select: { id: true, created_at: true } },
        appointment: { select: { id: true, start_at: true, title: true } },
        adverse_reactions: { orderBy: { reported_at: 'desc' } },
      },
    });
    if (!application) throw new NotFoundException('Aplicacao nao encontrada');
    return application;
  }

  async update(tenantId: string, id: string, dto: UpdateEstheticApplicationDto) {
    const existing = await this.prisma.estheticApplication.findFirst({
      where: { id, tenant_id: tenantId },
    });
    if (!existing) throw new NotFoundException('Aplicacao nao encontrada');

    return this.prisma.estheticApplication.update({
      where: { id },
      data: {
        notes: dto.notes,
        expected_revisit_at: dto.expected_revisit_at ? new Date(dto.expected_revisit_at) : undefined,
      },
    });
  }

  /**
   * Soft "delete" — apenas dentro da janela de 24h e exclusivamente pelo profissional
   * que aplicou. Nao remove o registro, anota como cancelado nas notas.
   * Isso preserva auditoria ANVISA (registro nunca some).
   */
  async cancel(tenantId: string, id: string, userId: string, reason: string) {
    const existing = await this.prisma.estheticApplication.findFirst({
      where: { id, tenant_id: tenantId },
    });
    if (!existing) throw new NotFoundException('Aplicacao nao encontrada');

    const ageMs = Date.now() - new Date(existing.applied_at).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours > DELETE_WINDOW_HOURS) {
      throw new ForbiddenException(
        `Aplicacao com mais de ${DELETE_WINDOW_HOURS}h nao pode ser cancelada (auditoria ANVISA). Use UPDATE para registrar correcao em notas.`,
      );
    }
    if (existing.applied_by_user_id !== userId) {
      throw new ForbiddenException('Apenas o profissional que aplicou pode cancelar dentro da janela de 24h');
    }

    const cancelNote = `\n\n[CANCELADO em ${new Date().toISOString()} por ${userId}: ${reason || 'sem motivo informado'}]`;
    return this.prisma.estheticApplication.update({
      where: { id },
      data: { notes: (existing.notes || '') + cancelNote },
    });
  }

  /** Aplicacoes com retorno previsto nos proximos N dias (default 30). */
  async findUpcomingRevisits(tenantId: string, daysAhead = 30) {
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + daysAhead);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return this.prisma.estheticApplication.findMany({
      where: {
        tenant_id: tenantId,
        expected_revisit_at: { gte: today, lte: horizon },
      },
      orderBy: { expected_revisit_at: 'asc' },
      include: {
        patient: { select: { id: true, name: true, phone: true, email: true } },
        procedure: { select: { id: true, name: true } },
      },
    });
  }
}
