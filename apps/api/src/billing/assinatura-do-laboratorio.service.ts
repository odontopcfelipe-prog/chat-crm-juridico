/**
 * Mensalidade do LABORATÓRIO — as mesmas regras da clínica (planos, 14 dias de
 * teste, PIX/boleto/cartão, suspensão pelo BillingService.dailyBillingCheck) e a
 * mesma conta Asaas da assinatura das clínicas (conta-asaas-da-plataforma.ts), nunca
 * a conta Asaas do próprio laboratório. O BillingService desvia para cá só quando a
 * conta é de laboratório; a clínica segue o caminho de sempre.
 *
 * Pagamento: o que vale é a lista de pagamentos da assinatura lida no Asaas. O aviso
 * do Asaas (webhook), a tela de Assinatura e a passada de hora em hora só disparam
 * essa leitura. Cada pagamento novo (de vencimento depois do já aplicado) ativa a
 * conta uma vez (troca condicional do current_charge_id).
 *
 * Assinatura: uma por conta. Criar é feito sob trava por conta; assinatura que
 * ficou no Asaas sem estar no banco (pedido que caiu no meio) é apagada antes de
 * criar a nova, e a já criada só muda com o suporte.
 */
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { getLabTenantIds, isLab } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AsaasClient } from '../payment-gateway/asaas/asaas-client';
import {
  chamarAsaas,
  ContaAsaasDaPlataforma,
  dataDoPagamento,
  ErroDoAsaas,
  lerContaDaPlataforma,
  meioDia,
  PagamentoAsaas,
  primeiroEmAberto,
  ultimoPago,
  umMesDepois,
  vencimentoDe,
} from './conta-asaas-da-plataforma';

export const MSG_ASSINATURA_INDISPONIVEL =
  'A assinatura ainda não está disponível. Fale com o suporte: suporte@odontosystem.com.br';
export const MSG_ASSINATURA_JA_CRIADA =
  'Sua assinatura já foi criada. Para trocar de plano ou de forma de pagamento, fale com o suporte: suporte@odontosystem.com.br';
export const MSG_ASAAS_FORA = 'Não foi possível falar com o Asaas agora. Tente de novo em instantes.';

const FORMAS = new Set(['PIX', 'BOLETO', 'CREDIT_CARD']);
const DIA_MS = 24 * 3600_000;
/** Dias de atraso tolerados (os mesmos do BillingService.dailyBillingCheck). */
const TOLERANCIA_ATRASO_DIAS = 5;
/** Assinaturas lidas por passada (as mais novas primeiro). */
const POR_PASSADA = 500;

/** O link de pagamento só sai se for um endereço https. */
function linkSeguro(v: unknown): string | null {
  return typeof v === 'string' && /^https:\/\/\S+$/.test(v) ? v : null;
}

/** Erro do Asaas vira mensagem para a tela; o resto que não é HTTP, "tente de novo". */
function paraATela(e: unknown): unknown {
  if (e instanceof HttpException) return e;
  if (e instanceof ErroDoAsaas) return new BadRequestException(`O Asaas recusou: ${e.descricao}`);
  return new ServiceUnavailableException(MSG_ASAAS_FORA);
}

@Injectable()
export class AssinaturaDoLaboratorioService {
  private readonly logger = new Logger('AssinaturaDoLaboratorio');

  constructor(
    private prisma: PrismaService,
    // A conta da assinatura das clínicas: lida sempre sem conta (lerContaDaPlataforma).
    private asaas: AsaasClient,
  ) {}

  /**
   * A conta é de laboratório? Decide em que conta Asaas fica o dinheiro, então lê o
   * perfil direto (sem cache) e, se a leitura falhar, lança: nunca cai na clínica por erro.
   */
  async ehLaboratorio(tenantId: string): Promise<boolean> {
    const perfil = await this.prisma.tenantBusinessProfile.findUnique({
      where: { tenant_id: tenantId },
      select: { business_type: true },
    });
    return isLab(perfil?.business_type);
  }

