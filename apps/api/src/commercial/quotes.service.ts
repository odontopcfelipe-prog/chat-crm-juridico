import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException, Inject, forwardRef, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { PortalAuthService } from '../portal/portal-auth.service';
import { QuoteVersionsService } from './quote-versions.service';
import { TreatmentPlanContractService } from './treatment-plan-contract.service';
import { TreatmentPlanBillingService } from './treatment-plan-billing.service';
import { ContractsService } from './contracts.service';
import { QuotePdfService } from './quote-pdf.service';
import { LeadsService } from '../leads/leads.service';
import { logCtx, fmtError } from '../common/logger/structured-logger';
import { Prisma } from '@crm/shared';

type ItemInput = {
  procedure_id: string;
  tooth_fdi?: string;
  quantity?: number;
  unit_price?: number;
  notes?: string;
  // Onda 3.2 (Fase 25) — dentista responsavel
  dentist_id?: string;
  // Onda 4.2 (Fase 25) — pagamento por procedimento
  payment_method?: string;
  installments_count?: number;
};

// Validade padrao quando operador nao informa — alinhada com norma de
// planos comerciais de clinicas dentais (orcamento "fica de pe" 30 dias).
const DEFAULT_VALID_DAYS = 30;
// Antecedencia da notificacao de expiracao (lembrete pro paciente)
const EXPIRY_REMINDER_DAYS = 3;

@Injectable()
export class QuotesService {
  private readonly logger = new Logger(QuotesService.name);

  constructor(
    private prisma: PrismaService,
    private moduleRef: ModuleRef,
    @Optional() @Inject(forwardRef(() => WhatsappService)) private whatsapp?: WhatsappService,
    @Optional() @Inject(forwardRef(() => PortalAuthService)) private portalAuth?: PortalAuthService,
    @Optional() private versions?: QuoteVersionsService,
    // Hook 3: TreatmentPlanContractService dispara ClickSign automaticamente
    // ao aceitar orçamento. @Optional pra não quebrar boot caso esteja
    // ausente (ex: em testes unitários do QuotesService).
    @Optional() private contractService?: TreatmentPlanContractService,
    // Onda 12.2: gera boletos Asaas (entrada + parcelas) ao aplicar
    // proposta aprovada pelo credit-check do Banco PASSOS.
    @Optional() private billingService?: TreatmentPlanBillingService,
    // Onda 14.24: gate de contrato antes de gerar cobranca. Bloqueia
    // approveAndBill se o quote tem contrato pendente nao assinado.
    @Optional() private contractsService?: ContractsService,
    // Onda 14.38: gera PDF do orcamento pra anexar no WhatsApp ao enviar
    // pro paciente (com secao "Proposta de pagamento" se chosen).
    @Optional() private pdfService?: QuotePdfService,
  ) {}

  async create(
    patientId: string,
    tenantId: string,
    userId: string,
    data: {
      valid_until?: string;
      discount_percent?: number;
      payment_terms?: string;
      notes?: string;
      items?: ItemInput[];
    },
  ) {
    // Onda 2.8 — log estruturado: contexto base aplicado em log de sucesso/erro
    const ctx = logCtx({
      tenant_id: tenantId,
      user_id: userId,
      action: 'create_quote',
      patient_id: patientId,
    });
    const start = Date.now();

    await this.assertPatientBelongsToTenant(patientId, tenantId);

    const items = data.items || [];
    const resolvedItems = await this.resolveItems(items, tenantId);
    const totals = this.computeTotals(resolvedItems, data.discount_percent || 0);

    // Onda 5 — orcamentos nao tem mais validade automatica.
    // Auto-expiracao desligada (cronDailyExpiry vira no-op). Mantem campo
    // valid_until no schema pra compatibilidade, mas so popula se admin
    // explicitamente passar uma data.
    const validUntil = data.valid_until ? new Date(data.valid_until) : null;

    // Onda 14.18 — calcula quote_number sequencial GLOBAL por tenant.
    // MAX(quote_number) atual + 1. Race condition possivel em criacoes
    // simultaneas, mas baixa probabilidade em contexto odontologico.
    const lastQuote = await this.prisma.quote.findFirst({
      where: { patient: { tenant_id: tenantId } },
      orderBy: { quote_number: 'desc' },
      select: { quote_number: true },
    });
    const nextQuoteNumber = (lastQuote?.quote_number || 0) + 1;

    try {
      const quote = await this.prisma.quote.create({
        data: {
          patient_id: patientId,
          created_by_user_id: userId,
          quote_number: nextQuoteNumber,
          valid_until: validUntil,
          discount_percent: data.discount_percent || 0,
          discount_value: totals.discount_value,
          subtotal: totals.subtotal,
          total_value: totals.total,
          payment_terms: data.payment_terms || null,
          notes: data.notes || null,
          items: {
            create: resolvedItems.map((i, idx) => ({
              procedure_id: i.procedure_id,
              tooth_fdi: i.tooth_fdi || null,
              quantity: i.quantity,
              unit_price: i.unit_price,
              total_price: i.total_price,
              notes: i.notes || null,
              order_index: idx,
            })),
          },
        },
        include: {
          items: {
            include: {
              procedure: {
                select: {
                  id: true,
                  name: true,
                  duration_minutes: true,
                  specialty: { select: { id: true, name: true } },
                },
              },
            },
          },
        },
      });

      this.logger.log(ctx({
        quote_id: quote.id,
        items_count: resolvedItems.length,
        total_value: Number(quote.total_value),
        duration_ms: Date.now() - start,
      }, 'Orcamento criado'));

      // ─── HOOK Quote.create -> Lead "Em Fechamento" ──────────────────────
      // Quando a dra cria orcamento, gradua o lead vinculado pro Funil 2.
      // Lead some do Kanban CRM (stage oculto) e aparece em /fechamentos.
      // Best-effort: roda em background, idempotente. Lógica delegada pra
      // LeadsService.graduateLeadToEmFechamento (reutilizada por start-attending).
      this.tryGraduateLead(patientId, tenantId, userId);

      return quote;
    } catch (e: any) {
      this.logger.error(ctx({
        duration_ms: Date.now() - start,
        error: fmtError(e),
      }, 'Falha ao criar orcamento'));
      throw e;
    }
  }

  /**
   * Helper: dispara graduação pra Em Fechamento via LeadsService (resolvido
   * via ModuleRef pra evitar ciclo no boot). Best-effort. Chamado em todo
   * ponto onde a dra "inicia/avanca" um orcamento — create, getOrCreateDraft.
   */
  private tryGraduateLead(patientId: string, tenantId: string, userId: string): void {
    try {
      const leadsService = this.moduleRef.get(LeadsService, { strict: false });
      if (!leadsService) return;
      leadsService.graduateLeadToEmFechamento(patientId, tenantId, userId).catch((err) =>
        this.logger.warn(`[QUOTE→EM_FECHAMENTO] Hook falhou pra patient ${patientId}: ${err?.message}`),
      );
    } catch {
      // LeadsService pode nao estar carregado em testes — ignorar
    }
  }

