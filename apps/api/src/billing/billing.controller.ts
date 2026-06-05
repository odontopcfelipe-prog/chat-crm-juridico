/**
 * Onda 17.32.86 — SaaS Fase 3b: endpoints de billing do tenant.
 */
import { Controller, Get, Post, Body, Req, BadRequestException } from '@nestjs/common';
import { BillingService } from './billing.service';
import { Public } from '../auth/decorators/public.decorator';

@Controller('billing')
export class BillingController {
  constructor(private service: BillingService) {}

  /** Lista os planos disponiveis (publico — usado no signup tambem). */
  @Public()
  @Get('plans')
  listPlans() {
    return this.service.listPlans();
  }

  /** Subscription + uso do tenant logado. */
  @Get('me')
  async getMine(@Req() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.getSubscriptionForTenant(tenantId);
  }

  /** Checkout: tenant escolhe plano + forma de pagamento. */
  @Post('checkout')
  async checkout(@Req() req: any, @Body() body: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!body?.plan_slug || !body?.billing_type) {
      throw new BadRequestException('plan_slug e billing_type sao obrigatorios');
    }
    return this.service.checkout(tenantId, {
      plan_slug: body.plan_slug,
      billing_type: body.billing_type,
    });
  }

  /**
   * Webhook publico do Asaas pra confirmar pagamentos de SAAS
   * subscription. Verifica via externalReference se eh saas-sub-*.
   */
  @Public()
  @Post('webhook/asaas')
  async webhook(@Body() body: any) {
    const payment = body?.payment;
    if (!payment) return { ok: true, ignored: true };
    const event = body?.event;
    if (event === 'PAYMENT_CONFIRMED' || event === 'PAYMENT_RECEIVED') {
      await this.service.handlePaymentReceived(payment);
    }
    return { ok: true };
  }
}
