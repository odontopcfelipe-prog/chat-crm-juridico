import {
  Injectable, Logger, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@crm/shared';
import {
  CreateInstallmentDto, GenerateFromQuoteDto, PayInstallmentDto,
  UpdateInstallmentDto, RenegotiateDto,
} from './dto/installment.dto';

@Injectable()
export class InstallmentsService {
  private readonly logger = new Logger(InstallmentsService.name);

  constructor(private prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateInstallmentDto) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.prisma.installment.create({
      data: {
        tenant_id: tenantId,
        patient_id: dto.patient_id,
        quote_id: dto.quote_id,
        sequence: dto.sequence ?? 1,
        total_count: dto.total_count ?? 1,
        amount: new Prisma.Decimal(dto.amount),
        due_date: new Date(dto.due_date),
        payment_method: dto.payment_method,
        notes: dto.notes,
      },
    });
  }

  /**
   * Gera N parcelas a partir de uma Quote ACCEPTED. Idempotente — se ja
   * existem parcelas para a quote, lanca BadRequest.
   */
  async generateFromQuote(tenantId: string, quoteId: string, dto: GenerateFromQuoteDto) {
    const quote = await this.prisma.quote.findUnique({
      where: { id: quoteId },
      include: { patient: { select: { id: true, tenant_id: true } } },
    });
    if (!quote) throw new NotFoundException('Orcamento nao encontrado');
    if (quote.patient.tenant_id !== tenantId) throw new BadRequestException('Orcamento de outro tenant');
    if (quote.status !== 'ACCEPTED') {
      throw new BadRequestException(`Quote precisa estar ACCEPTED (atual: ${quote.status})`);
    }

    const existing = await this.prisma.installment.count({ where: { quote_id: quoteId } });
    if (existing > 0) throw new BadRequestException('Quote ja tem parcelas geradas');

    const total = Number(quote.total_value);
    const entry = Number(dto.entry_value || 0);
    const remaining = total - entry;
    if (remaining < 0) throw new BadRequestException('entry_value maior que total da quote');

    const interval = dto.interval_days ?? 30;
    const baseDate = new Date(dto.first_due_date);
    const installments = [];
    const totalCountWithEntry = entry > 0 ? dto.total_count + 1 : dto.total_count;

    let seq = 1;

    if (entry > 0) {
      installments.push({
        tenant_id: tenantId,
        patient_id: quote.patient.id,
        quote_id: quoteId,
        sequence: seq++,
        total_count: totalCountWithEntry,
        amount: new Prisma.Decimal(entry),
        due_date: new Date(),
        notes: 'Entrada',
      });
    }

    const perInstallment = Number((remaining / dto.total_count).toFixed(2));
    let cumulative = 0;

    for (let i = 0; i < dto.total_count; i++) {
      const due = new Date(baseDate);
      due.setDate(due.getDate() + interval * i);
      // Ultima parcela ajusta arredondamento
      const isLast = i === dto.total_count - 1;
      const amount = isLast ? Number((remaining - cumulative).toFixed(2)) : perInstallment;
      cumulative += amount;
      installments.push({
        tenant_id: tenantId,
        patient_id: quote.patient.id,
        quote_id: quoteId,
        sequence: seq++,
        total_count: totalCountWithEntry,
        amount: new Prisma.Decimal(amount),
        due_date: due,
      });
    }

    await this.prisma.installment.createMany({ data: installments });

    return this.prisma.installment.findMany({
      where: { quote_id: quoteId },
      orderBy: { sequence: 'asc' },
    });
  }

  async findAll(
    tenantId: string,
    opts: {
      patient_id?: string;
      status?: string;
      quote_id?: string;
      overdue?: boolean;
      from?: string;
      to?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const page = Math.max(1, opts.page || 1);
    const limit = Math.min(200, Math.max(1, opts.limit || 50));
    const skip = (page - 1) * limit;

    const where: Prisma.InstallmentWhereInput = {
      tenant_id: tenantId,
      ...(opts.patient_id ? { patient_id: opts.patient_id } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.quote_id ? { quote_id: opts.quote_id } : {}),
      ...(opts.from || opts.to
        ? {
            due_date: {
              ...(opts.from ? { gte: new Date(opts.from) } : {}),
              ...(opts.to ? { lte: new Date(opts.to) } : {}),
            },
          }
        : {}),
      ...(opts.overdue
        ? { status: { in: ['ABERTA', 'PARCIAL', 'ATRASADA'] }, due_date: { lt: new Date() } }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.installment.findMany({
        where,
        orderBy: { due_date: 'asc' },
        skip,
        take: limit,
        include: {
          patient: { select: { id: true, name: true, phone: true, email: true } },
          quote: { select: { id: true, total_value: true } },
          _count: { select: { collection_attempts: true } },
        },
      }),
      this.prisma.installment.count({ where }),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  async findOne(tenantId: string, id: string) {
    const inst = await this.prisma.installment.findFirst({
      where: { id, tenant_id: tenantId },
      include: {
        patient: { select: { id: true, name: true, phone: true, email: true } },
        quote: true,
        collection_attempts: { orderBy: { sent_at: 'desc' } },
      },
    });
    if (!inst) throw new NotFoundException('Parcela nao encontrada');
    return inst;
  }

  async update(tenantId: string, id: string, dto: UpdateInstallmentDto) {
    await this.findOne(tenantId, id);
    return this.prisma.installment.update({
      where: { id },
      data: {
        amount: dto.amount !== undefined ? new Prisma.Decimal(dto.amount) : undefined,
        due_date: dto.due_date ? new Date(dto.due_date) : undefined,
        discount_value: dto.discount_value !== undefined ? new Prisma.Decimal(dto.discount_value) : undefined,
        fee_value: dto.fee_value !== undefined ? new Prisma.Decimal(dto.fee_value) : undefined,
        notes: dto.notes,
      },
    });
  }

  /** Registra pagamento (total ou parcial). */
  async pay(tenantId: string, id: string, dto: PayInstallmentDto) {
    const inst = await this.findOne(tenantId, id);
    if (inst.status === 'PAGA') throw new BadRequestException('Parcela ja foi paga');
    if (inst.status === 'CANCELADA') throw new BadRequestException('Parcela cancelada');

    const newAmountPaid = Number(inst.amount_paid) + dto.amount_paid;
    const totalDue = Number(inst.amount) - Number(inst.discount_value) + Number(inst.fee_value);
    const isFullPaid = newAmountPaid >= totalDue;

    return this.prisma.installment.update({
      where: { id },
      data: {
        amount_paid: new Prisma.Decimal(newAmountPaid),
        payment_method: dto.payment_method,
        paid_at: isFullPaid ? (dto.paid_at ? new Date(dto.paid_at) : new Date()) : undefined,
        status: isFullPaid ? 'PAGA' : 'PARCIAL',
        notes: dto.notes,
      },
    });
  }

  async cancel(tenantId: string, id: string, reason?: string) {
    const inst = await this.findOne(tenantId, id);
    if (inst.status === 'PAGA') throw new BadRequestException('Parcela ja paga, nao cancelar');
    return this.prisma.installment.update({
      where: { id },
      data: {
        status: 'CANCELADA',
        notes: reason ? `[CANCELADA: ${reason}]` : '[CANCELADA]',
      },
    });
  }

  /**
   * Renegocia: cancela parcelas pendentes do mesmo quote, soma o saldo
   * devedor + entry_value e gera N novas parcelas.
   */
  async renegotiate(tenantId: string, id: string, dto: RenegotiateDto) {
    const original = await this.findOne(tenantId, id);
    if (!original.quote_id) {
      throw new BadRequestException('Parcela sem quote_id — nao pode renegociar');
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Cancela todas as parcelas ABERTA/PARCIAL/ATRASADA do mesmo quote
      const open = await tx.installment.findMany({
        where: {
          quote_id: original.quote_id,
          status: { in: ['ABERTA', 'PARCIAL', 'ATRASADA'] },
        },
        select: { id: true, amount: true, amount_paid: true },
      });

      if (open.length === 0) throw new BadRequestException('Nao ha parcelas pendentes');

      const totalOpen = open.reduce(
        (sum, p) => sum + (Number(p.amount) - Number(p.amount_paid)),
        0,
      );
      const entry = Number(dto.entry_value || 0);
      const remaining = totalOpen - entry;
      if (remaining < 0) throw new BadRequestException('entry_value maior que saldo');

      const interval = dto.interval_days ?? 30;
      const baseDate = new Date(dto.new_first_due_date);
      const newSeq = await tx.installment.count({ where: { quote_id: original.quote_id! } });

      // 2. Cria entrada (se houver) + novas parcelas
      let seq = newSeq + 1;
      const totalNew = entry > 0 ? dto.new_total_count + 1 : dto.new_total_count;
      const created: { id: string }[] = [];

      if (entry > 0) {
        const e = await tx.installment.create({
          data: {
            tenant_id: tenantId,
            patient_id: original.patient_id,
            quote_id: original.quote_id!,
            sequence: seq++,
            total_count: newSeq + totalNew,
            amount: new Prisma.Decimal(entry),
            due_date: new Date(),
            notes: 'Entrada (renegociacao)',
          },
        });
        created.push(e);
      }

      const per = Number((remaining / dto.new_total_count).toFixed(2));
      let cum = 0;
      for (let i = 0; i < dto.new_total_count; i++) {
        const due = new Date(baseDate);
        due.setDate(due.getDate() + interval * i);
        const isLast = i === dto.new_total_count - 1;
        const amount = isLast ? Number((remaining - cum).toFixed(2)) : per;
        cum += amount;
        const ni = await tx.installment.create({
          data: {
            tenant_id: tenantId,
            patient_id: original.patient_id,
            quote_id: original.quote_id!,
            sequence: seq++,
            total_count: newSeq + totalNew,
            amount: new Prisma.Decimal(amount),
            due_date: due,
            notes: 'Renegociacao',
          },
        });
        created.push(ni);
      }

      // 3. Marca parcelas antigas como RENEGOCIADA apontando para a primeira nova
      const firstNew = created[0];
      await tx.installment.updateMany({
        where: { id: { in: open.map((p) => p.id) } },
        data: { status: 'RENEGOCIADA', renegotiated_to_id: firstNew.id },
      });

      return { renegotiated: open.length, created: created.length, new_first_id: firstNew.id };
    });
  }

  /** Resumo de inadimplencia agrupado por aging bucket. */
  async overdueSummary(tenantId: string) {
    const now = new Date();
    const buckets = [
      { label: '1-7 dias', days: 7 },
      { label: '8-15 dias', days: 15 },
      { label: '16-30 dias', days: 30 },
      { label: '31-60 dias', days: 60 },
      { label: '60+ dias', days: 999999 },
    ];

    const overdue = await this.prisma.installment.findMany({
      where: {
        tenant_id: tenantId,
        status: { in: ['ABERTA', 'PARCIAL', 'ATRASADA'] },
        due_date: { lt: now },
      },
      select: { id: true, amount: true, amount_paid: true, due_date: true },
    });

    const result: Record<string, { count: number; total: number }> = {};
    for (const b of buckets) result[b.label] = { count: 0, total: 0 };

    let prev = 0;
    for (const inst of overdue) {
      const daysLate = Math.floor((now.getTime() - new Date(inst.due_date).getTime()) / (1000 * 60 * 60 * 24));
      const remaining = Number(inst.amount) - Number(inst.amount_paid);
      for (const b of buckets) {
        if (daysLate <= b.days && daysLate > prev) {
          result[b.label].count += 1;
          result[b.label].total += remaining;
          break;
        }
      }
      prev = 0;
    }

    return {
      total_overdue: overdue.length,
      total_value: overdue.reduce((s, i) => s + Number(i.amount) - Number(i.amount_paid), 0),
      buckets: result,
    };
  }
}
