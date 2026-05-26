import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentGatewayService } from '../payment-gateway/payment-gateway.service';
import { AsaasClient } from '../payment-gateway/asaas/asaas-client';

/**
 * Onda 14.59 — Fluxo de cobranca da ENTRADA com trigger automatico.
 *
 * Diferente de createFinancingCharges (que gera tudo de uma vez), este servico
 * implementa o fluxo orientado a confirmacao:
 *
 *   1. Operador clica "Emitir cobranca da entrada"
 *      -> emitDownPayment() cria 1-2 cobrancas (sinal e/ou entrada)
 *      -> proposal_status = AWAITING_DOWN_PAYMENT
 *      -> se PIX/BOLETO, gera no Asaas; se CASH, fica pendente pra marcar manual
 *
 *   2. Paciente paga (PIX/boleto) OU operador marca recebido em especie
 *      -> webhook Asaas OU markCashReceived() chama handleChargePaid(chargeId)
 *
 *   3. handleChargePaid verifica se TODAS as cobrancas de sinal+entrada
 *      daquele plan estao confirmadas
 *      -> se sim, dispara triggerDownPaymentConfirmed(planId)
 *
 *   4. triggerDownPaymentConfirmed (idempotente via installments_generated_at):
 *      -> gera as N parcelas no Asaas (kind=INSTALLMENT)
 *      -> proposal_status = APPROVED
 *      -> se clicksign_send_timing=AFTER, dispara ClickSign
 *      -> (futuro) WhatsApp + socket event
 *
 * Permissao pra emitir/marcar especie: ADMIN ou FINANCEIRO (checado no controller).
 */
@Injectable()
export class DownPaymentFlowService {
  private readonly logger = new Logger(DownPaymentFlowService.name);

  constructor(
    private prisma: PrismaService,
    private paymentGateway: PaymentGatewayService,
    private asaas: AsaasClient,
  ) {}

