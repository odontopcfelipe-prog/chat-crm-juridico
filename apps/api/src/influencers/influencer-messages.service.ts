/**
 * Histórico de mensagens enviadas (read-only).
 * Listagem paginada com filtros opcionais por schedule, influencer ou status.
 */
import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const PAGE_SIZE = 50;
const VALID_STATUS = ['SENT', 'FAILED', 'SKIPPED'];

@Injectable()
export class InfluencerMessagesService {
  constructor(private prisma: PrismaService) {}

  async list(tenantId: string, opts?: {
    scheduleId?: string;
    influencerId?: string;
    status?: string;
    page?: number;
  }) {
    const where: any = { tenant_id: tenantId };
    if (opts?.scheduleId) where.schedule_id = opts.scheduleId;
    if (opts?.influencerId) where.influencer_id = opts.influencerId;
    if (opts?.status) {
      if (!VALID_STATUS.includes(opts.status)) {
        throw new BadRequestException(`status inválido (use: ${VALID_STATUS.join(', ')})`);
      }
      where.status = opts.status;
    }
    const page = Math.max(1, opts?.page || 1);

    const [items, total] = await Promise.all([
      (this.prisma as any).influencerMessageLog.findMany({
        where,
        orderBy: { scheduled_for: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          schedule: { select: { id: true, name: true } },
          influencer: { select: { id: true, name: true, phone: true, handle: true } },
        },
      }),
      (this.prisma as any).influencerMessageLog.count({ where }),
    ]);

    return { items, total, page, pageSize: PAGE_SIZE };
  }
}
