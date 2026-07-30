import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  Res,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
// Onda 17.52 — Etapa 1 do enforcement: escrita de orçamento/proposta/venda
// exige a permissão `manage_proposals` (antes qualquer logado escrevia/aprovava).
import { RequiresPermission } from '../auth/decorators/requires-permission.decorator';
import { QuotesService } from './quotes.service';
import { QuotePdfService } from './quote-pdf.service';
import { QuoteTemplatesService } from './quote-templates.service';
import type {
  CreateTemplateDto,
  UpdateTemplateDto,
} from './quote-templates.service';
import { QuoteCouponsService } from './quote-coupons.service';
import type { CreateCouponDto, UpdateCouponDto } from './quote-coupons.service';
import { QuoteAttachmentsService } from './quote-attachments.service';
import { QuoteVersionsService } from './quote-versions.service';
import { TreatmentPlansService } from './treatment-plans.service';
import { TreatmentPlanContractService } from './treatment-plan-contract.service';
import { TreatmentPlanBillingService } from './treatment-plan-billing.service';
import { DownPaymentFlowService } from './down-payment-flow.service';
import { AsaasClient } from '../payment-gateway/asaas/asaas-client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Authenticated } from '../auth/decorators/authenticated.decorator';
import type { AuthUser } from '../auth/decorators/authenticated.decorator';
import { Public } from '../auth/decorators/public.decorator';
import {
  CreateQuoteDto,
  UpdateQuoteDto,
  CreateQuoteItemDto,
  UpdateQuoteItemDto,
  OverrideItemPriceDto,
  RejectQuoteDto,
  SaveCounterProposalDto,
  CreditCheckSimulateDto,
  ApplyFinancingDto,
  ApproveAndBillDto,
  AddBonusDto,
  UpdateTreatmentPlanDto,
  UpdateTreatmentPlanItemDto,
  ExecuteTreatmentPlanItemDto,
} from './dto/commercial.dto';
import { CreditCheckService } from './credit-check.service';
import { ContractsService } from './contracts.service';
import { ContractPdfService } from './contract-pdf.service';

/**
 * Onda 2.1 — Migracao progressiva @Request() req: any -> @Authenticated() user.
 *
 * Endpoints de Quote ja migrados (servem de modelo):
 *   createQuote, listQuotes, findQuote, updateQuote, removeQuote,
 *   listDeletedQuotes, restoreQuote
 *
 * TODO migrar restante do controller (templates, coupons, attachments,
 * versions, treatment-plans). Padrao:
 *   - Trocar @Request() req: any por @Authenticated() user: AuthUser
 *   - Remover boilerplate "if (!tenantId) throw" (decorator ja garante)
 *   - Usar user.tenant_id e user.id direto
 */

@UseGuards(JwtAuthGuard)
@Controller()
export class CommercialController {
  constructor(
    private readonly quotesService: QuotesService,
    private readonly pdfService: QuotePdfService,
    private readonly templatesService: QuoteTemplatesService,
    private readonly couponsService: QuoteCouponsService,
    private readonly attachmentsService: QuoteAttachmentsService,
    private readonly versionsService: QuoteVersionsService,
    private readonly plansService: TreatmentPlansService,
    private readonly contractService: TreatmentPlanContractService,
    private readonly billingService: TreatmentPlanBillingService,
    private readonly downPaymentFlow: DownPaymentFlowService,
    private readonly creditCheckService: CreditCheckService,
    private readonly contractsService: ContractsService,
    private readonly contractPdfService: ContractPdfService,
    // Onda 17.32.71 — usado pra "Venda Rapida com Especie": apos
    // criar a charge PIX, marca como recebida em dinheiro no Asaas.
    private readonly asaasClient: AsaasClient,
  ) {}

  // ─── Quotes ───────────────────────────────────────────────────

  // ─── Quote endpoints — Onda 2.1: migrados pra @Authenticated() ────────

  @RequiresPermission('manage_proposals')
  @Post('patients/:patientId/quotes')
  createQuote(
    @Param('patientId') patientId: string,
    @Body() dto: CreateQuoteDto,
    @Authenticated() user: AuthUser,
  ) {
    return this.quotesService.create(patientId, user.tenant_id, user.id, dto);
  }

  /**
   * Onda 3.1 (Fase 25) — Pega DRAFT existente do paciente ou cria novo.
   * Usado pelo OdontogramaTab quando dentista adiciona procedimento via
   * click em dente. Evita race condition + descoberta manual.
   */
  @RequiresPermission('manage_proposals')
  @Post('patients/:patientId/quotes/draft-or-create')
  getOrCreateDraft(
    @Param('patientId') patientId: string,
    @Authenticated() user: AuthUser,
  ) {
    return this.quotesService.getOrCreateDraft(
      patientId,
      user.tenant_id,
      user.id,
    );
  }

  @RequiresPermission('manage_proposals', 'view_proposals')
  @Get('patients/:patientId/quotes')
  listQuotes(
    @Param('patientId') patientId: string,
    @Authenticated() user: AuthUser,
  ) {
    return this.quotesService.findByPatient(patientId, user.tenant_id);
  }

  /**
   * Closing Board — kanban dedicado à fase de fechamento (orçamentos SENT)
   * agrupados em 6 colunas: LENTES_PORCELANA, FACETAS_RESINA, IMPLANTE,
   * ORTODONTIA, HARMONIZACAO_FACIAL, OUTROS. Frontend: /atendimento/fechamentos.
   *
   * ⚠️ DEVE vir ANTES de @Get('quotes/:id') — caso contrário 'closing-board'
   * é capturado como :id e o handler retorna "Orçamento não encontrado".
   */
  @RequiresPermission('manage_proposals', 'view_proposals')
  @Get('quotes/closing-board')
  quotesClosingBoard(@Authenticated() user: AuthUser) {
    return this.quotesService.getClosingBoard(user.tenant_id);
  }

