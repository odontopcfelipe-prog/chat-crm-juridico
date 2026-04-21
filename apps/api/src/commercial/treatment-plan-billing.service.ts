import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentGatewayService } from '../payment-gateway/payment-gateway.service';
import { AsaasClient } from '../payment-gateway/asaas/asaas-client';

@Injectable()
export class TreatmentPlanBillingService {
  private readonly logger = new Logger(TreatmentPlanBillingService.name);

  constructor(
    private prisma: PrismaService,
    private paymentGateway: PaymentGatewayService,
    private asaas: AsaasClient,
  ) {}

  /**
   * Cria cobranca parcelada no Asaas para o TreatmentPlan.
   *
   * - Garante customer no Asaas (cria se nao existir, reusa se ja vinculado ao lead)
   * - Cria charge com N parcelas (Asaas gera todas automaticamente)
   * - Persiste o registro local em paymentGatewayCharge
   *
   * Pre-condicoes:
   *   - Plano deve estar ACTIVE (assinado e ativado)
   *   - Paciente precisa ter CPF cadastrado
   *   - Plano nao pode ja ter cobranca gerada (idempotencia)
   */
  async createInstallmentCharges(
    planId: string,
    tenantId: string,
    options: {
      billingType: 'PIX' | 'BOLETO' | 'CREDIT_CARD';
      installmentCount: number;
      firstDueDate?: string; // ISO date — default: 7 dias
    },
  ) {
    const plan = await this.prisma.treatmentPlan.findUnique({
      where: { id: planId },
      include: { patient: true },
    });
    if (!plan) throw new NotFoundException('Plano nao encontrado');
    if (plan.patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');

    if (plan.status !== 'ACTIVE') {
      throw new BadRequestException(`Plano deve estar ACTIVE para gerar cobrancas (atual: ${plan.status})`);
    }

    if (options.installmentCount < 1 || options.installmentCount > 24) {
      throw new BadRequestException('installmentCount deve estar entre 1 e 24');
    }

    const totalValue = Number(plan.total_value);
    if (totalValue <= 0) {
      throw new BadRequestException('Plano com valor total zero — adicione procedimentos antes de cobrar');
    }

    // Idempotencia: nao cria 2x para o mesmo plano
    const existing = await this.prisma.paymentGatewayCharge.findFirst({
      where: { description: { contains: `plan:${planId}` } },
    });
    if (existing) {
      throw new BadRequestException('Plano ja possui cobranca gerada');
    }

    // Customer Asaas
    const customer = await this.paymentGateway.ensureCustomerForPatient(plan.patient.id, tenantId);

    const installmentValue = +(totalValue / options.installmentCount).toFixed(2);
    const dueDate = options.firstDueDate
      ? new Date(options.firstDueDate)
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // +7 dias
    const dueDateStr = dueDate.toISOString().slice(0, 10);

    const description = `Plano de tratamento odontológico — ${plan.patient.name} (${options.installmentCount}x) [plan:${planId}]`;

    const asaasCharge = await this.asaas.createCharge({
      customer: customer.external_id,
      billingType: options.billingType,
      value: totalValue,
      dueDate: dueDateStr,
      description,
      externalReference: planId,
      installmentCount: options.installmentCount,
      installmentValue,
    });

    this.logger.log(
      `[BILLING] Charge Asaas criada para plan ${planId}: ${asaasCharge.id} | ` +
      `${options.billingType} ${options.installmentCount}x R$ ${installmentValue} = R$ ${totalValue}`,
    );

    // PIX QR code (se aplicavel)
    let pixData: any = null;
    if (options.billingType === 'PIX' && asaasCharge.id) {
      try { pixData = await this.asaas.getPixQrCode(asaasCharge.id); }
      catch (e: any) { this.logger.warn(`[BILLING] Falha QR PIX: ${e.message}`); }
    }

    const charge = await this.prisma.paymentGatewayCharge.create({
      data: {
        tenant_id: tenantId,
        gateway: 'ASAAS',
        external_id: asaasCharge.id,
        customer_external_id: customer.external_id,
        billing_type: options.billingType,
        amount: totalValue,
        due_date: dueDate,
        status: asaasCharge.status || 'PENDING',
        description,
        pix_qr_code: pixData?.encodedImage || null,
        pix_copy_paste: pixData?.payload || null,
        pix_expiration_date: pixData?.expirationDate ? new Date(pixData.expirationDate) : null,
        boleto_url: asaasCharge.bankSlipUrl || null,
        boleto_barcode: asaasCharge.nossoNumero || null,
        invoice_url: asaasCharge.invoiceUrl || null,
      },
    });

    return {
      charge,
      installmentCount: options.installmentCount,
      installmentValue,
      totalValue,
      pix: pixData ? {
        qrCode: pixData.encodedImage,
        copyPaste: pixData.payload,
        expirationDate: pixData.expirationDate,
      } : null,
      boleto: asaasCharge.bankSlipUrl ? {
        url: asaasCharge.bankSlipUrl,
        barcode: asaasCharge.nossoNumero,
      } : null,
    };
  }

  /** Lista as charges geradas pra um plano. */
  async listCharges(planId: string, tenantId: string) {
    const plan = await this.prisma.treatmentPlan.findUnique({
      where: { id: planId },
      select: { patient: { select: { tenant_id: true } } },
    });
    if (!plan) throw new NotFoundException('Plano nao encontrado');
    if (plan.patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');

    return this.prisma.paymentGatewayCharge.findMany({
      where: {
        tenant_id: tenantId,
        description: { contains: `plan:${planId}` },
      },
      orderBy: { due_date: 'asc' },
    });
  }
}