  /**
   * Passo 1: emite as cobrancas da entrada (sinal e/ou restante).
   *
   * Idempotencia: se plan ja tem down_payment_emitted_at preenchido, retorna
   * as charges existentes (nao re-emite). Pra re-emitir, operador precisa
   * cancelar manualmente as anteriores.
   */
  async emitDownPayment(
    planId: string,
    tenantId: string,
    options: {
      signalValue: number; // pode ser 0
      signalMethod: 'PIX' | 'BOLETO' | 'CASH';
      signalDueDate?: string; // default: hoje
      restValue: number; // pode ser 0
      restMethod: 'PIX' | 'BOLETO' | 'CASH';
      restDueDate?: string; // required se restValue > 0
      clicksignSendTiming?: 'BEFORE' | 'AFTER' | null;
    },
  ) {
    const plan = await this.prisma.treatmentPlan.findUnique({
      where: { id: planId },
      include: { patient: true },
    });
    if (!plan) throw new NotFoundException('Plano nao encontrado');
    if (plan.patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');

    // Idempotencia: se ja emitiu, retorna o que existe
    if (plan.down_payment_emitted_at) {
      this.logger.warn(`[DOWN-PMT] Plan ${planId} ja emitiu cobranca em ${plan.down_payment_emitted_at}, retornando existentes`);
      const existing = await this.prisma.paymentGatewayCharge.findMany({
        where: { treatment_plan_id: planId, kind: { in: ['SINAL', 'ENTRADA'] } },
        orderBy: { created_at: 'asc' },
      });
      return { charges: existing, idempotent: true };
    }

    if (options.signalValue < 0 || options.restValue < 0) {
      throw new BadRequestException('Valores nao podem ser negativos');
    }
    if (options.signalValue === 0 && options.restValue === 0) {
      throw new BadRequestException('Sem entrada — nao precisa emitir cobranca');
    }
    if (options.restValue > 0 && !options.restDueDate) {
      throw new BadRequestException('restDueDate obrigatorio quando restValue > 0');
    }

    // Salva timing do ClickSign no plan (se fornecido)
    await this.prisma.treatmentPlan.update({
      where: { id: planId },
      data: {
        proposal_status: 'AWAITING_DOWN_PAYMENT',
        down_payment_emitted_at: new Date(),
        ...(options.clicksignSendTiming !== undefined && {
          clicksign_send_timing: options.clicksignSendTiming,
        }),
      },
    });

    const today = new Date();
    const signalDue = options.signalDueDate ? new Date(options.signalDueDate) : today;
    const restDue = options.restDueDate ? new Date(options.restDueDate) : null;

    const created: any[] = [];

    // ─── SINAL ──────────────────────────────────────────
    if (options.signalValue > 0) {
      const signalCharge = await this.createCharge({
        planId,
        tenantId,
        patientName: plan.patient.name,
        kind: 'SINAL',
        value: options.signalValue,
        dueDate: signalDue,
        method: options.signalMethod,
      });
      created.push(signalCharge);
    }

    // ─── RESTANTE DA ENTRADA ────────────────────────────
    if (options.restValue > 0 && restDue) {
      const restCharge = await this.createCharge({
        planId,
        tenantId,
        patientName: plan.patient.name,
        kind: 'ENTRADA',
        value: options.restValue,
        dueDate: restDue,
        method: options.restMethod,
      });
      created.push(restCharge);
    }

    // TODO Onda 14.60: se clicksignSendTiming=BEFORE, disparar ClickSign aqui
    // (precisa ter ClicksignService injetado e endpoint generateContract pronto)

    this.logger.log(
      `[DOWN-PMT] Plan ${planId} emitiu ${created.length} cobrancas ` +
      `(sinal=R$${options.signalValue} ${options.signalMethod}, ` +
      `rest=R$${options.restValue} ${options.restMethod})`,
    );

    return { charges: created, idempotent: false };
  }

  /**
   * Helper interno: cria uma charge (PIX/BOLETO no Asaas, ou CASH so no DB).
   * Vincula ao plan via treatment_plan_id + kind pra trigger achar depois.
   */
  private async createCharge(args: {
    planId: string;
    tenantId: string;
    patientName: string;
    kind: 'SINAL' | 'ENTRADA';
    value: number;
    dueDate: Date;
    method: 'PIX' | 'BOLETO' | 'CASH';
  }) {
    const kindLabel = args.kind === 'SINAL' ? 'Sinal' : 'Entrada';
    const description = `${kindLabel} — ${args.patientName} [plan:${args.planId}]`;

    // CASH: nao chama Asaas, cria charge local com status PENDING
    // (operador marcara como received via markCashReceived endpoint)
    if (args.method === 'CASH') {
      return this.prisma.paymentGatewayCharge.create({
        data: {
          tenant_id: args.tenantId,
          treatment_plan_id: args.planId,
          kind: args.kind,
          gateway: 'CASH',
          // external_id eh @unique, gera placeholder sem conflito
          external_id: `cash-${args.planId}-${args.kind}-${Date.now()}`,
          customer_external_id: 'CASH', // nao aplicavel
          billing_type: 'CASH',
          amount: args.value,
          due_date: args.dueDate,
          status: 'PENDING',
          description,
        },
      });
    }

    // PIX/BOLETO: cria no Asaas (precisa do patient_id do plan)
    const plan = await this.prisma.treatmentPlan.findUnique({
      where: { id: args.planId },
      select: { patient_id: true },
    });
    if (!plan) throw new NotFoundException(`Plan ${args.planId} sumiu durante a emissao`);
    const customer = await this.paymentGateway.ensureCustomerForPatient(plan.patient_id, args.tenantId);
    const asaasCharge = await this.asaas.createCharge({
      customer: customer.external_id,
      billingType: args.method,
      value: args.value,
      dueDate: args.dueDate.toISOString().slice(0, 10),
      description,
      externalReference: args.planId,
    });

    return this.prisma.paymentGatewayCharge.create({
      data: {
        tenant_id: args.tenantId,
        treatment_plan_id: args.planId,
        kind: args.kind,
        gateway: 'ASAAS',
        external_id: asaasCharge.id,
        customer_external_id: customer.external_id,
        billing_type: args.method,
        amount: args.value,
        due_date: args.dueDate,
        status: asaasCharge.status || 'PENDING',
        description,
        boleto_url: asaasCharge.bankSlipUrl || null,
        boleto_barcode: asaasCharge.nossoNumero || null,
        invoice_url: asaasCharge.invoiceUrl || null,
      },
    });
  }

  /**
   * Passo 3: dispara quando uma charge eh confirmada (webhook ou cash).
   * Verifica se TODAS de SINAL+ENTRADA daquele plan estao pagas. Se sim,
   * chama triggerDownPaymentConfirmed pra gerar parcelas.
   */
  async handleChargePaid(chargeId: string) {
    const charge = await this.prisma.paymentGatewayCharge.findUnique({
      where: { id: chargeId },
      select: { treatment_plan_id: true, kind: true },
    });
    if (!charge?.treatment_plan_id) return; // nao eh do fluxo down-payment
    if (charge.kind !== 'SINAL' && charge.kind !== 'ENTRADA') return; // installments nao disparam trigger

    // Busca todas as charges de sinal+entrada do plan
    const downCharges = await this.prisma.paymentGatewayCharge.findMany({
      where: {
        treatment_plan_id: charge.treatment_plan_id,
        kind: { in: ['SINAL', 'ENTRADA'] },
      },
      select: { status: true, received_in_cash: true },
    });

    const allPaid = downCharges.every(
      (c) => c.status === 'RECEIVED' || c.status === 'CONFIRMED' || c.received_in_cash,
    );

    if (allPaid) {
      this.logger.log(`[DOWN-PMT] Plan ${charge.treatment_plan_id} — todas charges de entrada pagas, disparando trigger`);
      await this.triggerDownPaymentConfirmed(charge.treatment_plan_id);
    }
  }

  /**
   * Passo 4: entrada totalmente confirmada. Aprova proposta + gera parcelas.
   * Idempotente: se installments_generated_at preenchido, nao executa de novo.
   */
  async triggerDownPaymentConfirmed(planId: string) {
    const plan = await this.prisma.treatmentPlan.findUnique({
      where: { id: planId },
      include: { patient: true },
    });
    if (!plan) {
      this.logger.warn(`[DOWN-PMT] triggerDownPaymentConfirmed: plan ${planId} nao encontrado`);
      return;
    }

    if (plan.installments_generated_at) {
      this.logger.warn(`[DOWN-PMT] Plan ${planId} ja gerou parcelas em ${plan.installments_generated_at}, skip trigger`);
      return;
    }

    // Marca proposta como APROVADA + timestamp de geracao (idempotencia)
    await this.prisma.treatmentPlan.update({
      where: { id: planId },
      data: {
        proposal_status: 'APPROVED',
        installments_generated_at: new Date(),
      },
    });

    this.logger.log(`[DOWN-PMT] Plan ${planId} APROVADO. TODO: gerar parcelas + ClickSign + WhatsApp`);

    // TODO Onda 14.60:
    // - Gerar parcelas no Asaas (precisa dos params installmentCount + installmentValue
    //   salvos previamente no plan ou recebidos como params do emitDownPayment original)
    // - Se plan.clicksign_send_timing === 'AFTER', disparar ClickSign agora
    // - Mandar WhatsApp pro paciente "Pagamento confirmado!"
    // - Emit socket event 'down_payment_confirmed' pra UI atualizar
  }

  /**
   * Endpoint mark-cash-received: operador (admin/financeiro) marca uma charge
   * CASH como recebida. Equivale ao webhook do Asaas dizendo PAYMENT_RECEIVED.
   */
  async markCashReceived(chargeId: string, userId: string, tenantId: string) {
    const charge = await this.prisma.paymentGatewayCharge.findUnique({
      where: { id: chargeId },
    });
    if (!charge) throw new NotFoundException('Cobranca nao encontrada');
    if (charge.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    if (charge.gateway !== 'CASH') {
      throw new BadRequestException('Esta cobranca nao eh em especie (use o webhook do Asaas)');
    }
    if (charge.received_in_cash) {
      this.logger.warn(`[DOWN-PMT] Charge ${chargeId} ja foi marcada como recebida`);
      return charge;
    }

    const updated = await this.prisma.paymentGatewayCharge.update({
      where: { id: chargeId },
      data: {
        status: 'RECEIVED',
        received_in_cash: true,
        received_by_user_id: userId,
        received_at: new Date(),
        paid_at: new Date(),
      },
    });

    this.logger.log(`[DOWN-PMT] Charge ${chargeId} marcada como recebida em especie por user ${userId}`);

    // Dispara trigger (mesmo fluxo do webhook)
    await this.handleChargePaid(chargeId);

    return updated;
  }
}