  /**
   * Dashboard funil — counts/valores por status + conversao + expirando.
   *
   * ⚠️ Onda 15 (etapa 19.1) — DEVE vir ANTES de @Get('quotes/:id'), pelo
   * mesmo motivo do closing-board. Antes estava la embaixo (linha ~439)
   * e era capturado como :id='dashboard' → "Orcamento nao encontrado".
   */
  @RequiresPermission('manage_proposals', 'view_proposals')
  @Get('quotes/dashboard')
  quotesDashboard(
    @Request() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.getDashboardStats(tenantId, { from, to });
  }

  /**
   * Rotas LITERAIS de quotes — DEVEM vir ANTES de @Get('quotes/:id').
   * No NestJS as rotas casam por ORDEM de declaracao; se 'quotes/deleted' ou
   * 'quotes/archived' ficarem depois de :id, a request bate em findQuote
   * (id='deleted'/'archived') → "Orcamento nao encontrado" e as listas nunca
   * carregam. (Mesmo bug do dashboard de afiliados, commit 86d1f4ef.)
   */
  /** Onda 25.6 — Lista orcamentos soft-deletados nos ultimos 30 dias (admin) */
  @RequiresPermission('manage_proposals')
  @Get('quotes/deleted')
  listDeletedQuotes(@Authenticated() user: AuthUser) {
    return this.quotesService.listDeleted(user.tenant_id);
  }

  /** Onda 17.32.38 — Lista orçamentos arquivados do tenant. */
  @RequiresPermission('manage_proposals', 'view_proposals')
  @Get('quotes/archived')
  listArchivedQuotes(@Authenticated() user: AuthUser) {
    return this.quotesService.listArchivedQuotes(user.tenant_id);
  }

  /**
   * Journey Board — pipeline pós-venda (Jornada do paciente → "Progresso").
   * Vendas FECHADAS (ACCEPTED) agrupadas por etapa do tratamento (a agendar /
   * agendado / em tratamento / concluído). Frontend: /atendimento/progresso.
   *
   * ⚠️ DEVE vir ANTES de @Get('quotes/:id') — senão 'journey-board' é
   * capturado como :id e retorna "Orçamento não encontrado".
   */
  @RequiresPermission('manage_proposals', 'view_proposals')
  @Get('quotes/journey-board')
  quotesJourneyBoard(@Authenticated() user: AuthUser) {
    return this.quotesService.getJourneyBoard(user.tenant_id);
  }

  // Ala de Ortodontia (Jornada do paciente) — quadro por dentista responsável.
  // ⚠️ Também DEVE vir ANTES de @Get('quotes/:id') (senão vira :id).
  @RequiresPermission('manage_proposals', 'view_proposals')
  @Get('quotes/ortho-board')
  quotesOrthoBoard(@Authenticated() user: AuthUser) {
    return this.quotesService.getOrthoBoard(user.tenant_id);
  }

  // Disparo "Equipe → Pacientes sem agendamento": prévia do texto + teste manual.
  @RequiresPermission('view_marketing')
  @Get('pacientes-sem-agendamento/preview')
  semAgendamentoPreview(@Authenticated() user: AuthUser) {
    return this.quotesService.buildSemAgendamentoDigest(user.tenant_id);
  }

  @RequiresPermission('view_marketing')
  @Post('pacientes-sem-agendamento/test')
  semAgendamentoTest(@Body() body: { phone?: string }, @Authenticated() user: AuthUser) {
    if (!body?.phone) throw new BadRequestException('Informe um número pra testar');
    return this.quotesService.sendSemAgendamentoTest(user.tenant_id, body.phone);
  }

  @RequiresPermission('manage_proposals', 'view_proposals')
  @Get('quotes/:id')
  findQuote(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.quotesService.findOne(id, user.tenant_id);
  }

  @RequiresPermission('manage_proposals')
  @Patch('quotes/:id')
  updateQuote(
    @Param('id') id: string,
    @Body() dto: UpdateQuoteDto,
    @Authenticated() user: AuthUser,
  ) {
    return this.quotesService.update(id, user.tenant_id, dto as any);
  }

  @RequiresPermission('manage_proposals')
  @Delete('quotes/:id')
  removeQuote(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.quotesService.remove(id, user.tenant_id, user.id);
  }

  /** Onda 25.6 — Restaura orcamento soft-deletado (volta pra listagem normal) */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/restore')
  restoreQuote(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.quotesService.restore(id, user.tenant_id);
  }

  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/send')
  sendQuote(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.send(id, tenantId, req.user?.id);
  }

  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/accept')
  acceptQuote(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.accept(id, tenantId, req.user?.id);
  }

  /**
   * Onda 4.3 (Fase 25) — Track view do portal (publico, sem auth).
   * Chamado pelo frontend do portal quando paciente abre orcamento.
   * Incrementa portal_view_count + atualiza portal_last_viewed_at.
   */
  @Public()
  @Post('quotes/:id/track-view')
  trackQuoteView(@Param('id') id: string) {
    return this.quotesService.trackPortalView(id);
  }

  /**
   * Onda 4.1 (Fase 25) — Aprovar SO ALGUNS items do orcamento.
   * Body: { item_ids: string[] }
   * Cria novo Quote ACCEPTED + TreatmentPlan com items selecionados.
   * Original vira REJECTED com motivo automatico (preserva historico).
   */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/accept-partial')
  acceptPartialQuote(
    @Param('id') id: string,
    @Body() body: { item_ids?: string[] },
    @Authenticated() user: AuthUser,
  ) {
    if (!Array.isArray(body?.item_ids) || body.item_ids.length === 0) {
      throw new BadRequestException(
        'item_ids[] eh obrigatorio (selecione ao menos 1)',
      );
    }
    return this.quotesService.acceptPartial(
      id,
      user.tenant_id,
      body.item_ids,
      user.id,
    );
  }

