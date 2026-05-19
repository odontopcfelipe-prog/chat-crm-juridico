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

  /**
   * Onda 12.2 — Cria cobrancas pro Financiamento Banco PASSOS.
   *
   * Gera 2 charges no Asaas:
   *   1. ENTRADA — boleto unico com vencimento +3 dias (paciente paga upfront)
   *   2. PARCELADO — N boletos iguais com primeiro vencimento +33 dias
   *
   * Diferente de createInstallmentCharges (que faz N parcelas iguais), este
   * suporta entrada DIFERENTE + parcelas iguais, alinhado com a UX da
   * aba Propostas (20% entrada + Nx no Banco PASSOS).
   */
  async createFinancingCharges(
    planId: string,
    tenantId: string,
    options: {
      downPaymentValue: number;
      installmentCount: number;
      installmentValue: number;
      firstDueDate?: string;
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
    if (options.installmentCount < 1 || options.installmentCount > 36) {
      throw new BadRequestException('installmentCount deve estar entre 1 e 36');
    }
    if (options.downPaymentValue < 0) {
      throw new BadRequestException('Entrada nao pode ser negativa');
    }

    // Idempotencia
    const existing = await this.prisma.paymentGatewayCharge.findFirst({
      where: { description: { contains: `plan:${planId}` } },
    });
    if (existing) {
      throw new BadRequestException('Plano ja possui cobranca gerada');
    }

    const customer = await this.paymentGateway.ensureCustomerForPatient(plan.patient.id, tenantId);

    const baseDate = options.firstDueDate
      ? new Date(options.firstDueDate)
      : new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // entrada +3 dias
    const downPaymentDue = baseDate;
    const installmentsFirstDue = new Date(baseDate.getTime() + 30 * 24 * 60 * 60 * 1000); // +30 dias

    const created: any[] = [];

    // 1. ENTRADA — boleto unico
    if (options.downPaymentValue > 0) {
      const downAsaas = await this.asaas.createCharge({
        customer: customer.external_id,
        billingType: 'BOLETO',
        value: options.downPaymentValue,
        dueDate: downPaymentDue.toISOString().slice(0, 10),
        description: `Entrada Financiamento Banco PASSOS — ${plan.patient.name} [plan:${planId}]`,
        externalReference: planId,
      });
      this.logger.log(`[FINANCING] Entrada Asaas criada para plan ${planId}: ${downAsaas.id} | R$ ${options.downPaymentValue}`);

      const downCharge = await this.prisma.paymentGatewayCharge.create({
        data: {
          tenant_id: tenantId,
          gateway: 'ASAAS',
          external_id: downAsaas.id,
          customer_external_id: customer.external_id,
          billing_type: 'BOLETO',
          amount: options.downPaymentValue,
          due_date: downPaymentDue,
          status: downAsaas.status || 'PENDING',
          description: `Entrada (1/1) — ${plan.patient.name} [plan:${planId}]`,
          boleto_url: downAsaas.bankSlipUrl || null,
          boleto_barcode: downAsaas.nossoNumero || null,
          invoice_url: downAsaas.invoiceUrl || null,
        },
      });
      created.push({
        kind: 'entrada',
        charge: downCharge,
        boleto_url: downAsaas.bankSlipUrl,
        barcode: downAsaas.nossoNumero,
        due_date: downPaymentDue,
        amount: options.downPaymentValue,
      });
    }

    // 2. PARCELADO — Asaas cria N parcelas automaticamente
    const totalInstallments = options.installmentValue * options.installmentCount;
    const installmentsAsaas = await this.asaas.createCharge({
      customer: customer.external_id,
      billingType: 'BOLETO',
      value: totalInstallments,
      dueDate: installmentsFirstDue.toISOString().slice(0, 10),
      description: `Parcelado Financiamento Banco PASSOS — ${plan.patient.name} (${options.installmentCount}x) [plan:${planId}]`,
      externalReference: planId,
      installmentCount: options.installmentCount,
      installmentValue: options.installmentValue,
    });
    this.logger.log(
      `[FINANCING] Parcelado Asaas criado para plan ${planId}: ${installmentsAsaas.id} | ` +
      `${options.installmentCount}x R$ ${options.installmentValue} = R$ ${totalInstallments}`,
    );

    const installmentsCharge = await this.prisma.paymentGatewayCharge.create({
      data: {
        tenant_id: tenantId,
        gateway: 'ASAAS',
        external_id: installmentsAsaas.id,
        customer_external_id: customer.external_id,
        billing_type: 'BOLETO',
        amount: totalInstallments,
        due_date: installmentsFirstDue,
        status: installmentsAsaas.status || 'PENDING',
        description: `Parcelado (${options.installmentCount}x) — ${plan.patient.name} [plan:${planId}]`,
        boleto_url: installmentsAsaas.bankSlipUrl || null,
        boleto_barcode: installmentsAsaas.nossoNumero || null,
        invoice_url: installmentsAsaas.invoiceUrl || null,
      },
    });
    created.push({
      kind: 'parcelado',
      charge: installmentsCharge,
      boleto_url: installmentsAsaas.bankSlipUrl,
      barcode: installmentsAsaas.nossoNumero,
      due_date: installmentsFirstDue,
      amount: totalInstallments,
      installment_count: options.installmentCount,
      installment_value: options.installmentValue,
    });

    return {
      plan_id: planId,
      charges: created,
      total_financed:
        options.downPaymentValue + totalInstallments,
    };
  }

  /**
   * Onda 14.5 — Cria cobranca simples (1 charge) pro plano.
   *
   * Usado pelo fluxo "Aprovar e cobrar" do painel de Propostas. Cobre:
   *  - PIX (1x, gera QR code)
   *  - CREDIT_CARD (1x ou parcelado, link Asaas hosted)
   *  - BOLETO (1x a vista)
   *
   * Pra boleto parcelado COM entrada (Banco PASSOS), usar
   * createFinancingCharges em vez deste.
   */
  async createSimpleCharge(
    planId: string,
    tenantId: string,
    options: {
      billingType: 'PIX' | 'BOLETO' | 'CREDIT_CARD';
      value: number;
      installmentCount?: number; // so pra CREDIT_CARD
      firstDueDate?: string;
    },
  ) {
    const plan = await this.prisma.treatmentPlan.findUnique({
      where: { id: planId },
      include: { patient: true },
    });
    if (!plan) throw new NotFoundException('Plano nao encontrado');
    if (plan.patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    if (plan.status !== 'ACTIVE') {
      throw new BadRequestException(`Plano deve estar ACTIVE (atual: ${plan.status})`);
    }
    if (options.value <= 0) {
      throw new BadRequestException('Valor deve ser maior que zero');
    }

    // Onda 14.11 — Idempotencia melhorada:
    //  1) Ignora charges DELETED/REFUNDED (foram canceladas no Asaas e usuario
    //     quer gerar nova)
    //  2) Se ja existe charge ATIVA do MESMO billing_type → retorna existente
    //  3) Se ja existe charge ATIVA de OUTRO billing_type → erro claro
    //     (operador precisa cancelar a antiga no Asaas antes)
    const existingActive = await this.prisma.paymentGatewayCharge.findFirst({
      where: {
        description: { contains: `plan:${planId}` },
        status: { notIn: ['DELETED', 'REFUNDED', 'CANCELLED'] },
      },
      orderBy: { created_at: 'desc' },
    });
    if (existingActive) {
      const existingType = existingActive.billing_type;
      if (existingType === options.billingType) {
        this.logger.log(
          `[SIMPLE-CHARGE] Plan ${planId} ja tem cobranca ATIVA do mesmo tipo ` +
          `(${existingType}, ${existingActive.external_id}) — retornando existente`,
        );
        return {
          plan_id: planId,
          charge: existingActive,
          billing_type: existingActive.billing_type as 'PIX' | 'BOLETO' | 'CREDIT_CARD',
          installment_count: undefined,
          pix: existingActive.pix_qr_code
            ? {
                qrCode: existingActive.pix_qr_code,
                copyPaste: existingActive.pix_copy_paste || '',
                expirationDate: existingActive.pix_expiration_date?.toISOString() || '',
              }
            : null,
          boleto: existingActive.boleto_url
            ? { url: existingActive.boleto_url, barcode: existingActive.boleto_barcode }
            : null,
          invoice_url: existingActive.invoice_url,
          is_existing: true,
        };
      } else {
        // Tipo diferente — bloqueia com mensagem clara
        const typeLabels: Record<string, string> = {
          PIX: 'PIX',
          BOLETO: 'Boleto',
          CREDIT_CARD: 'Cartão',
        };
        throw new BadRequestException(
          `Já existe uma cobrança ${typeLabels[existingType] || existingType} ` +
          `ATIVA pra esse plano (status ${existingActive.status}). ` +
          `Pra gerar uma cobrança ${typeLabels[options.billingType]}, ` +
          `primeiro cancele a anterior no painel Asaas.`,
        );
      }
    }

    const customer = await this.paymentGateway.ensureCustomerForPatient(plan.patient.id, tenantId);

    const dueDate = options.firstDueDate
      ? new Date(options.firstDueDate)
      : new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

    const installmentCount = options.installmentCount && options.installmentCount > 1
      ? options.installmentCount
      : undefined;
    const installmentValue = installmentCount
      ? +(options.value / installmentCount).toFixed(2)
      : undefined;

    const descriptionParts = [
      `Plano de tratamento — ${plan.patient.name}`,
      installmentCount ? `(${installmentCount}x)` : '(à vista)',
      `[plan:${planId}]`,
    ];
    const description = descriptionParts.join(' ');

    const asaasCharge = await this.asaas.createCharge({
      customer: customer.external_id,
      billingType: options.billingType,
      value: options.value,
      dueDate: dueDate.toISOString().slice(0, 10),
      description,
      externalReference: planId,
      ...(installmentCount ? { installmentCount, installmentValue } : {}),
    });

    this.logger.log(
      `[SIMPLE-CHARGE] Plan ${planId}: ${options.billingType} ` +
      `${installmentCount ? `${installmentCount}x` : '1x'} R$ ${options.value}`,
    );

    // PIX QR code
    let pixData: any = null;
    if (options.billingType === 'PIX' && asaasCharge.id) {
      try { pixData = await this.asaas.getPixQrCode(asaasCharge.id); }
      catch (e: any) { this.logger.warn(`[SIMPLE-CHARGE] Falha QR PIX: ${e.message}`); }
    }

    const charge = await this.prisma.paymentGatewayCharge.create({
      data: {
        tenant_id: tenantId,
        gateway: 'ASAAS',
        external_id: asaasCharge.id,
        customer_external_id: customer.external_id,
        billing_type: options.billingType,
        amount: options.value,
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
      plan_id: planId,
      charge,
      billing_type: options.billingType,
      installment_count: installmentCount,
      pix: pixData ? {
        qrCode: pixData.encodedImage,
        copyPaste: pixData.payload,
        expirationDate: pixData.expirationDate,
      } : null,
      boleto: asaasCharge.bankSlipUrl ? {
        url: asaasCharge.bankSlipUrl,
        barcode: asaasCharge.nossoNumero,
      } : null,
      // Pra cartao: link hospedado pelo Asaas onde paciente preenche dados
      invoice_url: asaasCharge.invoiceUrl || null,
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
