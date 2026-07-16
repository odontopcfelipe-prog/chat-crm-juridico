import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import * as crypto from 'crypto';
import axios from 'axios';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { AsaasClient } from './asaas/asaas-client';
import { FinanceiroService } from '../financeiro/financeiro.service';
import { ChatGateway } from '../gateway/chat.gateway';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { EmailAutomationService } from '../email-automation/email-automation.service';
// Onda 14.53 — Resolvido via ModuleRef (strict:false) — LeadsService eh
// global no AppModule. Mesmo padrao de quotes.service.ts tryGraduateLead.
import { LeadsService } from '../leads/leads.service';
// Onda 18.x — CaixaService resolvido via ModuleRef (strict:false), sem dep de módulo
// (o caixa NÃO importa payment-gateway → sem ciclo). Usado só p/ garantir as contas
// padrão do caixa antes de amarrar a receita do split à conta CARTAO.
import { CaixaService } from '../caixa/caixa.service';

// Mapeamento de status Asaas → interno
const ASAAS_STATUS_MAP: Record<string, string> = {
  PENDING: 'PENDING',
  RECEIVED: 'RECEIVED',
  CONFIRMED: 'CONFIRMED',
  OVERDUE: 'OVERDUE',
  REFUNDED: 'REFUNDED',
  DELETED: 'DELETED',
  RECEIVED_IN_CASH: 'RECEIVED',
};

@Injectable()
export class PaymentGatewayService {
  private readonly logger = new Logger(PaymentGatewayService.name);

  constructor(
    private prisma: PrismaService,
    private asaas: AsaasClient,
    private whatsapp: WhatsappService,
    private financeiroService: FinanceiroService,
    private chatGateway: ChatGateway,
    // Onda 17.32.181 — e-mails automaticos (modulo @Global)
    private emailAutomation: EmailAutomationService,
    // Onda 14.53 — pra resolver LeadsService via { strict: false } sem
    // dependencia circular entre PaymentGatewayModule e LeadsModule.
    private moduleRef: ModuleRef,
  ) {}

  /**
   * Onda 17.41 — Recebimento na clínica (espécie / maquineta da clínica / PIX
   * da clínica), que NÃO usa o Asaas como processador real. Faz duas coisas:
   *
   *  1. Marca a cobrança local como recebida NA HORA (received_in_cash + status
   *     RECEIVED + paid_at). Antes isso dependia do webhook do Asaas voltar —
   *     se atrasasse/falhasse, a venda em dinheiro ficava presa em "a receber".
   *  2. Lança uma RECEITA no caixa (FinancialTransaction) vinculada à cobrança
   *     (transaction_id 1:1) → entra em Receitas / Resumo do Período / fechamento
   *     de caixa. O histórico no Asaas/ficha do paciente continua (a cobrança
   *     não é apagada).
   *
   * Idempotente: não duplica a RECEITA se a cobrança já tem transaction_id.
   * Online (PIX/Cartão Asaas) NÃO passa por aqui — segue só no mundo Asaas.
   */
  async registerClinicReceipt(
    externalId: string,
    opts?: {
      paymentMethod?: string;
      userId?: string;
      installments?: number;
      // Onda 18.x — split de 2+ formas na maquineta (2 cartões: parte no débito,
      // parte no crédito). Cada item vira UMA receita no caixa, todas amarradas à
      // MESMA venda (external_id). Se vazio/ausente, cai no fluxo normal de 1 receita.
      // `method` é a forma do CAIXA (CARTAO p/ débito E crédito — caixa tem 1 balde
      // "Maquininha (cartão)"); `debit` só refina a DESCRIÇÃO (Cartão débito/crédito).
      payments?: Array<{ method: string; value: number; installments?: number; debit?: boolean }>;
    },
  ) {
    const charge = await this.prisma.paymentGatewayCharge.findFirst({
      where: { external_id: externalId },
      select: { id: true, status: true, received_at: true, received_by_user_id: true, paid_at: true },
    });
    if (!charge) {
      this.logger.warn(`[clinic-receipt] cobrança local não encontrada p/ external ${externalId}`);
      return { ok: false, reason: 'charge_not_found' };
    }

    const now = new Date();
    // 1. Marca recebida na hora (independe do webhook do Asaas)
    const alreadyPaidStatus = charge.status === 'RECEIVED' || charge.status === 'CONFIRMED';
    await this.prisma.paymentGatewayCharge.update({
      where: { id: charge.id },
      data: {
        received_in_cash: true,
        received_at: charge.received_at ?? now,
        received_by_user_id: charge.received_by_user_id ?? opts?.userId ?? null,
        status: alreadyPaidStatus ? charge.status : 'RECEIVED',
        paid_at: charge.paid_at ?? now,
      },
    });

    // 2. Lança no caixa (RECEITA). Split (2 cartões na maquineta) => UMA receita
    // por forma; senão, o fluxo normal com o valor cheio numa forma só.
    const splits = (opts?.payments || []).filter((p) => p && p.value > 0);
    if (splits.length > 0) {
      const txId = await this.ensureChargeReceitaSplit(charge.id, splits);
      return { ok: true, transaction_id: txId, charge_id: charge.id, split: splits.length };
    }
    const txId = await this.ensureChargeReceita(charge.id, {
      paymentMethod: opts?.paymentMethod || 'DINHEIRO',
      receivedInClinic: true,
      installments: opts?.installments,
    });
    return { ok: true, transaction_id: txId, charge_id: charge.id };
  }

  /** Onda 17.41 — billing_type da cobrança → forma de pagamento do caixa. */
  private mapBillingToCaixaMethod(billingType: string | null): string {
    switch (billingType) {
      case 'CREDIT_CARD': return 'CARTAO';
      case 'BOLETO': return 'BOLETO';
      case 'PIX': return 'PIX';
      default: return 'PIX';
    }
  }

  /**
   * Onda 17.41 — "toda venda vira Receita": cria UMA VEZ o lançamento de RECEITA
   * no caixa (FinancialTransaction PAGO) pra uma cobrança recebida e vincula 1:1
   * (transaction_id). Idempotente — se a cobrança já tem transaction_id, não faz
   * nada. Reusado pelo recebimento na clínica (espécie/maquineta/PIX clínica) e
   * pelo webhook de pagamento confirmado (PIX/Cartão Asaas online).
   */
  private async ensureChargeReceita(
    chargeId: string,
    opts?: { paymentMethod?: string; receivedInClinic?: boolean; installments?: number },
  ): Promise<string | null> {
    const charge = await this.prisma.paymentGatewayCharge.findUnique({
      where: { id: chargeId },
      include: {
        treatment_plan: {
          select: {
            patient: { select: { name: true, lead_id: true } },
            quote: { select: { created_by_user_id: true } },
          },
        },
      },
    });
    if (!charge) return null;
    if (charge.transaction_id) return charge.transaction_id; // já lançado
    // Jurídico (LeadHonorarioPayment) tem caixa próprio — não duplica aqui.
    if (charge.lead_honorario_payment_id) return null;

    const now = new Date();
    const patientName = charge.treatment_plan?.patient?.name || 'Paciente';
    const method = opts?.paymentMethod || this.mapBillingToCaixaMethod(charge.billing_type);
    const inClinic = !!opts?.receivedInClinic;
    // Maquineta parcelada: só INFO (a adquirente faz o split; não gera cobrança).
    // Aparece como "Cartão N×" no caixa pra bater com o extrato depois.
    const parcelaSuffix =
      opts?.installments && opts.installments > 1 ? ` · Cartão ${opts.installments}×` : '';

    const tx = await this.prisma.financialTransaction.create({
      data: {
        tenant_id: charge.tenant_id,
        type: 'RECEITA',
        category: 'PROCEDIMENTO',
        description: `${inClinic ? 'Recebido na clínica' : 'Recebimento'} — ${patientName}${charge.description ? ` · ${charge.description}` : ''}${parcelaSuffix}`,
        amount: charge.amount,
        date: now,
        paid_at: charge.paid_at ?? now,
        payment_method: method,
        status: 'PAGO',
        dentist_id: charge.treatment_plan?.quote?.created_by_user_id ?? null,
        // CLIENTE na tela de Entradas: amarra a receita ao paciente (via Lead) — antes
        // o nome só ia na descrição e a coluna Cliente ficava "—".
        lead_id: charge.treatment_plan?.patient?.lead_id ?? null,
        reference_id: charge.external_id,
        notes: inClinic
          ? 'Venda/atendimento recebido na clínica (fechamento de caixa)'
          : 'Recebimento de cobrança (Asaas online)',
      },
    });
    await this.prisma.paymentGatewayCharge.update({
      where: { id: charge.id },
      data: { transaction_id: tx.id },
    });
    this.logger.log(
      `[caixa] RECEITA ${tx.id} (R$ ${charge.amount}, ${method}${inClinic ? ', clínica' : ''}) p/ cobrança ${charge.id}`,
    );
    // Onda 17.61 — paciente PAGOU → libera as comissões DEVIDA deste plano (trigger
    // ON_PAYMENT). Cobre clínica E Asaas (ambos passam por aqui). Best-effort.
    await this.releaseCommissionsForPlan(charge.tenant_id, charge.treatment_plan_id, now);
    return tx.id;
  }

  /**
   * Onda 18.x — variante de ensureChargeReceita p/ pagamento DIVIDIDO (ex.: 2
   * cartões na maquineta: parte no débito, parte no crédito parcelado). Cria UMA
   * RECEITA no caixa por forma (cada uma com o SEU valor), todas amarradas à mesma
   * venda via reference_id (external_id) — o fechamento concilia por forma. A
   * cobrança liga 1:1 à PRIMEIRA receita (idempotência via transaction_id).
   */
  private async ensureChargeReceitaSplit(
    chargeId: string,
    payments: Array<{ method: string; value: number; installments?: number; debit?: boolean }>,
  ): Promise<string | null> {
    const charge = await this.prisma.paymentGatewayCharge.findUnique({
      where: { id: chargeId },
      include: {
        treatment_plan: {
          select: {
            patient: { select: { name: true, lead_id: true } },
            quote: { select: { created_by_user_id: true } },
          },
        },
      },
    });
    if (!charge) return null;
    if (charge.transaction_id) return charge.transaction_id; // idempotente — já lançado
    if (charge.lead_honorario_payment_id) return null; // jurídico tem caixa próprio

    const now = new Date();
    const patientName = charge.treatment_plan?.patient?.name || 'Paciente';
    const dentistId = charge.treatment_plan?.quote?.created_by_user_id ?? null;
    const leadId = charge.treatment_plan?.patient?.lead_id ?? null; // p/ coluna Cliente em Entradas

    // As receitas do split precisam entrar no ESCOPO do caixa. A 1ª pegaria isso via
    // vínculo 1:1 com a cobrança (transaction_id); a 2ª NÃO — então amarramos TODAS à
    // conta física do CARTÃO (kind CARTAO). Sem isso o 2º cartão sumiria do fechamento
    // (caixaWhere exige account_id | cash_closing_id | gateway_charge).
    // Garante que as contas padrão do caixa existem (idempotente) — senão, num tenant
    // que ainda não abriu o caixa (contas são lazy), a 2ª receita do split ficaria fora
    // do fechamento por falta da conta CARTAO. Resolve o CaixaService via moduleRef.
    if (charge.tenant_id) {
      try {
        const caixa = this.moduleRef.get(CaixaService, { strict: false });
        await caixa?.ensureDefaultAccounts(charge.tenant_id);
      } catch (e: any) {
        this.logger.warn(`[caixa] ensureDefaultAccounts falhou: ${e?.message}`);
      }
    }
    const cardAccount = charge.tenant_id
      ? await this.prisma.cashAccount.findFirst({
          where: { tenant_id: charge.tenant_id, kind: 'CARTAO' },
          select: { id: true },
          orderBy: { active: 'desc' },
        })
      : null;
    if (!cardAccount) {
      this.logger.warn(`[caixa] sem conta CARTAO p/ tenant ${charge.tenant_id} — split pode não aparecer no fechamento`);
    }

    // Sanidade: a soma das formas deveria bater com o total da cobrança. Não
    // BLOQUEIA (registra o que realmente aconteceu na maquineta), mas loga o
    // desvio pra auditoria do caixa.
    const soma = payments.reduce((s, p) => s + (p.value || 0), 0);
    if (Math.abs(soma - Number(charge.amount)) > 0.02) {
      this.logger.warn(
        `[caixa] split não bate: soma R$${soma.toFixed(2)} ≠ cobrança R$${Number(charge.amount).toFixed(2)} (charge ${charge.id})`,
      );
    }

    const createdIds: string[] = [];
    for (const p of payments) {
      const parcelaSuffix = p.installments && p.installments > 1 ? ` ${p.installments}×` : '';
      const formaLabel = p.debit ? 'Cartão débito' : this.caixaMethodLabel(p.method);
      const tx = await this.prisma.financialTransaction.create({
        data: {
          tenant_id: charge.tenant_id,
          type: 'RECEITA',
          category: 'PROCEDIMENTO',
          description: `Recebido na clínica — ${patientName}${charge.description ? ` · ${charge.description}` : ''} · ${formaLabel}${parcelaSuffix}`,
          amount: p.value,
          date: now,
          paid_at: charge.paid_at ?? now,
          payment_method: p.method,
          status: 'PAGO',
          dentist_id: dentistId,
          lead_id: leadId,
          reference_id: charge.external_id,
          // Amarra à conta física do cartão → entra no escopo do caixa (senão a 2ª some).
          account_id: cardAccount?.id ?? null,
          notes: 'Venda recebida na clínica — 2 cartões na maquineta (fechamento de caixa)',
        },
      });
      createdIds.push(tx.id);
    }

    // Liga a cobrança à PRIMEIRA receita (1:1 primário + idempotência).
    await this.prisma.paymentGatewayCharge.update({
      where: { id: charge.id },
      data: { transaction_id: createdIds[0] ?? null },
    });
    this.logger.log(
      `[caixa] RECEITA SPLIT (${createdIds.length} formas: ${payments
        .map((p) => `${p.method} R$${p.value}`)
        .join(' + ')}) p/ cobrança ${charge.id}`,
    );
    // Paciente pagou → libera comissões DEVIDA (ON_PAYMENT). Uma vez só.
    await this.releaseCommissionsForPlan(charge.tenant_id, charge.treatment_plan_id, now);
    return createdIds[0] ?? null;
  }

