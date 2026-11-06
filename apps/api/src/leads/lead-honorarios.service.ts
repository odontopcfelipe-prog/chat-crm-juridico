import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Inject, forwardRef, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { FinanceiroService } from '../financeiro/financeiro.service';
import { isLabTenant } from '@crm/shared';
import { assertAnyPermission, negarPermissao } from '../auth/require-any-permission';
import { isAdminRole } from '../auth/patient-scope';
import { situacaoDaCobrancaDaParcela } from '../payment-gateway/cobranca-laboratorio';
import { LAB_COBRANCA_AVULSA } from './lab-cobranca-avulsa-textos';

/** Quem pediu a ação (req.user): as ações sobre o boleto em aberto conferem o papel. */
type QuemPede = { id?: string; roles?: string[] } | null | undefined;

@Injectable()
export class LeadHonorariosService {
  private readonly logger = new Logger(LeadHonorariosService.name);

  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => FinanceiroService)) private financeiroService: FinanceiroService,
    private moduleRef: ModuleRef,
  ) {}

  // ─── Conta do laboratório ───────────────────────────────

  /**
   * Conta de laboratório? (lista em cache de 60 s; a clínica só paga essa leitura.) No
   * laboratório a cobrança avulsa só alcança contato e parcela da PRÓPRIA conta: o
   * registro de outra conta responde como inexistente.
   */
  private async doLab(tenantId?: string): Promise<boolean> {
    return !!tenantId && (await isLabTenant(this.prisma, tenantId, (m) => this.logger.warn(m)));
  }

  /** Laboratório: o honorário (ou, sem conta gravada, o contato dele) é da conta de quem chama? */
  private async daContaDoLab(tenantId: string, hon: { tenant_id: string | null; lead_id: string }): Promise<boolean> {
    if (hon.tenant_id) return hon.tenant_id === tenantId;
    const lead = await this.prisma.lead.findUnique({ where: { id: hon.lead_id }, select: { tenant_id: true } });
    return lead?.tenant_id === tenantId;
  }

  /**
   * Contato com conta gravada e diferente da conta do token: em qualquer tipo de conta,
   * responde como inexistente. Contato legado (sem conta) e chamada interna (sem token): como antes.
   */
  private async contatoDeOutraConta(leadId: string, tenantId?: string): Promise<boolean> {
    if (!tenantId) return false;
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId }, select: { tenant_id: true } });
    return !!lead?.tenant_id && lead.tenant_id !== tenantId;
  }

  /** PaymentGatewayService pelo ModuleRef, sem injeção nova (mesmo padrão do módulo dele). */
  private gateway() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../payment-gateway/payment-gateway.service');
    return this.moduleRef.get(mod.PaymentGatewayService, { strict: false }) as import('../payment-gateway/payment-gateway.service').PaymentGatewayService;
  }

  /** Cancela no Asaas o boleto em aberto da parcela. Só o administrador; o gateway recusa se o Asaas não confirmar. */
  private async cancelarBoletoDaParcela(paymentId: string, tenantId: string, quem: QuemPede, motivo: string): Promise<void> {
    const charge = await this.prisma.paymentGatewayCharge.findUnique({
      where: { lead_honorario_payment_id: paymentId },
      select: { status: true, received_in_cash: true },
    });
    if (charge && situacaoDaCobrancaDaParcela(charge) === 'ABERTA' && !isAdminRole(quem?.roles)) {
      throw negarPermissao(LAB_COBRANCA_AVULSA.soAdminCancelaBoleto);
    }
    if (charge) await this.gateway().cancelarCobrancaDaParcelaDoLab(paymentId, tenantId, { userId: quem?.id ?? null, reason: motivo });
  }

  // ─── Queries ────────────────────────────────────────────

  async findByLead(leadId: string, tenantId?: string) {
    if (await this.doLab(tenantId)) {
      const contato = await this.prisma.lead.findFirst({ where: { id: leadId, tenant_id: tenantId }, select: { id: true } });
      if (!contato) throw new NotFoundException(LAB_COBRANCA_AVULSA.contatoNaoEncontrado);
      // A tela mostra o estado e o link da cobrança de cada parcela.
      return this.prisma.leadHonorario.findMany({
        where: { lead_id: leadId },
        include: {
          payments: {
            orderBy: { due_date: 'asc' },
            include: { gateway_charge: { select: { status: true, received_in_cash: true, boleto_url: true, invoice_url: true } } },
          },
        },
        orderBy: { created_at: 'desc' },
      });
    } else if (await this.contatoDeOutraConta(leadId, tenantId)) {
      throw new NotFoundException('Lead não encontrado');
    }
    return this.prisma.leadHonorario.findMany({
      where: { lead_id: leadId },
      include: {
        payments: { orderBy: { due_date: 'asc' } },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async findPendingPayments(tenantId?: string) {
    const where: any = {
      status: { in: ['PENDENTE', 'ATRASADO'] },
      lead_honorario: {
        status: { in: ['NEGOCIANDO', 'ACEITO'] },
      },
    };
    if (tenantId) {
      where.lead_honorario.tenant_id = tenantId;
    }

    return this.prisma.leadHonorarioPayment.findMany({
      where,
      include: {
        lead_honorario: {
          include: {
            lead: { select: { id: true, name: true, phone: true } },
          },
        },
      },
      orderBy: { due_date: 'asc' },
    });
  }

  async getSummary(tenantId?: string) {
    const where: any = {
      status: { in: ['NEGOCIANDO', 'ACEITO'] },
    };
    if (tenantId) where.tenant_id = tenantId;

    const honorarios = await this.prisma.leadHonorario.findMany({
      where,
      include: {
        lead: { select: { id: true, name: true, phone: true } },
        payments: true,
      },
      orderBy: { created_at: 'desc' },
    });

    return honorarios.map(h => {
      const payments = h.payments || [];
      const contracted = Number(h.total_value);
      const received = payments.filter(p => p.status === 'PAGO').reduce((s, p) => s + Number(p.amount), 0);
      const pending = payments.filter(p => p.status === 'PENDENTE').reduce((s, p) => s + Number(p.amount), 0);
      const overdue = payments.filter(p => p.status === 'ATRASADO').reduce((s, p) => s + Number(p.amount), 0);
      return {
        id: h.id,
        lead: h.lead,
        type: h.type,
        status: h.status,
        contracted,
        received,
        pending,
        overdue,
        installment_count: h.installment_count,
        created_at: h.created_at,
      };
    });
  }

  // ─── CRUD Honorário ─────────────────────────────────────

  async create(leadId: string, data: {
    type: string;
    total_value: number;
    notes?: string;
    payments: Array<{ amount: number; due_date?: string | null }>;
  }, tenantId?: string) {
    if (!data.total_value || data.total_value <= 0) {
      throw new BadRequestException('Valor total deve ser maior que zero');
    }
    // Laboratório: só contato da própria conta.
    if (await this.doLab(tenantId)) {
      const contato = await this.prisma.lead.findFirst({ where: { id: leadId, tenant_id: tenantId }, select: { id: true } });
      if (!contato) throw new NotFoundException(LAB_COBRANCA_AVULSA.contatoNaoEncontrado);
    } else if (await this.contatoDeOutraConta(leadId, tenantId)) {
      throw new NotFoundException('Lead não encontrado');
    }

    const validTypes = ['CONTRATUAL', 'ENTRADA', 'ACORDO'];
    if (!validTypes.includes(data.type)) {
      throw new BadRequestException(`Tipo inválido. Use: ${validTypes.join(', ')}`);
    }

    if (!data.payments || data.payments.length === 0) {
      throw new BadRequestException('Informe pelo menos uma parcela');
    }

    // Validar soma das parcelas
    const paymentSum = data.payments.reduce((s, p) => s + p.amount, 0);
    const diff = Math.abs(paymentSum - data.total_value);
    if (diff > 0.02) {
      throw new BadRequestException(`Soma das parcelas (${paymentSum.toFixed(2)}) difere do valor total (${data.total_value.toFixed(2)})`);
    }

    const now = new Date();

    return this.prisma.leadHonorario.create({
      data: {
        lead_id: leadId,
        tenant_id: tenantId || null,
        type: data.type,
        total_value: data.total_value,
        installment_count: data.payments.length,
        notes: data.notes || null,
        payments: {
          create: data.payments.map(p => {
            const dueDate = p.due_date ? new Date(p.due_date) : null;
            return {
              amount: p.amount,
              due_date: dueDate,
              status: dueDate && dueDate < now ? 'ATRASADO' : 'PENDENTE',
            };
          }),
        },
      },
      include: {
        payments: { orderBy: { due_date: 'asc' } },
      },
    });
  }

  async update(id: string, data: {
    type?: string;
    total_value?: number;
    notes?: string;
    status?: string;
  }, tenantId?: string) {
    const existing = await this.prisma.leadHonorario.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Honorário negociado não encontrado');
    if (tenantId && (await this.doLab(tenantId)) && !(await this.daContaDoLab(tenantId, existing))) {
      throw new NotFoundException(LAB_COBRANCA_AVULSA.naoEncontrada);
    }
    if (await this.contatoDeOutraConta(existing.lead_id, tenantId)) throw new NotFoundException('Honorário negociado não encontrado');
    if (existing.status === 'CONVERTIDO') {
      throw new ForbiddenException('Honorário já convertido não pode ser alterado');
    }

    if (data.type) {
      const validTypes = ['CONTRATUAL', 'ENTRADA', 'ACORDO'];
      if (!validTypes.includes(data.type)) {
        throw new BadRequestException(`Tipo inválido. Use: ${validTypes.join(', ')}`);
      }
    }

    if (data.status) {
      const validStatuses = ['NEGOCIANDO', 'ACEITO', 'RECUSADO'];
      if (!validStatuses.includes(data.status)) {
        throw new BadRequestException(`Status inválido. Use: NEGOCIANDO, ACEITO, RECUSADO`);
      }
    }

    return this.prisma.leadHonorario.update({
      where: { id },
      data: {
        ...(data.type && { type: data.type }),
        ...(data.total_value !== undefined && { total_value: data.total_value }),
        ...(data.notes !== undefined && { notes: data.notes }),
        ...(data.status && { status: data.status }),
      },
      include: { payments: { orderBy: { due_date: 'asc' } } },
    });
  }

  async delete(id: string, tenantId?: string, quem?: QuemPede) {
    const existing = await this.prisma.leadHonorario.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Honorário negociado não encontrado');
    const lab = await this.doLab(tenantId);
    if (tenantId && lab && !(await this.daContaDoLab(tenantId, existing))) {
      throw new NotFoundException(LAB_COBRANCA_AVULSA.naoEncontrada);
    }
    if (await this.contatoDeOutraConta(existing.lead_id, tenantId)) throw new NotFoundException('Honorário negociado não encontrado');
    if (existing.status === 'CONVERTIDO') {
      throw new ForbiddenException('Honorário já convertido não pode ser excluído');
    }
    // Laboratório: parcela paga segura a cobrança; boleto em aberto é cancelado no Asaas antes.
    if (tenantId && lab) {
      const parcelas = await this.prisma.leadHonorarioPayment.findMany({
        where: { lead_honorario_id: id },
        select: { id: true, status: true, gateway_charge: { select: { status: true, received_in_cash: true } } },
      });
      if (parcelas.some((p) => p.status === 'PAGO' || (p.gateway_charge && situacaoDaCobrancaDaParcela(p.gateway_charge) === 'PAGA'))) {
        throw new BadRequestException(LAB_COBRANCA_AVULSA.temParcelaPaga);
      }
      for (const p of parcelas) await this.cancelarBoletoDaParcela(p.id, tenantId, quem, LAB_COBRANCA_AVULSA.motivoExcluirCobranca);
    }

    await this.prisma.leadHonorario.delete({ where: { id } });
    return { ok: true };
  }

  // ─── Parcelas (Payments) ────────────────────────────────

  async addPayment(leadHonorarioId: string, data: { amount: number; due_date: string }, tenantId?: string) {
    const hon = await this.prisma.leadHonorario.findUnique({ where: { id: leadHonorarioId } });
    if (!hon) throw new NotFoundException('Honorário não encontrado');
    if (tenantId && (await this.doLab(tenantId)) && !(await this.daContaDoLab(tenantId, hon))) {
      throw new NotFoundException(LAB_COBRANCA_AVULSA.naoEncontrada);
    }
    if (await this.contatoDeOutraConta(hon.lead_id, tenantId)) throw new NotFoundException('Honorário não encontrado');
    if (hon.status === 'CONVERTIDO') throw new ForbiddenException('Honorário já convertido');

    const dueDate = new Date(data.due_date);
    const payment = await this.prisma.leadHonorarioPayment.create({
      data: {
        lead_honorario_id: leadHonorarioId,
        amount: data.amount,
        due_date: dueDate,
        status: dueDate < new Date() ? 'ATRASADO' : 'PENDENTE',
      },
    });

    // Atualizar contagem de parcelas
    const count = await this.prisma.leadHonorarioPayment.count({ where: { lead_honorario_id: leadHonorarioId } });
    await this.prisma.leadHonorario.update({
      where: { id: leadHonorarioId },
      data: { installment_count: count },
    });

    return payment;
  }

  async deletePayment(paymentId: string, tenantId?: string, quem?: QuemPede) {
    const payment = await this.prisma.leadHonorarioPayment.findUnique({
      where: { id: paymentId },
      include: { lead_honorario: { select: { tenant_id: true, lead_id: true } } },
    });
    if (!payment) throw new NotFoundException('Parcela não encontrada');
    const lab = await this.doLab(tenantId);
    if (tenantId && lab && !(await this.daContaDoLab(tenantId, payment.lead_honorario))) {
      throw new NotFoundException(LAB_COBRANCA_AVULSA.parcelaNaoEncontrada);
    }
    if (await this.contatoDeOutraConta(payment.lead_honorario.lead_id, tenantId)) throw new NotFoundException('Parcela não encontrada');
    if (payment.status === 'PAGO') throw new ForbiddenException('Parcela já paga não pode ser excluída');
    // Laboratório: boleto em aberto é cancelado no Asaas antes (se o Asaas não confirmar, a parcela fica).
    if (tenantId && lab) await this.cancelarBoletoDaParcela(paymentId, tenantId, quem, LAB_COBRANCA_AVULSA.motivoExcluirParcela);

    await this.prisma.leadHonorarioPayment.delete({ where: { id: paymentId } });

    // Atualizar contagem
    const count = await this.prisma.leadHonorarioPayment.count({ where: { lead_honorario_id: payment.lead_honorario_id } });
    await this.prisma.leadHonorario.update({
      where: { id: payment.lead_honorario_id },
      data: { installment_count: count },
    });

    return { ok: true };
  }

  async markPaid(paymentId: string, data: { payment_method?: string }, tenantId?: string, quem?: QuemPede) {
    const payment = await this.prisma.leadHonorarioPayment.findUnique({
      where: { id: paymentId },
      include: {
        lead_honorario: {
          select: { tenant_id: true, lead_id: true, type: true, lead: { select: { name: true } } },
        },
      },
    });
    if (!payment) throw new NotFoundException('Parcela não encontrada');
    const lab = await this.doLab(tenantId);
    if (tenantId && lab && !(await this.daContaDoLab(tenantId, payment.lead_honorario))) {
      throw new NotFoundException(LAB_COBRANCA_AVULSA.parcelaNaoEncontrada);
    }
    if (await this.contatoDeOutraConta(payment.lead_honorario.lead_id, tenantId)) throw new NotFoundException('Parcela não encontrada');
    // Laboratório: parcela com boleto em aberto dá baixa nele no Asaas, e é essa baixa que
    // marca a parcela e lança a receita (um lançamento só, e o cliente não paga duas vezes).
    if (tenantId && lab) {
      const charge = await this.prisma.paymentGatewayCharge.findUnique({
        where: { lead_honorario_payment_id: paymentId },
        select: { status: true, received_in_cash: true },
      });
      if (charge && situacaoDaCobrancaDaParcela(charge) === 'ABERTA') {
        await assertAnyPermission(this.prisma, quem, ['operate_cash', 'manage_financial'], LAB_COBRANCA_AVULSA.soCaixaDaBaixa);
        await this.gateway().baixarCobrancaDaParcelaDoLab(paymentId, tenantId, { userId: quem?.id ?? null, paymentMethod: data.payment_method });
        return this.prisma.leadHonorarioPayment.findUnique({ where: { id: paymentId } });
      }
    }

    const updated = await this.prisma.leadHonorarioPayment.update({
      where: { id: paymentId },
      data: {
        status: 'PAGO',
        paid_at: new Date(),
        ...(data.payment_method && { payment_method: data.payment_method }),
      },
    });

    try {
      await this.financeiroService.createFromLeadHonorarioPayment(paymentId, payment.lead_honorario.tenant_id || undefined);
      this.logger.log(`[LEAD-HON] Transação financeira criada para pagamento ${paymentId}`);
    } catch (e: any) {
      this.logger.warn(`[LEAD-HON] Falha ao criar transação financeira: ${e.message}`);
    }

    return updated;
  }

  // ─── Atualizar vencidos ─────────────────────────────────

  async markOverduePayments() {
    const now = new Date();
    await this.prisma.leadHonorarioPayment.updateMany({
      where: {
        status: 'PENDENTE',
        due_date: { lt: now },
      },
      data: { status: 'ATRASADO' },
    });
  }
}