  /**
   * Onda 7.2 — Aprovar items IN-PLACE (no MESMO orcamento, sem split).
   * Body: { item_ids: string[] }
   * Marca approved_at = now() nos items selecionados. Items pendentes
   * ficam visiveis na lista pra aprovacao futura. Sem criar novo quote,
   * sem mexer em TreatmentPlan/Installments. Substitui o fluxo antigo
   * (accept-partial) que dividia em 2 quotes.
   */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/approve-items')
  approveItems(
    @Param('id') id: string,
    @Body() body: { item_ids?: string[] },
    @Authenticated() user: AuthUser,
  ) {
    if (!Array.isArray(body?.item_ids) || body.item_ids.length === 0) {
      throw new BadRequestException(
        'item_ids[] eh obrigatorio (selecione ao menos 1)',
      );
    }
    return this.quotesService.approveItems(
      id,
      user.tenant_id,
      body.item_ids,
    );
  }

  /**
   * Onda 10 — Salva contraproposta como linha em Quote.notes.
   * Frontend envia payment_label (ex: "PIX à vista", "6x no cartão") e
   * final_value (ja com desconto/juros aplicados). Note e opcional.
   */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/counter-proposal')
  saveCounterProposal(
    @Param('id') id: string,
    @Body() dto: SaveCounterProposalDto,
    @Authenticated() user: AuthUser,
  ) {
    return this.quotesService.saveCounterProposal(id, user.tenant_id, {
      payment_label: dto.payment_label,
      final_value: Number(dto.final_value),
      note: dto.note,
    });
  }

  /**
   * Onda 12 — Simula consulta de credito pro Financiamento Banco PASSOS.
   * MVP mock — decisao em ~1.5s baseada em regras renda × parcela.
   * Em producao: substituir credit-check.service por integracao Serasa.
   */
  @RequiresPermission('manage_proposals')
  @Post('credit-check/simulate')
  simulateCreditCheck(@Body() dto: CreditCheckSimulateDto, @Authenticated() user: AuthUser) {
    return this.creditCheckService.simulate({
      cpf: dto.cpf,
      tenantId: user.tenant_id,
      nome: dto.nome,
      data_nascimento: dto.data_nascimento,
      renda_mensal: Number(dto.renda_mensal),
      telefone: dto.telefone,
      profissao: dto.profissao,
      parcela_alvo: Number(dto.parcela_alvo),
      parcelas: dto.parcelas,
      valor_total: Number(dto.valor_total),
    });
  }

  /**
   * Onda 13 — Adiciona bônus de fechamento ao quote.
   * Quando type=DESCONTO_EXTRA, aplica desconto adicional ao quote (recalcula
   * total). Demais tipos ficam como texto no historico.
   */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/bonus')
  addBonus(
    @Param('id') id: string,
    @Body() dto: AddBonusDto,
    @Authenticated() user: AuthUser,
  ) {
    return this.quotesService.addBonus(id, user.tenant_id, {
      type: dto.type,
      description: dto.description,
      valid_until: dto.valid_until,
      discount_percent_delta:
        dto.discount_percent_delta !== undefined
          ? Number(dto.discount_percent_delta)
          : undefined,
    });
  }

  /**
   * Onda 14.5 — Aprova proposta + gera cobranca direta (PIX/Cartao/Boleto a vista).
   * Pra Boleto parcelado com entrada, usar /apply-financing.
   */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/approve-and-bill')
  approveAndBill(
    @Param('id') id: string,
    @Body() dto: ApproveAndBillDto,
    @Authenticated() user: AuthUser,
  ) {
    return this.quotesService.approveAndBill(id, user.tenant_id, user.id, {
      billing_type: dto.billing_type as 'PIX' | 'CREDIT_CARD' | 'BOLETO',
      value: Number(dto.value),
      installment_count: dto.installment_count,
      manual_payment_method: dto.manual_payment_method,
      received_in_clinic: dto.received_in_clinic,
      received_method: dto.received_method,
      auto_execute_items: dto.auto_execute_items,
      executed_by_dentist_id: dto.executed_by_dentist_id,
    });
  }