  /** Pagamentos da assinatura no Asaas (a lista inteira, até 100). */
  private async pagamentos(conta: ContaAsaasDaPlataforma, assinaturaId: string): Promise<unknown[]> {
    const r = await chamarAsaas(conta, 'GET', `/subscriptions/${encodeURIComponent(assinaturaId)}/payments?limit=100`);
    return Array.isArray(r?.data) ? r.data : [];
  }

  /**
   * Lê os pagamentos da assinatura e aplica o pago mais recente, se for novo e de
   * vencimento depois do já aplicado (estorno do atual não faz o anterior valer de
   * novo). Próximo vencimento: o em aberto mais antigo, se houver um antes do pago;
   * senão um mês depois do pago. Em dia (até 5 dias de atraso): assinatura ACTIVE e
   * a conta ativa de novo (menos a encerrada); senão PAST_DUE e a conta fica como está.
   */
  async sincronizar(
    subId: string,
    conta?: ContaAsaasDaPlataforma | null,
    agora: Date = new Date(),
  ): Promise<{ aplicado: boolean; emAberto: PagamentoAsaas | null }> {
    const c = conta ?? (await lerContaDaPlataforma(this.asaas));
    const sub = await this.prisma.saasSubscription.findUnique({ where: { id: subId } });
    if (!c || !sub?.asaas_subscription_id) return { aplicado: false, emAberto: null };

    const lista = await this.pagamentos(c, sub.asaas_subscription_id);
    const pago = ultimoPago(lista);
    const emAberto = primeiroEmAberto(lista);
    if (!pago || pago.id === sub.current_charge_id) return { aplicado: false, emAberto };
    const jaAplicado = vencimentoDe(lista, sub.current_charge_id);
    if (jaAplicado && pago.dueDate <= jaAplicado) return { aplicado: false, emAberto };

    const devendo = emAberto && emAberto.dueDate < pago.dueDate ? emAberto : null;
    const proximo = devendo ? meioDia(devendo.dueDate) : umMesDepois(pago.dueDate);
    const emDia = proximo.getTime() >= agora.getTime() - TOLERANCIA_ATRASO_DIAS * DIA_MS;

    // Só quem ainda vê o pagamento anterior grava: duas leituras ao mesmo tempo ativam uma vez.
    const troca = await this.prisma.saasSubscription.updateMany({
      where: { id: sub.id, current_charge_id: sub.current_charge_id },
      data: {
        status: emDia ? 'ACTIVE' : 'PAST_DUE',
        last_paid_at: dataDoPagamento(pago, agora),
        next_charge_date: proximo,
        current_charge_id: pago.id,
      },
    });
    if (troca.count !== 1) return { aplicado: false, emAberto };

    if (emDia) {
      await this.prisma.tenant.updateMany({
        where: { id: sub.tenant_id, status: { not: 'DELETED' } },
        data: { status: 'ACTIVE', suspended_at: null, suspended_reason: null },
      });
    }
    this.logger.log(
      `[ASSINATURA-LAB] Pagamento ${pago.id} aplicado: conta ${sub.tenant_id}, assinatura ${sub.id}${emDia ? '' : ' (ainda em atraso)'}`,
    );
    return { aplicado: true, emAberto };
  }

