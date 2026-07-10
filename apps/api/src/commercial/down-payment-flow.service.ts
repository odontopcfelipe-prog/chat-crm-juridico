import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
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
    private moduleRef: ModuleRef,
  ) {}

  /**
   * HOOK 5 (Programa de Afiliado) — credita a comissão do afiliado quando a
   * Quote vira ACCEPTED pelo auto-aceite tardio (sinal pago). Best-effort +
   * idempotente por quote_id (a AffiliateService pula se já existe referral).
   * Sem isso, fechamento via Opção B (financiamento/sinal) não comissionava.
   */
  private recordAffiliateReferral(
    quoteId: string,
    patientId: string,
    treatmentValue: number,
    tenantId: string,
  ): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AffiliateService } = require('../patients/affiliate.service');
      const affiliateService = this.moduleRef.get(AffiliateService, { strict: false });
      if (affiliateService) {
        affiliateService
          .recordReferralFromAcceptedQuote({ quoteId, patientId, treatmentValue, tenantId })
          .catch((err: any) =>
            this.logger.warn(`[DOWN-PMT→AFFILIATE] Hook falhou (quote ${quoteId}): ${err?.message}`),
          );
      }
    } catch (e: any) {
      this.logger.warn(`[DOWN-PMT→AFFILIATE] AffiliateService indisponivel: ${e?.message}`);
    }
  }

  /**
   * Wrapper: aceita quoteId e resolve o treatment_plan_id correspondente.
   * Conveniencia pro frontend que trabalha com Quote nao com TreatmentPlan.
   *
   * Onda 15 (etapa 15) — ACEITE TARDIO: se a proposta ainda nao tem plano,
   * cria um plano TENTATIVO (sem mudar quote.status). A proposta so vira
   * ACCEPTED quando o pagamento do SINAL for confirmado pelo webhook do
   * Asaas (logica em handleChargePaid). Esse fluxo permite que o operador
   * emita o PIX antes de aceitar formalmente — o ato de pagar e o aceite.
   */
  async emitDownPaymentByQuote(
    quoteId: string,
    tenantId: string,
    options: Parameters<DownPaymentFlowService['emitDownPayment']>[2],
  ) {
    let plan = await this.prisma.treatmentPlan.findFirst({
      where: { quote_id: quoteId },
      select: { id: true },
    });

    if (!plan) {
      // Sem plano: cria tentativo. Quote NAO e marcada como ACCEPTED aqui —
      // o auto-aceite acontece em handleChargePaid quando o sinal for pago.
      const quote = await this.prisma.quote.findFirst({
        where: { id: quoteId },
        include: { items: true, patient: { select: { tenant_id: true } } },
      });
      if (!quote) {
        throw new NotFoundException('Orcamento nao encontrado');
      }
      if (quote.patient.tenant_id !== tenantId) {
        throw new ForbiddenException('Acesso negado');
      }
      if (!['DRAFT', 'SENT'].includes(quote.status)) {
        throw new BadRequestException(
          `Esta proposta esta em status ${quote.status}; so DRAFT/SENT podem ` +
          `gerar plano tentativo via emit (use Aprovar normalmente).`,
        );
      }
      plan = await this.prisma.treatmentPlan.create({
        data: {
          patient_id: quote.patient_id,
          quote_id: quoteId,
          // Status PENDING_SIGNATURE (mesmo que acceptQuote usa). Vira ACTIVE
          // quando handleChargePaid detectar sinal pago e aceitar a proposta.
          status: 'PENDING_SIGNATURE',
          total_value: quote.total_value,
          items: {
            create: quote.items.map((qi, idx) => ({
              procedure_id: qi.procedure_id,
              tooth_fdi: qi.tooth_fdi,
              quantity: qi.quantity,
              unit_price: qi.unit_price,
              total_price: qi.total_price,
              notes: qi.notes,
              order_index: idx,
            })),
          },
        },
        select: { id: true },
      });
      this.logger.log(
        `[DOWN-PMT] Plano TENTATIVO criado pra quote ${quoteId} (plan ${plan.id}). ` +
        `Quote segue como ${quote.status} ate o sinal ser pago.`,
      );
    }

    return this.emitDownPayment(plan.id, tenantId, options);
  }

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
      /** Onda 14.59.2 — quais partes emitir. Default: ambas.
       *  Permite operador emitir SO o sinal ou SO o restante (botoes
       *  individuais no frontend). Idempotente: se ja existe charge
       *  do mesmo kind, retorna existente sem recriar. */
      parts?: ('SIGNAL' | 'REST')[];
    },
  ) {
    const parts = options.parts ?? ['SIGNAL', 'REST'];
    const emitSignal = parts.includes('SIGNAL');
    const emitRest = parts.includes('REST');
    const plan = await this.prisma.treatmentPlan.findUnique({
      where: { id: planId },
      include: { patient: true },
    });
    if (!plan) throw new NotFoundException('Plano nao encontrado');
    if (plan.patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');

    // Onda 14.59.2 — Idempotencia POR PARTE. Em vez de bloquear a emissao
    // inteira se ja emitiu uma parte, busca quais kinds ja existem e
    // emite somente os pedidos QUE AINDA NAO existem.
    const existingByKind = await this.prisma.paymentGatewayCharge.findMany({
      where: { treatment_plan_id: planId, kind: { in: ['SINAL', 'ENTRADA'] } },
      orderBy: { created_at: 'asc' },
    });
    const hasSignal = existingByKind.some((c) => c.kind === 'SINAL');
    const hasEntrada = existingByKind.some((c) => c.kind === 'ENTRADA');

    if (options.signalValue < 0 || options.restValue < 0) {
      throw new BadRequestException('Valores nao podem ser negativos');
    }
    const shouldCreateSignal = emitSignal && options.signalValue > 0 && !hasSignal;
    const shouldCreateRest = emitRest && options.restValue > 0 && !hasEntrada;

    if (!shouldCreateSignal && !shouldCreateRest) {
      // Nada novo pra criar — retorna existentes
      this.logger.warn(`[DOWN-PMT] Plan ${planId} ja tem charges pra as partes pedidas, retornando existentes`);
      return { charges: existingByKind, idempotent: true };
    }

    if (shouldCreateRest && !options.restDueDate) {
      throw new BadRequestException('restDueDate obrigatorio quando restValue > 0');
    }

    // Atualiza plan: marca status awaiting + timestamp da primeira emissao (idempotente)
    await this.prisma.treatmentPlan.update({
      where: { id: planId },
      data: {
        proposal_status: 'AWAITING_DOWN_PAYMENT',
        ...(!plan.down_payment_emitted_at && { down_payment_emitted_at: new Date() }),
        ...(options.clicksignSendTiming !== undefined && {
          clicksign_send_timing: options.clicksignSendTiming,
        }),
      },
    });

    const today = new Date();
    // Onda 15 (etapa 16.4) — Helper pra parsear datas YYYY-MM-DD sem
    // shift de timezone. Veja comentario equivalente em
    // treatment-plan-billing.service.ts createFinancingCharges.
    const parseLocalDate = (s: string) => new Date(s + 'T12:00:00Z');
    const signalDue = options.signalDueDate ? parseLocalDate(options.signalDueDate) : today;
    const restDue = options.restDueDate ? parseLocalDate(options.restDueDate) : null;

    const created: any[] = [];

    // ─── SINAL ──────────────────────────────────────────
    if (shouldCreateSignal) {
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
    if (shouldCreateRest && restDue) {
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
    }, args.tenantId);

    // Onda 15 (etapa 14) — Pra PIX, buscar QR code + copia-cola NA HORA da
    // criacao (sem esperar o webhook do Asaas, que so dispara quando o
    // paciente abre o link). Assim o operador pode mostrar o QR direto no
    // modal da clinica, com cara profissional, sem precisar redirecionar
    // pra pagina hospedada do Asaas. Falha aqui NAO bloqueia o registro:
    // o invoice_url continua funcionando como fallback.
    let pixData: { encodedImage?: string; payload?: string } | null = null;
    if (args.method === 'PIX') {
      try {
        pixData = await this.asaas.getPixQrCode(asaasCharge.id, args.tenantId);
      } catch (err: any) {
        this.logger.warn(
          `[DOWN-PMT] Falha ao buscar QR PIX da charge ${asaasCharge.id}: ${err?.message || err}`,
        );
      }
    }

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
        pix_qr_code: pixData?.encodedImage || null,
        pix_copy_paste: pixData?.payload || null,
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
      select: { treatment_plan_id: true, kind: true, tenant_id: true },
    });
    if (!charge?.treatment_plan_id) return; // nao eh do fluxo down-payment
    if (charge.kind !== 'SINAL' && charge.kind !== 'ENTRADA') return; // installments nao disparam trigger

    // Onda 15 (etapa 15) — AUTO-ACEITE TARDIO: se o SINAL acabou de ser pago
    // e a quote vinculada ainda esta DRAFT/SENT (plano tentativo gerado pelo
    // emit-down-payment), aceita a proposta automaticamente + ativa o plano.
    // Idempotente: se quote ja for ACCEPTED, nao faz nada.
    if (charge.kind === 'SINAL') {
      const plan = await this.prisma.treatmentPlan.findUnique({
        where: { id: charge.treatment_plan_id },
        select: { id: true, quote_id: true, status: true },
      });
      if (plan?.quote_id) {
        const quote = await this.prisma.quote.findUnique({
          where: { id: plan.quote_id },
          select: {
            id: true,
            status: true,
            patient_id: true,
            total_value: true,
          },
        });
        if (quote && (quote.status === 'DRAFT' || quote.status === 'SENT')) {
          const now = new Date();
          await this.prisma.$transaction([
            this.prisma.quote.update({
              where: { id: quote.id },
              data: {
                status: 'ACCEPTED',
                accepted_at: now,
                // Se aceitando de DRAFT (sem sent_at), registra sent_at agora
                // pra manter audit trail consistente (mesma logica de acceptQuote).
                ...(quote.status === 'DRAFT' ? { sent_at: now } : {}),
              },
            }),
            this.prisma.treatmentPlan.update({
              where: { id: plan.id },
              data: { status: 'ACTIVE' },
            }),
          ]);
          this.logger.log(
            `[DOWN-PMT] Auto-aceite tardio: sinal pago → quote ${quote.id} ` +
            `${quote.status}→ACCEPTED + plan ${plan.id} ACTIVE.`,
          );
          // HOOK 5 — auto-aceite por sinal pago: credita o afiliado (Opção B).
          // tenant_id vem da charge (Quote não tem coluna própria de tenant).
          if (charge.tenant_id) {
            this.recordAffiliateReferral(
              quote.id,
              quote.patient_id,
              Number(quote.total_value),
              charge.tenant_id,
            );
          }
        }
      }
    }

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
   * Onda 14.59.2 — Emite parcelas manualmente (alternativa ao trigger automatico).
   * Pre-requisitos:
   *   - Plan deve existir
   *   - Todas charges de SINAL e ENTRADA devem estar pagas (RECEIVED/CONFIRMED ou
   *     received_in_cash=true). Sem essa garantia, recusa pra evitar gerar parcelas
   *     antes do cliente confirmar a entrada.
   *   - Idempotente: se installments_generated_at ja preenchido, retorna existentes.
   */
  async emitInstallmentsByQuote(
    quoteId: string,
    tenantId: string,
    options: {
      installmentCount: number;
      installmentValue: number;
      firstDueDate?: string; // default: hoje + 30 dias
    },
  ) {
    const plan = await this.prisma.treatmentPlan.findFirst({
      where: { quote_id: quoteId },
      include: { patient: true },
    });
    if (!plan) {
      throw new BadRequestException('Plano nao encontrado pra esta proposta.');
    }
    if (plan.patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');

    // Idempotencia
    if (plan.installments_generated_at) {
      this.logger.warn(`[INSTALLMENTS] Plan ${plan.id} ja gerou parcelas em ${plan.installments_generated_at}`);
      const existing = await this.prisma.paymentGatewayCharge.findMany({
        where: { treatment_plan_id: plan.id, kind: 'INSTALLMENT' },
        orderBy: { created_at: 'asc' },
      });
      return { charges: existing, idempotent: true };
    }

    // Verifica sinal+entrada todas pagas
    const downCharges = await this.prisma.paymentGatewayCharge.findMany({
      where: { treatment_plan_id: plan.id, kind: { in: ['SINAL', 'ENTRADA'] } },
    });
    const allPaid = downCharges.length > 0 && downCharges.every(
      (c) => c.status === 'RECEIVED' || c.status === 'CONFIRMED' || c.received_in_cash,
    );
    if (!allPaid) {
      throw new BadRequestException(
        'Nao eh possivel emitir parcelas: ainda ha cobrancas de sinal/entrada pendentes. ' +
        'Aguarde a confirmacao do pagamento (PIX/boleto via webhook) ou marque como recebida em especie.',
      );
    }

    if (options.installmentCount < 1 || options.installmentCount > 36) {
      throw new BadRequestException('installmentCount deve estar entre 1 e 36');
    }
    if (options.installmentValue <= 0) {
      throw new BadRequestException('installmentValue deve ser positivo');
    }

    // Onda 15 (etapa 16.4) — Veja parseLocalDate em emitDownPayment.
    const firstDue = options.firstDueDate
      ? new Date(options.firstDueDate + 'T12:00:00Z')
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    // Cria 1 charge no Asaas que vira N boletos (Asaas split automatico)
    const customer = await this.paymentGateway.ensureCustomerForPatient(plan.patient_id, tenantId);
    const total = options.installmentValue * options.installmentCount;
    const asaasCharge = await this.asaas.createCharge({
      customer: customer.external_id,
      billingType: 'BOLETO',
      value: total,
      dueDate: firstDue.toISOString().slice(0, 10),
      description: `Parcelas (${options.installmentCount}x) — ${plan.patient.name} [plan:${plan.id}]`,
      externalReference: plan.id,
      installmentCount: options.installmentCount,
      installmentValue: options.installmentValue,
    }, tenantId);

    const installmentsCharge = await this.prisma.paymentGatewayCharge.create({
      data: {
        tenant_id: tenantId,
        treatment_plan_id: plan.id,
        kind: 'INSTALLMENT',
        gateway: 'ASAAS',
        external_id: asaasCharge.id,
        customer_external_id: customer.external_id,
        billing_type: 'BOLETO',
        amount: total,
        due_date: firstDue,
        status: asaasCharge.status || 'PENDING',
        description: `Parcelas ${options.installmentCount}x R$ ${options.installmentValue} — ${plan.patient.name} [plan:${plan.id}]`,
        boleto_url: asaasCharge.bankSlipUrl || null,
        boleto_barcode: asaasCharge.nossoNumero || null,
        invoice_url: asaasCharge.invoiceUrl || null,
      },
    });

    await this.prisma.treatmentPlan.update({
      where: { id: plan.id },
      data: {
        installments_generated_at: new Date(),
        proposal_status: 'APPROVED',
      },
    });

    this.logger.log(
      `[INSTALLMENTS] Plan ${plan.id} parcelas geradas manualmente: ${options.installmentCount}x R$ ${options.installmentValue}`,
    );

    return { charges: [installmentsCharge], idempotent: false };
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