  /**
   * Onda 3.1 (Fase 25) — Pega DRAFT mais recente do paciente OU cria novo.
   *
   * Use case: dentista clica em dente do odontograma + procedimento;
   * frontend precisa adicionar item num quote DRAFT mas nao quer:
   *   1. Listar quotes pra ver se existe DRAFT
   *   2. Decidir: usar esse OU criar novo
   *   3. Race condition se 2 cliques simultaneos
   *
   * Aqui resolve em 1 query atomic. Se ha DRAFT, devolve. Se nao, cria
   * vazio com defaults padrao. Idempotente.
   */
  async getOrCreateDraft(patientId: string, tenantId: string, userId: string) {
    await this.assertPatientBelongsToTenant(patientId, tenantId);

    // Tenta achar DRAFT existente (mais recente, nao deletado)
    const existing = await this.prisma.quote.findFirst({
      where: {
        patient_id: patientId,
        status: 'DRAFT',
        deleted_at: null,
      },
      orderBy: { created_at: 'desc' },
      include: {
        items: {
          include: {
            procedure: {
              select: {
                id: true,
                name: true,
                duration_minutes: true,
                specialty: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });

    if (existing) {
      this.logger.log(logCtx({
        tenant_id: tenantId,
        user_id: userId,
        action: 'get_or_create_draft',
        patient_id: patientId,
      })({ quote_id: existing.id, reused: true }, 'DRAFT existente reutilizado'));
      // Mesmo reusando DRAFT antigo, graduar lead pra Em Fechamento.
      // Cobre o caso "dra ja tinha selecionado dentes no odontograma e
      // agora abriu o quote de novo" — lead precisa avancar pra refletir
      // a intencao de fechar. Idempotente.
      this.tryGraduateLead(patientId, tenantId, userId);
      return existing;
    }

    // Sem DRAFT — cria vazio (delegar pro create() que ja loga + valida)
    return this.create(patientId, tenantId, userId, { items: [] });
  }

  async findByPatient(patientId: string, tenantId: string) {
    await this.assertPatientBelongsToTenant(patientId, tenantId);
    const quotes = await this.prisma.quote.findMany({
      // Onda 25.6 — exclui soft-deletados da listagem normal
      where: { patient_id: patientId, deleted_at: null },
      orderBy: { created_at: 'desc' },
      include: {
        _count: { select: { items: true } },
        created_by: { select: { id: true, name: true } },
        // Onda 3.7 — items minimo pra classificar a categoria de fechamento.
        // Onda 7.2 — incluido approved_at pra calcular contadores parciais
        // no frontend (badge "X/Y aprovados" nos cards da lista).
        // Onda 9 — incluido quantity + procedure.duration_minutes pra somar
        // "horas de cadeira" e mostrar no card da aba Propostas.
        items: {
          select: {
            total_price: true,
            approved_at: true,
            quantity: true,
            procedure: {
              select: { name: true, category: true, duration_minutes: true },
            },
          },
        },
      },
    });
    return quotes.map((q) => ({
      ...q,
      closing_category: this.classifyQuoteColumn(q.items),
      // Onda 7.2 — contadores de aprovacao parcial (cheap, calculado aqui
      // pra evitar 2a query no frontend). approved_count = quantos items
      // ja foram aprovados; pending_count = total - approved_count.
      approved_count: q.items.filter((it) => it.approved_at !== null).length,
      pending_count: q.items.filter((it) => it.approved_at === null).length,
      // Onda 11.1 — valor monetario aprovado vs pendente (BUG: aba Propostas
      // estava usando total_value bruto, ignorando aprovacao parcial). Agora
      // o front pode mostrar "R$ a negociar" descontando o que ja foi aprovado.
      approved_value: q.items
        .filter((it) => it.approved_at !== null)
        .reduce((acc, it) => acc + Number(it.total_price), 0),
      pending_value: q.items
        .filter((it) => it.approved_at === null)
        .reduce((acc, it) => acc + Number(it.total_price), 0),
      // Onda 9 — soma de duration_minutes × quantity de cada item. Usado na
      // aba Propostas pra mostrar "−Xh cadeira" no card.
      total_duration_minutes: q.items.reduce(
        (acc, it) => acc + (it.procedure?.duration_minutes ?? 0) * (it.quantity ?? 1),
        0,
      ),
      // Onda 11 — conta linhas [CONTRAPROPOSTA ...] em notes pra exibir
      // badge "N propostas" no card da aba Propostas.
      counter_proposals_count: q.notes
        ? (q.notes.match(/\[CONTRAPROPOSTA /g) || []).length
        : 0,
    }));
  }

  async findOne(id: string, tenantId: string) {
    const quote = await this.prisma.quote.findUnique({
      where: { id },
      include: {
        patient: { select: { id: true, name: true, tenant_id: true, phone: true } },
        coupon: { select: { id: true, code: true, description: true, discount_type: true, discount_amount: true } },
        created_by: { select: { id: true, name: true } },
        items: {
          orderBy: { order_index: 'asc' },
          include: {
            procedure: {
              select: {
                id: true,
                name: true,
                code_tuss: true,
                duration_minutes: true,
                // Onda 3.7 — category necessaria pra classificacao de fechamento
                category: true,
                specialty: { select: { id: true, name: true } },
              },
            },
            // Onda 3.2 — dentista responsavel (nome p/ exibir no item)
            dentist: { select: { id: true, name: true } },
          },
        },
        treatment_plan: true,
        // Onda 3 — Anexos (Fase 24): retorna metadata pra UI mostrar contador.
        // Binario eh servido via /quote-attachments/:id/file separado.
        _count: { select: { attachments: true, versions: true } },
        // Onda 3b — Mostra origem da renegociacao (se vier de outro orcamento)
        renegotiated_from: {
          select: {
            id: true, status: true, total_value: true, created_at: true,
          },
        },
        // Onda 4.1 — quote pai (caso este tenha vindo de aprovacao parcial)
        accepted_from: {
          select: {
            id: true, status: true, total_value: true, created_at: true,
          },
        },
      },
    });
    if (!quote) throw new NotFoundException('Orcamento nao encontrado');
    if (quote.patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    // Onda 3.7 — closing_category exposto pra UI mostrar nome categorico
    return {
      ...quote,
      closing_category: this.classifyQuoteColumn(quote.items),
    };
  }

  async update(id: string, tenantId: string, data: Prisma.QuoteUncheckedUpdateInput) {
    const quote = await this.findOne(id, tenantId);
    // Onda 8.3 — `priority` e metadado de classificacao (aba Propostas) e nao
    // muda dados financeiros/itens. Pode ser alterado em qualquer status.
    // Onda 14.21 — `visible_in_proposals` segue o mesmo padrao: metadata de
    // UI (esconde da aba Propostas) sem afetar dados do orcamento.
    // Onda 14.26 — `requires_credit_check` idem: metadata de UI que decide
    // se parcelados desta venda exigem credit-check (toggle no painel).
    // Demais campos continuam bloqueados apos envio.
    const META_FIELDS = new Set(['priority', 'visible_in_proposals', 'requires_credit_check']);
    const onlyMetaChange =
      Object.keys(data).length > 0 &&
      Object.keys(data).every((k) => META_FIELDS.has(k));
    if (!onlyMetaChange && quote.status !== 'DRAFT') {
      throw new BadRequestException('Orcamento nao pode ser editado apos envio');
    }

    // Recalcula totais se desconto mudou
    if (data.discount_percent !== undefined) {
      const items = await this.prisma.quoteItem.findMany({
        where: { quote_id: id },
        select: { total_price: true },
      });
      const subtotal = items.reduce((acc, i) => acc + Number(i.total_price), 0);
      const discount_percent = Number(data.discount_percent) || 0;
      const discount_value = subtotal * (discount_percent / 100);
      data.subtotal = subtotal;
      data.discount_value = discount_value;
      data.total_value = subtotal - discount_value;
    }

    return this.prisma.quote.update({
      where: { id },
      data: {
        ...data,
        valid_until: data.valid_until ? new Date(data.valid_until as any) : data.valid_until,
      },
    });
  }

  /**
   * Onda 14.33 — Marca proposta como "ESCOLHIDA pra apresentar ao paciente".
   * Exclusiva por paciente: se ja existe outra chosen do mesmo paciente, ela
   * vira false antes desta virar true. Faz tudo numa transacao pra evitar
   * race condition (2 cliques rapidos do operador).
   *
   * Onda 14.38 — agora aceita opcionalmente a forma de pagamento + entrada
   * configuradas pelo operador no painel. Persiste pra que o PDF do
   * orcamento mostre a oferta exata apresentada ao paciente.
   *
   * Nao muda o status do Quote — e so um marcador visual de "aguardando
   * decisao do paciente sobre esta variacao". Na UI, esmaece as outras
   * propostas do paciente pra reduzir confusao visual.
   */
  async markAsChosenProposal(
    quoteId: string,
    tenantId: string,
    opts?: { payment_key?: string | null; down_payment?: number | null },
  ) {
    const quote = await this.findOne(quoteId, tenantId);

    // Onda 14.38 — sanitiza inputs. payment_key vazio/invalido vira null
    // (operador ainda nao escolheu forma de pagamento). down_payment >= 0
    // limitado pelo total do quote pra evitar negativo / overflow.
    const totalNum = Number(quote.total_value) || 0;
    const cleanPaymentKey = (typeof opts?.payment_key === 'string' && opts.payment_key.trim())
      ? opts.payment_key.trim().slice(0, 50)
      : null;
    const cleanDownPayment = typeof opts?.down_payment === 'number' && opts.down_payment > 0
      ? Math.min(opts.down_payment, totalNum)
      : 0;

    await this.prisma.$transaction(async (tx) => {
      // 1. Desmarca quaisquer outras chosen do mesmo paciente (so 1 por vez)
      await tx.quote.updateMany({
        where: {
          patient_id: quote.patient_id,
          is_chosen_proposal: true,
          NOT: { id: quoteId },
        },
        data: { is_chosen_proposal: false },
      });
      // 2. Marca esta como chosen + salva forma de pagamento congelada
      await tx.quote.update({
        where: { id: quoteId },
        data: {
          is_chosen_proposal: true,
          chosen_payment_key: cleanPaymentKey,
          chosen_down_payment: cleanDownPayment,
        },
      });
    });

    this.logger.log(
      `[Quote ${quoteId}] marcada como CHOSEN proposal pra paciente ${quote.patient_id}` +
      (cleanPaymentKey ? ` (payment=${cleanPaymentKey}, down=${cleanDownPayment})` : ''),
    );
    return this.findOne(quoteId, tenantId);
  }

  /** Onda 14.33 — Desmarca a proposta escolhida (volta ao estado neutro). */
  async unmarkChosenProposal(quoteId: string, tenantId: string) {
    await this.findOne(quoteId, tenantId); // valida tenant ownership
    await this.prisma.quote.update({
      where: { id: quoteId },
      data: { is_chosen_proposal: false },
    });
    this.logger.log(`[Quote ${quoteId}] desmarcada como CHOSEN proposal`);
    return this.findOne(quoteId, tenantId);
  }

  /**
   * Onda 10 — Salva contraproposta como linha estruturada em Quote.notes.
   *
   * Formato:
   *   [CONTRAPROPOSTA YYYY-MM-DD HH:mm] <priority> em <payment_label> = R$ <value>
   *   [CONTRAPROPOSTA YYYY-MM-DD HH:mm] <...> = R$ <...> — <nota opcional>
   *
   * Anexa no final do campo `notes` (preserva historico). Funciona em qualquer
   * status (DRAFT/SENT/ACCEPTED/REJECTED) — contraproposta e registro de
   * negociacao, nao muda dados financeiros.
   */
  async saveCounterProposal(
    quoteId: string,
    tenantId: string,
    data: { payment_label: string; final_value: number; note?: string },
  ) {
    const quote = await this.findOne(quoteId, tenantId);

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const timestamp =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}`;

    const priorityLabel =
      quote.priority === 'COMPLETO' ? 'Completo'
      : quote.priority === 'ESSENCIAL' ? 'Essencial'
      : quote.priority === 'URGENTE' ? 'Urgente'
      : 'Proposta';

    const valueFormatted = Number(data.final_value).toLocaleString('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

    let line = `[CONTRAPROPOSTA ${timestamp}] ${priorityLabel} em ${data.payment_label} = R$ ${valueFormatted}`;
    if (data.note && data.note.trim().length > 0) {
      line += ` — ${data.note.trim()}`;
    }

    const newNotes = quote.notes
      ? `${quote.notes}\n${line}`
      : line;

    return this.prisma.quote.update({
      where: { id: quoteId },
      data: { notes: newNotes },
      select: { id: true, notes: true },
    });
  }

  /**
   * Onda 13 — Adiciona bônus de fechamento ao quote.
   *
   * Registra linha estruturada em `notes` (parsing igual contraproposta).
   * Quando type=DESCONTO_EXTRA, ADICIONA o delta ao discount_percent atual e
   * recalcula total_value (descontos progressivos).
   *
   * Formato da linha:
   *   [BONUS YYYY-MM-DD HH:mm type=X valido_ate=YYYY-MM-DDTHH:mm delta=N] descricao
   */
  async addBonus(
    quoteId: string,
    tenantId: string,
    data: {
      type: string;
      description: string;
      valid_until: string;
      discount_percent_delta?: number;
    },
  ) {
    const quote = await this.findOne(quoteId, tenantId);

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const timestamp =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}`;

    let metadataExtra = '';
    let descriptionFinal = data.description;
    let updateData: Prisma.QuoteUncheckedUpdateInput = {};

    if (data.type === 'DESCONTO_EXTRA' && data.discount_percent_delta) {
      const currentDiscount = Number(quote.discount_percent || 0);
      const newDiscount = currentDiscount + data.discount_percent_delta;
      if (newDiscount > 100) {
        throw new BadRequestException('Desconto total nao pode ultrapassar 100%');
      }
      const subtotal = quote.items.reduce((acc, it) => acc + Number(it.total_price), 0);
      const newDiscountValue = subtotal * (newDiscount / 100);
      const newTotal = subtotal - newDiscountValue;

      updateData = {
        discount_percent: newDiscount,
        discount_value: newDiscountValue,
        total_value: newTotal,
      };

      metadataExtra = ` delta=${data.discount_percent_delta}`;
      descriptionFinal +=
        ` · valor: R$ ${Number(quote.total_value).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` +
        ` → R$ ${newTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` +
        ` (desconto ${currentDiscount}% → ${newDiscount}%)`;
    }

    const line =
      `[BONUS ${timestamp} type=${data.type} valido_ate=${data.valid_until}${metadataExtra}] ${descriptionFinal}`;

    const newNotes = quote.notes ? `${quote.notes}\n${line}` : line;

    const updated = await this.prisma.quote.update({
      where: { id: quoteId },
      data: { ...updateData, notes: newNotes },
      select: {
        id: true,
        notes: true,
        discount_percent: true,
        discount_value: true,
        total_value: true,
      },
    });

    this.logger.log(
      `[BONUS] Quote ${quoteId}: type=${data.type}, valid_until=${data.valid_until}` +
      (data.discount_percent_delta ? ` delta=${data.discount_percent_delta}%` : ''),
    );

    return updated;
  }

  /**
   * Onda 12.2 — Aplica financiamento aprovado pelo credit-check (Banco PASSOS).
   *
   * Orquestra o fluxo completo de fechamento:
   *   1. Aceita o quote (vira ACCEPTED + cria TreatmentPlan PENDING_SIGNATURE)
   *   2. Marca o TreatmentPlan diretamente como ACTIVE (pula assinatura
   *      pq o credit-check ja validou — flag `start_date` indica inicio)
   *   3. Gera os boletos Asaas via TreatmentPlanBillingService:
   *      - Entrada (1 boleto, vencimento +3 dias)
   *      - Parcelado (N boletos iguais, primeiro +33 dias)
   *   4. Persiste decision_id e source da consulta nas notes do plano
   *
   * Pre-condicoes:
   *   - quote DRAFT ou SENT
   *   - billingService injetado (CommercialModule)
   *   - Paciente com CPF cadastrado (validado pelo Asaas client)
   */

  /**
   * Onda 14.5 — Aprovar proposta e gerar cobranca conforme forma de pagamento.
   *
   * Orquestra:
   *   1. Aceita quote (vira ACCEPTED + cria TreatmentPlan)
   *   2. Marca plano como ACTIVE
   *   3. Gera cobranca Asaas:
   *      - PIX → 1 charge PIX (com QR code)
   *      - CREDIT_CARD → 1 charge parcelado (link Asaas hosted)
   *      - BOLETO (a vista) → 1 boleto
   *   4. Envia link pro paciente via WhatsApp (best effort, nao bloqueia)
   *   5. Retorna dados da cobranca pra UI exibir
   *
   * Boleto parcelado (Banco PASSOS) deve usar applyFinancing, nao este.
   */
  async approveAndBill(
    quoteId: string,
    tenantId: string,
    userId: string,
    data: {
      billing_type: 'PIX' | 'CREDIT_CARD' | 'BOLETO';
      value: number;
      installment_count?: number; // so CREDIT_CARD
    },
  ) {
    if (!this.billingService) {
      throw new BadRequestException('Servico de cobranca indisponivel');
    }

    // Onda 14.8 — logs por etapa pra debug + catch global com mensagens claras
    this.logger.log(`[APPROVE-AND-BILL] [step:start] Quote ${quoteId}`);

    try {
      // 0. Valida pre-condicoes (CPF + lead_id) ANTES de aceitar
      const quote = await this.findOne(quoteId, tenantId);
      this.logger.log(`[APPROVE-AND-BILL] [step:findOne] Quote ${quoteId} status=${quote.status}, items=${quote.items.length}`);

      await this.ensurePatientReadyForBilling(quote.patient_id, tenantId);
      this.logger.log(`[APPROVE-AND-BILL] [step:patient-ready] OK`);

      // Onda 14.24 — Gate de contrato.
      // Onda 14.34 — DESATIVADO (operador pediu pra nao ser obrigatorio
      // assinar contrato antes de aprovar/cobrar). Helper isBillingAllowed
      // continua disponivel pra reativacao futura — basta descomentar este
      // bloco. Por enquanto so loga warning se ha contrato pendente, sem
      // bloquear o fluxo de aprovacao.
      if (this.contractsService) {
        const check = await this.contractsService.isBillingAllowed(quoteId);
        if (!check.allowed) {
          this.logger.warn(
            `[APPROVE-AND-BILL] [step:contract-gate] Contrato pendente (${check.reason}) — segue sem bloquear (Onda 14.34)`,
          );
        }
      }

      // 1. Aceita SO se ainda DRAFT/SENT (idempotente)
      if (quote.status === 'DRAFT' || quote.status === 'SENT') {
        await this.accept(quoteId, tenantId, userId);
        this.logger.log(`[APPROVE-AND-BILL] [step:accept] Quote aceito`);
      } else {
        this.logger.log(`[APPROVE-AND-BILL] [step:accept-skip] Quote ja ${quote.status}`);
      }

      // 2. Busca o TreatmentPlan e ativa (idempotente)
      const plan = await this.prisma.treatmentPlan.findFirst({
        where: { quote_id: quoteId },
      });
      if (!plan) {
        throw new BadRequestException(
          'Plano de tratamento nao foi criado — verifique se o orcamento tem items',
        );
      }
      this.logger.log(`[APPROVE-AND-BILL] [step:plan-found] Plan ${plan.id} status=${plan.status}`);

      if (plan.status !== 'ACTIVE') {
        await this.prisma.treatmentPlan.update({
          where: { id: plan.id },
          data: { status: 'ACTIVE', start_date: new Date() },
        });
        this.logger.log(`[APPROVE-AND-BILL] [step:plan-activated]`);
      }

      // 3. Cria cobranca
      this.logger.log(`[APPROVE-AND-BILL] [step:charge-start] type=${data.billing_type} value=${data.value} installments=${data.installment_count ?? 1}`);
      const result = await this.billingService.createSimpleCharge(plan.id, tenantId, {
        billingType: data.billing_type,
        value: data.value,
        installmentCount: data.installment_count,
      });

      this.logger.log(
        `[APPROVE-AND-BILL] [step:done] Quote ${quoteId}: ${data.billing_type} ` +
        `${data.installment_count ? `${data.installment_count}x` : '1x'} R$ ${data.value}`,
      );

      return { quote_id: quoteId, ...result };
    } catch (err: any) {
      // Loga stack completo no servidor
      this.logger.error(
        `[APPROVE-AND-BILL] [FAILED] Quote ${quoteId} | err.name=${err?.name} | err.message=${err?.message}`,
        err?.stack,
      );

      // Re-throw BadRequest com mensagem clara se for erro conhecido
      if (err?.name === 'BadRequestException' || err?.status === 400) {
        throw err;
      }

      // Erros do Asaas vem com 4xx do axios. Extrai mensagem util.
      const asaasMsg = err?.message?.includes('[Asaas')
        ? err.message
        : null;
      if (asaasMsg) {
        throw new BadRequestException(`Erro Asaas: ${asaasMsg}`);
      }

      // Erro Prisma (constraint, etc)
      if (err?.code?.startsWith('P')) {
        throw new BadRequestException(`Erro de banco: ${err.code} — ${err.meta?.cause || err.message}`);
      }

      // Senao, propaga como 500 mesmo (caso desconhecido)
      throw err;
    }
  }

  /**
   * Onda 14.6 — Garante que paciente esta pronto pra cobranca:
   *  - tem CPF (Asaas exige pra criar customer)
   *  - tem lead_id (PaymentGatewayCustomer.lead_id e obrigatorio)
   *
   * Se faltar lead_id, tenta vincular um lead existente pelo telefone,
   * ou cria um lead "fantasma" minimo so pra associar (sem stage especifico).
   */
  private async ensurePatientReadyForBilling(patientId: string, tenantId: string) {
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { id: true, name: true, phone: true, cpf: true, lead_id: true },
    });
    if (!patient) throw new BadRequestException('Paciente nao encontrado');
    if (!patient.cpf) {
      throw new BadRequestException(
        'Paciente sem CPF cadastrado. Edite o paciente e adicione o CPF antes de gerar cobranca.',
      );
    }

    if (patient.lead_id) return; // ja tem lead, OK

    // Tenta vincular lead existente pelo telefone
    if (patient.phone) {
      const existingLead = await this.prisma.lead.findUnique({
        where: { phone: patient.phone },
      });
      if (existingLead) {
        await this.prisma.patient.update({
          where: { id: patientId },
          data: { lead_id: existingLead.id },
        });
        this.logger.log(`[APPROVE-AND-BILL] Vinculou lead existente ${existingLead.id} ao paciente ${patientId}`);
        return;
      }
    }

    // Cria lead minimo (fantasma) so pra ter um lead_id pro Asaas customer
    if (!patient.phone) {
      throw new BadRequestException(
        'Paciente sem telefone. Edite o paciente e adicione o telefone antes de gerar cobranca.',
      );
    }
    const newLead = await this.prisma.lead.create({
      data: {
        tenant_id: tenantId,
        name: patient.name,
        phone: patient.phone,
        origin: 'AUTO_CREATED_FROM_PATIENT',
        is_client: true,
        became_client_at: new Date(),
      },
    });
    await this.prisma.patient.update({
      where: { id: patientId },
      data: { lead_id: newLead.id },
    });
    this.logger.log(`[APPROVE-AND-BILL] Criou lead fantasma ${newLead.id} pra paciente ${patientId}`);
  }

  async applyFinancing(
    quoteId: string,
    tenantId: string,
    userId: string,
    data: {
      down_payment_value: number;
      installment_count: number;
      installment_value: number;
      decision_id?: string;
      source?: 'internal' | 'asaas_history' | 'serasa';
    },
  ) {
    if (!this.billingService) {
      throw new BadRequestException(
        'Servico de cobranca indisponivel. Tente novamente em alguns segundos.',
      );
    }

    // Onda 14.6 — Valida pre-condicoes ANTES de aceitar
    const quoteCheck = await this.findOne(quoteId, tenantId);
    await this.ensurePatientReadyForBilling(quoteCheck.patient_id, tenantId);

    // 1. Aceita o quote SO se ainda DRAFT/SENT (idempotente)
    if (quoteCheck.status === 'DRAFT' || quoteCheck.status === 'SENT') {
      await this.accept(quoteId, tenantId, userId);
    }

    // 2. Busca o TreatmentPlan recem-criado e marca como ACTIVE
    const plan = await this.prisma.treatmentPlan.findFirst({
      where: { quote_id: quoteId },
    });
    if (!plan) {
      throw new BadRequestException(
        'Plano de tratamento nao foi criado — verifique se o orcamento tem items',
      );
    }

    const decisionTag = data.decision_id
      ? `\n[FINANCING ${new Date().toISOString().slice(0, 16).replace('T', ' ')}] Aprovado pelo Banco PASSOS (decision_id: ${data.decision_id}, source: ${data.source || 'internal'})`
      : '';

    await this.prisma.treatmentPlan.update({
      where: { id: plan.id },
      data: {
        status: 'ACTIVE',
        start_date: new Date(),
        notes: (plan.notes || '') + decisionTag,
      },
    });

    // 3. Gera os boletos
    const result = await this.billingService.createFinancingCharges(plan.id, tenantId, {
      downPaymentValue: data.down_payment_value,
      installmentCount: data.installment_count,
      installmentValue: data.installment_value,
    });

    this.logger.log(
      `[APPLY-FINANCING] Quote ${quoteId} aplicado: plano ${plan.id} ACTIVE | ` +
      `entrada R$ ${data.down_payment_value} + ${data.installment_count}x R$ ${data.installment_value}`,
    );

    return {
      quote_id: quoteId,
      ...result,
    };
  }

  async send(id: string, tenantId: string, userId?: string) {
    const quote = await this.findOne(id, tenantId);
    if (quote.status !== 'DRAFT') {
      throw new BadRequestException('Apenas orcamentos em DRAFT podem ser enviados');
    }

    const updated = await this.prisma.quote.update({
      where: { id },
      data: { status: 'SENT', sent_at: new Date() },
    });

    // Onda 3b — snapshot automatico do estado enviado (preserva pra renegociacao futura)
    if (this.versions && userId) {
      await this.versions.createSnapshot(id, userId, 'SEND').catch((e) =>
        this.logger.warn(`[VERSION] snapshot SEND falhou: ${e?.message}`),
      );
    }

    return updated;
  }

  async accept(id: string, tenantId: string, userId?: string) {
    const quote = await this.findOne(id, tenantId);
    // Onda 3.7 — DRAFT tambem pode ser aceito (operador confirma direto sem
    // passar pelo portal — caso comum: paciente fechou na recepcao). Auto-seta
    // sent_at quando aceitar de DRAFT pra registrar que houve um envio implicito.
    if (!['DRAFT', 'SENT'].includes(quote.status)) {
      throw new BadRequestException(
        `Apenas orcamentos DRAFT/SENT podem ser aceitos. Status atual: ${quote.status}`,
      );
    }

    // Onda 3b — snapshot da versao final antes de mudar pra ACCEPTED
    if (this.versions && userId) {
      await this.versions.createSnapshot(id, userId, 'ACCEPT').catch((e) =>
        this.logger.warn(`[VERSION] snapshot ACCEPT falhou: ${e?.message}`),
      );
    }

    // Transacao: marca quote + cria TreatmentPlan + TreatmentPlanItems
    const result = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const acceptedQuote = await tx.quote.update({
        where: { id },
        data: {
          status: 'ACCEPTED',
          accepted_at: now,
          // Onda 3.7 — se aceitando direto de DRAFT, registra sent_at agora pra
          // manter audit trail consistente (todo aceito teve um "envio").
          ...(quote.status === 'DRAFT' && !quote.sent_at ? { sent_at: now } : {}),
        },
      });

      const plan = await tx.treatmentPlan.create({
        data: {
          patient_id: quote.patient_id,
          quote_id: id,
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
        include: { items: true },
      });

      return { quote: acceptedQuote, treatment_plan: plan };
    });

    // ─── HOOK 3: Quote ACCEPTED → dispara ClickSign automaticamente ──────
    // Após o orçamento ser aceito + plano de tratamento criado, manda o TCLE
    // pro paciente assinar via WhatsApp. Se falhar, NÃO bloqueia o accept
    // (operador pode reenviar manualmente via UI). Roda em background.
    //
    // Pré-requisitos pro ClickSign:
    //   - Patient com lead_id (auto-criado pelo Hook 1 se veio do funil)
    //   - Patient.phone preenchido
    // Se faltar, sendForSignature lança BadRequest e a operação é silenciada.
    if (this.contractService) {
      this.contractService.sendForSignature(result.treatment_plan.id, tenantId)
        .then(({ signingUrl }) => {
          this.logger.log(`[ACCEPT→CLICKSIGN] Plano ${result.treatment_plan.id} enviado pra assinatura — ${signingUrl.slice(0, 60)}...`);
        })
        .catch((err: any) => {
          this.logger.warn(`[ACCEPT→CLICKSIGN] Falha ao disparar assinatura do plano ${result.treatment_plan.id}: ${err?.message}. Operador pode reenviar manualmente.`);
        });
    }

    // ─── HOOK 5 (Onda 5e v34): Programa de Afiliado ─────────────────────
    // Se o paciente desta quote tem referred_by_id apontando pra um Patient
    // afiliado, cria AffiliateReferral creditando 3% (ou pct configurado)
    // do valor total no saldo do afiliado. Idempotente (pula se ja existe
    // referral pra essa quote_id) e best-effort (nao bloqueia o accept).
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AffiliateService } = require('../patients/affiliate.service');
      const affiliateService = this.moduleRef.get(AffiliateService, { strict: false });
      if (affiliateService) {
        affiliateService
          .recordReferralFromAcceptedQuote({
            quoteId: id,
            patientId: quote.patient_id,
            treatmentValue: Number(quote.total_value),
            tenantId,
          })
          .catch((err: any) =>
            this.logger.warn(`[ACCEPT→AFFILIATE] Hook falhou: ${err?.message}`),
          );
      }
    } catch (e: any) {
      this.logger.warn(`[ACCEPT→AFFILIATE] AffiliateService indisponivel: ${e?.message}`);
    }

    return result;
  }

  /**
   * Onda 4.3 (Fase 25) — Trackear view do portal pelo paciente.
   *
   * Chamado pelo frontend do portal quando paciente abre orcamento via
   * magic link. Endpoint publico (sem auth) — mas valida que o quote
   * existe via id. Atualiza:
   *   - portal_view_count (incrementa atomic)
   *   - portal_last_viewed_at (sobrescreve com agora)
   *
   * Idempotente — N chamadas simultaneas resultam em N+ view_count
   * (atomic increment via Prisma).
   *
   * NAO valida tenant nem requer auth — id do quote eh opaco (UUID),
   * sem risco de enumeration. Pior caso: alguem com link fica spam-ando
   * counter (impacto minimo, log estruturado registra origem).
   */
  async trackPortalView(quoteId: string) {
    try {
      await this.prisma.quote.update({
        where: { id: quoteId },
        data: {
          portal_view_count: { increment: 1 },
          portal_last_viewed_at: new Date(),
        },
      });
      return { ok: true };
    } catch (e: any) {
      // 404 sem revelar detalhe (security)
      this.logger.warn(`[QUOTE-VIEW] Tentativa de track em quote inexistente: ${quoteId}`);
      return { ok: false };
    }
  }

  /**
   * Onda 4.1 (Fase 25) — Aprovar SO ALGUNS items do orcamento.
   *
   * Cenario: paciente recebeu orcamento de R$ 5000 com 5 procedimentos,
   * topa fechar 3 (R$ 3000) e quer pensar nos outros 2.
   *
   * Antes: tudo-ou-nada (Aceitar = todos, Rejeitar = nenhum). Perde 60%
   * da venda porque paciente trava.
   *
   * Agora: cria 2 quotes:
   *   - ORIGINAL: vira REJECTED com motivo automatico (fica historico
   *     do que foi proposto vs nao aceito)
   *   - NOVO: ACCEPTED apontando pra accepted_from_id=ORIGINAL,
   *     contendo so os items selecionados, gera TreatmentPlan
   *
   * Items NAO selecionados: ficam preservados no quote ORIGINAL (REJECTED).
   * Operadora pode usar "Renegociar" (Onda 3b) pra criar novo DRAFT
   * apenas com os rejeitados se quiser tentar fechar depois.
   */
  async acceptPartial(
    id: string,
    tenantId: string,
    selectedItemIds: string[],
    userId?: string,
  ) {
    const quote = await this.findOne(id, tenantId);
    // Onda 3.8 — DRAFT tambem pode ser aprovado parcialmente (operador
    // confirma na recepcao sem passar pelo portal). Auto-seta sent_at no
    // novo quote pra manter audit trail.
    if (!['DRAFT', 'SENT'].includes(quote.status)) {
      throw new BadRequestException(
        `Apenas orcamentos DRAFT/SENT podem ser aprovados parcialmente. Status atual: ${quote.status}`,
      );
    }
    if (!selectedItemIds || selectedItemIds.length === 0) {
      throw new BadRequestException('Selecione ao menos 1 item pra aprovar');
    }
    if (selectedItemIds.length === quote.items.length) {
      throw new BadRequestException(
        'Aprovacao parcial requer pelo menos 1 item NAO selecionado. Use accept() pra aprovar tudo.',
      );
    }

    // Filtra apenas items que pertencem a este quote (seguranca)
    const selectedItems = quote.items.filter((it) => selectedItemIds.includes(it.id));
    if (selectedItems.length !== selectedItemIds.length) {
      throw new BadRequestException('Alguns item_ids nao pertencem a este orcamento');
    }

    // Recalcula totais do parcial (sem desconto cupom — paciente pode
    // re-aplicar no novo se desejar)
    const subtotal = selectedItems.reduce((acc, it) => acc + Number(it.total_price), 0);
    // Aplica desconto proporcional do original (mantem coerencia)
    const discountPct = Number(quote.discount_percent || 0);
    const discountValue = subtotal * (discountPct / 100);
    const totalValue = subtotal - discountValue;

    // Onda 3.8 — Items que FICAM no original (nao selecionados). Vao
    // continuar disponiveis pra venda futura. Calcula novo total do
    // original.
    const remainingItems = quote.items.filter(
      (it) => !selectedItemIds.includes(it.id),
    );
    const remainingSubtotal = remainingItems.reduce(
      (acc, it) => acc + Number(it.total_price),
      0,
    );
    const remainingDiscountValue = remainingSubtotal * (discountPct / 100);
    const remainingTotalValue = remainingSubtotal - remainingDiscountValue;

    // Snapshot do original ANTES da mudanca (preserva historico)
    if (this.versions && userId) {
      await this.versions
        .createSnapshot(
          id,
          userId,
          'MANUAL',
          `Aprovacao parcial: ${selectedItems.length}/${quote.items.length} items movidos para novo orcamento ACCEPTED — restantes ficam neste`,
        )
        .catch((e) => this.logger.warn(`[VERSION] snapshot parcial falhou: ${e?.message}`));
    }

    // Transaction: remove items selecionados do original + recalcula totais
    // + cria novo Quote ACCEPTED com items copiados + TreatmentPlan
    return this.prisma.$transaction(async (tx) => {
      // 1. Onda 3.8 — Remove os items SELECIONADOS do original (eles foram
      // pro novo). Os items NAO selecionados ficam no original pra venda
      // futura. Original mantem status (DRAFT continua DRAFT, SENT continua
      // SENT — operador pode renviar se quiser).
      await tx.quoteItem.deleteMany({
        where: {
          quote_id: id,
          id: { in: selectedItemIds },
        },
      });

      // 2. Atualiza totais do original com items restantes + marca origem nas
      //    notes pra deixar claro que veio de aprovacao parcial. (Onda 5)
      //    O title NAO eh mais sobrescrito — se o operador ja deu nome
      //    customizado ("teste", "Reabilitacao superior"), preserva.
      //    Frontend detecta "resto de aprovacao parcial" via notes prefix,
      //    nao via title. So seta titulo default se quote ainda nao tiver nome.
      const remainderTag = `[Resto de aprovacao parcial em ${new Date().toLocaleDateString('pt-BR')}]`;
      const alreadyTagged = (quote.notes || '').startsWith('[Resto de aprovacao parcial');
      const newNotes = alreadyTagged
        ? quote.notes
        : (quote.notes ? `${remainderTag}\n${quote.notes}` : remainderTag);
      const updateData: Prisma.QuoteUpdateInput = {
        notes: newNotes,
        subtotal: remainingSubtotal,
        discount_value: remainingDiscountValue,
        total_value: remainingTotalValue,
      };
      // So define titulo default se ainda nao houver
      if (!quote.title || !quote.title.trim()) {
        updateData.title = 'Procedimento restante';
      }
      await tx.quote.update({
        where: { id },
        data: updateData,
      });

      // 3. Cria novo Quote ACCEPTED com items selecionados.
      // Onda 5 — herda title do original pra preservar o nome dado pelo
      // operador ("teste", "Reabilitacao superior"). Equipe distingue da
      // versao "restante" pelo status ACCEPTED (fundo verde) vs DRAFT
      // (fundo amber). Pode editar depois se quiser.
      // Tambem nao herda o prefix "[Resto de aprovacao parcial...]" das
      // notes — esse prefix so vai pro restante (que fica no original).
      const acceptedNotes = (quote.notes || '').startsWith('[Resto de aprovacao parcial')
        ? null
        : quote.notes;
      // Onda 14.19 — aprovacao parcial cria um quote NOVO. Sem isso o quote
      // sai com quote_number=0 (default da coluna) e fica sem identificador
      // nas listas. MAX+1 dentro do tx — leitura ve o estado atual da tx.
      const lastForTenant = await tx.quote.findFirst({
        where: { patient: { tenant_id: tenantId } },
        orderBy: { quote_number: 'desc' },
        select: { quote_number: true },
      });
      const nextQuoteNumber = (lastForTenant?.quote_number || 0) + 1;
      const acceptedQuote = await tx.quote.create({
        data: {
          patient_id: quote.patient_id,
          created_by_user_id: userId || quote.created_by_user_id,
          status: 'ACCEPTED',
          accepted_at: new Date(),
          accepted_from_id: id, // rastreio pro historico
          title: quote.title, // preserva nome do operador
          quote_number: nextQuoteNumber,
          subtotal,
          discount_percent: discountPct,
          discount_value: discountValue,
          total_value: totalValue,
          payment_terms: quote.payment_terms,
          notes: acceptedNotes,
          valid_until: quote.valid_until,
          items: {
            create: selectedItems.map((qi, idx) => ({
              procedure_id: qi.procedure_id,
              tooth_fdi: qi.tooth_fdi,
              quantity: qi.quantity,
              unit_price: qi.unit_price,
              total_price: qi.total_price,
              notes: qi.notes,
              order_index: idx,
              dentist_id: (qi as any).dentist_id || null, // Onda 3.2
            })),
          },
        },
      });

      // 4. Cria TreatmentPlan a partir do novo quote ACCEPTED
      const plan = await tx.treatmentPlan.create({
        data: {
          patient_id: quote.patient_id,
          quote_id: acceptedQuote.id,
          status: 'PENDING_SIGNATURE',
          total_value: totalValue,
          items: {
            create: selectedItems.map((qi, idx) => ({
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
        include: { items: true },
      });

      this.logger.log(logCtx({
        tenant_id: tenantId,
        user_id: userId,
        action: 'accept_partial_quote',
        original_quote_id: id,
      })({
        new_quote_id: acceptedQuote.id,
        treatment_plan_id: plan.id,
        items_accepted: selectedItems.length,
        items_total: quote.items.length,
        accepted_value: totalValue,
        // Onda 3.8 — items restantes ficam disponiveis no original
        items_remaining: remainingItems.length,
        remaining_value: remainingTotalValue,
      }, 'Orcamento aprovado parcialmente — restantes preservados no original'));

      return {
        original_quote_id: id,
        accepted_quote: acceptedQuote,
        treatment_plan: plan,
        // Onda 3.8 — frontend usa isso pra mostrar mensagem clara ao operador
        items_remaining_in_original: remainingItems.length,
        remaining_total_value: remainingTotalValue,
      };
    });
  }

  async reject(id: string, tenantId: string, reason?: string, userId?: string) {
    const quote = await this.findOne(id, tenantId);
    if (quote.status !== 'SENT') {
      throw new BadRequestException('Apenas orcamentos SENT podem ser rejeitados');
    }

    const updated = await this.prisma.quote.update({
      where: { id },
      data: { status: 'REJECTED', rejected_at: new Date(), rejection_reason: reason || null },
    });

    // Onda 3b — snapshot da versao rejeitada
    if (this.versions && userId) {
      await this.versions.createSnapshot(id, userId, 'REJECT', reason).catch((e) =>
        this.logger.warn(`[VERSION] snapshot REJECT falhou: ${e?.message}`),
      );
    }

    return updated;
  }

  /**
   * Onda 25.6 (Fase 25) — Soft delete: marca deleted_at + deleted_by_user_id
   * em vez de delete fisico. Permite recuperar via restore() por 30 dias.
   * Job futuro fara hard delete dos antigos pra evitar inflar o banco.
   */
  async remove(id: string, tenantId: string, userId?: string) {
    const quote = await this.findOne(id, tenantId);
    if (quote.status !== 'DRAFT') {
      throw new BadRequestException('Apenas rascunhos podem ser removidos');
    }
    return this.prisma.quote.update({
      where: { id },
      data: {
        deleted_at: new Date(),
        deleted_by_user_id: userId || null,
      },
    });
  }

  /**
   * Onda 25.6 — Restaura orcamento soft-deletado (admin only).
   * Limpa deleted_at + deleted_by_user_id.
   */
  async restore(id: string, tenantId: string) {
    // Acessa o quote ignorando o filtro de soft-delete
    const quote = await this.prisma.quote.findUnique({
      where: { id },
      include: { patient: { select: { tenant_id: true } } },
    });
    if (!quote) throw new NotFoundException('Orçamento não encontrado');
    if (quote.patient.tenant_id !== tenantId) {
      throw new NotFoundException('Orçamento não encontrado');
    }
    if (!quote.deleted_at) {
      throw new BadRequestException('Orçamento não está deletado');
    }
    return this.prisma.quote.update({
      where: { id },
      data: { deleted_at: null, deleted_by_user_id: null },
    });
  }

  /**
   * Onda 25.6 — Lista orcamentos soft-deletados nos ultimos 30 dias do tenant.
   * Pra tela admin de recuperacao.
   */
  async listDeleted(tenantId: string) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    return this.prisma.quote.findMany({
      where: {
        deleted_at: { gte: thirtyDaysAgo, not: null },
        patient: { tenant_id: tenantId },
      },
      orderBy: { deleted_at: 'desc' },
      include: {
        patient: { select: { id: true, name: true } },
        deleted_by: { select: { id: true, name: true } },
        _count: { select: { items: true } },
      },
    });
  }

  // ─── QuoteItem ────────────────────────────────────────────────

  async addItem(quoteId: string, tenantId: string, input: ItemInput) {
    const quote = await this.findOne(quoteId, tenantId);
    if (quote.status !== 'DRAFT') {
      throw new BadRequestException('Itens so podem ser adicionados em rascunhos');
    }
    const [resolved] = await this.resolveItems([input], tenantId);
    const item = await this.prisma.quoteItem.create({
      data: {
        quote_id: quoteId,
        procedure_id: resolved.procedure_id,
        tooth_fdi: resolved.tooth_fdi || null,
        quantity: resolved.quantity,
        unit_price: resolved.unit_price,
        total_price: resolved.total_price,
        notes: resolved.notes || null,
        order_index: quote.items.length,
        // Onda 3.2 — dentista responsavel (opcional)
        dentist_id: input.dentist_id || null,
        // Onda 4.2 — pagamento por procedimento (opcional)
        payment_method: input.payment_method || null,
        installments_count: input.installments_count || null,
      },
    });
    await this.recalcTotals(quoteId);
    return item;
  }

  async updateItem(
    itemId: string,
    tenantId: string,
    data: {
      tooth_fdi?: string; quantity?: number; unit_price?: number;
      notes?: string; order_index?: number;
      // Onda 3.2 — string vazia ou null limpa (sem dentista atribuido)
      dentist_id?: string | null;
      // Onda 4.2 — pagamento por procedimento (string vazia/null limpa)
      payment_method?: string | null;
      installments_count?: number | null;
    },
  ) {
    const item = await this.getItemEnsuringTenant(itemId, tenantId);
    if (item.quote.status !== 'DRAFT') {
      throw new BadRequestException('Itens so podem ser editados em rascunhos');
    }

    const patch: Prisma.QuoteItemUncheckedUpdateInput = { ...data };

    // Onda 3.2 — string vazia vira null (operacao "limpar dentista")
    if (data.dentist_id === '') {
      patch.dentist_id = null;
    }
    // Onda 4.2 — string vazia/null limpa pagamento por proc (volta pro default do quote)
    if (data.payment_method === '') {
      patch.payment_method = null;
      patch.installments_count = null; // limpa parcelas tb (incoerente sem method)
    }

    if (data.quantity !== undefined || data.unit_price !== undefined) {
      const qty = data.quantity ?? item.quantity;
      const price = data.unit_price ?? Number(item.unit_price);
      patch.total_price = qty * price;
    }
    const updated = await this.prisma.quoteItem.update({ where: { id: itemId }, data: patch });
    await this.recalcTotals(item.quote_id);
    return updated;
  }

  async removeItem(itemId: string, tenantId: string) {
    const item = await this.getItemEnsuringTenant(itemId, tenantId);
    if (item.quote.status !== 'DRAFT') {
      throw new BadRequestException('Itens so podem ser removidos em rascunhos');
    }
    await this.prisma.quoteItem.delete({ where: { id: itemId } });
    await this.recalcTotals(item.quote_id);
    return { ok: true };
  }

  // ─── Helpers ──────────────────────────────────────────────────

  /** Carrega procedures pra pegar preco base (quando unit_price nao informado). */
  private async resolveItems(items: ItemInput[], tenantId: string) {
    if (items.length === 0) return [];
    const procIds = [...new Set(items.map((i) => i.procedure_id))];
    const procs = await this.prisma.procedure.findMany({
      where: { id: { in: procIds }, tenant_id: tenantId },
      select: { id: true, base_price: true, tenant_id: true },
    });
    const byId = new Map(procs.map((p) => [p.id, p]));

    return items.map((i) => {
      const proc = byId.get(i.procedure_id);
      if (!proc) throw new BadRequestException(`Procedimento ${i.procedure_id} nao encontrado`);
      const quantity = i.quantity ?? 1;
      const unit_price = i.unit_price ?? Number(proc.base_price);
      const total_price = quantity * unit_price;
      return { ...i, quantity, unit_price, total_price };
    });
  }

  private computeTotals(items: { total_price: number }[], discountPercent: number) {
    const subtotal = items.reduce((acc, i) => acc + i.total_price, 0);
    const discount_value = subtotal * (discountPercent / 100);
    const total = subtotal - discount_value;
    return { subtotal, discount_value, total };
  }

  private async recalcTotals(quoteId: string) {
    const items = await this.prisma.quoteItem.findMany({
      where: { quote_id: quoteId },
      select: { total_price: true },
    });
    const quote = await this.prisma.quote.findUnique({
      where: { id: quoteId },
      select: { discount_percent: true },
    });
    const discountPercent = Number(quote?.discount_percent || 0);
    const totals = this.computeTotals(items.map((i) => ({ total_price: Number(i.total_price) })), discountPercent);
    await this.prisma.quote.update({
      where: { id: quoteId },
      data: {
        subtotal: totals.subtotal,
        discount_value: totals.discount_value,
        total_value: totals.total,
      },
    });
  }

  private async assertPatientBelongsToTenant(patientId: string, tenantId: string) {
    const row = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { tenant_id: true },
    });
    if (!row) throw new NotFoundException('Paciente nao encontrado');
    if (row.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
  }

  private async getItemEnsuringTenant(itemId: string, tenantId: string) {
    const item = await this.prisma.quoteItem.findUnique({
      where: { id: itemId },
      include: {
        quote: {
          select: { id: true, status: true, patient: { select: { tenant_id: true } } },
        },
      },
    });
    if (!item) throw new NotFoundException('Item nao encontrado');
    if (item.quote.patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    return item;
  }

  // ─── Onda 1 — Listagem global + Dashboard funil ────────────────

  /**
   * Lista TODOS os orcamentos do tenant com filtros (status, dentista, range
   * de datas). Substitui findByPatient quando operador quer visao geral
   * comercial (pagina /atendimento/orcamentos).
   */
  async findAll(
    tenantId: string,
    opts: {
      status?: string;
      createdById?: string;
      patientId?: string;
      from?: string; // ISO date
      to?: string;
      search?: string;
      limit?: number;
    } = {},
  ) {
    const limit = Math.min(500, Math.max(1, opts.limit || 100));
    const where: Prisma.QuoteWhereInput = {
      patient: { tenant_id: tenantId },
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.createdById ? { created_by_user_id: opts.createdById } : {}),
      ...(opts.patientId ? { patient_id: opts.patientId } : {}),
      ...(opts.from || opts.to
        ? {
            created_at: {
              ...(opts.from ? { gte: new Date(opts.from) } : {}),
              ...(opts.to ? { lte: new Date(opts.to) } : {}),
            },
          }
        : {}),
      ...(opts.search
        ? {
            patient: {
              tenant_id: tenantId,
              OR: [
                { name: { contains: opts.search, mode: 'insensitive' } },
                { phone: { contains: opts.search } },
                { cpf: { contains: opts.search } },
              ],
            },
          }
        : {}),
    };

    return this.prisma.quote.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: limit,
      include: {
        patient: { select: { id: true, name: true, phone: true } },
        created_by: { select: { id: true, name: true } },
        _count: { select: { items: true } },
      },
    });
  }

  /**
   * Dashboard funil de orcamentos: contagens e valores por status,
   * taxa de conversao, e expirando em ate 7 dias. Usado na pagina
   * /atendimento/orcamentos pra visao gerencial.
   */
  async getDashboardStats(
    tenantId: string,
    opts: { from?: string; to?: string } = {},
  ) {
    const where: Prisma.QuoteWhereInput = {
      patient: { tenant_id: tenantId },
      ...(opts.from || opts.to
        ? {
            created_at: {
              ...(opts.from ? { gte: new Date(opts.from) } : {}),
              ...(opts.to ? { lte: new Date(opts.to) } : {}),
            },
          }
        : {}),
    };

    const [grouped, expiringSoon] = await Promise.all([
      this.prisma.quote.groupBy({
        by: ['status'],
        where,
        _count: true,
        _sum: { total_value: true },
      }),
      this.prisma.quote.count({
        where: {
          patient: { tenant_id: tenantId },
          status: 'SENT',
          valid_until: {
            gte: new Date(),
            lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          },
        },
      }),
    ]);

    const byStatus: Record<string, { count: number; total: number }> = {
      DRAFT: { count: 0, total: 0 },
      SENT: { count: 0, total: 0 },
      ACCEPTED: { count: 0, total: 0 },
      REJECTED: { count: 0, total: 0 },
      EXPIRED: { count: 0, total: 0 },
    };
    for (const g of grouped) {
      byStatus[g.status] = {
        count: g._count,
        total: Number(g._sum.total_value) || 0,
      };
    }

    // Conversao = ACCEPTED / (ACCEPTED + REJECTED + EXPIRED) — exclui DRAFT/SENT
    // ainda em aberto. Reflete decisao final do paciente.
    const decided =
      byStatus.ACCEPTED.count + byStatus.REJECTED.count + byStatus.EXPIRED.count;
    const conversionRate = decided > 0 ? byStatus.ACCEPTED.count / decided : null;

    return {
      byStatus,
      total_count: Object.values(byStatus).reduce((s, x) => s + x.count, 0),
      pipeline_value: byStatus.SENT.total + byStatus.DRAFT.total,
      revenue_accepted: byStatus.ACCEPTED.total,
      conversion_rate: conversionRate,
      expiring_soon: expiringSoon,
    };
  }

  // ─── Closing Board — kanban de fechamentos por procedimento ───────────
  //
  // Vista dedicada à fase de fechamento de venda: orçamentos SENT
  // agrupados por procedimento principal (item de maior valor) em 6
  // colunas: LENTES_PORCELANA, FACETAS_RESINA, IMPLANTE, ORTODONTIA,
  // HARMONIZACAO_FACIAL, OUTROS.
  //
  // Header (summary): pipeline_value total, count_total em fechamento,
  // quantos vencem em 7d, quantos já expiraram, taxa de conversão dos
  // últimos 30 dias.
  //
  // Endpoint: GET /quotes/closing-board (commercial.controller.ts)
  // Frontend: /atendimento/fechamentos (kanban estilo "Advogado — Preparação")

  /**
   * Onda 3.7 — exposto como public pra ser usado no findOne/findByPatient
   * (nao so no closing-board). Frontend mostra o nome categorico na UI
   * "Plano de tratamento" do paciente: "#1 LENTES PORCELANAS · 3 itens".
   */
  classifyQuoteColumn(items: Array<{
    procedure: { category: string | null; name: string };
    total_price: any;
  }>): 'LENTES_PORCELANA' | 'FACETAS_RESINA' | 'IMPLANTE' | 'ORTODONTIA' | 'HARMONIZACAO_FACIAL' | 'OUTROS' {
    if (!items.length) return 'OUTROS';

    // Pega item de maior valor (= procedimento "principal" do orçamento)
    const main = items.reduce((max, it) =>
      Number(it.total_price) > Number(max.total_price) ? it : max,
    );
    const cat = (main.procedure.category || '').toUpperCase();
    const name = (main.procedure.name || '').toLowerCase();

    if (cat === 'IMPLANTE') return 'IMPLANTE';
    if (cat === 'ORTODONTIA') return 'ORTODONTIA';

    // Categorias estéticas faciais (Harmonização Orofacial)
    const HOF_CATS = new Set([
      'HOF', 'TOXINA_BOTULINICA', 'PREENCHIMENTO_AH', 'BIOESTIMULADOR',
      'FIOS_PDO', 'FIOS_PLLA', 'PEELING_QUIMICO', 'MICROAGULHAMENTO',
      'SKINBOOSTER', 'LASER', 'RADIOFREQUENCIA', 'ULTRASSOM_MICROFOCADO',
      'LIPO_ENZIMATICA', 'LIMPEZA_PELE',
    ]);
    if (HOF_CATS.has(cat)) return 'HARMONIZACAO_FACIAL';

    // ESTETICA_DENTAL precisa olhar o nome — pode ser lente OU faceta de resina
    if (cat === 'ESTETICA_DENTAL') {
      if (/lente|porcelan|cerâmic|ceramic|veneer|e\.?max|dissilicato/.test(name)) {
        return 'LENTES_PORCELANA';
      }
      if (/resina|faceta direta/.test(name)) {
        return 'FACETAS_RESINA';
      }
      // Clareamento e outros estéticos genéricos caem em OUTROS
    }

    // PROFILAXIA, DENTISTICA, ENDODONTIA, PERIODONTIA, PROTESE, CIRURGIA,
    // CLAREAMENTO solto, e qualquer categoria não mapeada
    return 'OUTROS';
  }

  /**
   * Onda 7.2 — Aprovar items IN-PLACE no mesmo orçamento (sem split).
   * Marca approved_at = now() nos items selecionados. Os items pendentes
   * (sem approved_at) ficam disponiveis pra futuras aprovacoes (paciente
   * volta proxima consulta e fecha mais).
   *
   * NAO altera Quote.status, NAO cria TreatmentPlan, NAO gera Installments.
   * Eh apenas o marcador de "esse item ja foi aprovado pelo paciente".
   * Idempotente: items ja aprovados nao mudam approved_at (preserva
   * timestamp original).
   */
  async approveItems(
    quoteId: string,
    tenantId: string,
    selectedItemIds: string[],
  ) {
    if (!selectedItemIds || selectedItemIds.length === 0) {
      throw new BadRequestException('Selecione ao menos 1 item pra aprovar');
    }

    // Valida quote existe + pertence ao tenant
    const quote = await this.findOne(quoteId, tenantId);

    // Filtra apenas items que pertencem a este quote (seguranca)
    const validIds = new Set(quote.items.map((it) => it.id));
    const safeIds = selectedItemIds.filter((id) => validIds.has(id));
    if (safeIds.length !== selectedItemIds.length) {
      throw new BadRequestException(
        'Alguns item_ids nao pertencem a este orcamento',
      );
    }

    // Marca os pendentes como aprovados. Items ja aprovados (approved_at
    // != null) sao ignorados pra preservar timestamp original.
    const now = new Date();
    const result = await this.prisma.quoteItem.updateMany({
      where: {
        id: { in: safeIds },
        quote_id: quoteId,
        approved_at: null, // so atualiza pendentes
      },
      data: { approved_at: now },
    });

    return {
      quote_id: quoteId,
      approved_count: result.count,
      already_approved: safeIds.length - result.count,
      approved_at: now,
    };
  }

  /**
   * Closing Board — orçamentos em fechamento agrupados por categoria.
   * Pensado pra UI kanban com 6 colunas + summary no topo.
   *
   * - status=SENT (filtra automaticamente — DRAFT, ACCEPTED, REJECTED, EXPIRED não aparecem)
   * - Agrupa pelo procedimento de MAIOR VALOR de cada quote
   * - Cards ordenados por urgência (vencendo primeiro)
   */
  async getClosingBoard(tenantId: string) {
    this.logger.log(`[CLOSING_BOARD] start tenantId=${tenantId}`);
    let quotes: any[];
    try {
      quotes = await this.prisma.quote.findMany({
        where: {
          patient: { tenant_id: tenantId },
          status: 'SENT',
        },
        include: {
          patient: { select: { id: true, name: true, phone: true } },
          items: {
            select: {
              id: true,
              total_price: true,
              quantity: true,
              procedure: { select: { name: true, category: true } },
            },
          },
          created_by: { select: { id: true, name: true } },
        },
        orderBy: [
          // valid_until pode ser null em alguns quotes — Prisma aceita {nulls: 'last'}
          { valid_until: { sort: 'asc', nulls: 'last' } },
        ],
      });
      this.logger.log(`[CLOSING_BOARD] findMany OK count=${quotes.length}`);
    } catch (err: any) {
      this.logger.error(`[CLOSING_BOARD] findMany FALHOU: ${err.message}`, err.stack);
      throw err;
    }

    // 6 colunas pré-inicializadas pra a UI sempre receber chave válida
    const COLUMNS = ['LENTES_PORCELANA', 'FACETAS_RESINA', 'IMPLANTE', 'ORTODONTIA', 'HARMONIZACAO_FACIAL', 'OUTROS'] as const;
    const byCategory: Record<string, any[]> = {};
    for (const c of COLUMNS) byCategory[c] = [];

    const now = Date.now();
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    let expiring7d = 0;

    for (const q of quotes) {
      const column = this.classifyQuoteColumn(q.items as any);
      const validUntilMs = q.valid_until ? q.valid_until.getTime() : null;
      const daysLeft = validUntilMs !== null
        ? Math.floor((validUntilMs - now) / (24 * 60 * 60 * 1000))
        : null;

      if (validUntilMs !== null && validUntilMs >= now && validUntilMs - now <= SEVEN_DAYS) {
        expiring7d++;
      }

      // Resumo curto do procedimento principal pra exibir no card
      const mainItem = q.items.length > 0
        ? q.items.reduce((max: any, it: any) =>
            Number(it.total_price) > Number(max.total_price) ? it : max,
          )
        : null;
      const mainProcedureName = mainItem?.procedure.name || '—';
      const itemsCount = q.items.length;

      byCategory[column].push({
        id: q.id,
        status: q.status,
        total_value: Number(q.total_value),
        valid_until: q.valid_until,
        days_left: daysLeft,
        sent_at: q.sent_at,
        whatsapp_read_at: q.whatsapp_read_at,
        portal_view_count: q.portal_view_count,
        portal_last_viewed_at: q.portal_last_viewed_at,
        patient: q.patient,
        created_by: q.created_by,
        main_procedure: mainProcedureName,
        items_count: itemsCount,
      });
    }

    // Summary header
    const pipelineValue = quotes.reduce((s, q) => s + Number(q.total_value), 0);

    // Conversão últimos 30d — soma quotes com decisão final (accepted/rejected/expired)
    // nos últimos 30 dias e calcula a taxa de aceite. Best-effort: se a query
    // falhar, deixa null em vez de derrubar o endpoint inteiro.
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
    let conversionRate30d: number | null = null;
    try {
      const [acc, rej, exp] = await Promise.all([
        this.prisma.quote.count({
          where: { patient: { tenant_id: tenantId }, status: 'ACCEPTED', accepted_at: { gte: thirtyDaysAgo } },
        }),
        this.prisma.quote.count({
          where: { patient: { tenant_id: tenantId }, status: 'REJECTED', rejected_at: { gte: thirtyDaysAgo } },
        }),
        this.prisma.quote.count({
          where: { patient: { tenant_id: tenantId }, status: 'EXPIRED', valid_until: { gte: thirtyDaysAgo } },
        }),
      ]);
      const totalDecided = acc + rej + exp;
      conversionRate30d = totalDecided > 0 ? acc / totalDecided : null;
    } catch (err: any) {
      this.logger.warn(`[CLOSING_BOARD] conversion_rate_30d falhou (mantendo null): ${err.message}`);
    }

    // Expirados totais (status já = EXPIRED, ainda visíveis pra ação manual)
    let expiredCount = 0;
    try {
      expiredCount = await this.prisma.quote.count({
        where: { patient: { tenant_id: tenantId }, status: 'EXPIRED' },
      });
    } catch (err: any) {
      this.logger.warn(`[CLOSING_BOARD] expiredCount falhou (mantendo 0): ${err.message}`);
    }

    const result = {
      summary: {
        pipeline_value: pipelineValue,
        count_total: quotes.length,
        expiring_7d: expiring7d,
        expired: expiredCount,
        conversion_rate_30d: conversionRate30d,
      },
      by_category: byCategory,
    };
    this.logger.log(`[CLOSING_BOARD] OK count=${quotes.length} pipeline=${pipelineValue}`);
    return result;
  }

  // ─── Onda 1 — Auto-expiracao + lembrete D-3 ────────────────────

  /**
   * Marca como EXPIRED orcamentos com status=SENT cuja valid_until
   * ja passou. Idempotente — pode rodar quantas vezes precisar.
   * Usado pelo cron diario E pode ser chamado manualmente via admin.
   */
  async expireOldQuotes(tenantId?: string): Promise<{ expired: number }> {
    const now = new Date();
    const where: Prisma.QuoteWhereInput = {
      status: 'SENT',
      valid_until: { lt: now },
      ...(tenantId ? { patient: { tenant_id: tenantId } } : {}),
    };
    const result = await this.prisma.quote.updateMany({
      where,
      data: { status: 'EXPIRED' },
    });
    if (result.count > 0) {
      this.logger.log(`[QUOTES] ${result.count} orcamento(s) auto-expirados`);
    }
    return { expired: result.count };
  }

  /**
   * Envia lembrete WhatsApp D-3 antes da expiracao pra orcamentos SENT.
   * "Seu orcamento expira em 3 dias, quer renegociar?". Best-effort —
   * roda no cron e nao bloqueia.
   */
  async sendExpiryReminders(): Promise<{ sent: number }> {
    if (!this.whatsapp) {
      this.logger.warn('[QUOTES] WhatsappService nao disponivel — pulando lembretes');
      return { sent: 0 };
    }
    // Janela: orcamentos SENT que expiram nos proximos 3 dias.
    // Usa window de 24h pra evitar duplicar lembrete (cron diario).
    const target = new Date();
    target.setDate(target.getDate() + EXPIRY_REMINDER_DAYS);
    const targetStart = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 0, 0, 0);
    const targetEnd = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 23, 59, 59);

    const candidates = await this.prisma.quote.findMany({
      where: {
        status: 'SENT',
        valid_until: { gte: targetStart, lte: targetEnd },
      },
      include: {
        patient: { select: { id: true, name: true, phone: true } },
      },
      take: 200,
    });

    let sent = 0;
    for (const q of candidates) {
      if (!q.patient?.phone) continue;
      try {
        const firstName = (q.patient.name || '').split(' ')[0] || 'Olá';
        const total = Number(q.total_value).toLocaleString('pt-BR', {
          style: 'currency', currency: 'BRL',
        });
        const validDate = q.valid_until?.toLocaleDateString('pt-BR') || '—';
        const msg =
          `Oi ${firstName}! 👋\n\n` +
          `Passando pra lembrar que seu orçamento (${total}) está prestes a expirar em ${validDate}.\n\n` +
          `Quer reservar agora ou tem alguma dúvida sobre o tratamento? É só responder por aqui que a gente conversa! 😊`;
        const result: any = await this.whatsapp.sendText(q.patient.phone, msg);
        if (result && result.statusCode < 400) sent++;
      } catch (e: any) {
        this.logger.warn(`[QUOTES] Lembrete D-3 falhou pra ${q.id}: ${e?.message}`);
      }
    }
    if (sent > 0) {
      this.logger.log(`[QUOTES] ${sent} lembrete(s) D-3 enviado(s)`);
    }
    return { sent };
  }