  /** GET /billing/me do laboratório: o mesmo formato da clínica + o pagamento em aberto. */
  async minhaAssinatura(tenantId: string) {
    const conta = await lerContaDaPlataforma(this.asaas);
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

  /** POST /billing/checkout do laboratório: cliente e assinatura na conta da assinatura das clínicas. */
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

    const conta = await lerContaDaPlataforma(this.asaas);
    if (!conta) throw new ConflictException(MSG_ASSINATURA_INDISPONIVEL);

    try {
      // Um pedido por conta de cada vez (clique duplo, duas abas, duas réplicas).
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`assinatura-lab:${tenantId}`}))`;
          return this.criarAssinatura(conta, tenant, plan, forma, agora);
        },
        { maxWait: 10_000, timeout: 120_000 },
      );
    } catch (e) {
      throw paraATela(e);
    }
  }

  private async criarAssinatura(
    conta: ContaAsaasDaPlataforma,
    tenant: { id: string; name: string; cpf_cnpj: string | null; email: string | null },
    plan: { id: string; slug: string; name: string; price_monthly: unknown },
    forma: string,
    agora: Date,
  ) {
    const existente = await this.prisma.saasSubscription.findUnique({ where: { tenant_id: tenant.id } });
    if (existente?.asaas_subscription_id && existente.status !== 'CANCELLED') {
      throw new ConflictException(MSG_ASSINATURA_JA_CRIADA);
    }

    // Cliente da conta na plataforma: o mesmo de antes (pela referência) ou um novo.
    const referenciaCliente = `saas-tenant-${tenant.id}`;
    const achados = await chamarAsaas(conta, 'GET', `/customers?externalReference=${encodeURIComponent(referenciaCliente)}&limit=1`);
    let clienteId: string | undefined = achados?.data?.[0]?.id;
    if (clienteId) {
      // Assinatura que ficou no Asaas sem chegar ao banco: sem pagamento, sai; paga, só o suporte resolve.
      const delas = await chamarAsaas(conta, 'GET', `/subscriptions?customer=${encodeURIComponent(clienteId)}&limit=100`);
      for (const s of Array.isArray(delas?.data) ? delas.data : []) {
        if (typeof s?.id !== 'string' || !s.id) continue;
        if (ultimoPago(await this.pagamentos(conta, s.id))) {
          this.logger.error(`[ASSINATURA-LAB] Conta ${tenant.id}: assinatura ${s.id} paga no Asaas e fora do banco — suporte`);
          throw new ConflictException(MSG_ASSINATURA_JA_CRIADA);
        }
        try {
          await chamarAsaas(conta, 'DELETE', `/subscriptions/${encodeURIComponent(s.id)}`);
        } catch (e) {
          if (!(e instanceof ErroDoAsaas && e.status === 404)) throw e;
        }
        this.logger.warn(`[ASSINATURA-LAB] Conta ${tenant.id}: assinatura ${s.id} sem pagamento e fora do banco apagada`);
      }
    } else {
      const novo = await chamarAsaas(conta, 'POST', '/customers', {
        name: tenant.name,
        cpfCnpj: tenant.cpf_cnpj,
        email: tenant.email,
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
    if (typeof assinatura?.id !== 'string' || !assinatura.id) {
      throw new BadRequestException('O Asaas não devolveu a assinatura. Tente de novo.');
    }

    const dados = {
      tenant_id: tenant.id,
      plan_id: plan.id,
      status: 'PENDING_PAYMENT',
      asaas_customer_id: clienteId,
      asaas_subscription_id: assinatura.id,
      current_charge_id: null,
      next_charge_date: primeiroVencimento,
      billing_type: forma,
    };
    await this.prisma.saasSubscription.upsert({ where: { tenant_id: tenant.id }, create: dados, update: dados });
    await this.prisma.tenant.update({ where: { id: tenant.id }, data: { plan: plan.slug.toUpperCase() } });

    // O link da primeira mensalidade (se o Asaas ainda não gerou, a tela busca de novo).
    let link: string | null = null;
    try {
      link = linkSeguro(primeiroEmAberto(await this.pagamentos(conta, assinatura.id))?.invoiceUrl);
    } catch (e: any) {
      this.logger.warn(`[ASSINATURA-LAB] Link da primeira mensalidade não lido (conta ${tenant.id}): ${e?.message}`);
    }
    this.logger.log(`[ASSINATURA-LAB] Assinatura ${plan.slug} criada: conta ${tenant.id}, ${forma}`);

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
   * (as não ativas e as com vencimento até amanhã), as mais novas primeiro. Sem a conta
   * da assinatura ou sem laboratório, não faz nada. Funciona sem o webhook configurado.
   */
  @Cron('25 * * * *', { timeZone: 'America/Maceio' })
  async sincronizarPendentes(agora: Date = new Date()): Promise<number> {
    try {
      const conta = await lerContaDaPlataforma(this.asaas);
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
        orderBy: { created_at: 'desc' },
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
