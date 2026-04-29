/**
 * ReferralsService — Indicação Premiada / cashback (Fase 21).
 *
 * Ciclo de vida da Referral:
 *  1. Paciente B é criado com referred_by_id apontando pra A
 *     → ReferralsService.createPending() cria Referral{status:PENDING, expires_at}
 *  2. Paciente B fecha plano (TreatmentPlan vira ACCEPTED ou ACTIVE)
 *     → ReferralsService.markEarned() atualiza pra EARNED
 *  3. Admin aplica cashback (desconto na próxima parcela de A ou pagamento)
 *     → ReferralsService.markPaid() atualiza pra PAID
 *
 * O valor do cashback (reward_value) vem da ReferralRule do tenant. Caso
 * não exista regra configurada, usa default de R$ 50 (sensato pra clínicas
 * pequenas/médias) e habilita por padrão.
 */
import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface UpdateReferralDto {
  status?: 'PENDING' | 'EARNED' | 'PAID' | 'EXPIRED' | 'CANCELLED';
  reward_value?: number;
  notes?: string | null;
  expires_at?: string | null;
}

export interface UpdateRuleDto {
  enabled?: boolean;
  default_reward_value?: number;
  expiration_days?: number;
  notes?: string | null;
}

const DEFAULT_REWARD = 50;
const DEFAULT_EXPIRATION_DAYS = 180;