  /**
   * Cron diario — desativado na Onda 5: orcamentos nao expiram automaticamente
   * mais (decisao de produto). Os metodos `expireOldQuotes` e `sendExpiryReminders`
   * permanecem disponiveis pra chamada manual via admin se algum dia precisar.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cronDailyExpiry() {
    // No-op: auto-expiracao desligada. Para reativar, descomente:
    // await this.expireOldQuotes();
    // await this.sendExpiryReminders();
  }

  // ─── Onda 1 — Envio via WhatsApp ───────────────────────────────

  /**
   * Envia orcamento por WhatsApp pro paciente: gera magic link via portal,
   * monta mensagem custom com resumo (total, items, validade), envia via
   * Evolution. Atualiza status SENT + sent_at se ainda era DRAFT.
   *
   * Aceita re-envio em SENT (sem mudar status, so registra no log).
   */
  async sendByWhatsapp(quoteId: string, tenantId: string, userId?: string) {
    if (!this.whatsapp) {
      throw new BadRequestException('Servico de WhatsApp nao disponivel');
    }
    if (!this.portalAuth) {
      throw new BadRequestException('Servico de portal nao disponivel');
    }
    const quote = await this.findOne(quoteId, tenantId);
    if (!['DRAFT', 'SENT'].includes(quote.status)) {
      throw new BadRequestException(
        `Orcamento esta ${quote.status} — nao pode reenviar. Crie um novo orcamento se precisar.`,
      );
    }
    if (!quote.patient.phone) {
      throw new BadRequestException(
        'Paciente sem telefone cadastrado — adicione antes de enviar via WhatsApp.',
      );
    }

    // Gera magic link sem disparar mensagem automatica do portal
    // (vamos enviar uma mensagem custom com dados do orcamento)
    const magic = await this.portalAuth.createMagicLink(
      tenantId, quote.patient_id, 'OTHER',
    );

    // Mensagem custom com resumo
    const firstName = (quote.patient.name || '').split(' ')[0] || 'Olá';
    const formatBRL = (v: any) =>
      Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const itemCount = quote.items?.length || 0;
    const validUntil = quote.valid_until
      ? quote.valid_until.toLocaleDateString('pt-BR')
      : null;
    // Onda 3 — conta anexos pra mencionar na mensagem (gera curiosidade no paciente)
    const attachmentCount = (quote as any)._count?.attachments || 0;

    const msg =
      `Oi ${firstName}! 👋\n\n` +
      `Seu orçamento do Instituto Odonto Passos está pronto:\n\n` +
      `📋 ${itemCount} procedimento(s)\n` +
      `💰 Total: ${formatBRL(quote.total_value)}\n` +
      (Number(quote.discount_value) > 0
        ? `🎁 Desconto: ${formatBRL(quote.discount_value)}\n`
        : '') +
      (validUntil ? `📅 Válido até ${validUntil}\n` : '') +
      (attachmentCount > 0 ? `📎 ${attachmentCount} anexo(s) (fotos, exames)\n` : '') +
      `\nAcesse pra ver detalhes e aceitar:\n${magic.link}\n\n` +
      `Qualquer dúvida, é só responder por aqui. 😊`;

    let dispatchOk = false;
    let dispatchReason = '';
    let whatsappMessageId: string | null = null;

    // Onda 14.38 — Gera PDF do orcamento pra anexar. Inclui seçao "Proposta
    // de pagamento" quando is_chosen_proposal=true. Se geracao do PDF falhar,
    // cai no fluxo legado (so texto + link).
    let pdfBase64: string | null = null;
    try {
      if (this.pdfService) {
        const pdfBuffer = await this.pdfService.generatePdf(quoteId, tenantId);
        pdfBase64 = pdfBuffer.toString('base64');
        this.logger.log(`[QUOTES] PDF gerado pra anexar (${pdfBuffer.length} bytes)`);
      }
    } catch (e: any) {
      this.logger.warn(`[QUOTES] Falha ao gerar PDF, segue sem anexo: ${e?.message}`);
    }

    try {
      // Onda 14.38 — Se conseguimos gerar o PDF, envia como documento.
      // Caption = mensagem text. fileName = "orcamento-XXX.pdf".
      // Se nao tem PDF, fallback no sendText legado.
      const result: any = pdfBase64
        ? await this.whatsapp.sendMedia(
            quote.patient.phone,
            'document',
            `data:application/pdf;base64,${pdfBase64}`,
            msg,
            undefined,
            `orcamento-${(quote as any).quote_number || quoteId.slice(0, 8)}.pdf`,
          )
        : await this.whatsapp.sendText(quote.patient.phone, msg);
      dispatchOk = result && (!result.statusCode || result.statusCode < 400) && !result.error;
      if (!dispatchOk) {
        dispatchReason = result?.error || `HTTP ${result?.statusCode || '?'}`;
      }
      // Onda 4.3 — captura messageId pra crusar com webhook messages.update
      // (formato Evolution: { key: { id, fromMe, remoteJid }, ... })
      whatsappMessageId = result?.key?.id || result?.messageId || null;
    } catch (e: any) {
      dispatchReason = e?.message || 'erro desconhecido';
    }

    if (!dispatchOk) {
      throw new BadRequestException(
        `Falha ao enviar WhatsApp: ${dispatchReason}. Link gerado: ${magic.link}`,
      );
    }

    // Sucesso: marca como SENT (se ainda era DRAFT) + salva message_id
    const wasDraft = quote.status === 'DRAFT';
    await this.prisma.quote.update({
      where: { id: quoteId },
      data: {
        ...(wasDraft ? { status: 'SENT', sent_at: new Date() } : {}),
        // Onda 4.3 — atualiza message_id mesmo se for re-envio (sobrescreve antigo)
        ...(whatsappMessageId ? { whatsapp_message_id: whatsappMessageId } : {}),
      },
    });

    // Onda 3b — snapshot da versao enviada (se foi a primeira vez)
    if (wasDraft && this.versions && userId) {
      await this.versions.createSnapshot(quoteId, userId, 'SEND', 'Enviado via WhatsApp').catch((e) =>
        this.logger.warn(`[VERSION] snapshot SEND-WhatsApp falhou: ${e?.message}`),
      );
    }

    this.logger.log(
      `[QUOTES] Orcamento ${quoteId} enviado via WhatsApp pra ${quote.patient.phone}`,
    );
    return {
      ok: true,
      link: magic.link,
      sent_to: quote.patient.phone,
      status: 'SENT',
    };
  }
}
