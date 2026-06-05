/**
 * Onda 17.32.86 — SaaS Fase 3b: cobranca automatizada do plano.
 *
 * Cada tenant assina um SaasPlan e paga mensalmente via Asaas. O
 * sistema-odonto eh cliente do Asaas (conta da PROPRIA plataforma,
 * nao do tenant) e cobra cada tenant como uma subscription.
 *
 * Fluxo:
 *   1. Tenant abre /atendimento/billing
 *   2. Escolhe plano + forma de pagamento
 *   3. POST /billing/checkout: cria customer + subscription Asaas
 *   4. Retorna URL/QR pro primeiro pagamento
 *   5. Webhook confirma pagamento -> tenant.status='ACTIVE'
 *   6. Cron diario suspende tenants atrasados >5 dias
 */
import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AsaasClient } from '../payment-gateway/asaas/asaas-client';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private prisma: PrismaService,
    // Usa a conta Asaas DA PLATAFORMA (sem tenantId — config global)
    private asaas: AsaasClient,
  ) {}

  /** Lista planos disponiveis pra escolha do tenant. */
  async listPlans() {
    return this.prisma.saasPlan.findMany({
      where: { active: true },
      orderBy: { display_order: 'asc' },
    });
  }

  /** Retorna assinatura + uso do tenant pra UI mostrar no /billing. */
  async getSubscriptionForTenant(tenantId: string) {
    const sub = await this.prisma.saasSubscription.findUnique({
      where: { tenant_id: tenantId },
      include: { plan: true },
    });
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, status: true, trial_ends_at: true, cpf_cnpj: true, email: true, phone: true },
    });
    return { tenant, subscription: sub };
  }

  /**
   * Tenant escolhe plano + forma de pagamento. Cria customer + subscription
   * no Asaas (conta da plataforma).
   */
  async checkout(tenantId: string, body: {
    plan_slug: string;
    billing_type: 'PIX' | 'BOLETO' | 'CREDIT_CARD';
  }) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Tenant nao encontrado');
    if (!tenant.cpf_cnpj) {
      throw new BadRequestException('Cadastre o CPF/CNPJ do tenant antes de assinar');
    }
    if (!tenant.email) {
      throw new BadRequestException('Cadastre o email do tenant antes de assinar');
    }

    const plan = await this.prisma.saasPlan.findUnique({ where: { slug: body.plan_slug } });
    if (!plan || !plan.active) throw new BadRequestException('Plano invalido');

    // 1. Cria customer no Asaas (se ja nao existir pra esse tenant)
    let existing = await this.prisma.saasSubscription.findUnique({ where: { tenant_id: tenantId } });
    let asaasCustomerId = existing?.asaas_customer_id;
    if (!asaasCustomerId) {
      const customer = await this.asaas.createCustomer({
        name: tenant.name,
        cpfCnpj: tenant.cpf_cnpj,
        email: tenant.email,
        phone: tenant.phone || undefined,
        externalReference: `saas-tenant-${tenant.id}`,
      });
      asaasCustomerId = customer.id;
    }

    // 2. Cria subscription Asaas (mensalidade recorrente)
    const nextDue = new Date();
    nextDue.setDate(nextDue.getDate() + 1); // primeiro vencimento amanha
    const nextDueStr = nextDue.toISOString().slice(0, 10);
    const monthlyValue = Number(plan.price_monthly);
    const subscription = await this.createAsaasSubscription({
      customer: asaasCustomerId!,
      billingType: body.billing_type,
      value: monthlyValue,
      nextDueDate: nextDueStr,
      cycle: 'MONTHLY',
      description: `Mensalidade ${plan.name} - ${tenant.name}`,
      externalReference: `saas-sub-${tenant.id}`,
    });

    // 3. Persiste no banco
    const data = {
      tenant_id: tenantId,
      plan_id: plan.id,
      status: 'PENDING_PAYMENT',
      asaas_customer_id: asaasCustomerId!,
      asaas_subscription_id: subscription.id,
      next_charge_date: nextDue,
      billing_type: body.billing_type,
    };
    if (existing) {
      await this.prisma.saasSubscription.update({
        where: { tenant_id: tenantId },
        data,
      });
    } else {
      await this.prisma.saasSubscription.create({ data });
    }

    // 4. Atualiza plano do tenant
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { plan: plan.slug.toUpperCase() },
    });

    return {
      ok: true,
      subscription_id: subscription.id,
      next_due_date: nextDueStr,
      plan: plan.name,
      message: `Assinatura ${plan.name} criada. Aguardando pagamento.`,
    };
  }

  /**
   * Wrapper pro endpoint /subscriptions do Asaas (nao tem helper no
   * AsaasClient ainda — chama via fetch direto na URL do customer).
   */
  private async createAsaasSubscription(payload: {
    customer: string;
    billingType: string;
    value: number;
    nextDueDate: string;
    cycle: string;
    description?: string;
    externalReference?: string;
  }): Promise<any> {
    // AsaasClient nao expoe createSubscription, mas o endpoint eh
    // /subscriptions com mesmo header apikey. Vamos chamar via wrapper
    // do AsaasClient (privado) — temporariamente fazemos uma chamada
    // direta. Idealmente: adicionar AsaasClient.createSubscription().
    const config = await this.asaas.getConfig();
    const url = `${config.baseUrl}/subscriptions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: config.apiKey,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new BadRequestException(`Asaas /subscriptions ${res.status}: ${text}`);
    }
    return res.json();
  }

  /**
   * Processa evento de pagamento confirmado vindo do webhook Asaas.
   * Atualiza SaasSubscription + ativa o tenant.
   */
  async handlePaymentReceived(payment: any) {
    // O externalReference da subscription tem prefixo "saas-sub-<tenantId>"
    const subscriptionId = payment?.subscription || payment?.payment?.subscription;
    if (!subscriptionId) return; // nao eh cobranca de SaaS Subscription

    const sub = await this.prisma.saasSubscription.findFirst({
      where: { asaas_subscription_id: subscriptionId },
    });
    if (!sub) return;

    // Calcula proximo vencimento (+1 mes)
    const next = sub.next_charge_date ? new Date(sub.next_charge_date) : new Date();
    next.setMonth(next.getMonth() + 1);

    await this.prisma.saasSubscription.update({
      where: { id: sub.id },
      data: {
        status: 'ACTIVE',
        last_paid_at: new Date(),
        next_charge_date: next,
        current_charge_id: payment?.id || payment?.payment?.id,
      },
    });

    // Reativa o tenant se estiver suspenso ou trial
    await this.prisma.tenant.update({
      where: { id: sub.tenant_id },
      data: {
        status: 'ACTIVE',
        suspended_at: null,
        suspended_reason: null,
      },
    });

    this.logger.log(`[SAAS-BILLING] Pagamento confirmado: tenant ${sub.tenant_id}, sub ${sub.id}`);
  }

  /**
   * Cron diario as 9h. Verifica:
   *  1. Trials expirando hoje/proximos 3 dias — manda webhook ou email
   *  2. Subscriptions com next_charge_date > 5 dias atras — suspende tenant
   *  3. Trials expirados sem subscription — suspende
   */
  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async dailyBillingCheck() {
    const now = new Date();

    // 1. Tenants em trial que ja expiraram (sem subscription paga)
    const expiredTrials = await this.prisma.tenant.findMany({
      where: {
        status: 'TRIAL',
        trial_ends_at: { lt: now },
      },
      select: { id: true, name: true },
    });
    for (const t of expiredTrials) {
      const hasActiveSub = await this.prisma.saasSubscription.findFirst({
        where: { tenant_id: t.id, status: 'ACTIVE' },
      });
      if (hasActiveSub) continue;
      await this.prisma.tenant.update({
        where: { id: t.id },
        data: {
          status: 'SUSPENDED',
          suspended_at: now,
          suspended_reason: 'Período de avaliação expirado. Contrate um plano pra continuar.',
        },
      });
      this.logger.log(`[SAAS-BILLING] Trial expirado, suspendendo: ${t.name} (${t.id})`);
    }

    // 2. Subscriptions atrasadas mais de 5 dias
    const fiveDaysAgo = new Date(now);
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
    const overdueSubs = await this.prisma.saasSubscription.findMany({
      where: {
        status: { in: ['ACTIVE', 'PAST_DUE'] },
        next_charge_date: { lt: fiveDaysAgo },
      },
      include: { plan: true },
    });
    for (const s of overdueSubs) {
      await this.prisma.saasSubscription.update({
        where: { id: s.id },
        data: { status: 'PAST_DUE' },
      });
      await this.prisma.tenant.update({
        where: { id: s.tenant_id },
        data: {
          status: 'SUSPENDED',
          suspended_at: now,
          suspended_reason: `Pagamento da mensalidade ${s.plan.name} em atraso. Regularize pra continuar.`,
        },
      });
      this.logger.log(`[SAAS-BILLING] Inadimplente >5 dias, suspendendo: tenant ${s.tenant_id}`);
    }

    return {
      checked_at: now,
      expired_trials: expiredTrials.length,
      overdue_subs: overdueSubs.length,
    };
  }
}