@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  constructor(private prisma: PrismaService) {}

  // ─── Configuração da regra ────────────────────────────────────

  async getRule(tenantId: string) {
    let rule = await (this.prisma as any).referralRule.findUnique({
      where: { tenant_id: tenantId },
    });
    if (!rule) {
      // Cria regra default na primeira chamada — opt-out, não opt-in
      rule = await (this.prisma as any).referralRule.create({
        data: {
          tenant_id: tenantId,
          enabled: true,
          default_reward_value: DEFAULT_REWARD,
          expiration_days: DEFAULT_EXPIRATION_DAYS,
        },
      });
    }
    return rule;
  }

  async updateRule(tenantId: string, data: UpdateRuleDto) {
    await this.getRule(tenantId); // garante que existe
    return (this.prisma as any).referralRule.update({
      where: { tenant_id: tenantId },
      data: {
        ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
        ...(data.default_reward_value !== undefined ? { default_reward_value: data.default_reward_value } : {}),
        ...(data.expiration_days !== undefined ? { expiration_days: data.expiration_days } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
      },
    });
  }

  // ─── Hooks de ciclo de vida ──────────────────────────────────

  /**
   * Chamado em PatientsService.create() quando referred_by_id está setado.
   * Cria Referral{status:PENDING} se não existir. Idempotente — uma
   * Referral por paciente referido (referred_id é unique).
   */
  async createPending(params: {
    tenantId: string;
    referrerId: string;
    referredId: string;
  }) {
    if (params.referrerId === params.referredId) {
      this.logger.warn(`[REFERRAL] Tentativa de auto-indicacao ignorada (paciente=${params.referredId})`);
      return null;
    }

    // Idempotente: se já existe, retorna a existente
    const existing = await (this.prisma as any).referral.findUnique({
      where: { referred_id: params.referredId },
    });
    if (existing) return existing;

    const rule = await this.getRule(params.tenantId);
    if (!rule.enabled) {
      this.logger.log(`[REFERRAL] Programa desativado pra tenant ${params.tenantId} — pulando criacao`);
      return null;
    }

    const expiresAt = new Date(Date.now() + Number(rule.expiration_days) * 24 * 60 * 60 * 1000);

    const referral = await (this.prisma as any).referral.create({
      data: {
        tenant_id: params.tenantId,
        referrer_id: params.referrerId,
        referred_id: params.referredId,
        status: 'PENDING',
        reward_value: rule.default_reward_value,
        expires_at: expiresAt,
      },
    });
    this.logger.log(
      `[REFERRAL] PENDING criada — paciente ${params.referredId} indicado por ${params.referrerId} (R$ ${rule.default_reward_value})`,
    );
    return referral;
  }

  /**
   * Marca Referral como EARNED quando o paciente referido fecha um plano.
   * Chamado por TreatmentPlansService quando status vira ACCEPTED/ACTIVE.
   * Idempotente — só atualiza se ainda está PENDING.
   */
  async markEarned(referredPatientId: string, triggeringPlanId?: string) {
    const referral = await (this.prisma as any).referral.findUnique({
      where: { referred_id: referredPatientId },
    });
    if (!referral) return null;
    if (referral.status !== 'PENDING') {
      // já earned/paid/expired — nada a fazer
      return referral;
    }

    const updated = await (this.prisma as any).referral.update({
      where: { id: referral.id },
      data: {
        status: 'EARNED',
        earned_at: new Date(),
        triggering_plan_id: triggeringPlanId || null,
      },
    });
    this.logger.log(
      `[REFERRAL] EARNED — referral ${referral.id} (referrer=${referral.referrer_id} cashback=R$ ${referral.reward_value})`,
    );
    return updated;
  }

  // ─── CRUD admin ──────────────────────────────────────────────

  async list(tenantId: string, opts: { status?: string; referrerId?: string } = {}) {
    return (this.prisma as any).referral.findMany({
      where: {
        tenant_id: tenantId,
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.referrerId ? { referrer_id: opts.referrerId } : {}),
      },
      include: {
        referrer: { select: { id: true, name: true, phone: true, avatar_url: true } },
        referred: { select: { id: true, name: true, phone: true, avatar_url: true } },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async stats(tenantId: string) {
    const grouped = await (this.prisma as any).referral.groupBy({
      by: ['status'],
      where: { tenant_id: tenantId },
      _count: true,
      _sum: { reward_value: true },
    });
    const out: Record<string, { count: number; total: number }> = {
      PENDING:   { count: 0, total: 0 },
      EARNED:    { count: 0, total: 0 },
      PAID:      { count: 0, total: 0 },
      EXPIRED:   { count: 0, total: 0 },
      CANCELLED: { count: 0, total: 0 },
    };
    for (const g of grouped) {
      out[g.status] = {
        count: g._count,
        total: Number(g._sum.reward_value) || 0,
      };
    }
    // Total geral
    const totalCount = Object.values(out).reduce((s, x) => s + x.count, 0);
    const totalEarnedAndPaid = (out.EARNED?.total || 0) + (out.PAID?.total || 0);
    return { byStatus: out, totalCount, totalRewardCirculating: totalEarnedAndPaid };
  }

  async findOne(id: string, tenantId: string) {
    const referral = await (this.prisma as any).referral.findUnique({
      where: { id },
      include: {
        referrer: { select: { id: true, name: true, phone: true, avatar_url: true } },
        referred: { select: { id: true, name: true, phone: true, avatar_url: true } },
      },
    });
    if (!referral) throw new NotFoundException('Indicacao nao encontrada');
    if (referral.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    return referral;
  }

  async update(id: string, tenantId: string, data: UpdateReferralDto) {
    await this.findOne(id, tenantId);
    const updateData: any = {};
    if (data.status !== undefined) {
      updateData.status = data.status;
      // marca timestamp automatico em transicoes terminais
      if (data.status === 'EARNED') updateData.earned_at = new Date();
      if (data.status === 'PAID') updateData.paid_at = new Date();
    }
    if (data.reward_value !== undefined) updateData.reward_value = data.reward_value;
    if (data.notes !== undefined) updateData.notes = data.notes;
    if (data.expires_at !== undefined) {
      updateData.expires_at = data.expires_at ? new Date(data.expires_at) : null;
    }

    return (this.prisma as any).referral.update({
      where: { id },
      data: updateData,
      include: {
        referrer: { select: { id: true, name: true, phone: true, avatar_url: true } },
        referred: { select: { id: true, name: true, phone: true, avatar_url: true } },
      },
    });
  }

  async markPaid(id: string, tenantId: string, notes?: string) {
    const ref = await this.findOne(id, tenantId);
    if (ref.status !== 'EARNED') {
      throw new BadRequestException(
        `Apenas indicações com status EARNED podem ser marcadas como PAGAS. Atual: ${ref.status}`,
      );
    }
    return this.update(id, tenantId, { status: 'PAID', notes: notes ?? ref.notes });
  }

  async remove(id: string, tenantId: string) {
    await this.findOne(id, tenantId);
    return (this.prisma as any).referral.delete({ where: { id } });
  }
}