  /** Onda 18.x — rótulo humano da forma de pagamento p/ descrição da receita. */
  private caixaMethodLabel(method: string): string {
    switch (method) {
      case 'CARTAO_DEBITO': return 'Cartão débito';
      case 'CARTAO': return 'Cartão crédito';
      case 'PIX': return 'PIX';
      case 'PIX_MAQUININHA': return 'PIX maquineta';
      case 'DINHEIRO': return 'Espécie';
      case 'BOLETO': return 'Boleto';
      default: return method;
    }
  }

  /**
   * Onda 17.61 — Libera (DEVIDA → DISPONIVEL) as comissões do plano cujo pagamento foi
   * recebido. Fechava o buraco crítico: comissões com trigger ON_PAYMENT (o padrão das
   * regras) nasciam DEVIDA e ficavam PRESAS pra sempre — não havia gancho de "paciente
   * pagou", então nunca chegavam à tela "A pagar".
   *
   * Libera na PRIMEIRA cobrança recebida do plano; quem já está DISPONIVEL/PAGA não é
   * tocado (só DEVIDA vira DISPONIVEL → idempotente em parcelamentos). O pagamento
   * efetivo ao profissional segue MANUAL (DISPONIVEL → PAGA), então a clínica mantém o
   * controle de quando de fato pagar. Best-effort: nunca derruba o lançamento da receita.
   */
  private async releaseCommissionsForPlan(tenantId: string | null, treatmentPlanId: string | null, now: Date) {
    if (!tenantId || !treatmentPlanId) return;
    try {
      // Onda 17.67 — libera por ITEM do plano (comissão de execução) E por QUOTE do
      // plano (comissão de VENDA, que não tem treatment_plan_item_id). Sem o segundo
      // ramo, a comissão de venda ficava presa em DEVIDA pra sempre.
      const plan = await this.prisma.treatmentPlan.findUnique({
        where: { id: treatmentPlanId },
        select: { quote_id: true },
      });
      const orConds: any[] = [{ treatment_plan_item: { treatment_plan_id: treatmentPlanId } }];
      if (plan?.quote_id) orConds.push({ quote_id: plan.quote_id });
      const pending = await this.prisma.commission.findMany({
        where: {
          tenant_id: tenantId,
          status: 'DEVIDA',
          OR: orConds,
        },
        select: { id: true },
      });
      if (pending.length === 0) return;
      const res = await this.prisma.commission.updateMany({
        where: { id: { in: pending.map((c) => c.id) } },
        data: { status: 'DISPONIVEL', available_at: now },
      });
      this.logger.log(
        `[Commission] ${res.count} comissao(oes) liberada(s) DEVIDA->DISPONIVEL (plano ${treatmentPlanId} pago)`,
      );
    } catch (e: any) {
      this.logger.warn(`[Commission] Falha ao liberar comissoes do plano ${treatmentPlanId}: ${e?.message ?? e}`);
    }
  }

  /**
   * Onda 14.13 — Busca parcelas filhas de uma charge parcelada no Asaas.
   *
   * Quando criamos charge com installmentCount > 1, o Asaas gera N cobrancas
   * filhas com um mesmo `installment` ID. Esse metodo busca:
   *  1. Status atualizado da charge mae (refresh do Asaas)
   *  2. Se charge eh parcelada (tem field `installment`), lista as filhas
   *
   * Retorna array vazio se charge nao for parcelada.
   */
  async getChargeSubInstallments(chargeId: string, tenantId: string) {
    const charge = await this.prisma.paymentGatewayCharge.findFirst({
      where: { id: chargeId, tenant_id: tenantId },
    });
    if (!charge) throw new NotFoundException('Cobranca nao encontrada');

    // Refresh do status no Asaas
    // Onda 17.32.83 — passa tenant_id pra usar settings do tenant
    let asaasCharge: any;
    try {
      asaasCharge = await this.asaas.getCharge(charge.external_id, charge.tenant_id);
    } catch (err: any) {
      this.logger.warn(`[SUB-INSTALLMENTS] Falha refresh charge ${charge.external_id}: ${err.message}`);
      return { parent_status: charge.status, sub_installments: [] };
    }

    if (!asaasCharge.installment) {
      // Nao parcelada — sem filhas
      return { parent_status: asaasCharge.status, sub_installments: [] };
    }

    // Busca todas as parcelas filhas via Asaas
    try {
      const list = await this.asaas.listCharges({
        installment: asaasCharge.installment,
        limit: 50,
      }, charge.tenant_id);
      let rows = list?.data || [];

      // Onda 15 (etapa 16.6) — A listagem do Asaas as vezes nao traz o
      // bankSlipUrl (boleto PDF) por padrao. Quando vier vazio, faz um
      // getCharge por filha pra puxar o boleto completo. Custa N chamadas
      // extras, mas garante a 2a via no Financeiro.
      const missingBoleto = rows.filter((c: any) => c.billingType === 'BOLETO' && !c.bankSlipUrl);
      if (missingBoleto.length > 0) {
        this.logger.log(
          `[SUB-INSTALLMENTS] ${missingBoleto.length}/${rows.length} filhas sem bankSlipUrl — ` +
          `buscando individualmente.`,
        );
        await Promise.all(
          missingBoleto.map(async (c: any) => {
            try {
              const detail = await this.asaas.getCharge(c.id, charge.tenant_id);
              c.bankSlipUrl = detail.bankSlipUrl || c.bankSlipUrl;
              c.invoiceUrl = detail.invoiceUrl || c.invoiceUrl;
              c.nossoNumero = detail.nossoNumero || c.nossoNumero;
            } catch (err: any) {
              this.logger.warn(`[SUB-INSTALLMENTS] Falha enriquecer charge ${c.id}: ${err?.message || err}`);
            }
          }),
        );
      }

      const items = rows.map((c: any) => ({
        external_id: c.id,
        installment_number: c.installmentNumber,
        value: c.value,
        net_value: c.netValue,
        due_date: c.dueDate,
        status: c.status,
        boleto_url: c.bankSlipUrl,
        invoice_url: c.invoiceUrl,
        payment_date: c.paymentDate,
      }));
      // Ordena por installmentNumber asc
      items.sort((a: any, b: any) => (a.installment_number || 0) - (b.installment_number || 0));
      return {
        parent_status: asaasCharge.status,
        sub_installments: items,
      };
    } catch (err: any) {
      this.logger.warn(`[SUB-INSTALLMENTS] Falha listar filhas: ${err.message}`);
      return { parent_status: asaasCharge.status, sub_installments: [] };
    }
  }