  /**
   * Onda 17.32.68 — Venda Rapida (balcao sem avaliacao).
   *
   * Cria um Quote+Plan+Charge em 1 unica chamada atomica:
   *   1. Cria Quote com items
   *   2. Aceita Quote (dispara accept hooks)
   *   3. approveAndBill (gera cobranca Asaas + cria TreatmentPlan ACTIVE)
   *
   * Diferente do fluxo normal, NAO passa pelo modal de avaliacao —
   * operador escolhe procedimentos prontos e finaliza na hora.
   * Usado em vendas de balcao: limpeza, clareamento, raspagem,
   * extracao simples, etc.
   */
  @RequiresPermission('manage_proposals')
  @Post('venda-rapida')
  async vendaRapida(
    @Body() dto: {
      patient_id: string;
      items: Array<{
        procedure_id: string;
        quantity?: number;
        dentist_id?: string;
        unit_price?: number;
      }>;
      payment: {
        // Onda 17.32.71 — Adicionado 'CASH' (especie). Backend cria
        // charge PIX e em seguida chama receiveInCash no Asaas pra
        // marcar como recebida em dinheiro.
        billing_type: 'PIX' | 'CREDIT_CARD' | 'BOLETO' | 'CASH';
        value: number;
        installment_count?: number;
        discount_percent?: number;
      };
      notes?: string;
    },
    @Authenticated() user: AuthUser,
  ) {
    if (!dto.items || dto.items.length === 0) {
      throw new Error('Selecione pelo menos 1 procedimento');
    }
    // 1. Cria Quote (com items)
    const quote = await this.quotesService.create(
      dto.patient_id,
      user.tenant_id,
      user.id,
      {
        items: dto.items.map((it) => ({
          procedure_id: it.procedure_id,
          quantity: it.quantity || 1,
          dentist_id: it.dentist_id,
          unit_price: it.unit_price,
        })),
        discount_percent: dto.payment.discount_percent || 0,
        notes: dto.notes || 'Venda rapida (balcao sem avaliacao)',
      },
    );
    // Onda 17.32.71 — CASH eh tratado como PIX no Asaas (cria charge
    // PIX) e depois marca como recebida em dinheiro. Operador nao
    // precisa mostrar QR — paciente ja pagou em mãos.
    const isCash = dto.payment.billing_type === 'CASH';
    const billingTypeForAsaas: 'PIX' | 'CREDIT_CARD' | 'BOLETO' =
      dto.payment.billing_type === 'CASH'
        ? 'PIX'
        : dto.payment.billing_type;

    // 2. approveAndBill (aceita + cria plan + gera charge)
    const result = await this.quotesService.approveAndBill(
      quote.id,
      user.tenant_id,
      user.id,
      {
        billing_type: billingTypeForAsaas,
        value: Number(dto.payment.value),
        installment_count: dto.payment.installment_count,
      },
    );

    // 3. Se CASH, marca a charge como recebida em dinheiro no Asaas
    //    (idempotente: se o webhook ja confirmou, retorna sucesso silencioso).
    if (isCash && result?.charge?.external_id) {
      try {
        const today = new Date().toISOString().slice(0, 10);
        await this.asaasClient.receiveInCash(
          result.charge.external_id,
          today,
          Number(dto.payment.value),
          user.tenant_id,
        );
      } catch (e: any) {
        // nao quebra — charge ja foi criada; operador pode marcar
        // como recebida manualmente depois
        console.warn(`[VENDA-RAPIDA] receiveInCash falhou pra ${result.charge.external_id}: ${e?.message}`);
      }
    }

    return {
      ...result,
      quote_id: quote.id,
      quote_number: quote.quote_number,
      // Onda 17.32.71 — Flag pro frontend saber que ja foi pago e
      // nao precisa mostrar QR PIX no dialog de sucesso.
      paid_in_cash: isCash,
    };
  }

  /**
   * Onda 12.2 — Aplica financiamento aprovado (chamado pelo botao "Aplicar
   * essa proposta" no modal Banco PASSOS apos credit-check approved).
   *
   * Cadeia: accept quote → cria TreatmentPlan → marca ACTIVE → gera boletos
   * (entrada +3d, parcelas +33d) via Asaas. Retorna URLs dos boletos.
   */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/apply-financing')
  applyFinancing(
    @Param('id') id: string,
    @Body() dto: ApplyFinancingDto,
    @Authenticated() user: AuthUser,
  ) {
    return this.quotesService.applyFinancing(id, user.tenant_id, user.id, {
      down_payment_value: Number(dto.down_payment_value),
      installment_count: dto.installment_count,
      installment_value: Number(dto.installment_value),
      decision_id: dto.decision_id,
      source: dto.source,
      // Onda 14.58 — sinal + datas customizadas (opcionais)
      signal_value: dto.signal_value !== undefined ? Number(dto.signal_value) : undefined,
      signal_method: dto.signal_method,
      entrada_due_date: dto.entrada_due_date,
      installments_start_date: dto.installments_start_date,
    });
  }

  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/reject')
  rejectQuote(
    @Param('id') id: string,
    @Body() dto: RejectQuoteDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.reject(
      id,
      tenantId,
      dto?.rejection_reason,
      req.user?.id,
    );
  }

  /**
   * Onda 14.33 — Marca proposta como "escolhida pra aguardar decisao do
   * paciente". Exclusiva por paciente: ao marcar uma, qualquer outra do
   * mesmo paciente que estivesse marcada e desmarcada. UI destaca a chosen
   * e esmaece as demais.
   *
   * Onda 14.38 — Body opcional aceita { payment_key, down_payment } pra
   * persistir a forma de pagamento + entrada apresentada pelo operador.
   * Esses dados aparecem na secao "Proposta de pagamento" do PDF gerado
   * (que e anexado ao WhatsApp em /send-whatsapp). */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/choose-as-proposal')
  chooseQuoteAsProposal(
    @Param('id') id: string,
    @Body() body: {
      payment_key?: string | null;
      down_payment?: number | null;
      // Onda 15 (etapa 16.8) — Persistir tambem o "Plano de cobranca da
      // entrada" inteiro, pra operador nao perder a configuracao ao salvar.
      signal_value?: number | null;
      signal_method?: string | null;
      entrada_due_date?: string | null;
      installments_start_date?: string | null;
      avista_discount_enabled?: boolean | null;
      sem_juros_enabled?: boolean | null;
    },
    @Authenticated() user: AuthUser,
  ) {
    return this.quotesService.markAsChosenProposal(id, user.tenant_id, {
      payment_key: body?.payment_key,
      down_payment: body?.down_payment,
      signal_value: body?.signal_value,
      signal_method: body?.signal_method,
      entrada_due_date: body?.entrada_due_date,
      installments_start_date: body?.installments_start_date,
      avista_discount_enabled: body?.avista_discount_enabled,
      sem_juros_enabled: body?.sem_juros_enabled,
    });
  }

  /** Onda 18 — config do desconto à vista (% por clínica) pro front montar o toggle. */
  @RequiresPermission('manage_proposals', 'view_proposals')
  @Get('quotes/config/avista-discount')
  getAvistaDiscountConfig(@Authenticated() user: AuthUser) {
    return this.quotesService.getAvistaDiscountConfig(user.tenant_id);
  }

  /** Onda 18 — clínica ajusta o % do desconto à vista (0 desliga geral). */
  @RequiresPermission('manage_proposals')
  @Patch('quotes/config/avista-discount')
  setAvistaDiscountConfig(@Body() body: { pct: number }, @Authenticated() user: AuthUser) {
    return this.quotesService.setAvistaDiscountPct(user.tenant_id, Number(body?.pct));
  }

