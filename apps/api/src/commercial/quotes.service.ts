import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException, Inject, forwardRef, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { PortalAuthService } from '../portal/portal-auth.service';
import { QuoteVersionsService } from './quote-versions.service';
import { TreatmentPlanContractService } from './treatment-plan-contract.service';
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

    // Default valid_until = hoje + 30 dias se nao informado.
    // Nunca cria orcamento sem validade — vira problema na auto-expiracao.
    const validUntil = data.valid_until
      ? new Date(data.valid_until)
      : (() => {
          const d = new Date();
          d.setDate(d.getDate() + DEFAULT_VALID_DAYS);
          return d;
        })();

    try {
      const quote = await this.prisma.quote.create({
        data: {
          patient_id: patientId,
          created_by_user_id: userId,
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
    return this.prisma.quote.findMany({
      // Onda 25.6 — exclui soft-deletados da listagem normal
      where: { patient_id: patientId, deleted_at: null },
      orderBy: { created_at: 'desc' },
      include: {
        _count: { select: { items: true } },
        created_by: { select: { id: true, name: true } },
      },
    });
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
    return quote;
  }

  async update(id: string, tenantId: string, data: Prisma.QuoteUncheckedUpdateInput) {
    const quote = await this.findOne(id, tenantId);
    if (quote.status !== 'DRAFT') {
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
    if (quote.status !== 'SENT') {
      throw new BadRequestException('Apenas orcamentos SENT podem ser aceitos');
    }

    // Onda 3b — snapshot da versao final antes de mudar pra ACCEPTED
    if (this.versions && userId) {
      await this.versions.createSnapshot(id, userId, 'ACCEPT').catch((e) =>
        this.logger.warn(`[VERSION] snapshot ACCEPT falhou: ${e?.message}`),
      );
    }

    // Transacao: marca quote + cria TreatmentPlan + TreatmentPlanItems
    const result = await this.prisma.$transaction(async (tx) => {
      const acceptedQuote = await tx.quote.update({
        where: { id },
        data: { status: 'ACCEPTED', accepted_at: new Date() },
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
    if (quote.status !== 'SENT') {
      throw new BadRequestException('Apenas orcamentos SENT podem ser aprovados parcialmente');
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

    // Snapshot do original ANTES da mudanca (preserva historico)
    if (this.versions && userId) {
      await this.versions
        .createSnapshot(id, userId, 'REJECT', `Aprovacao parcial: ${selectedItems.length}/${quote.items.length} items aceitos`)
        .catch((e) => this.logger.warn(`[VERSION] snapshot REJECT falhou: ${e?.message}`));
    }

    // Transaction: marca original REJECTED + cria novo ACCEPTED + TreatmentPlan
    return this.prisma.$transaction(async (tx) => {
      // 1. Marca original como REJECTED (preserva items pra historico)
      await tx.quote.update({
        where: { id },
        data: {
          status: 'REJECTED',
          rejected_at: new Date(),
          rejection_reason: `Aprovacao parcial: ${selectedItems.length} de ${quote.items.length} items movidos pra novo orcamento ACCEPTED`,
        },
      });

      // 2. Cria novo Quote ACCEPTED com items selecionados
      const acceptedQuote = await tx.quote.create({
        data: {
          patient_id: quote.patient_id,
          created_by_user_id: userId || quote.created_by_user_id,
          status: 'ACCEPTED',
          accepted_at: new Date(),
          accepted_from_id: id, // rastreio pro historico
          subtotal,
          discount_percent: discountPct,
          discount_value: discountValue,
          total_value: totalValue,
          payment_terms: quote.payment_terms,
          notes: quote.notes,
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

      // 3. Cria TreatmentPlan a partir do novo quote ACCEPTED
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
        rejected_value: Number(quote.total_value) - totalValue,
      }, 'Orcamento aprovado parcialmente'));

      return {
        original_quote_id: id,
        accepted_quote: acceptedQuote,
        treatment_plan: plan,
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

  /** Determina a coluna do card a partir do item de maior valor. */
  private classifyQuoteColumn(items: Array<{
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

  /** Cron: roda 1x ao dia (3h da manhã, fora do horário comercial). */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cronDailyExpiry() {
    try {
      await this.expireOldQuotes();
      await this.sendExpiryReminders();
    } catch (e: any) {
      this.logger.error(`[QUOTES] cronDailyExpiry falhou: ${e?.message}`);
    }
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
    try {
      const result: any = await this.whatsapp.sendText(quote.patient.phone, msg);
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
