/**
 * Mensalidade do LABORATÓRIO — as mesmas regras da clínica (planos, 14 dias de
 * teste, PIX/boleto/cartão, suspensão pelo BillingService.dailyBillingCheck), mas
 * cobrada na conta Asaas da plataforma (conta-asaas-da-plataforma.ts), nunca na
 * conta de uma clínica. O BillingService desvia para cá só quando a conta é de
 * laboratório; a clínica segue o caminho de sempre.
 *
 * Pagamento: o que vale é a lista de pagamentos da assinatura lida no Asaas. O aviso
 * do Asaas (webhook), a tela de Assinatura e a passada de hora em hora só disparam
 * essa leitura. Cada pagamento novo ativa a conta uma vez (troca condicional do
 * current_charge_id).
 */
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { getLabTenantIds, isLabTenant } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  chamarAsaas,
  ContaAsaasDaPlataforma,
  dataDoPagamento,
  ErroDoAsaas,
  lerContaDaPlataforma,
  PagamentoAsaas,
  primeiroEmAberto,
  ultimoPago,
  umMesDepois,
} from './conta-asaas-da-plataforma';

export const MSG_ASSINATURA_INDISPONIVEL =
  'A assinatura ainda não está disponível. Fale com o suporte: suporte@odontosystem.com.br';
export const MSG_ASSINATURA_JA_CRIADA =
  'Sua assinatura já está ativa. Para trocar de plano ou de forma de pagamento, fale com o suporte: suporte@odontosystem.com.br';

const FORMAS = new Set(['PIX', 'BOLETO', 'CREDIT_CARD']);
const DIA_MS = 24 * 3600_000;
/** Assinaturas lidas por passada (as mais antigas primeiro). */
const POR_PASSADA = 200;

/** O link de pagamento só sai se for um endereço https. */
function linkSeguro(v: unknown): string | null {
  return typeof v === 'string' && /^https:\/\/\S+$/.test(v) ? v : null;
}

@Injectable()
export class AssinaturaDoLaboratorioService {
  private readonly logger = new Logger('AssinaturaDoLaboratorio');

  constructor(private prisma: PrismaService) {}

  /** A conta é de laboratório? (cache de 60 s do @crm/shared; nunca rejeita) */
  ehLaboratorio(tenantId: unknown): Promise<boolean> {
    return isLabTenant(this.prisma, tenantId, (m) => this.logger.warn(m));
  }

  /** Pagamentos da assinatura no Asaas (a lista inteira, até 100). */
  private async pagamentos(conta: ContaAsaasDaPlataforma, assinaturaId: string): Promise<unknown[]> {
    const r = await chamarAsaas(conta, 'GET', `/subscriptions/${encodeURIComponent(assinaturaId)}/payments?limit=100`);
    return Array.isArray(r?.data) ? r.data : [];
  }

  /**
   * Lê os pagamentos da assinatura e aplica o pago mais recente, se for novo:
   * assinatura ACTIVE, próximo vencimento = um mês depois do vencimento pago e a
   * conta ativa de novo (menos a encerrada). Sem pagamento novo, não grava nada.
   */
  async sincronizar(
    subId: string,
    conta?: ContaAsaasDaPlataforma | null,
    agora: Date = new Date(),
  ): Promise<{ aplicado: boolean; emAberto: PagamentoAsaas | null }> {
    const c = conta ?? (await lerContaDaPlataforma(this.prisma));
    const sub = await this.prisma.saasSubscription.findUnique({ where: { id: subId } });
    if (!c || !sub?.asaas_subscription_id) return { aplicado: false, emAberto: null };

    const lista = await this.pagamentos(c, sub.asaas_subscription_id);
    const pago = ultimoPago(lista);
    const emAberto = primeiroEmAberto(lista);
    if (!pago || pago.id === sub.current_charge_id) return { aplicado: false, emAberto };

    // Só quem ainda vê o pagamento anterior grava: duas leituras ao mesmo tempo ativam uma vez.
    const troca = await this.prisma.saasSubscription.updateMany({
      where: { id: sub.id, current_charge_id: sub.current_charge_id },
      data: {
        status: 'ACTIVE',
        last_paid_at: dataDoPagamento(pago, agora),
        next_charge_date: umMesDepois(pago.dueDate),
        current_charge_id: pago.id,
      },
    });
    if (troca.count !== 1) return { aplicado: false, emAberto };

    await this.prisma.tenant.updateMany({
      where: { id: sub.tenant_id, status: { not: 'DELETED' } },
      data: { status: 'ACTIVE', suspended_at: null, suspended_reason: null },
    });
    this.logger.log(`[ASSINATURA-LAB] Pagamento ${pago.id} aplicado: conta ${sub.tenant_id}, assinatura ${sub.id}`);
    return { aplicado: true, emAberto };
  }