  /**
   * Onda 14.9 — Lista TODAS as cobrancas Asaas vinculadas a um paciente.
   *
   * Liga via PaymentGatewayCustomer.lead_id → Patient.lead_id. Inclui:
   *  - Charges do plano (description: 'plan:{planId}' via approveAndBill)
   *  - Charges de Installment (parcelas)
   *  - Charges de honorario do lead
   *
   * Usado pelo FinanceiroTab pra mostrar cobrancas geradas + status atualizado
   * (atualizado em tempo real pelo webhook Asaas).
   */
  /**
   * Onda 14.52 — Reenvia o link de pagamento (PIX/boleto/cartao) pro paciente
   * via WhatsApp. Usado pelo botao "Reenviar" no card de proposta aceita
   * dentro da aba Financeiro.
   *
   * Fluxo:
   *  1. Busca charge no banco
   *  2. Resolve customer → lead → patient
   *  3. Resolve Instance WhatsApp do tenant (com fallback automatico se 404)
   *  4. Monta mensagem com link/QR/codigo barras conforme billing_type
   *  5. Envia via Evolution API
   *  6. Salva mensagem na conversa pra ficar no historico do chat
   */
  async resendChargeWhatsapp(chargeId: string, tenantId: string) {
    // 1. Charge
    const charge = await this.prisma.paymentGatewayCharge.findFirst({
      where: { id: chargeId, tenant_id: tenantId },
    });
    if (!charge) throw new NotFoundException('Cobranca nao encontrada');

    // 2. Customer → Lead → Patient
    const customer = await this.prisma.paymentGatewayCustomer.findFirst({
      where: { external_id: charge.customer_external_id, gateway: 'ASAAS' },
      include: {
        lead: {
          select: { id: true, name: true, phone: true },
        },
      },
    });
    if (!customer?.lead) {
      throw new BadRequestException('Cliente nao vinculado a lead — atualize o cadastro');
    }
    const lead = customer.lead;
    // Patient (preferencial) — tem nome melhor que lead
    const patient = await this.prisma.patient.findFirst({
      where: { lead_id: lead.id, tenant_id: tenantId },
      select: { id: true, name: true, phone: true },
    });
    const rawPhone = patient?.phone || lead.phone;
    const displayName = patient?.name || lead.name || 'Olá';
    if (!rawPhone) {
      throw new BadRequestException('Paciente sem telefone cadastrado');
    }
    // Onda 14.59.3 — Normaliza pra E.164 BR: garante que o numero tem `55`
    // (codigo do Brasil) na frente antes de mandar pra Evolution API. Sem
    // isso, ela valida `82996578143@s.whatsapp.net` (sem 55) e retorna
    // "exists":false mesmo com o whatsapp existindo em `5582996578143`.
    const digits = rawPhone.replace(/\D/g, '');
    let phone: string;
    if (digits.startsWith('55') && digits.length >= 12) {
      phone = digits; // ja tem codigo BR
    } else if (digits.length === 10 || digits.length === 11) {
      phone = `55${digits}`; // DDD+numero sem codigo
    } else {
      phone = digits; // internacional ou formato fora do padrao — manda como esta
    }
    this.logger.log(`[RESEND] Normalizou phone: "${rawPhone}" -> "${phone}"`);

    // 3. Instances do tenant — Onda 18.7: cobranca sai pelo chip FINANCEIRO
    // primeiro (fallback: CLINICA -> demais). Ordena as instancias pra o loop
    // de envio abaixo tentar o Financeiro antes do resto.
    const allInstances = await this.prisma.instance.findMany({
      where: { tenant_id: tenantId, type: 'whatsapp' },
      orderBy: { created_at: 'desc' },
      select: { name: true, purpose: true },
    });
    const purposeRank = (p: string | null) =>
      p === 'FINANCEIRO' ? 0 : p === 'CLINICA' ? 1 : 2;
    const instances = [...allInstances].sort(
      (a, b) => purposeRank(a.purpose) - purposeRank(b.purpose),
    );
    if (instances.length === 0) {
      throw new BadRequestException(
        'Nenhuma instancia WhatsApp configurada pra esta clinica. Configure em Configuracoes › WhatsApp.',
      );
    }

    // 4. Monta mensagem por tipo
    const valor = Number(charge.amount).toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    });
    const due = new Date(charge.due_date).toLocaleDateString('pt-BR');
    const firstName = displayName.split(' ')[0];

    let msg: string;
    if (charge.billing_type === 'PIX') {
      msg =
        `Oi ${firstName}! 👋\n\n` +
        `Lembrando do seu pagamento via *PIX* de *${valor}*.\n` +
        `📅 Vencimento: ${due}\n\n`;
      if (charge.invoice_url) {
        msg += `🔗 Link de pagamento:\n${charge.invoice_url}\n\n`;
      }
      if (charge.pix_copy_paste) {
        msg += `📋 PIX Copia e Cola:\n\`\`\`${charge.pix_copy_paste}\`\`\`\n\n`;
      }
      msg += `Qualquer dúvida, é só responder por aqui. 😊`;
    } else if (charge.billing_type === 'BOLETO') {
      msg =
        `Oi ${firstName}! 👋\n\n` +
        `Lembrando do seu *boleto* de *${valor}*.\n` +
        `📅 Vencimento: ${due}\n\n`;
      if (charge.boleto_url || charge.invoice_url) {
        msg += `🔗 Acesse o boleto:\n${charge.boleto_url || charge.invoice_url}\n\n`;
      }
      if (charge.boleto_barcode) {
        msg += `📋 Código de barras:\n\`\`\`${charge.boleto_barcode}\`\`\`\n\n`;
      }
      msg += `Qualquer dúvida, é só responder. 😊`;
    } else if (charge.billing_type === 'CREDIT_CARD') {
      msg =
        `Oi ${firstName}! 👋\n\n` +
        `Lembrando do pagamento de *${valor}* no *cartão*.\n` +
        `📅 Vencimento: ${due}\n\n`;
      if (charge.invoice_url) {
        msg += `💳 Link pra pagar:\n${charge.invoice_url}\n\n`;
      }
      msg += `Qualquer dúvida, estamos por aqui. 😊`;
    } else {
      msg =
        `Oi ${firstName}! 👋\n\n` +
        `Lembrando do seu pagamento de *${valor}*.\n` +
        `📅 Vencimento: ${due}\n\n`;
      if (charge.invoice_url) {
        msg += `🔗 Link:\n${charge.invoice_url}\n\n`;
      }
    }

    // 5. Envia com fallback entre instances
    const sendErrors: string[] = [];
    let usedInstance: string | null = null;
    let sendResult: any = null;
    // Boleto com PDF disponível → manda o PDF anexo (texto vira legenda); PIX/
    // cartão/sem-boleto seguem como texto+link.
    const asBoletoPdf = charge.billing_type === 'BOLETO' && !!charge.boleto_url;
    for (const inst of instances) {
      try {
        const result: any = asBoletoPdf
          ? await this.whatsapp.sendMedia(phone, 'document', charge.boleto_url as string, msg, inst.name, 'boleto.pdf', 'application/pdf')
          : await this.whatsapp.sendText(phone, msg, inst.name);
        const httpStatus = result?.statusCode ?? 0;
        // Evolution responde 200 com "exists":false quando o número NÃO está no
        // WhatsApp — sem isto, o resend dava "enviado" e nada chegava (falso-sucesso).
        const existsFalse = (() => {
          try { return /"exists"\s*:\s*false/.test(JSON.stringify(result)); } catch { return false; }
        })();
        const isOk =
          result && (!result.statusCode || result.statusCode < 400) && !result.error && !existsFalse;
        if (isOk) {
          usedInstance = inst.name;
          sendResult = result;
          break;
        }
        if (httpStatus === 404) {
          sendErrors.push(`"${inst.name}": 404`);
          continue;
        }
        sendErrors.push(`"${inst.name}": ${result?.error || `HTTP ${httpStatus}`}`);
        break; // erro nao-404 — para
      } catch (e: any) {
        sendErrors.push(`"${inst.name}": ${e.message}`);
      }
    }

    if (!usedInstance) {
      throw new BadRequestException(
        `Falha ao reenviar pelo WhatsApp: ${sendErrors.join('; ')}`,
      );
    }
    this.logger.log(
      `[RESEND] Cobranca ${chargeId} (${charge.billing_type}) reenviada via "${usedInstance}" pra ${phone}`,
    );

    // 6. Salva mensagem na conversa (historico do chat) — best-effort.
    // Onda 18.32 — na conversa PRÓPRIA do Financeiro (find-or-create); fallback
    // pra última conversa se o tenant não tem inbox Financeiro.
    try {
      const convo =
        (await this.findOrCreateFinanceiroConversation(lead.id, tenantId, lead.phone)) ??
        (await this.prisma.conversation.findFirst({
          where: { lead_id: lead.id, status: { not: 'ENCERRADO' } },
          orderBy: { last_message_at: 'desc' },
          select: { id: true },
        }));
      if (convo) {
        const evolutionMsgId =
          sendResult?.data?.key?.id || sendResult?.key?.id || `sys_resend_${Date.now()}`;
        await this.prisma.message.create({
          data: {
            conversation_id: convo.id,
            direction: 'out',
            type: 'text',
            text: msg,
            external_message_id: evolutionMsgId,
            status: 'enviado',
          },
        });
        await this.prisma.conversation.update({
          where: { id: convo.id },
          data: { last_message_at: new Date() },
        });
      }
    } catch (e: any) {
      this.logger.warn(`[RESEND] Falha ao salvar mensagem no historico: ${e.message}`);
    }

    return { ok: true, instance: usedInstance, billing_type: charge.billing_type };
  }

  async getChargesByPatient(patientId: string, tenantId: string) {
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { lead_id: true, tenant_id: true },
    });
    if (!patient) throw new NotFoundException('Paciente nao encontrado');
    if (patient.tenant_id !== tenantId) throw new BadRequestException('Acesso negado');
    if (!patient.lead_id) return [];

    const customer = await this.prisma.paymentGatewayCustomer.findFirst({
      where: { lead_id: patient.lead_id, gateway: 'ASAAS' },
    });
    if (!customer) return [];

    return this.prisma.paymentGatewayCharge.findMany({
      where: {
        tenant_id: tenantId,
        customer_external_id: customer.external_id,
      },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
  }

  // ─── Customer sync ─────────────────────────────────────

  /** Variante para Patient (Fase 4 — odontologia). CPF vem do proprio Patient. */
  async ensureCustomerForPatient(patientId: string, tenantId: string) {
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: {
        id: true, name: true, phone: true, email: true, cpf: true,
        tenant_id: true, lead_id: true,
      },
    });
    if (!patient) throw new NotFoundException('Paciente nao encontrado');
    if (patient.tenant_id !== tenantId) throw new BadRequestException('Acesso negado');
    if (!patient.cpf) {
      throw new BadRequestException('Paciente sem CPF — cadastre antes de gerar cobranca');
    }
    if (!patient.lead_id) {
      throw new BadRequestException(
        'Paciente nao vinculado a Lead — necessario para gerar cobranca via Asaas',
      );
    }

    // Reusa customer existente do mesmo Lead, se houver — MAS valida que ele
    // ainda existe no ambiente atual do Asaas. Onda 18.4 (BUG "invalid_customer"):
    // ao trocar sandbox->producao (ou vice-versa), o external_id salvo aponta
    // pra um customer que so existe no ambiente ANTIGO. O Asaas entao recusa a
    // cobranca com 400 "invalid_customer: Customer invalido ou nao informado".
    // Aqui a gente revalida e, se o Asaas confirmar 404 (nao existe), recria no
    // ambiente atual e ATUALIZA o registro (respeitando a unique).
    const existing = await this.prisma.paymentGatewayCustomer.findFirst({
      where: { lead_id: patient.lead_id, gateway: 'ASAAS' },
    });
    if (existing) {
      try {
        await this.asaas.getCustomer(existing.external_id, tenantId);
        return existing; // valido no ambiente atual — reusa
      } catch (e: any) {
        const msg = String(e?.message || '');
        // So recria se o Asaas CONFIRMOU que nao existe (404). Erro
        // transitorio/rede/5xx a gente propaga — nao mascara nem cria duplicado.
        if (!msg.includes('[Asaas 404]')) throw e;
        this.logger.warn(
          `[CUSTOMER] external_id ${existing.external_id} nao existe no Asaas atual (404) — recriando p/ paciente ${patientId}`,
        );
      }
    }

    const asaasCustomer = await this.asaas.createCustomer({
      name: patient.name,
      cpfCnpj: patient.cpf,
      email: patient.email || undefined,
      phone: patient.phone || undefined,
      externalReference: patient.id,
    }, tenantId);
    this.logger.log(`[CUSTOMER] Criado no Asaas para paciente ${patientId}: ${asaasCustomer.id}`);

    // Se ja existia um registro (invalido no ambiente atual), ATUALIZA o
    // external_id em vez de criar outro — senao viola a unique
    // [tenant_id, lead_id, gateway].
    if (existing) {
      return this.prisma.paymentGatewayCustomer.update({
        where: { id: existing.id },
        data: {
          external_id: asaasCustomer.id,
          cpf_cnpj: patient.cpf,
          sync_status: 'SYNCED',
          last_synced_at: new Date(),
        },
      });
    }

    return this.prisma.paymentGatewayCustomer.create({
      data: {
        tenant_id: tenantId,
        lead_id: patient.lead_id,
        gateway: 'ASAAS',
        external_id: asaasCustomer.id,
        cpf_cnpj: patient.cpf,
        sync_status: 'SYNCED',
        last_synced_at: new Date(),
      },
    });
  }

  async ensureCustomer(leadId: string, tenantId?: string) {
    // Verificar se ja existe registro local
    const existing = await this.prisma.paymentGatewayCustomer.findFirst({
      where: {
        lead_id: leadId,
        gateway: 'ASAAS',
        ...(tenantId ? { tenant_id: tenantId } : {}),
      },
    });

    if (existing) {
      // Onda 18.4 — valida no ambiente atual do Asaas antes de reusar (mesmo bug
      // do sandbox->producao: o external_id salvo pode nao existir no ambiente
      // atual -> "invalid_customer" na cobranca). Recria so em 404 confirmado.
      try {
        await this.asaas.getCustomer(existing.external_id, tenantId);
        this.logger.debug(`[CUSTOMER] Lead ${leadId} ja tem customer Asaas: ${existing.external_id}`);
        return existing;
      } catch (e: any) {
        const msg = String(e?.message || '');
        if (!msg.includes('[Asaas 404]')) throw e;
        this.logger.warn(`[CUSTOMER] external_id ${existing.external_id} nao existe no Asaas atual (404) — recriando p/ lead ${leadId}`);
      }
    }

    // Buscar dados do lead
    // STUBBED: FichaTrabalhista removida Fase 0.2
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        cpf_cnpj: true,
        tenant_id: true,
      },
    });

    if (!lead) throw new NotFoundException('Lead nao encontrado');

    // STUBBED: fallback via ficha trabalhista removido
    const cpfCnpj = lead.cpf_cnpj || null;

    if (!cpfCnpj) {
      throw new BadRequestException(
        'Lead não possui CPF/CNPJ cadastrado. Preencha o CPF no painel do lead antes de gerar cobrança.',
      );
    }

    // Criar customer no Asaas
    // Onda 17.32.83 — tenantId vem do escopo do metodo (ensureCustomer)
    const asaasCustomer = await this.asaas.createCustomer({
      name: lead.name || 'Sem nome',
      cpfCnpj,
      email: lead.email || undefined,
      phone: lead.phone || undefined,
      externalReference: lead.id,
    }, tenantId);

    this.logger.log(
      `[CUSTOMER] Criado no Asaas: ${asaasCustomer.id} para lead ${leadId}`,
    );

    // Salvar localmente — se ja existia um registro (invalido no ambiente atual),
    // ATUALIZA o external_id; senao cria (respeita a unique [tenant, lead, gateway]).
    const customer = existing
      ? await this.prisma.paymentGatewayCustomer.update({
          where: { id: existing.id },
          data: {
            external_id: asaasCustomer.id,
            cpf_cnpj: cpfCnpj,
            sync_status: 'SYNCED',
            last_synced_at: new Date(),
          },
        })
      : await this.prisma.paymentGatewayCustomer.create({
          data: {
            tenant_id: tenantId || lead.tenant_id,
            lead_id: leadId,
            gateway: 'ASAAS',
            external_id: asaasCustomer.id,
            cpf_cnpj: cpfCnpj,
            sync_status: 'SYNCED',
            last_synced_at: new Date(),
          },
        });

    return customer;
  }

  // ─── Charge creation ───────────────────────────────────

  async createCharge(
    honorarioPaymentId: string,
    _billingType: 'PIX' | 'BOLETO' | 'CREDIT_CARD',
    _tenantId?: string,
  ) {
    // STUBBED: HonorarioPayment/CaseHonorario/LegalCase removidos Fase 0.2
    // Método preservado apenas para compat de assinatura.
    this.logger.warn(`[STUB] createCharge chamado com ${honorarioPaymentId} — no-op Fase 0.2`);
    throw new BadRequestException('Cobrança de honorário jurídico desativada (Fase 0.2 — migração odontológica)');
  }

  // ─── Cobrança para LeadHonorarioPayment ─────────────────

  async createChargeForLeadPayment(
    leadHonorarioPaymentId: string,
    billingType: 'PIX' | 'BOLETO' | 'CREDIT_CARD',
    tenantId?: string,
  ) {
    const existingCharge = await this.prisma.paymentGatewayCharge.findUnique({
      where: { lead_honorario_payment_id: leadHonorarioPaymentId },
    });
    if (existingCharge) {
      this.logger.warn(`[CHARGE] Ja existe cobranca para lead payment ${leadHonorarioPaymentId}: ${existingCharge.external_id}`);
      return existingCharge;
    }

    const payment = await this.prisma.leadHonorarioPayment.findUnique({
      where: { id: leadHonorarioPaymentId },
      include: {
        lead_honorario: {
          include: {
            lead: { select: { id: true, name: true, phone: true, email: true } },
          },
        },
      },
    });

    if (!payment) throw new NotFoundException('Pagamento de honorário negociado não encontrado');

    const lead = (payment as any).lead_honorario?.lead;
    if (!lead?.id) throw new BadRequestException('Honorário negociado não possui lead vinculado');

    const honTenant = (payment as any).lead_honorario?.tenant_id;
    const customer = await this.ensureCustomer(lead.id, tenantId || honTenant);

    const dueDate = payment.due_date ? new Date(payment.due_date) : new Date();
    const dueDateStr = dueDate.toISOString().slice(0, 10);
    const honType = (payment as any).lead_honorario?.type || '';
    const typeLabels: Record<string, string> = { CONTRATUAL: 'Contratuais', ENTRADA: 'Entrada', ACORDO: 'Acordo' };

    const effectiveTenantId = tenantId || honTenant;
    const asaasCharge = await this.asaas.createCharge({
      customer: customer.external_id,
      billingType,
      value: Number(payment.amount),
      dueDate: dueDateStr,
      description: `Honorário ${typeLabels[honType] || honType} - Lead ${lead.name || 'Sem nome'}`.trim(),
      externalReference: leadHonorarioPaymentId,
    }, effectiveTenantId);

    this.logger.log(`[CHARGE] Criada para lead: ${asaasCharge.id} | ${billingType} | R$ ${Number(payment.amount)} | Venc: ${dueDateStr}`);

    let pixData: any = null;
    if (billingType === 'PIX' && asaasCharge.id) {
      try { pixData = await this.asaas.getPixQrCode(asaasCharge.id, effectiveTenantId); }
      catch (e: any) { this.logger.warn(`[CHARGE] Falha QR Code PIX: ${e.message}`); }
    }

    const charge = await this.prisma.paymentGatewayCharge.create({
      data: {
        tenant_id: tenantId || honTenant || null,
        lead_honorario_payment_id: leadHonorarioPaymentId,
        gateway: 'ASAAS',
        external_id: asaasCharge.id,
        customer_external_id: customer.external_id,
        billing_type: billingType,
        amount: Number(payment.amount),
        due_date: dueDate,
        status: asaasCharge.status || 'PENDING',
        description: asaasCharge.description || null,
        pix_qr_code: pixData?.encodedImage || null,
        pix_copy_paste: pixData?.payload || null,
        pix_expiration_date: pixData?.expirationDate ? new Date(pixData.expirationDate) : null,
        boleto_url: asaasCharge.bankSlipUrl || null,
        boleto_barcode: asaasCharge.nossoNumero || null,
        invoice_url: asaasCharge.invoiceUrl || null,
      },
    });

    return {
      ...charge,
      pix: pixData ? { qrCode: pixData.encodedImage, copyPaste: pixData.payload, expirationDate: pixData.expirationDate } : null,
      boleto: asaasCharge.bankSlipUrl ? { url: asaasCharge.bankSlipUrl, barcode: asaasCharge.nossoNumero } : null,
    };
  }

  /**
   * Onda 17.32.182 — E-mail automatico "pagamento atrasado".
   * Disparado pelo webhook PAYMENT_OVERDUE do Asaas. Best-effort.
   */
  private async sendPaymentOverdueEmail(charge: any): Promise<void> {
    try {
      if (!charge?.installment_id || !charge?.tenant_id) return;
      const inst = await this.prisma.installment.findUnique({
        where: { id: charge.installment_id },
        select: { patient: { select: { name: true, email: true } } },
      });
      const email = inst?.patient?.email;
      if (!email) return;
      await this.emailAutomation.dispatch(
        'pagamento_atrasado',
        charge.tenant_id,
        email,
        {
          paciente_nome: inst!.patient!.name,
          valor: Number(charge.amount).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
          vencimento: charge.due_date ? new Date(charge.due_date).toLocaleDateString('pt-BR') : '',
        },
        { ctaUrl: charge.invoice_url || charge.boleto_url || undefined },
      );
    } catch (e: any) {
      this.logger.warn(`[AUTO-MAIL] pagamento_atrasado falhou: ${e?.message}`);
    }
  }

  /**
   * Onda 17.32.181 — E-mail automatico "pagamento confirmado".
   * Best-effort: busca o paciente da parcela e dispara; qualquer falha
   * so loga (o webhook nunca quebra por causa de e-mail).
   */
  private async sendPaymentConfirmedEmail(charge: any, paymentData: any): Promise<void> {
    try {
      if (!charge?.installment_id || !charge?.tenant_id) return;
      const inst = await this.prisma.installment.findUnique({
        where: { id: charge.installment_id },
        select: { patient: { select: { name: true, email: true } } },
      });
      const email = inst?.patient?.email;
      if (!email) return;
      const paidAt = paymentData?.paymentDate ? new Date(paymentData.paymentDate) : new Date();
      await this.emailAutomation.dispatch('pagamento_confirmado', charge.tenant_id, email, {
        paciente_nome: inst!.patient!.name,
        valor: Number(charge.amount).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
        data_pagamento: paidAt.toLocaleDateString('pt-BR'),
      });
    } catch (e: any) {
      this.logger.warn(`[AUTO-MAIL] pagamento_confirmado falhou: ${e?.message}`);
    }
  }

  // ─── Cobrança para Installment (Fase 18 — Odontologia) ─

  /**
   * Cria cobranca no Asaas para uma Installment (parcela odontologica).
   * Usa Patient.cpf + Patient.lead_id para garantir/criar customer Asaas.
   * Idempotente: se a parcela ja tem charge, retorna a existente.
   */
  async createChargeForInstallment(
    installmentId: string,
    billingType: 'PIX' | 'BOLETO' | 'CREDIT_CARD',
    tenantId: string,
  ) {
    // Idempotencia
    const existing = await this.prisma.paymentGatewayCharge.findUnique({
      where: { installment_id: installmentId },
    });
    if (existing) {
      this.logger.warn(`[CHARGE-INST] Ja existe cobranca para installment ${installmentId}: ${existing.external_id}`);
      // Retorna com PIX se aplicavel (cache local)
      return {
        ...existing,
        pix: existing.pix_qr_code
          ? {
              qrCode: existing.pix_qr_code,
              copyPaste: existing.pix_copy_paste,
              expirationDate: existing.pix_expiration_date,
            }
          : null,
        boleto: existing.boleto_url
          ? { url: existing.boleto_url, barcode: existing.boleto_barcode }
          : null,
      };
    }

    // Buscar parcela
    const installment = await this.prisma.installment.findFirst({
      where: { id: installmentId, tenant_id: tenantId },
      include: {
        patient: { select: { id: true, name: true, cpf: true, lead_id: true, email: true } },
        quote: { select: { id: true } },
      },
    });
    if (!installment) throw new NotFoundException('Parcela nao encontrada');
    if (installment.status === 'PAGA') {
      throw new BadRequestException('Parcela ja foi paga');
    }
    if (installment.status === 'CANCELADA') {
      throw new BadRequestException('Parcela cancelada');
    }
    if (!installment.patient.cpf) {
      throw new BadRequestException('Paciente sem CPF — cadastre antes de gerar cobranca');
    }
    if (!installment.patient.lead_id) {
      throw new BadRequestException('Paciente nao vinculado a Lead — necessario para Asaas');
    }

    // Garantir customer no Asaas (via Patient)
    const customer = await this.ensureCustomerForPatient(installment.patient.id, tenantId);

    // Valor liquido (amount - desconto + juros)
    const value = Number(installment.amount)
      - Number(installment.discount_value || 0)
      + Number(installment.fee_value || 0);

    const dueDate = new Date(installment.due_date);
    const dueDateStr = dueDate.toISOString().slice(0, 10);
    const description =
      `Parcela ${installment.sequence}/${installment.total_count}` +
      ` — ${installment.patient.name}`;

    // Criar cobranca no Asaas (tenantId vem do escopo)
    const asaasCharge = await this.asaas.createCharge({
      customer: customer.external_id,
      billingType,
      value,
      dueDate: dueDateStr,
      description,
      externalReference: installmentId,
    }, tenantId);

    this.logger.log(
      `[CHARGE-INST] Criada no Asaas: ${asaasCharge.id} | ${billingType} | R$ ${value} | Venc: ${dueDateStr}`,
    );

    // PIX QR Code (se aplicavel)
    let pixData: any = null;
    if (billingType === 'PIX' && asaasCharge.id) {
      try { pixData = await this.asaas.getPixQrCode(asaasCharge.id, tenantId); }
      catch (e: any) { this.logger.warn(`[CHARGE-INST] Falha QR Code PIX: ${e.message}`); }
    }

    // Salva localmente
    const charge = await this.prisma.paymentGatewayCharge.create({
      data: {
        tenant_id: tenantId,
        installment_id: installmentId,
        gateway: 'ASAAS',
        external_id: asaasCharge.id,
        customer_external_id: customer.external_id,
        billing_type: billingType,
        amount: value,
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

    // Atualiza referencia gateway_charge_id na Installment (compat)
    await this.prisma.installment.update({
      where: { id: installmentId },
      data: { gateway_charge_id: asaasCharge.id },
    });

    // Onda 17.32.181 — e-mail automatico "cobranca gerada" (best-effort,
    // nunca bloqueia a emissao; dispatch trata erros internamente)
    void this.emailAutomation.dispatch(
      'cobranca_criada',
      tenantId,
      installment.patient.email,
      {
        paciente_nome: installment.patient.name,
        valor: value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
        vencimento: dueDate.toLocaleDateString('pt-BR'),
        forma_pagamento: billingType === 'CREDIT_CARD' ? 'Cartão' : billingType === 'BOLETO' ? 'Boleto' : 'PIX',
      },
      { ctaUrl: charge.invoice_url || charge.boleto_url || undefined },
    );

    return {
      ...charge,
      pix: pixData
        ? { qrCode: pixData.encodedImage, copyPaste: pixData.payload, expirationDate: pixData.expirationDate }
        : null,
      boleto: asaasCharge.bankSlipUrl
        ? { url: asaasCharge.bankSlipUrl, barcode: asaasCharge.nossoNumero }
        : null,
    };
  }

  /** Detalhes da cobranca de uma Installment (com refresh do Asaas). */
  async getInstallmentChargeDetails(installmentId: string, tenantId: string) {
    const charge = await this.prisma.paymentGatewayCharge.findUnique({
      where: { installment_id: installmentId },
    });
    if (!charge) {
      throw new NotFoundException('Cobranca nao encontrada para esta parcela');
    }
    if (charge.tenant_id !== tenantId) {
      throw new BadRequestException('Acesso negado');
    }

    let asaasData: any = null;
    try {
      asaasData = await this.asaas.getCharge(charge.external_id, charge.tenant_id);
      const mapped = ASAAS_STATUS_MAP[asaasData.status] || asaasData.status;
      if (mapped !== charge.status) {
        await this.prisma.paymentGatewayCharge.update({
          where: { id: charge.id },
          data: {
            status: mapped,
            paid_at: asaasData.paymentDate ? new Date(asaasData.paymentDate) : charge.paid_at,
            net_value: asaasData.netValue || charge.net_value,
            invoice_url: asaasData.invoiceUrl || charge.invoice_url,
          },
        });
      }
    } catch (e: any) {
      this.logger.warn(`[CHARGE-INST] Falha consulta Asaas: ${e.message}`);
    }

    return { local: charge, gateway: asaasData };
  }

  // ─── Cobrança parcelada (Asaas installment) ────────────

  async createInstallmentCharge(
    leadHonorarioId: string,
    billingType: 'PIX' | 'BOLETO' | 'CREDIT_CARD',
    tenantId?: string,
  ) {
    // Buscar honorário com parcelas pendentes
    const honorario = await this.prisma.leadHonorario.findUnique({
      where: { id: leadHonorarioId },
      include: {
        lead: { select: { id: true, name: true, phone: true, email: true } },
        payments: {
          where: { status: { in: ['PENDENTE', 'ATRASADO'] } },
          orderBy: { due_date: 'asc' },
        },
      },
    });

    if (!honorario) throw new NotFoundException('Honorário negociado não encontrado');
    if (!honorario.lead?.id) throw new BadRequestException('Lead não vinculado');
    if (honorario.payments.length === 0) throw new BadRequestException('Nenhuma parcela pendente');

    // Verificar se já existem cobranças para essas parcelas
    const paymentIds = honorario.payments.map(p => p.id);
    const existingCharges = await this.prisma.paymentGatewayCharge.findMany({
      where: { lead_honorario_payment_id: { in: paymentIds } },
    });
    if (existingCharges.length > 0) {
      throw new BadRequestException(`Já existem ${existingCharges.length} cobrança(s) gerada(s) para este honorário`);
    }

    // Garantir customer no Asaas
    const customer = await this.ensureCustomer(
      honorario.lead.id,
      tenantId || honorario.tenant_id || undefined,
    );

    const totalValue = honorario.payments.reduce((s, p) => s + Number(p.amount), 0);
    const installmentCount = honorario.payments.length;
    const installmentValue = Number(honorario.payments[0].amount); // Asaas usa valor da primeira parcela
    const firstDueDate = honorario.payments[0].due_date || new Date();
    const dueDateStr = new Date(firstDueDate).toISOString().slice(0, 10);

    const typeLabels: Record<string, string> = { CONTRATUAL: 'Contratuais', ENTRADA: 'Entrada', ACORDO: 'Acordo' };
    const description = `Honorário ${typeLabels[honorario.type] || honorario.type} - ${honorario.lead.name || 'Lead'} (${installmentCount}x)`.trim();

    // Criar cobrança parcelada no Asaas
    const effectiveTenantId2 = tenantId || honorario.tenant_id || null;
    const asaasCharge = await this.asaas.createCharge({
      customer: customer.external_id,
      billingType,
      value: totalValue,
      dueDate: dueDateStr,
      description,
      externalReference: leadHonorarioId,
      installmentCount,
      installmentValue,
    }, effectiveTenantId2);

    this.logger.log(`[CHARGE] Parcelada criada no Asaas: ${asaasCharge.id} | ${billingType} | ${installmentCount}x R$ ${installmentValue} | Total: R$ ${totalValue}`);

    let pixData: any = null;
    if (billingType === 'PIX' && asaasCharge.id) {
      try { pixData = await this.asaas.getPixQrCode(asaasCharge.id, effectiveTenantId2); }
      catch (e: any) { this.logger.warn(`[CHARGE] Falha QR Code PIX: ${e.message}`); }
    }

    // Salvar cobrança vinculada à primeira parcela
    const charge = await this.prisma.paymentGatewayCharge.create({
      data: {
        tenant_id: tenantId || honorario.tenant_id || null,
        lead_honorario_payment_id: honorario.payments[0].id,
        gateway: 'ASAAS',
        external_id: asaasCharge.id,
        customer_external_id: customer.external_id,
        billing_type: billingType,
        amount: totalValue,
        due_date: new Date(firstDueDate),
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
      ...charge,
      installmentCount,
      installmentValue,
      totalValue,
      pix: pixData ? { qrCode: pixData.encodedImage, copyPaste: pixData.payload, expirationDate: pixData.expirationDate } : null,
      boleto: asaasCharge.bankSlipUrl ? { url: asaasCharge.bankSlipUrl, barcode: asaasCharge.nossoNumero } : null,
    };
  }

  // ─── Batch charges ─────────────────────────────────────

  async createBatchCharges(
    honorarioId: string,
    _billingType: string,
    _tenantId?: string,
  ) {
    // STUBBED: HonorarioPayment/CaseHonorario removidos Fase 0.2
    this.logger.warn(`[STUB] createBatchCharges chamado com ${honorarioId} — no-op Fase 0.2`);
    throw new BadRequestException('Cobrança em lote de honorário jurídico desativada (Fase 0.2 — migração odontológica)');
  }

  // ─── Charge details ────────────────────────────────────

  async getChargeDetails(honorarioPaymentId: string, _tenantId?: string) {
    // STUBBED: HonorarioPayment removido Fase 0.2 — método preservado p/ compat
    this.logger.warn(`[STUB] getChargeDetails chamado com ${honorarioPaymentId} — no-op Fase 0.2`);
    throw new NotFoundException('Cobranca nao encontrada para este pagamento');
  }

  // ─── Webhook handling ──────────────────────────────────

  /**
   * Valida o token do webhook do Asaas (header `asaas-access-token`).
   * O Asaas envia em cada requisicao o "Token de autenticacao" configurado no
   * painel; comparamos com o `asaas_webhook_token` salvo nas settings.
   *
   * Padrao igual ao Clicksign: se o token NAO esta configurado, loga warning e
   * aceita (fail-open) pra nao derrubar webhooks legitimos antes de configurar.
   * Quando configurado, exige match exato (timing-safe).
   */
  async verifyWebhookToken(received?: string): Promise<{ ok: boolean; configured: boolean }> {
    const { webhookToken } = await this.asaas.getConfig();
    if (!webhookToken) {
      this.logger.warn(
        '[WEBHOOK] asaas_webhook_token NAO configurado — aceitando sem validar. ' +
          'Configure o token no painel Asaas e em Settings para proteger contra spoofing.',
      );
      return { ok: true, configured: false };
    }
    const a = Buffer.from(received || '');
    const b = Buffer.from(webhookToken);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    return { ok, configured: true };
  }

  async handleWebhook(payload: any) {
    const event = payload?.event;
    const paymentData = payload?.payment;

    if (!paymentData?.id) {
      this.logger.warn('[WEBHOOK] Payload sem payment.id, ignorando');
      return;
    }

    this.logger.log(
      `[WEBHOOK] Evento: ${event} | Payment: ${paymentData.id} | Status: ${paymentData.status}`,
    );

    // Buscar cobranca local pelo external_id
    const charge = await this.prisma.paymentGatewayCharge.findUnique({
      where: { external_id: paymentData.id },
    });

    if (!charge) {
      this.logger.warn(
        `[WEBHOOK] Cobranca nao encontrada localmente para external_id: ${paymentData.id} — processando evento mesmo assim`,
      );

      // Mesmo sem registro local, notificar cliente
      const mappedStatusNoCharge = ASAAS_STATUS_MAP[paymentData.status] || paymentData.status;

      // Notificar exclusão/estorno
      if (mappedStatusNoCharge === 'DELETED' || mappedStatusNoCharge === 'REFUNDED' || event === 'PAYMENT_DELETED') {
        try {
          await this.notifyClientChargeDeleted(paymentData, { amount: paymentData.value }, mappedStatusNoCharge === 'REFUNDED' ? 'REFUNDED' : 'DELETED');
        } catch (e: any) {
          this.logger.warn(`[WEBHOOK] Falha ao notificar cliente (sem registro local): ${e.message}`);
        }
      }

      // Notificar pagamento confirmado
      if (mappedStatusNoCharge === 'RECEIVED' || mappedStatusNoCharge === 'CONFIRMED' || event === 'PAYMENT_RECEIVED' || event === 'PAYMENT_CONFIRMED') {
        try {
          await this.notifyClientPaymentReceived(paymentData, { amount: paymentData.value });
        } catch (e: any) {
          this.logger.warn(`[WEBHOOK] Falha ao notificar cliente sobre pagamento (sem registro local): ${e.message}`);
        }
      }

      return;
    }

    // Mapear status
    const mappedStatus = ASAAS_STATUS_MAP[paymentData.status] || paymentData.status;

    // Idempotencia: se status ja e o mesmo, nao reprocessar
    if (charge.status === mappedStatus) {
      this.logger.debug(`[WEBHOOK] Status ja era ${mappedStatus}, ignorando duplicata`);
      return;
    }

    // Atualizar cobranca local
    const updatedCharge = await this.prisma.paymentGatewayCharge.update({
      where: { id: charge.id },
      data: {
        status: mappedStatus,
        paid_at: paymentData.paymentDate
          ? new Date(paymentData.paymentDate)
          : charge.paid_at,
        payment_date: paymentData.confirmedDate
          ? new Date(paymentData.confirmedDate)
          : charge.payment_date,
        net_value: paymentData.netValue || charge.net_value,
        invoice_url: paymentData.invoiceUrl || charge.invoice_url,
        webhook_payload: payload,
      },
    });

    // Onda 18.x — CORREÇÃO: o dinheiro só entra no CAIXA quando o Asaas
    // efetivamente COMPENSA/RECEBE (status RECEIVED), NÃO em CONFIRMED. Pro
    // BOLETO, CONFIRMED = cliente pagou/banco registrou, mas a compensação vem
    // alguns dias depois (a "baixa"); só aí o dinheiro está disponível. PIX (e o
    // PIX que vem no boleto) compensam na hora, então já chegam como RECEIVED.
    // Assim o boleto cai no caixa no DIA da compensação, não no vencimento nem
    // no pagamento. RECEIVED_IN_CASH (dá baixa na recepção) também mapeia p/
    // RECEIVED. Idempotente via transaction_id. Best-effort.
    if (mappedStatus === 'RECEIVED') {
      try {
        await this.ensureChargeReceita(charge.id);
      } catch (e: any) {
        this.logger.warn(`[WEBHOOK] Falha ao lançar RECEITA no caixa p/ ${charge.id}: ${e?.message}`);
      }
    }

    // Onda 14.59 — Se charge eh de SINAL/ENTRADA e foi confirmada, dispara
    // trigger do down-payment flow (gera parcelas + aprova proposta quando
    // todas as charges da entrada estiverem pagas). ModuleRef pra evitar
    // circular dep entre PaymentGatewayModule e CommercialModule.
    if (
      (mappedStatus === 'RECEIVED' || mappedStatus === 'CONFIRMED') &&
      (charge as any).kind &&
      ((charge as any).kind === 'SINAL' || (charge as any).kind === 'ENTRADA')
    ) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('../commercial/down-payment-flow.service');
        const downFlow = this.moduleRef.get(mod.DownPaymentFlowService, { strict: false });
        if (downFlow) {
          await downFlow.handleChargePaid(charge.id);
        }
      } catch (e: any) {
        this.logger.warn(`[WEBHOOK] Falha ao disparar down-payment trigger pra charge ${charge.id}: ${e.message}`);
      }
    }

    // STUBBED: HonorarioPayment removido Fase 0.2 — branch desativado

    // Fase 18: se pagamento RECEIVED/CONFIRMED e tem installment_id (parcela odonto),
    // marcar Installment como PAGA
    if (
      (mappedStatus === 'RECEIVED' || mappedStatus === 'CONFIRMED') &&
      charge.installment_id
    ) {
      try {
        const inst = await this.prisma.installment.findUnique({
          where: { id: charge.installment_id },
          select: {
            id: true,
            amount: true,
            discount_value: true,
            fee_value: true,
            status: true,
            // Onda 14.53 — patient_id usado no hook de graduacao Lead -> Cliente
            patient_id: true,
          },
        });
        if (inst && inst.status !== 'PAGA') {
          const totalDue = Number(inst.amount) - Number(inst.discount_value) + Number(inst.fee_value);
          await this.prisma.installment.update({
            where: { id: inst.id },
            data: {
              status: 'PAGA',
              amount_paid: totalDue,
              paid_at: paymentData.paymentDate ? new Date(paymentData.paymentDate) : new Date(),
              payment_method: charge.billing_type,
            },
          });
          this.logger.log(`[WEBHOOK] Installment ${charge.installment_id} marcada como PAGA via Asaas`);

          // Emitir evento via WebSocket
          this.emitFinancialUpdate(charge.tenant_id, {
            type: 'installment_paid',
            chargeId: charge.id,
            installmentId: charge.installment_id,
            status: mappedStatus,
            amount: Number(charge.amount),
          });

          // Onda 14.53 — Hook pos-pagamento: promove Lead -> Cliente quando
          // primeira parcela cai em conta. Best-effort, idempotente (skip se
          // ja eh cliente). Nao bloqueia o webhook em caso de falha — apenas
          // loga warning. Cascateia automaticamente:
          //  - WhatsApp move conversa pra aba "Clientes"
          //  - IA passa a usar skill 'Acompanhamento' (pos-venda)
          this.tryGraduateLeadToClient(inst.patient_id, charge.tenant_id);
        }
      } catch (e: any) {
        this.logger.error(`[WEBHOOK] Erro ao marcar Installment como PAGA: ${e.message}`);
      }
    }

    // Se pagamento RECEIVED/CONFIRMED e tem transaction_id, dar baixa na FinancialTransaction
    // STUBBED: honorario_payment_id removido Fase 0.2 — sempre trata como avulsa
    if (
      (mappedStatus === 'RECEIVED' || mappedStatus === 'CONFIRMED') &&
      charge.transaction_id &&
      !(charge as any).honorario_payment_id
    ) {
      try {
        await this.prisma.financialTransaction.update({
          where: { id: charge.transaction_id },
          data: {
            status: 'PAGO',
            paid_at: new Date(),
            payment_method: charge.billing_type,
          },
        });
        this.logger.log(`[WEBHOOK] FinancialTransaction ${charge.transaction_id} marcada como PAGO (receita avulsa)`);
      } catch (e: any) {
        this.logger.warn(`[WEBHOOK] Falha ao dar baixa em transação avulsa: ${e.message}`);
      }
    }

    // Se pagamento RECEIVED ou CONFIRMED, notificar cliente via WhatsApp
    if (mappedStatus === 'RECEIVED' || mappedStatus === 'CONFIRMED') {
      try {
        await this.notifyClientPaymentReceived(paymentData, charge);
      } catch (e: any) {
        this.logger.warn(`[WEBHOOK] Falha ao notificar cliente sobre pagamento: ${e.message}`);
      }
      // Onda 17.32.181 — e-mail automatico "pagamento confirmado"
      void this.sendPaymentConfirmedEmail(charge, paymentData);
    }

    // Onda 17.32.182 — e-mail automatico "pagamento atrasado": o banco
    // (Asaas) envia PAYMENT_OVERDUE quando a cobranca vence sem pagar
    if (mappedStatus === 'OVERDUE') {
      void this.sendPaymentOverdueEmail(charge);
    }

    // Se cobrança DELETADA ou REFUNDED, notificar cliente via WhatsApp
    if (mappedStatus === 'DELETED' || mappedStatus === 'REFUNDED') {
      try {
        await this.notifyClientChargeDeleted(paymentData, charge, mappedStatus);
      } catch (e: any) {
        this.logger.warn(`[WEBHOOK] Falha ao notificar cliente sobre exclusão: ${e.message}`);
      }

      // Onda 17.32.55 — Se TODAS as charges ativas do paciente foram
      // canceladas/refundadas, demove Lead de volta (volta pra aba
      // "Leads" no WhatsApp + IA volta pro modo comercial).
      // Best-effort: nao bloqueia o webhook se falhar.
      this.tryDemoteLeadIfAllChargesCancelled(charge);
    }

    // Emitir update generico de status
    this.emitFinancialUpdate(charge.tenant_id, {
      type: 'charge_status_update',
      chargeId: charge.id,
      externalId: charge.external_id,
      oldStatus: charge.status,
      newStatus: mappedStatus,
    });

    return updatedCharge;
  }

  // ─── Reconciliation ────────────────────────────────────

  async reconcile(tenantId?: string) {
    const where: any = { status: 'PENDING', gateway: 'ASAAS' };
    if (tenantId) where.tenant_id = tenantId;

    const pendingCharges = await this.prisma.paymentGatewayCharge.findMany({
      where,
      take: 100,
      orderBy: { created_at: 'asc' },
    });

    this.logger.log(`[RECONCILE] Verificando ${pendingCharges.length} cobrancas pendentes`);

    let updated = 0;
    let errors = 0;

    for (const charge of pendingCharges) {
      try {
        const asaasData = await this.asaas.getCharge(charge.external_id, charge.tenant_id);
        const mappedStatus = ASAAS_STATUS_MAP[asaasData.status] || asaasData.status;

        if (mappedStatus !== charge.status) {
          // Reprocessar como se fosse um webhook
          await this.handleWebhook({
            event: 'PAYMENT_' + asaasData.status,
            payment: asaasData,
          });
          updated++;
        }
      } catch (e: any) {
        this.logger.warn(
          `[RECONCILE] Erro ao verificar cobranca ${charge.external_id}: ${e.message}`,
        );
        errors++;
      }
    }

    return { total: pendingCharges.length, updated, errors };
  }

  // ─── Settings ──────────────────────────────────────────

  async getSettings(tenantId?: string) {
    const config = await this.asaas.getConfig(tenantId);

    return {
      provider: 'ASAAS',
      configured: !!config.apiKey,
      sandbox: config.sandbox,
    };
  }

  /**
   * Onda 17.32.141 — Quick Setup do Asaas pro ADMIN do tenant.
   * Valida a chave fazendo um GET real na Asaas. Se OK, persiste
   * em TenantSetting. Caso contrario, retorna erro amigavel.
   */
  async setupAsaas(
    tenantId: string | undefined | null,
    apiKey: string,
    sandbox = false,
  ): Promise<{ ok: true; sandbox: boolean }> {
    if (!tenantId) {
      throw new BadRequestException('Tenant nao identificado no token.');
    }
    if (!apiKey || apiKey.trim().length < 20) {
      throw new BadRequestException('Chave do Asaas invalida. Cole a chave completa (>= 20 caracteres).');
    }

    const trimmedKey = apiKey.trim();
    const baseUrl = sandbox
      ? 'https://api-sandbox.asaas.com/v3'
      : 'https://api.asaas.com/v3';

    // Valida a chave fazendo chamada real na Asaas
    try {
      const response = await axios.get(`${baseUrl}/finance/balance`, {
        headers: {
          access_token: trimmedKey,
          'Content-Type': 'application/json',
          'User-Agent': 'LexCRM/1.0',
        },
        timeout: 10000,
      });
      if (typeof response.data?.balance !== 'number') {
        throw new BadRequestException('Chave aceita mas resposta inesperada do Asaas. Tente de novo.');
      }
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 401) {
        throw new BadRequestException('Chave invalida ou sem permissao. Verifique no painel do Asaas: Integracoes > API.');
      }
      if (status === 403) {
        throw new BadRequestException('Chave sem permissao pra ler saldo. Use uma chave com escopo de leitura.');
      }
      if (e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT') {
        throw new BadRequestException('Asaas demorou pra responder. Tente de novo em alguns segundos.');
      }
      if (e instanceof BadRequestException) throw e;
      this.logger.error(`[setupAsaas] Erro validando chave: ${e?.message}`);
      throw new BadRequestException('Nao foi possivel validar a chave no Asaas. Verifique e tente de novo.');
    }

    // Chave valida — persiste no TenantSetting do tenant
    const { setTenantSetting } = await import('../tenants/tenant-settings.helper.js');
    await setTenantSetting(this.prisma, tenantId, 'ASAAS_API_KEY', trimmedKey);
    await setTenantSetting(this.prisma, tenantId, 'ASAAS_BASE_URL', baseUrl);

    this.logger.log(`[setupAsaas] Asaas configurado pro tenant ${tenantId} (sandbox=${sandbox})`);
    return { ok: true, sandbox };
  }

  // ─── Helpers ───────────────────────────────────────────

  // ─── Customer Sync (CRM ↔ Asaas) ──────────────────────

  /**
   * Importa clientes do Asaas e tenta vincular automaticamente aos leads do CRM.
   * Match por: 1) externalReference (lead_id), 2) CPF/CNPJ, 3) nome exato
   */
  async importAsaasCustomers(tenantId?: string): Promise<{
    total: number; linked: number; alreadyLinked: number; unlinked: any[];
  }> {
    this.logger.log('[CUSTOMER-SYNC] Importando clientes do Asaas...');
    let allCustomers: any[] = [];
    let offset = 0;
    const limit = 100;

    // Paginar todos os clientes do Asaas (usa conta do tenant quando disponivel)
    while (true) {
      const page = await this.asaas.listCustomers({ offset, limit }, tenantId);
      const items = page?.data || [];
      allCustomers = [...allCustomers, ...items];
      if (!page?.hasMore || items.length === 0) break;
      offset += limit;
    }

    this.logger.log(`[CUSTOMER-SYNC] ${allCustomers.length} clientes encontrados no Asaas`);

    let linked = 0;
    let alreadyLinked = 0;
    const unlinked: any[] = [];

    for (const cust of allCustomers) {
      if (cust.deleted) continue;

      // Ja vinculado?
      const existing = await this.prisma.paymentGatewayCustomer.findFirst({
        where: { gateway: 'ASAAS', external_id: cust.id },
      });
      if (existing) { alreadyLinked++; continue; }

      // Match 1: externalReference = lead_id
      let leadId: string | null = null;
      if (cust.externalReference) {
        const lead = await this.prisma.lead.findUnique({
          where: { id: cust.externalReference },
          select: { id: true },
        });
        if (lead) leadId = lead.id;
      }

      // Match 2: CPF/CNPJ
      if (!leadId && cust.cpfCnpj) {
        const cpfClean = cust.cpfCnpj.replace(/\D/g, '');
        // Busca no campo cpf_cnpj do Lead
        const lead = await this.prisma.lead.findFirst({
          where: {
            cpf_cnpj: cpfClean,
            ...(tenantId ? { tenant_id: tenantId } : {}),
          },
          select: { id: true },
        });
        if (lead) leadId = lead.id;

        // STUBBED: FichaTrabalhista removida Fase 0.2 — fallback desativado
      }

      // Match 3: nome exato (case insensitive)
      if (!leadId && cust.name) {
        const lead = await this.prisma.lead.findFirst({
          where: {
            name: { equals: cust.name, mode: 'insensitive' },
            ...(tenantId ? { tenant_id: tenantId } : {}),
          },
          select: { id: true },
        });
        if (lead) leadId = lead.id;
      }

      if (leadId) {
        // Vincular
        try {
          await this.prisma.paymentGatewayCustomer.create({
            data: {
              tenant_id: tenantId || null,
              lead_id: leadId,
              gateway: 'ASAAS',
              external_id: cust.id,
              cpf_cnpj: cust.cpfCnpj?.replace(/\D/g, '') || null,
              sync_status: 'SYNCED',
              last_synced_at: new Date(),
            },
          });
          // Atualizar cpf_cnpj no Lead se vazio
          if (cust.cpfCnpj) {
            await this.prisma.lead.updateMany({
              where: { id: leadId, cpf_cnpj: null },
              data: { cpf_cnpj: cust.cpfCnpj.replace(/\D/g, '') },
            });
          }
          linked++;
        } catch (e: any) {
          this.logger.warn(`[CUSTOMER-SYNC] Erro ao vincular ${cust.id}: ${e.message}`);
        }
      } else {
        // Match 4: se tem telefone, criar lead automaticamente e vincular
        const rawPhone = (cust.mobilePhone || cust.phone || '').replace(/\D/g, '');
        if (rawPhone && rawPhone.length >= 10) {
          // Normalizar telefone para formato do sistema (55+DD+8dig, sem 9 extra)
          let phone = rawPhone;
          if (phone.length <= 11) phone = '55' + phone;
          // Remover 9 extra: 5582999867111 (13dig) → 558299867111 (12dig)
          if (phone.length === 13 && phone.startsWith('55') && phone[4] === '9') {
            phone = phone.slice(0, 4) + phone.slice(5);
          }

          try {
            // Verificar se já existe lead com esse telefone (busca exata + parcial).
            // Onda 17.36 — escopo por tenant: sem isso a importação Asaas
            // vinculava o customer a lead de OUTRA clínica com o mesmo numero.
            let existingLead = await this.prisma.lead.findFirst({
              where: {
                tenant_id: tenantId || null,
                OR: [{ phone }, { phone: rawPhone }, { phone: { contains: rawPhone.slice(-10) } }],
              },
              select: { id: true },
            });

            if (!existingLead) {
              // Criar lead a partir dos dados do Asaas com telefone normalizado
              existingLead = await this.prisma.lead.create({
                data: {
                  tenant_id: tenantId || null,
                  name: cust.name || null,
                  phone: phone,
                  email: cust.email || null,
                  cpf_cnpj: cust.cpfCnpj?.replace(/\D/g, '') || null,
                  stage: 'FINALIZADO',
                  is_client: true,
                  became_client_at: new Date(),
                  origin: 'asaas_import',
                },
              });
              this.logger.log(`[CUSTOMER-SYNC] Lead criado a partir do Asaas: ${existingLead.id} (${cust.name})`);
            }

            // Vincular
            await this.prisma.paymentGatewayCustomer.create({
              data: {
                tenant_id: tenantId || null,
                lead_id: existingLead.id,
                gateway: 'ASAAS',
                external_id: cust.id,
                cpf_cnpj: cust.cpfCnpj?.replace(/\D/g, '') || null,
                sync_status: 'SYNCED',
                last_synced_at: new Date(),
              },
            });
            linked++;
            continue;
          } catch (e: any) {
            this.logger.warn(`[CUSTOMER-SYNC] Erro ao criar lead para ${cust.name}: ${e.message}`);
          }
        }

        unlinked.push({
          asaasId: cust.id,
          name: cust.name,
          cpfCnpj: cust.cpfCnpj,
          email: cust.email,
          phone: rawPhone || null,
        });
      }
    }

    this.logger.log(`[CUSTOMER-SYNC] Resultado: ${linked} vinculados, ${alreadyLinked} ja vinculados, ${unlinked.length} sem match`);
    return { total: allCustomers.length, linked, alreadyLinked, unlinked };
  }

  /** Vinculacao manual: conecta um cliente Asaas a um lead do CRM */
  async linkCustomerToLead(asaasCustomerId: string, leadId: string, tenantId?: string) {
    // Buscar dados do cliente no Asaas (usa tenantId quando disponivel)
    const cust = await this.asaas.getCustomer(asaasCustomerId, tenantId);
    if (!cust) throw new NotFoundException('Cliente nao encontrado no Asaas');

    // Verificar se lead existe
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId }, select: { id: true } });
    if (!lead) throw new NotFoundException('Lead nao encontrado');

    // Criar vinculo
    const record = await this.prisma.paymentGatewayCustomer.create({
      data: {
        tenant_id: tenantId || null,
        lead_id: leadId,
        gateway: 'ASAAS',
        external_id: asaasCustomerId,
        cpf_cnpj: cust.cpfCnpj?.replace(/\D/g, '') || null,
        sync_status: 'SYNCED',
        last_synced_at: new Date(),
      },
    });

    // Atualizar cpf_cnpj no Lead
    if (cust.cpfCnpj) {
      await this.prisma.lead.updateMany({
        where: { id: leadId, cpf_cnpj: null },
        data: { cpf_cnpj: cust.cpfCnpj.replace(/\D/g, '') },
      });
    }

    return record;
  }

  /** Desvincular um cliente */
  async unlinkCustomer(id: string) {
    return this.prisma.paymentGatewayCustomer.delete({ where: { id } });
  }

  /** Lista clientes vinculados (local) */
  async listLinkedCustomers(tenantId?: string) {
    return this.prisma.paymentGatewayCustomer.findMany({
      where: { gateway: 'ASAAS', ...(tenantId ? { tenant_id: tenantId } : {}) },
      include: {
        lead: { select: { id: true, name: true, phone: true, email: true, cpf_cnpj: true } },
      },
      orderBy: { last_synced_at: 'desc' },
    });
  }

  /**
   * Notifica o cliente via WhatsApp quando um pagamento é confirmado.
   */
  /**
   * Onda 18.32 — conversa PRÓPRIA do Financeiro (isolamento do chip de cobrança).
   * Acha/cria a conversa do lead no inbox FINANCEIRO — mundo separado do
   * Comercial/Clínica (o "contato duplicado" entre abas é intencional: este é só
   * o contato de cobrança). Retorna null se o tenant não tem inbox Financeiro —
   * o caller usa o fallback antigo (última conversa) e nada quebra.
   */
  private async findOrCreateFinanceiroConversation(
    leadId: string,
    tenantId: string | null | undefined,
    phone?: string | null,
  ): Promise<{ id: string; instance_name: string | null } | null> {
    try {
      if (!tenantId) return null;
      const finInbox = await this.prisma.inbox.findFirst({
        where: { tenant_id: tenantId, purpose: 'FINANCEIRO' },
        select: { id: true },
      });
      if (!finInbox) return null;
      const existing = await this.prisma.conversation.findFirst({
        where: {
          lead_id: leadId,
          channel: 'whatsapp',
          status: { not: 'ENCERRADO' },
          inbox: { purpose: 'FINANCEIRO' },
        },
        orderBy: { last_message_at: 'desc' },
        select: { id: true, instance_name: true },
      });
      if (existing) return existing;
      const finInstance = await this.whatsapp.getInstanceForPurpose(tenantId, 'FINANCEIRO');
      const cleanPhone = (phone || '').replace(/\D/g, '');
      const created = await this.prisma.conversation.create({
        data: {
          lead_id: leadId,
          channel: 'whatsapp',
          status: 'ABERTO',
          ...(cleanPhone ? { external_id: `${cleanPhone}@s.whatsapp.net` } : {}),
          inbox_id: finInbox.id,
          instance_name: finInstance ?? null,
          tenant_id: tenantId,
          last_message_at: new Date(),
        },
        select: { id: true, instance_name: true },
      });
      this.logger.log(`[FINANCEIRO] Conversa própria criada pro lead ${leadId}: ${created.id}`);
      return created;
    } catch (e: any) {
      this.logger.warn(`[FINANCEIRO] Falha ao resolver conversa do financeiro: ${e.message}`);
      return null;
    }
  }

  private async notifyClientPaymentReceived(paymentData: any, charge: any) {
    // Onda 18.28 — respeita o toggle "Confirmação de pagamento" da Central de
    // Disparos (default LIGADA; só pula se o admin desligou explicitamente).
    const tenantId = (charge as any)?.tenant_id;
    if (tenantId) {
      const flag = await this.prisma.globalSetting.findUnique({
        where: { key: `PAYMENT_CONFIRMATION_ENABLED_${tenantId}` },
      });
      if (flag?.value === 'false') {
        this.logger.log(`[WEBHOOK] Confirmação de pagamento desligada (tenant ${tenantId}) — pulando`);
        return;
      }
    }

    const customerId = paymentData.customer;
    if (!customerId) return;

    const gatewayCustomer = await this.prisma.paymentGatewayCustomer.findFirst({
      where: { external_id: customerId, gateway: 'ASAAS' },
      include: { lead: { select: { id: true, name: true, phone: true } } },
    });

    if (!gatewayCustomer?.lead?.phone) return;

    const lead = gatewayCustomer.lead;
    const firstName = (lead.name || 'Cliente').split(' ')[0];
    const valor = Number(paymentData.value || charge?.amount || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    // A descrição vem do Asaas — e é a NOSSA, que carrega a tag interna
    // [plan:{uuid}] pra ligar cobrança↔plano. Sem limpar, o paciente lia
    // "(Sinal de fechamento — Fulano [plan:c6f80716-dffe-...])". Limpa só o TEXTO;
    // a coluna description no banco continua com a tag (é ela que casa o plano).
    const { cobrancaTemplateKey, DEFAULT_CONFIRMACAO_PAGAMENTO, stripInternalTags } = await import('@crm/shared');
    const descricao = stripInternalTags(paymentData.description);

    // Onda 18.28 — usa o texto EDITÁVEL da Central de Disparos (mesma infra dos
    // boletos); cai no default se não editado. {descricao} já vem com parênteses.
    let tpl = DEFAULT_CONFIRMACAO_PAGAMENTO;
    if (tenantId) {
      const row = await this.prisma.globalSetting.findUnique({
        where: { key: cobrancaTemplateKey('confirmacao_pagamento', tenantId) },
      });
      if (row?.value) {
        try {
          const parsed = JSON.parse(row.value);
          if (typeof parsed?.template === 'string' && parsed.template.trim()) tpl = parsed.template;
        } catch { /* corrompido — usa o default */ }
      }
    }
    // Onda 18.30 — {clinica} = nome do tenant (Tenant.name).
    let clinicaNome = 'a clínica';
    if (tenantId) {
      const t = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }).catch(() => null);
      if (t?.name) clinicaNome = t.name;
    }
    const msg = tpl
      .replace(/\{nome\}/g, firstName)
      .replace(/\{valor\}/g, valor)
      .replace(/\{descricao\}/g, descricao ? ` (${descricao})` : '')
      .replace(/\{clinica\}/g, clinicaNome);

    let clientPhone = lead.phone.replace(/\D/g, '');
    if (clientPhone.length <= 11) clientPhone = '55' + clientPhone;
    if (clientPhone.length === 13 && clientPhone.startsWith('55') && clientPhone[4] === '9') {
      clientPhone = clientPhone.slice(0, 4) + clientPhone.slice(5);
    }

    // Onda 18.32 — grava na conversa PRÓPRIA do Financeiro (find-or-create).
    // Fallback: última conversa do lead (tenant ainda sem inbox Financeiro).
    const lastConvo =
      (await this.findOrCreateFinanceiroConversation(lead.id, tenantId, lead.phone)) ??
      (await this.prisma.conversation.findFirst({
        where: { lead_id: lead.id, status: { not: 'ENCERRADO' } },
        orderBy: { last_message_at: 'desc' },
        select: { id: true, instance_name: true },
      }).catch(() => null));

    // Onda 18.7 — confirmação de pagamento sai pelo chip FINANCEIRO (fallback:
    // instância da última conversa).
    const finInstance = (charge as any)?.tenant_id
      ? await this.whatsapp.getInstanceForPurpose((charge as any).tenant_id, 'FINANCEIRO')
      : null;
    const dispatchInstance = finInstance ?? lastConvo?.instance_name ?? undefined;

    try {
      const sendResult = await this.whatsapp.sendText(clientPhone, msg, dispatchInstance);
      this.logger.log(`[WEBHOOK] Confirmação de pagamento enviada para ${clientPhone}`);

      if (lastConvo) {
        const evolutionMsgId = sendResult?.data?.key?.id || `sys_payment_${Date.now()}`;
        await this.prisma.message.create({
          data: { conversation_id: lastConvo.id, direction: 'out', type: 'text', text: msg, external_message_id: evolutionMsgId, status: 'enviado' },
        });
        await this.prisma.conversation.update({ where: { id: lastConvo.id }, data: { last_message_at: new Date() } });
      }
    } catch (e: any) {
      this.logger.warn(`[WEBHOOK] Falha ao enviar confirmação para ${clientPhone}: ${e.message}`);
    }
  }

  /**
   * Notifica o cliente via WhatsApp quando uma cobrança é excluída/estornada.
   * Busca o lead vinculado ao customer do Asaas para enviar a mensagem.
   */
  private async notifyClientChargeDeleted(paymentData: any, charge: any, status: string) {
    // Buscar o cliente Asaas → Lead
    const customerId = paymentData.customer;
    if (!customerId) return;

    const gatewayCustomer = await this.prisma.paymentGatewayCustomer.findFirst({
      where: { external_id: customerId, gateway: 'ASAAS' },
      include: { lead: { select: { id: true, name: true, phone: true, tenant_id: true } } },
    });

    if (!gatewayCustomer?.lead?.phone) {
      this.logger.warn(`[WEBHOOK] Sem telefone do cliente para notificar (customer: ${customerId})`);
      return;
    }

    const lead = gatewayCustomer.lead;
    const firstName = (lead.name || 'Cliente').split(' ')[0];
    const valor = Number(paymentData.value || charge.amount || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    // Mesma limpeza da confirmação: a tag [plan:{uuid}] é interna, não vai pro paciente.
    const { stripInternalTags } = await import('@crm/shared');
    const descricao = stripInternalTags(paymentData.description);
    const isEstorno = status === 'REFUNDED';

    const msg = isEstorno
      ? (
        `💰 *Estorno de Cobrança*\n\n` +
        `Olá, ${firstName}!\n\n` +
        `Informamos que a cobrança no valor de *${valor}*${descricao ? ` (${descricao})` : ''} foi *estornada*.\n\n` +
        `O valor será devolvido conforme a forma de pagamento utilizada.\n` +
        `Qualquer dúvida, estamos à disposição.`
      )
      : (
        `📋 *Cobrança Cancelada*\n\n` +
        `Olá, ${firstName}!\n\n` +
        `Informamos que a cobrança no valor de *${valor}*${descricao ? ` (${descricao})` : ''} foi *cancelada*.\n\n` +
        `Caso tenha dúvidas sobre o motivo ou precise de uma nova cobrança, responda esta mensagem.`
      );

    // Normalizar telefone: 55+DD+8dig (sem 9 extra) — mesmo formato do to12Digits
    let clientPhone = lead.phone.replace(/\D/g, '');
    if (clientPhone.length <= 11) clientPhone = '55' + clientPhone;
    // Remover 9 extra: 5582999867111 (13dig) → 558299867111 (12dig)
    if (clientPhone.length === 13 && clientPhone.startsWith('55') && clientPhone[4] === '9') {
      clientPhone = clientPhone.slice(0, 4) + clientPhone.slice(5);
    }

    // Atualizar telefone do lead para o formato normalizado (evita duplicatas)
    if (lead.phone !== clientPhone) {
      await this.prisma.lead.update({ where: { id: lead.id }, data: { phone: clientPhone } }).catch(() => {});
    }

    // Buscar ou criar conversa para o lead.
    // Onda 18.32 — primeiro a conversa PRÓPRIA do Financeiro (find-or-create);
    // fallback pro comportamento antigo se o tenant não tem inbox Financeiro.
    const notifyTenantId: string | null =
      (charge as any)?.tenant_id || (lead as any)?.tenant_id || null;
    let lastConvo = await this.findOrCreateFinanceiroConversation(
      lead.id,
      notifyTenantId,
      lead.phone,
    );
    if (!lastConvo) {
      lastConvo = await this.prisma.conversation.findFirst({
        where: { lead_id: lead.id, status: { not: 'ENCERRADO' } },
        orderBy: { last_message_at: 'desc' },
        select: { id: true, instance_name: true },
      }).catch(() => null);
    }

    if (!lastConvo) {
      // Criar conversa para que a mensagem fique visível no chat.
      // Onda 18.32 (review) — channel MINÚSCULO ('whatsapp': é o que o webhook e
      // os finds filtram; 'WHATSAPP' criava conversa inencontrável) + tenant_id
      // (sem ele a conversa ficava invisível no findAll, que filtra por tenant).
      try {
        const newConvo = await this.prisma.conversation.create({
          data: {
            lead_id: lead.id,
            channel: 'whatsapp',
            status: 'ABERTO',
            instance_name: 'whatsapp',
            last_message_at: new Date(),
            ...(notifyTenantId ? { tenant_id: notifyTenantId } : {}),
          },
        });
        lastConvo = { id: newConvo.id, instance_name: 'whatsapp' };
        this.logger.log(`[WEBHOOK] Conversa criada para lead ${lead.id}: ${newConvo.id}`);
      } catch (e: any) {
        this.logger.warn(`[WEBHOOK] Falha ao criar conversa: ${e.message}`);
      }
    }
    // Onda 18.7 — estorno/cancelamento sai pelo chip FINANCEIRO (fallback:
    // instância da conversa).
    const finInstance = (charge as any)?.tenant_id
      ? await this.whatsapp.getInstanceForPurpose((charge as any).tenant_id, 'FINANCEIRO')
      : null;
    try {
      const sendResult = await this.whatsapp.sendText(
        clientPhone,
        msg,
        finInstance ?? lastConvo?.instance_name ?? undefined,
      );
      this.logger.log(`[WEBHOOK] Notificação de ${status} enviada para ${clientPhone}`);

      // Salvar mensagem na conversa (visível para o operador)
      if (lastConvo) {
        const evolutionMsgId = sendResult?.data?.key?.id || `sys_charge_${Date.now()}`;
        await this.prisma.message.create({
          data: {
            conversation_id: lastConvo.id,
            direction: 'out',
            type: 'text',
            text: msg,
            external_message_id: evolutionMsgId,
            status: 'enviado',
          },
        });
        await this.prisma.conversation.update({
          where: { id: lastConvo.id },
          data: { last_message_at: new Date() },
        });
      }
    } catch (e: any) {
      this.logger.warn(`[WEBHOOK] Falha ao enviar WhatsApp para ${clientPhone}: ${e.message}`);
    }
  }

  private emitFinancialUpdate(tenantId: string | null, data: any) {
    try {
      if (this.chatGateway?.server && tenantId) {
        this.chatGateway.server
          .to('tenant:' + tenantId)
          .emit('financial_update', data);
      }
    } catch (e: any) {
      this.logger.warn(`[SOCKET] Falha ao emitir evento: ${e.message}`);
    }
  }

  /**
   * Onda 14.53 — Hook: promove Lead vinculado ao paciente pra "Cliente" quando
   * a primeira parcela cai em conta. Resolvido via ModuleRef pra evitar
   * dependencia circular entre PaymentGatewayModule e LeadsModule (mesmo
   * padrao usado em quotes.service.ts tryGraduateLead).
   *
   * Best-effort, idempotente. Falhas logam warning mas nao bloqueiam o
   * webhook de pagamento — financeiro nao pode quebrar por causa de hook
   * paralelo de IA/WhatsApp.
   */
  private tryGraduateLeadToClient(patientId: string, tenantId: string | null): void {
    if (!tenantId) return;
    try {
      const leadsService = this.moduleRef.get(LeadsService, { strict: false });
      if (!leadsService) return;
      leadsService
        .graduateLeadToClient(patientId, tenantId)
        .catch((err: any) =>
          this.logger.warn(
            `[INSTALLMENT→CLIENT] Hook falhou pra patient ${patientId}: ${err?.message}`,
          ),
        );
    } catch {
      // LeadsService pode nao estar carregado em testes — ignorar silenciosamente
    }
  }

  /**
   * Onda 17.32.55 — Quando uma charge eh cancelada/refundada, checa se
   * TODAS as charges ativas do mesmo paciente (via customer_external_id)
   * foram canceladas. Se sim, demove o Lead de volta (volta pra "Leads"
   * no WhatsApp + IA volta a modo comercial).
   *
   * Best-effort: nao aguarda, nao bloqueia o webhook.
   */
  private tryDemoteLeadIfAllChargesCancelled(charge: {
    id: string;
    tenant_id: string | null;
    customer_external_id: string | null;
  }): void {
    if (!charge.tenant_id || !charge.customer_external_id) return;
    const tenantId = charge.tenant_id;
    const customerExternalId = charge.customer_external_id;
    (async () => {
      try {
        // 1. Conta charges do paciente que ainda estao ATIVAS (nao
        //    canceladas/refundadas). Se houver alguma, mantem cliente.
        const activeCount = await this.prisma.paymentGatewayCharge.count({
          where: {
            tenant_id: tenantId,
            customer_external_id: customerExternalId,
            status: { notIn: ['DELETED', 'REFUNDED'] },
          },
        });
        if (activeCount > 0) {
          this.logger.log(
            `[DEMOTE-CHECK] Customer ${customerExternalId} ainda tem ${activeCount} charge(s) ativa(s) — mantem cliente`,
          );
          return;
        }
        // 2. Todas canceladas — busca o patient_id via customer
        const customer = await this.prisma.paymentGatewayCustomer.findFirst({
          where: { external_id: customerExternalId, gateway: 'ASAAS' },
          select: { lead_id: true },
        });
        if (!customer?.lead_id) return;
        const patient = await this.prisma.patient.findFirst({
          where: { lead_id: customer.lead_id, tenant_id: tenantId },
          select: { id: true },
        });
        if (!patient?.id) return;
        // 3. Demove
        const leadsService = this.moduleRef.get(LeadsService, { strict: false });
        if (!leadsService) return;
        const res = await leadsService.demoteLeadFromClient(patient.id, tenantId);
        if (res?.ok && !res.alreadyLead) {
          this.logger.log(
            `[DEMOTE] Lead ${res.leadId} demovido a lead (todas charges canceladas)`,
          );
        }
      } catch (err: any) {
        this.logger.warn(`[DEMOTE-CHECK] Falhou: ${err?.message}`);
      }
    })();
  }
}
