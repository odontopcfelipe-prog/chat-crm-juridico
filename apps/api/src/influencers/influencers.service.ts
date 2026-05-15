/**
 * InfluencersService — cadastro de influenciadores (parcerias de marketing).
 *
 * Isolado: não toca em Patient/Lead/Referral. Multi-tenant — todas as queries
 * filtram por tenant_id. Coupon_code é único por tenant quando preenchido
 * (UX evita rastreamento duplicado de campanhas).
 */
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type Platform = 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE' | 'OUTRO';
export type CommissionType = 'PERCENTUAL' | 'FIXO' | 'PERMUTA';
export type InfluencerStatus = 'ATIVO' | 'PAUSADO' | 'INATIVO';

export interface CreateInfluencerDto {
  name: string;
  handle?: string | null;
  phone?: string | null;
  email?: string | null;
  platform?: Platform | null;
  followers?: number | null;
  niche?: string | null;
  commission_type?: CommissionType | null;
  commission_value?: number | null;
  coupon_code?: string | null;
  status?: InfluencerStatus;
  notes?: string | null;
}

export interface UpdateInfluencerDto extends Partial<CreateInfluencerDto> {}

const VALID_PLATFORMS: Platform[] = ['INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'OUTRO'];
const VALID_COMMISSION: CommissionType[] = ['PERCENTUAL', 'FIXO', 'PERMUTA'];
const VALID_STATUS: InfluencerStatus[] = ['ATIVO', 'PAUSADO', 'INATIVO'];

@Injectable()
export class InfluencersService {
  constructor(private prisma: PrismaService) {}

  // Normaliza @handle (remove @ inicial e espaços) — UX permite digitar com ou sem
  private normalizeHandle(h?: string | null): string | null {
    if (!h) return null;
    const trimmed = h.trim().replace(/^@+/, '');
    return trimmed.length === 0 ? null : trimmed;
  }

  private normalizeCoupon(c?: string | null): string | null {
    if (!c) return null;
    const trimmed = c.trim().toUpperCase();
    return trimmed.length === 0 ? null : trimmed;
  }

  private validate(data: CreateInfluencerDto | UpdateInfluencerDto) {
    if ('platform' in data && data.platform && !VALID_PLATFORMS.includes(data.platform)) {
      throw new BadRequestException(`platform inválido. Use: ${VALID_PLATFORMS.join(', ')}`);
    }
    if ('commission_type' in data && data.commission_type && !VALID_COMMISSION.includes(data.commission_type)) {
      throw new BadRequestException(`commission_type inválido. Use: ${VALID_COMMISSION.join(', ')}`);
    }
    if ('status' in data && data.status && !VALID_STATUS.includes(data.status)) {
      throw new BadRequestException(`status inválido. Use: ${VALID_STATUS.join(', ')}`);
    }
    if ('followers' in data && data.followers != null && data.followers < 0) {
      throw new BadRequestException('followers não pode ser negativo');
    }
    if ('commission_value' in data && data.commission_value != null && data.commission_value < 0) {
      throw new BadRequestException('commission_value não pode ser negativo');
    }
  }

  async list(tenantId: string, opts?: { status?: string; q?: string }) {
    const where: any = { tenant_id: tenantId };
    if (opts?.status && VALID_STATUS.includes(opts.status as InfluencerStatus)) {
      where.status = opts.status;
    }
    if (opts?.q && opts.q.trim()) {
      const q = opts.q.trim();
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { handle: { contains: q, mode: 'insensitive' } },
        { coupon_code: { contains: q, mode: 'insensitive' } },
      ];
    }
    return (this.prisma as any).influencer.findMany({
      where,
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });
  }

  async findOne(id: string, tenantId: string) {
    const item = await (this.prisma as any).influencer.findFirst({
      where: { id, tenant_id: tenantId },
    });
    if (!item) throw new NotFoundException('Influenciador não encontrado');
    return item;
  }

  async create(tenantId: string, data: CreateInfluencerDto) {
    if (!data.name || !data.name.trim()) {
      throw new BadRequestException('Nome é obrigatório');
    }
    this.validate(data);

    const coupon = this.normalizeCoupon(data.coupon_code);
    if (coupon) {
      const dup = await (this.prisma as any).influencer.findFirst({
        where: { tenant_id: tenantId, coupon_code: coupon },
      });
      if (dup) throw new BadRequestException(`Cupom "${coupon}" já está em uso`);
    }

    return (this.prisma as any).influencer.create({
      data: {
        tenant_id: tenantId,
        name: data.name.trim(),
        handle: this.normalizeHandle(data.handle),
        phone: data.phone?.trim() || null,
        email: data.email?.trim() || null,
        platform: data.platform || null,
        followers: data.followers ?? null,
        niche: data.niche?.trim() || null,
        commission_type: data.commission_type || null,
        commission_value: data.commission_value ?? null,
        coupon_code: coupon,
        status: data.status || 'ATIVO',
        notes: data.notes?.trim() || null,
      },
    });
  }

  async update(id: string, tenantId: string, data: UpdateInfluencerDto) {
    await this.findOne(id, tenantId); // garante existência + tenant
    this.validate(data);

    const patch: any = {};
    if (data.name !== undefined) {
      if (!data.name || !data.name.trim()) throw new BadRequestException('Nome não pode ser vazio');
      patch.name = data.name.trim();
    }
    if (data.handle !== undefined) patch.handle = this.normalizeHandle(data.handle);
    if (data.phone !== undefined) patch.phone = data.phone?.trim() || null;
    if (data.email !== undefined) patch.email = data.email?.trim() || null;
    if (data.platform !== undefined) patch.platform = data.platform || null;
    if (data.followers !== undefined) patch.followers = data.followers ?? null;
    if (data.niche !== undefined) patch.niche = data.niche?.trim() || null;
    if (data.commission_type !== undefined) patch.commission_type = data.commission_type || null;
    if (data.commission_value !== undefined) patch.commission_value = data.commission_value ?? null;
    if (data.coupon_code !== undefined) {
      const coupon = this.normalizeCoupon(data.coupon_code);
      if (coupon) {
        const dup = await (this.prisma as any).influencer.findFirst({
          where: { tenant_id: tenantId, coupon_code: coupon, NOT: { id } },
        });
        if (dup) throw new BadRequestException(`Cupom "${coupon}" já está em uso`);
      }
      patch.coupon_code = coupon;
    }
    if (data.status !== undefined) patch.status = data.status || 'ATIVO';
    if (data.notes !== undefined) patch.notes = data.notes?.trim() || null;

    return (this.prisma as any).influencer.update({
      where: { id },
      data: patch,
    });
  }

  async remove(id: string, tenantId: string) {
    await this.findOne(id, tenantId);
    await (this.prisma as any).influencer.delete({ where: { id } });
    return { ok: true };
  }
}
