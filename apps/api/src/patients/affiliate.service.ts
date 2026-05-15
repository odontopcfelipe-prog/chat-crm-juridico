import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * AffiliateService — Onda 5e v34 (Fase 25).
 *
 * Gerencia o programa de afiliado: lead/paciente parceiro que recebe 3%
 * (configuravel) de cada tratamento fechado por indicacao dele. Saldo
 * acumula automaticamente e pode ser sacado (PIX/dinheiro) ou usado como
 * credito em tratamentos proprios.
 *
 * Calcula saldo em runtime via:
 *   disponivel = sum(referral.commission_value WHERE status='creditado')
 *              - sum(withdrawal.amount WHERE status IN ('pago','solicitado'))
 *
 * Hook: QuotesService.markAccepted chama `recordReferralFromAcceptedQuote()`
 * quando uma Quote vira ACCEPTED, e cria AffiliateReferral se o paciente
 * tem `referred_by_id` apontando pra um Patient afiliado.
 */

const VALID_METHODS = ['PIX', 'DINHEIRO', 'CREDITO_TRATAMENTO'] as const;
type WithdrawalMethod = (typeof VALID_METHODS)[number];

@Injectable()
export class AffiliateService {
  private readonly logger = new Logger(AffiliateService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Retorna o dashboard completo de afiliado de um paciente:
   * saldo (disponivel/acumulado/sacado/pendente), lista de indicacoes
   * e historico de saques.
   */
  async getDashboard(patientId: string, tenantId: string) {
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, tenant_id: tenantId },
      select: {
        id: true,
        name: true,
        is_affiliate: true,
        affiliate_code: true,
        affiliate_commission_pct: true,
        affiliate_notes: true,
      },
    });
    if (!patient) throw new NotFoundException('Paciente nao encontrado');

    const [referrals, withdrawals] = await Promise.all([
      this.prisma.affiliateReferral.findMany({
        where: { tenant_id: tenantId, referrer_id: patientId },
        orderBy: { closed_at: 'desc' },
        include: {
          referred: { select: { id: true, name: true, phone: true } },
        },
      }),
      this.prisma.affiliateWithdrawal.findMany({
        where: { tenant_id: tenantId, patient_id: patientId },
        orderBy: { requested_at: 'desc' },
      }),
    ]);

    // Saldo calculado em runtime
    const totalAcumulado = referrals
      .filter((r) => r.status === 'creditado')
      .reduce((a, r) => a + Number(r.commission_value), 0);
    const totalSacado = withdrawals
      .filter((w) => w.status === 'pago')
      .reduce((a, w) => a + Number(w.amount), 0);
    const pendenteSaque = withdrawals
      .filter((w) => w.status === 'solicitado')
      .reduce((a, w) => a + Number(w.amount), 0);
    const disponivel = Math.max(0, totalAcumulado - totalSacado - pendenteSaque);

    return {
      patient: {
        id: patient.id,
        name: patient.name,
        is_affiliate: patient.is_affiliate,
        affiliate_code: patient.affiliate_code,
        affiliate_commission_pct: Number(patient.affiliate_commission_pct),
        affiliate_notes: patient.affiliate_notes,
      },
      stats: { disponivel, totalAcumulado, totalSacado, pendenteSaque },
      referrals: referrals.map((r) => ({
        id: r.id,
        indicated_name: r.referred?.name ?? '—',
        indicated_phone: r.referred?.phone ?? null,
        indicated_id: r.referred_id,
        closed_at: r.closed_at.toISOString(),
        treatment_value: Number(r.treatment_value),
        commission_value: Number(r.commission_value),
        commission_pct: Number(r.commission_pct),
        status: r.status as 'creditado' | 'pendente' | 'cancelado',
        quote_id: r.quote_id,
      })),
      withdrawals: withdrawals.map((w) => ({
        id: w.id,
        amount: Number(w.amount),
        method: w.method,
        pix_key: w.pix_key,
        status: w.status as 'solicitado' | 'pago' | 'recusado',
        requested_at: w.requested_at.toISOString(),
        paid_at: w.paid_at?.toISOString() ?? null,
        notes: w.notes,
      })),
    };
  }

  /**
   * Solicita saque do saldo. Valida valor contra saldo disponivel.
   * Cria AffiliateWithdrawal com status='solicitado'.
   *
   * Admin/financeiro depois confirma pagamento via `confirmWithdrawalPaid()`.
   */
  async requestWithdrawal(
    patientId: string,
    tenantId: string,
    data: {
      amount: number;
      method: WithdrawalMethod;
      pix_key?: string;
      notes?: string;
    },
  ) {
    if (!data.amount || data.amount <= 0) {
      throw new BadRequestException('Valor invalido');
    }
    if (!VALID_METHODS.includes(data.method)) {
      throw new BadRequestException(
        `method deve ser um de: ${VALID_METHODS.join(', ')}`,
      );
    }
    if (data.method === 'PIX' && !data.pix_key?.trim()) {
      throw new BadRequestException('PIX requer pix_key');
    }

    const dashboard = await this.getDashboard(patientId, tenantId);
    if (!dashboard.patient.is_affiliate) {
      throw new ForbiddenException('Paciente nao e afiliado ativo');
    }
    if (data.amount > dashboard.stats.disponivel) {
      throw new BadRequestException(
        `Saldo insuficiente. Disponivel: R$ ${dashboard.stats.disponivel.toFixed(2)}`,
      );
    }

    const withdrawal = await this.prisma.affiliateWithdrawal.create({
      data: {
        tenant_id: tenantId,
        patient_id: patientId,
        amount: data.amount,
        method: data.method,
        pix_key: data.method === 'PIX' ? (data.pix_key?.trim() || null) : null,
        notes: data.notes?.trim() || null,
        status: 'solicitado',
      },
    });

    this.logger.log(
      `[AFFILIATE_WITHDRAWAL] Solicitado: patient=${patientId} amount=${data.amount} method=${data.method} id=${withdrawal.id}`,
    );

    return { id: withdrawal.id, status: withdrawal.status };
  }

  /**
   * Admin confirma que pagou o saque. Marca paid_at + paid_by_user_id.
   * Idempotente: se ja esta pago, retorna sem erro.
   */
  async confirmWithdrawalPaid(
    withdrawalId: string,
    tenantId: string,
    paidByUserId: string,
  ) {
    const w = await this.prisma.affiliateWithdrawal.findFirst({
      where: { id: withdrawalId, tenant_id: tenantId },
    });
    if (!w) throw new NotFoundException('Saque nao encontrado');
    if (w.status === 'pago') return { ok: true, idempotent: true };
    if (w.status === 'recusado') {
      throw new BadRequestException('Saque ja foi recusado — nao pode pagar');
    }

    await this.prisma.affiliateWithdrawal.update({
      where: { id: withdrawalId },
      data: {
        status: 'pago',
        paid_at: new Date(),
        paid_by_user_id: paidByUserId,
      },
    });

    this.logger.log(
      `[AFFILIATE_WITHDRAWAL] Pago: id=${withdrawalId} by=${paidByUserId}`,
    );
    return { ok: true };
  }

  /**
   * Admin recusa o saque (ex: dados PIX invalidos, saldo retroativamente
   * cancelado, etc). Libera o valor pra voltar pro saldo disponivel.
   */
  async refuseWithdrawal(
    withdrawalId: string,
    tenantId: string,
    notes?: string,
  ) {
    const w = await this.prisma.affiliateWithdrawal.findFirst({
      where: { id: withdrawalId, tenant_id: tenantId },
    });
    if (!w) throw new NotFoundException('Saque nao encontrado');
    if (w.status !== 'solicitado') {
      throw new BadRequestException('So saques solicitados podem ser recusados');
    }
    await this.prisma.affiliateWithdrawal.update({
      where: { id: withdrawalId },
      data: { status: 'recusado', notes: notes?.trim() || w.notes },
    });
    return { ok: true };
  }

  /**
   * Hook chamado pelo QuotesService quando uma Quote vira ACCEPTED.
   *
   * Cria um AffiliateReferral pro afiliado que indicou o paciente,
   * calculando a comissao baseado no `affiliate_commission_pct` do
   * referrer (snapshot do % na hora — protege contra mudancas futuras
   * de percentual nao afetarem comissoes ja geradas).
   *
   * Idempotente: nao cria duplicado se ja existe AffiliateReferral
   * com o mesmo quote_id.
   *
   * Best-effort: erros sao logados mas nao bloqueiam a aceitacao da Quote.
   */
  async recordReferralFromAcceptedQuote(params: {
    quoteId: string;
    patientId: string;
    treatmentValue: number;
    tenantId: string;
  }): Promise<void> {
    try {
      // Ja existe referral pra essa Quote? (idempotente)
      const existing = await this.prisma.affiliateReferral.findFirst({
        where: { quote_id: params.quoteId },
      });
      if (existing) {
        this.logger.log(
          `[AFFILIATE] Quote ${params.quoteId} ja gerou referral — skip`,
        );
        return;
      }

      const patient = await this.prisma.patient.findUnique({
        where: { id: params.patientId },
        select: { referred_by_id: true },
      });
      if (!patient?.referred_by_id) return; // sem indicador

      const referrer = await this.prisma.patient.findUnique({
        where: { id: patient.referred_by_id },
        select: {
          id: true,
          is_affiliate: true,
          affiliate_commission_pct: true,
        },
      });
      if (!referrer?.is_affiliate) {
        this.logger.log(
          `[AFFILIATE] Referrer ${patient.referred_by_id} nao e afiliado — skip`,
        );
        return;
      }

      const pct = Number(referrer.affiliate_commission_pct ?? 3);
      const commission = +(params.treatmentValue * (pct / 100)).toFixed(2);

      const referral = await this.prisma.affiliateReferral.create({
        data: {
          tenant_id: params.tenantId,
          referrer_id: referrer.id,
          referred_id: params.patientId,
          quote_id: params.quoteId,
          treatment_value: params.treatmentValue,
          commission_pct: pct,
          commission_value: commission,
          status: 'creditado',
        },
      });

      this.logger.log(
        `[AFFILIATE] Referral criado: id=${referral.id} referrer=${referrer.id} commission=R$${commission} (quote=${params.quoteId})`,
      );
    } catch (e: any) {
      this.logger.warn(
        `[AFFILIATE] Falha ao registrar referral pra quote ${params.quoteId}: ${e?.message}`,
      );
    }
  }
}