  /** GET /billing/me do laboratório: o mesmo formato da clínica + o pagamento em aberto. */
  async minhaAssinatura(tenantId: string) {
    const conta = await lerContaDaPlataforma(this.prisma);
    const atual = await this.prisma.saasSubscription.findUnique({
      where: { tenant_id: tenantId },
      select: { id: true, status: true, asaas_subscription_id: true },
    });
    let emAberto: PagamentoAsaas | null = null;
    if (conta && atual?.asaas_subscription_id && atual.status !== 'CANCELLED') {
      try {
        emAberto = (await this.sincronizar(atual.id, conta)).emAberto;
      } catch (e: any) {
        this.logger.warn(`[ASSINATURA-LAB] Leitura dos pagamentos falhou (conta ${tenantId}): ${e?.message}`);
      }
    }
    const subscription = await this.prisma.saasSubscription.findUnique({
      where: { tenant_id: tenantId },
      include: { plan: true },
    });
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, status: true, trial_ends_at: true, cpf_cnpj: true, email: true, phone: true },
    });
    return {
      tenant,
      subscription,
      assinatura_disponivel: !!conta,
      pagamento_pendente: emAberto
        ? { link: linkSeguro(emAberto.invoiceUrl), vencimento: emAberto.dueDate, valor: emAberto.value ?? null }
        : null,
    };
  }

  /**
   * POST /billing/checkout do laboratório. Cliente e assinatura na conta da
   * plataforma; a assinatura ainda sem pagamento pode ser trocada (a anterior sai
   * do Asaas antes); a já paga, só com o suporte.
   */
  async checkout(tenantId: string, body: { plan_slug?: unknown; billing_type?: unknown }, agora: Date = new Date()) {
    const forma = body?.billing_type;
    if (typeof forma !== 'string' || !FORMAS.has(forma)) {
      throw new BadRequestException('Forma de pagamento inválida: use PIX, BOLETO ou CREDIT_CARD.');
    }
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Conta não encontrada');
    if (!tenant.cpf_cnpj) throw new BadRequestException('Cadastre o CPF/CNPJ da conta antes de assinar');
    if (!tenant.email) throw new BadRequestException('Cadastre o e-mail da conta antes de assinar');

    const plan = typeof body?.plan_slug === 'string' ? await this.prisma.saasPlan.findUnique({ where: { slug: body.plan_slug } }) : null;
    if (!plan || !plan.active) throw new BadRequestException('Plano inválido');

    const conta = await lerContaDaPlataforma(this.prisma);
    if (!conta) throw new ConflictException(MSG_ASSINATURA_INDISPONIVEL);

    const existente = await this.prisma.saasSubscription.findUnique({ where: { tenant_id: tenantId } });
    if (existente?.asaas_subscription_id && existente.status !== 'CANCELLED') {
      // Um pagamento que ainda não chegou aqui conta antes de trocar.
      const lido = await this.sincronizar(existente.id, conta, agora);
      const status = lido.aplicado ? 'ACTIVE' : existente.status;
      if (status !== 'PENDING_PAYMENT') throw new ConflictException(MSG_ASSINATURA_JA_CRIADA);
      try {
        await chamarAsaas(conta, 'DELETE', `/subscriptions/${encodeURIComponent(existente.asaas_subscription_id)}`);
      } catch (e) {
        if (!(e instanceof ErroDoAsaas && e.status === 404)) throw e;
      }
    }

    // Cliente da conta na plataforma: o mesmo de antes (pela referência) ou um novo.
    const referenciaCliente = `saas-tenant-${tenant.id}`;
    const achados = await chamarAsaas(conta, 'GET', `/customers?externalReference=${encodeURIComponent(referenciaCliente)}&limit=1`);
    let clienteId: string | undefined = achados?.data?.[0]?.id;
    if (!clienteId) {
      const novo = await chamarAsaas(conta, 'POST', '/customers', {
        name: tenant.name,
        cpfCnpj: tenant.cpf_cnpj,
        email: tenant.email,
        mobilePhone: tenant.phone || undefined,
        externalReference: referenciaCliente,
      });
      clienteId = novo?.id;
    }
    if (!clienteId) throw new BadRequestException('O Asaas não devolveu o cliente. Tente de novo.');

    const primeiroVencimento = new Date(agora.getTime() + DIA_MS);
    const nextDueDate = primeiroVencimento.toISOString().slice(0, 10);
    const assinatura = await chamarAsaas(conta, 'POST', '/subscriptions', {
      customer: clienteId,
      billingType: forma,
      value: Math.round(Number(plan.price_monthly) * 100) / 100,
      nextDueDate,
      cycle: 'MONTHLY',
      description: `Mensalidade ${plan.name} - ${tenant.name}`,
      externalReference: `saas-sub-${tenant.id}`,
    });

    const dados = {
      tenant_id: tenantId,
      plan_id: plan.id,
      status: 'PENDING_PAYMENT',
      asaas_customer_id: clienteId,
      asaas_subscription_id: assinatura.id,
      current_charge_id: null,
      next_charge_date: primeiroVencimento,
      billing_type: forma,
    };
    await this.prisma.saasSubscription.upsert({ where: { tenant_id: tenantId }, create: dados, update: dados });
    await this.prisma.tenant.update({ where: { id: tenantId }, data: { plan: plan.slug.toUpperCase() } });

    // O link da primeira mensalidade (se o Asaas ainda não gerou, a tela busca de novo).
    let link: string | null = null;
    try {
      link = linkSeguro(primeiroEmAberto(await this.pagamentos(conta, assinatura.id))?.invoiceUrl);
    } catch (e: any) {
      this.logger.warn(`[ASSINATURA-LAB] Link da primeira mensalidade não lido (conta ${tenantId}): ${e?.message}`);
    }
    this.logger.log(`[ASSINATURA-LAB] Assinatura ${plan.slug} criada: conta ${tenantId}, ${forma}`);

    return {
      ok: true,
      subscription_id: assinatura.id,
      next_due_date: nextDueDate,
      plan: plan.name,
      message: `Assinatura ${plan.name} criada. Pague a primeira mensalidade para ativar.`,
      link_pagamento: link,
    };
  }

  /**
   * De hora em hora: lê as assinaturas de laboratório que podem ter pagamento novo
   * (as não ativas e as com vencimento até amanhã). Sem conta da plataforma ou sem
   * laboratório, não faz nada. Funciona sem o webhook configurado.
   */
  @Cron('25 * * * *', { timeZone: 'America/Maceio' })
  async sincronizarPendentes(agora: Date = new Date()): Promise<number> {
    try {
      const conta = await lerContaDaPlataforma(this.prisma);
      if (!conta) return 0;
      const labs = await getLabTenantIds(this.prisma, (m) => this.logger.warn(m));
      if (!labs.size) return 0;
      const subs = await this.prisma.saasSubscription.findMany({
        where: {
          tenant_id: { in: [...labs] },
          asaas_subscription_id: { not: null },
          status: { in: ['PENDING_PAYMENT', 'ACTIVE', 'PAST_DUE'] },
          OR: [
            { status: { not: 'ACTIVE' } },
            { next_charge_date: null },
            { next_charge_date: { lte: new Date(agora.getTime() + DIA_MS) } },
          ],
        },
        select: { id: true },
        orderBy: { updated_at: 'asc' },
        take: POR_PASSADA,
      });
      let aplicados = 0;
      for (const s of subs) {
        try {
          if ((await this.sincronizar(s.id, conta, agora)).aplicado) aplicados++;
        } catch (e: any) {
          this.logger.warn(`[ASSINATURA-LAB] Leitura da assinatura ${s.id} falhou: ${e?.message}`);
        }
      }
      return aplicados;
    } catch (e: any) {
      this.logger.warn(`[ASSINATURA-LAB] Passada de hora em hora falhou: ${e?.message}`);
      return 0;
    }
  }
}