  /** Onda 14.33 — Desmarca proposta escolhida (volta ao estado neutro). */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/unchoose-as-proposal')
  unchooseQuoteAsProposal(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.quotesService.unmarkChosenProposal(id, user.tenant_id);
  }

  /** Onda 17.32.38 — Arquivar orçamento (some de Propostas, vai pra Financeiro). */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/archive')
  archiveQuote(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.quotesService.archiveQuote(id, user.tenant_id, user.id);
  }

  /** Onda 17.32.38 — Desarquivar orçamento (volta pra Propostas). */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/unarchive')
  unarchiveQuote(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.quotesService.unarchiveQuote(id, user.tenant_id);
  }

  // ─── Onda 1 (Fase 24) — Listagem global + funil + WhatsApp ──────

  /** Lista TODOS os orcamentos do tenant (pagina /atendimento/orcamentos) */
  @RequiresPermission('manage_proposals')
  @Get('quotes')
  listAllQuotes(
    @Request() req: any,
    @Query('status') status?: string,
    @Query('createdById') createdById?: string,
    @Query('patientId') patientId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.findAll(tenantId, {
      status,
      createdById,
      patientId,
      from,
      to,
      search,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  /** Envia orcamento por WhatsApp com link do portal */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/send-whatsapp')
  sendQuoteByWhatsapp(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.sendByWhatsapp(id, tenantId, req.user?.id);
  }

  /** Admin: forca auto-expiracao agora (idempotente) */
  @RequiresPermission('manage_proposals')
  @Post('quotes/expire-old')
  expireOldQuotes(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.expireOldQuotes(tenantId);
  }

  // ─── Onda 2 (Fase 24) — PDF + Templates + Cupons ───────────────

  /** Gera PDF profissional do orcamento */
  @RequiresPermission('manage_proposals')
  @Get('quotes/:id/pdf')
  async quotePdf(
    @Param('id') id: string,
    @Request() req: any,
    @Res() res: Response,
    @Query('values') values?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    // ?values=false → PDF só com os procedimentos (sem valores/total/condições).
    const withValues = values !== 'false';
    const buffer = await this.pdfService.generatePdf(id, tenantId, withValues);
    res.set('Content-Type', 'application/pdf');
    res.set(
      'Content-Disposition',
      `inline; filename="${withValues ? 'orcamento' : 'procedimentos'}-${id.slice(0, 8)}.pdf"`,
    );
    res.set('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  // Templates
  @RequiresPermission('manage_proposals')
  @Get('quote-templates')
  listTemplates(@Request() req: any, @Query('activeOnly') activeOnly?: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.templatesService.list(tenantId, {
      activeOnly: activeOnly === 'true' || activeOnly === '1',
    });
  }

  @RequiresPermission('manage_proposals')
  @Get('quote-templates/:id')
  findTemplate(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.templatesService.findOne(id, tenantId);
  }

  @RequiresPermission('manage_proposals')
  @Post('quote-templates')
  createTemplate(@Request() req: any, @Body() dto: CreateTemplateDto) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.templatesService.create(tenantId, dto);
  }

  @RequiresPermission('manage_proposals')
  @Patch('quote-templates/:id')
  updateTemplate(
    @Param('id') id: string,
    @Request() req: any,
    @Body() dto: UpdateTemplateDto,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.templatesService.update(id, tenantId, dto);
  }

  @RequiresPermission('manage_proposals')
  @Delete('quote-templates/:id')
  removeTemplate(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.templatesService.remove(id, tenantId);
  }

  /** Aplica template a um orcamento existente — copia items */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/apply-template')
  applyTemplate(
    @Param('id') quoteId: string,
    @Body() body: { template_id: string },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!body?.template_id)
      throw new BadRequestException('template_id obrigatorio');
    return this.templatesService.applyToQuote(
      quoteId,
      body.template_id,
      tenantId,
    );
  }

  // Cupons
  @RequiresPermission('manage_proposals')
  @Get('quote-coupons')
  listCoupons(@Request() req: any, @Query('activeOnly') activeOnly?: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.couponsService.list(tenantId, {
      activeOnly: activeOnly === 'true' || activeOnly === '1',
    });
  }

  @RequiresPermission('manage_proposals')
  @Get('quote-coupons/:id')
  findCoupon(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.couponsService.findOne(id, tenantId);
  }

  @RequiresPermission('manage_proposals')
  @Post('quote-coupons')
  createCoupon(@Request() req: any, @Body() dto: CreateCouponDto) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.couponsService.create(tenantId, dto);
  }

  @RequiresPermission('manage_proposals')
  @Patch('quote-coupons/:id')
  updateCoupon(
    @Param('id') id: string,
    @Request() req: any,
    @Body() dto: UpdateCouponDto,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.couponsService.update(id, tenantId, dto);
  }

  @RequiresPermission('manage_proposals')
  @Delete('quote-coupons/:id')
  removeCoupon(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.couponsService.remove(id, tenantId);
  }

  /** Aplica cupom a um orcamento — valida + atualiza desconto + incrementa used_count */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/apply-coupon')
  applyCoupon(
    @Param('id') quoteId: string,
    @Body() body: { code: string },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!body?.code) throw new BadRequestException('code obrigatorio');
    return this.couponsService.applyToQuote(quoteId, body.code, tenantId);
  }

  /** Remove cupom do orcamento */
  @RequiresPermission('manage_proposals')
  @Delete('quotes/:id/coupon')
  removeCouponFromQuote(@Param('id') quoteId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.couponsService.removeFromQuote(quoteId, tenantId);
  }

  // ─── Onda 3 (Fase 24) — Anexos do orcamento ──────────────────

  /** Lista anexos do orcamento (metadata, sem o binário) */
  @RequiresPermission('manage_proposals')
  @Get('quotes/:id/attachments')
  listAttachments(@Param('id') quoteId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.attachmentsService.list(quoteId, tenantId);
  }

  /** Upload de anexo (multipart, campo "file" + opcional category/description) */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/attachments')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }),
  )
  uploadAttachment(
    @Param('id') quoteId: string,
    @UploadedFile() file: any,
    @Body() body: { category?: string; description?: string },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.id;
    if (!tenantId || !userId) throw new BadRequestException('Contexto ausente');
    if (!file) throw new BadRequestException('Arquivo nao recebido');
    return this.attachmentsService.upload(quoteId, tenantId, userId, file, {
      category: body?.category,
      description: body?.description,
    });
  }

  /** Serve o arquivo binario inline (preview/download) */
  @RequiresPermission('manage_proposals')
  @Get('quote-attachments/:attachmentId/file')
  async getAttachmentFile(
    @Param('attachmentId') attachmentId: string,
    @Request() req: any,
    @Res() res: Response,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const { buffer, mime_type, filename } =
      await this.attachmentsService.getFileBuffer(attachmentId, tenantId);
    res.set('Content-Type', mime_type);
    res.set(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(filename)}"`,
    );
    res.set('Content-Length', String(buffer.length));
    res.set('Cache-Control', 'private, max-age=3600');
    res.end(buffer);
  }

  /** Remove anexo (apaga arquivo + registro) */
  @RequiresPermission('manage_proposals')
  @Delete('quote-attachments/:attachmentId')
  removeAttachment(
    @Param('attachmentId') attachmentId: string,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.attachmentsService.remove(attachmentId, tenantId);
  }

  // ─── Onda 3b (Fase 24) — Versions + Renegotiate ──────────────

  /** Lista versoes (snapshots) do orcamento — timeline pra UI */
  @RequiresPermission('manage_proposals')
  @Get('quotes/:id/versions')
  listVersions(@Param('id') quoteId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.versionsService.list(quoteId, tenantId);
  }

  /** Detalhe de uma versao com snapshot completo (pra modal de comparar) */
  @RequiresPermission('manage_proposals')
  @Get('quote-versions/:versionId')
  findVersion(@Param('versionId') versionId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.versionsService.findOne(versionId, tenantId);
  }

  /**
   * Renegociar: cria duplicata DRAFT + marca atual REJECTED.
   * Operador edita o novo, envia v2.
   */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/renegotiate')
  renegotiateQuote(
    @Param('id') quoteId: string,
    @Body() body: { note?: string },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.id;
    if (!tenantId || !userId) throw new BadRequestException('Contexto ausente');
    return this.versionsService.renegotiate(
      quoteId,
      tenantId,
      userId,
      body?.note,
    );
  }

  /**
   * Onda 3.4 — Duplicar como nova OPCAO paralela. Original permanece ativo.
   * Ideal para apresentar varias condicoes comerciais (a vista, parcelado)
   * com os mesmos procedimentos clinicos.
   */
  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/duplicate-as-option')
  duplicateAsOption(@Param('id') quoteId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.id;
    if (!tenantId || !userId) throw new BadRequestException('Contexto ausente');
    return this.versionsService.duplicateAsOption(quoteId, tenantId, userId);
  }

  // ─── QuoteItems ───────────────────────────────────────────────

  @RequiresPermission('manage_proposals')
  @Post('quotes/:id/items')
  addQuoteItem(
    @Param('id') id: string,
    @Body() dto: CreateQuoteItemDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.addItem(id, tenantId, dto);
  }

  @RequiresPermission('manage_proposals')
  @Patch('quote-items/:id')
  updateQuoteItem(
    @Param('id') id: string,
    @Body() dto: UpdateQuoteItemDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.updateItem(id, tenantId, dto);
  }

  // Onda 18.6 — Editar o preco de um item da proposta. SO ADMIN/SUPER_ADMIN
  // (ajustar valor mexe no total e na cobranca futura; dentista/CRC tem
  // override_price pra montar orcamento, mas ajustar preco de PROPOSTA e
  // restrito a admin). Gate de role aqui + status DRAFT/SENT no service; o
  // front tambem esconde o controle (defense in depth).
  @Patch('quote-items/:id/override-price')
  overrideItemPrice(
    @Param('id') id: string,
    @Body() dto: OverrideItemPriceDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const roles: string[] = req.user?.roles ?? [];
    if (!roles.includes('ADMIN') && !roles.includes('SUPER_ADMIN')) {
      throw new ForbiddenException('Apenas administradores podem editar o preco da proposta');
    }
    return this.quotesService.overrideItemPrice(id, tenantId, dto.total_price);
  }

  @RequiresPermission('manage_proposals')
  @Delete('quote-items/:id')
  removeQuoteItem(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.removeItem(id, tenantId);
  }

  // ─── TreatmentPlans ───────────────────────────────────────────

  @Get('patients/:patientId/treatment-plans')
  listPlans(@Param('patientId') patientId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.plansService.findByPatient(patientId, tenantId);
  }

  /**
   * Onda 5e v38 — items achatados de todos os planos do paciente, usado
   * pela aba "Tratamento" da ficha. Retorna { kpis, items[] } com cada
   * item ja resolvido (procedure name, plano vinculado, executor).
   */
  @Get('patients/:patientId/treatment-items')
  listPatientTreatmentItems(@Param('patientId') patientId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.plansService.findItemsByPatient(patientId, tenantId);
  }

  // Fila central do Financeiro: planos aceitos aguardando validação (libera o tratamento).
  // DEVE vir ANTES de @Get('treatment-plans/:id') senão 'pending-validation' vira :id.
  @RequiresPermission('manage_financial')
  @Get('treatment-plans/pending-validation')
  pendingValidation(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.plansService.findPendingFinancialValidation(tenantId);
  }

  @Get('treatment-plans/:id')
  findPlan(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.plansService.findOne(id, tenantId);
  }

  @Patch('treatment-plans/:id')
  updatePlan(
    @Param('id') id: string,
    @Body() dto: UpdateTreatmentPlanDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.plansService.update(id, tenantId, dto as any);
  }

  @Post('treatment-plans/:id/send-for-signature')
  sendPlanForSignature(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.contractService.sendForSignature(id, tenantId);
  }

  @Post('treatment-plans/:id/create-charges')
  createInstallmentCharges(
    @Param('id') id: string,
    @Body()
    dto: {
      billingType: 'PIX' | 'BOLETO' | 'CREDIT_CARD';
      installmentCount: number;
      firstDueDate?: string;
    },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!dto?.billingType)
      throw new BadRequestException(
        'billingType obrigatorio (PIX, BOLETO, CREDIT_CARD)',
      );
    if (!dto?.installmentCount)
      throw new BadRequestException('installmentCount obrigatorio (1-24)');
    return this.billingService.createInstallmentCharges(id, tenantId, dto);
  }

  @Get('treatment-plans/:id/charges')
  listPlanCharges(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.billingService.listCharges(id, tenantId);
  }

  /**
   * Onda 14.59 — Emite cobranca da ENTRADA (sinal + restante) com auto-trigger.
   *
   * 1-2 cobrancas geradas no Asaas (ou registro CASH local se metodo=CASH).
   * Quando todas confirmadas (via webhook Asaas ou markCashReceived), trigger
   * automatico gera as parcelas + aprova proposta.
   *
   * Permissao: ADMIN ou FINANCEIRO.
   */
  @Post('treatment-plans/:id/emit-down-payment')
  emitDownPayment(
    @Param('id') id: string,
    @Body()
    dto: {
      signalValue: number;
      signalMethod: 'PIX' | 'BOLETO' | 'CASH';
      signalDueDate?: string;
      restValue: number;
      restMethod: 'PIX' | 'BOLETO' | 'CASH';
      restDueDate?: string;
      clicksignSendTiming?: 'BEFORE' | 'AFTER' | null;
    },
    @Authenticated() user: AuthUser,
  ) {
    if (!user.tenant_id) throw new BadRequestException('tenant_id ausente');
    const roles = user.roles ?? [];
    if (!roles.includes('ADMIN') && !roles.includes('FINANCEIRO')) {
      throw new ForbiddenException('Apenas ADMIN ou FINANCEIRO podem emitir cobranca da entrada');
    }
    return this.downPaymentFlow.emitDownPayment(id, user.tenant_id, dto);
  }

  /**
   * Onda 14.59 — Wrapper que aceita quote_id (mais comodo pro frontend).
   * Resolve internamente o treatment_plan_id e chama emit-down-payment.
   */
  @Post('quotes/:id/emit-down-payment')
  emitDownPaymentByQuote(
    @Param('id') id: string,
    @Body()
    dto: {
      signalValue: number;
      signalMethod: 'PIX' | 'BOLETO' | 'CASH';
      signalDueDate?: string;
      restValue: number;
      restMethod: 'PIX' | 'BOLETO' | 'CASH';
      restDueDate?: string;
      clicksignSendTiming?: 'BEFORE' | 'AFTER' | null;
      parts?: ('SIGNAL' | 'REST')[];
    },
    @Authenticated() user: AuthUser,
  ) {
    if (!user.tenant_id) throw new BadRequestException('tenant_id ausente');
    const roles = user.roles ?? [];
    if (!roles.includes('ADMIN') && !roles.includes('FINANCEIRO')) {
      throw new ForbiddenException('Apenas ADMIN ou FINANCEIRO podem emitir cobranca da entrada');
    }
    return this.downPaymentFlow.emitDownPaymentByQuote(id, user.tenant_id, dto);
  }

  /**
   * Onda 14.59.2 — Emite as PARCELAS do plano (alternativa ao trigger automatico
   * do webhook). Util quando operador quer disparar manualmente ao confirmar
   * entrada em especie, ou quando quer revisar antes de gerar.
   *
   * Backend valida que sinal+entrada estao pagos antes de criar parcelas.
   * Permissao: ADMIN ou FINANCEIRO.
   */
  @Post('quotes/:id/emit-installments')
  emitInstallmentsByQuote(
    @Param('id') id: string,
    @Body()
    dto: {
      installmentCount: number;
      installmentValue: number;
      firstDueDate?: string;
    },
    @Authenticated() user: AuthUser,
  ) {
    if (!user.tenant_id) throw new BadRequestException('tenant_id ausente');
    const roles = user.roles ?? [];
    if (!roles.includes('ADMIN') && !roles.includes('FINANCEIRO')) {
      throw new ForbiddenException('Apenas ADMIN ou FINANCEIRO podem emitir parcelas');
    }
    return this.downPaymentFlow.emitInstallmentsByQuote(id, user.tenant_id, dto);
  }

  /**
   * Onda 14.59 — Marca cobranca CASH como recebida em especie.
   * Equivale ao webhook do Asaas avisando PAYMENT_RECEIVED. Dispara o trigger
   * automatico (se for sinal/entrada e completar o ciclo).
   *
   * Permissao: ADMIN ou FINANCEIRO.
   */
  @Post('charges/:id/mark-cash-received')
  markCashReceived(@Param('id') id: string, @Authenticated() user: AuthUser) {
    if (!user.tenant_id) throw new BadRequestException('tenant_id ausente');
    const roles = user.roles ?? [];
    if (!roles.includes('ADMIN') && !roles.includes('FINANCEIRO')) {
      throw new ForbiddenException('Apenas ADMIN ou FINANCEIRO podem marcar recebimento em especie');
    }
    return this.downPaymentFlow.markCashReceived(id, user.id, user.tenant_id);
  }

  @Post('treatment-plans/:id/activate')
  activatePlan(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.plansService.activate(id, tenantId);
  }

  @Post('treatment-plans/:id/pause')
  pausePlan(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.plansService.pause(id, tenantId);
  }

  // Onda 17.72 — Validação financeira: SÓ o Financeiro (manage_financial) libera o
  // tratamento. Seta a flag que destrava a confirmação dos procedimentos pelo dentista.
  @RequiresPermission('manage_financial')
  @Post('treatment-plans/:id/validate')
  validatePlan(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.plansService.validate(id, tenantId, req.user.id);
  }

  @Post('treatment-plans/:id/complete')
  completePlan(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.plansService.complete(id, tenantId);
  }

  // ─── TreatmentPlanItems ───────────────────────────────────────

  @Patch('treatment-plan-items/:id')
  updatePlanItem(
    @Param('id') id: string,
    @Body() dto: UpdateTreatmentPlanItemDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.plansService.updateItem(id, tenantId, dto);
  }

  @Post('treatment-plan-items/:id/execute')
  executePlanItem(
    @Param('id') id: string,
    @Body() dto: ExecuteTreatmentPlanItemDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    // JwtStrategy.validate() retorna { id: payload.sub, ... } — usar req.user.id
    const userId = req.user?.id;
    if (!tenantId || !userId) throw new BadRequestException('Contexto ausente');
    return this.plansService.executeItem(id, tenantId, userId, dto);
  }

  // ─── Contracts (Onda 14.24) ────────────────────────────────────
  // Gate entre proposta aceita e geracao de cobranca. Fase 1: transicoes
  // manuais via cliques do operador. Fase 2: trocar PATCH manuais por
  // webhooks ClickSign (sem mudar API publica).

  /** Pega o contrato de um quote (ou null se nao existe). */
  @Get('quotes/:id/contract')
  getQuoteContract(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.contractsService.findByQuote(id, user.tenant_id);
  }

  /** Cria contrato DRAFT pra um Quote ACCEPTED.
   *  Onda 14.30 — aceita body { selected_documents: string[] } com docs
   *  extras pra incluir junto com o contrato principal (TCLE, LGPD, etc). */
  @Post('quotes/:id/contract')
  createQuoteContract(
    @Param('id') id: string,
    @Body() body: { selected_documents?: string[] },
    @Authenticated() user: AuthUser,
  ) {
    return this.contractsService.createForQuote(id, user.tenant_id, user.id, {
      selected_documents: body?.selected_documents,
    });
  }

  /** Detalhe do contrato + events. */
  @Get('contracts/:id')
  getContract(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.contractsService.findOne(id, user.tenant_id);
  }

  /** Marca como enviado (Fase 1: manual). */
  @Post('contracts/:id/send')
  sendContract(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.contractsService.markSent(id, user.tenant_id, user.id);
  }

  /**
   * Onda 14.24 Fase 2 — Envia contrato via ClickSign:
   *   - Gera PDF + sobe no ClickSign + envia WhatsApp
   *   - Persiste clicksign_document_id + signing_url
   *   - Webhook auto_close vai marcar como SIGNED quando paciente + clinica assinarem
   */
  @Post('contracts/:id/send-clicksign')
  sendContractViaClickSign(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.contractsService.sendToClickSign(id, user.tenant_id, user.id);
  }

  /** Marca que o paciente abriu o documento (Fase 1: manual). */
  @Post('contracts/:id/mark-opened')
  markContractOpened(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.contractsService.markOpened(id, user.tenant_id, user.id);
  }

  /** Marca que o paciente assinou (falta a clinica). */
  @Post('contracts/:id/sign-patient')
  signContractPatient(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.contractsService.markPatientSigned(id, user.tenant_id, user.id);
  }

  /** Marca que a clinica assinou — final. Libera geracao de cobranca. */
  @Post('contracts/:id/sign-clinic')
  signContractClinic(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.contractsService.markClinicSigned(id, user.tenant_id, user.id);
  }

  /** Cancela o contrato (operador desiste e quer refazer). */
  @Post('contracts/:id/cancel')
  cancelContract(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @Authenticated() user: AuthUser,
  ) {
    return this.contractsService.cancel(id, user.tenant_id, user.id, body?.reason);
  }

  /** Pula o contrato (operador assume risco — geralmente pra valores baixos). */
  @Post('contracts/:id/skip')
  skipContract(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @Authenticated() user: AuthUser,
  ) {
    return this.contractsService.skip(id, user.tenant_id, user.id, body?.reason);
  }

  /**
   * Onda 14.24 Fase 1.5 — Preview PDF do contrato. Stream do PDF gerado
   * a partir do template apropriado (por especialidade). Permite operador
   * conferir conteudo antes de enviar pro paciente. Fase 2 vai reusar
   * mesmo PDF pra subir no ClickSign.
   */
  @Get('contracts/:id/preview-pdf')
  async previewContractPdf(
    @Param('id') id: string,
    @Authenticated() user: AuthUser,
    @Res() res: Response,
  ) {
    const buffer = await this.contractPdfService.generatePdf(id, user.tenant_id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="contrato-${id.substring(0, 8)}.pdf"`);
    res.send(buffer);
  }

  /**
   * Onda 17.32.30 — Serve o PDF de um template de termo (clareamento,
   * facetas, implante, etc) direto do diretorio contract-templates/.
   * Permite o operador PRE-VISUALIZAR o termo antes de marcar o checkbox,
   * pra saber o que cada termo cobre.
   *
   * Whitelist via EXTRA_DOCUMENT_PDF_MAP (no servico) — nao da pra acessar
   * arquivos arbitrarios fora do mapeamento.
   */
  @Get('contract-templates/:docId/pdf')
  async previewContractTemplate(
    @Param('docId') docId: string,
    @Res() res: Response,
  ) {
    const buffer = await this.contractPdfService.readTemplatePdf(docId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="termo-${docId.toLowerCase()}.pdf"`);
    res.send(buffer);
  }
}
