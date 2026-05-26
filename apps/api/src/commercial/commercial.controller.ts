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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Authenticated } from '../auth/decorators/authenticated.decorator';
import type { AuthUser } from '../auth/decorators/authenticated.decorator';
import { Public } from '../auth/decorators/public.decorator';
import {
  CreateQuoteDto,
  UpdateQuoteDto,
  CreateQuoteItemDto,
  UpdateQuoteItemDto,
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
  ) {}

  // ─── Quotes ───────────────────────────────────────────────────

  // ─── Quote endpoints — Onda 2.1: migrados pra @Authenticated() ────────

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
  @Get('quotes/closing-board')
  quotesClosingBoard(@Authenticated() user: AuthUser) {
    return this.quotesService.getClosingBoard(user.tenant_id);
  }

  @Get('quotes/:id')
  findQuote(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.quotesService.findOne(id, user.tenant_id);
  }

  @Patch('quotes/:id')
  updateQuote(
    @Param('id') id: string,
    @Body() dto: UpdateQuoteDto,
    @Authenticated() user: AuthUser,
  ) {
    return this.quotesService.update(id, user.tenant_id, dto as any);
  }

  @Delete('quotes/:id')
  removeQuote(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.quotesService.remove(id, user.tenant_id, user.id);
  }

  /** Onda 25.6 — Lista orcamentos soft-deletados nos ultimos 30 dias (admin) */
  @Get('quotes/deleted')
  listDeletedQuotes(@Authenticated() user: AuthUser) {
    return this.quotesService.listDeleted(user.tenant_id);
  }

  /** Onda 25.6 — Restaura orcamento soft-deletado (volta pra listagem normal) */
  @Post('quotes/:id/restore')
  restoreQuote(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.quotesService.restore(id, user.tenant_id);
  }

  @Post('quotes/:id/send')
  sendQuote(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.send(id, tenantId, req.user?.id);
  }

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
  @Post('credit-check/simulate')
  simulateCreditCheck(@Body() dto: CreditCheckSimulateDto) {
    return this.creditCheckService.simulate({
      cpf: dto.cpf,
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
    });
  }

  /**
   * Onda 12.2 — Aplica financiamento aprovado (chamado pelo botao "Aplicar
   * essa proposta" no modal Banco PASSOS apos credit-check approved).
   *
   * Cadeia: accept quote → cria TreatmentPlan → marca ACTIVE → gera boletos
   * (entrada +3d, parcelas +33d) via Asaas. Retorna URLs dos boletos.
   */
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
  @Post('quotes/:id/choose-as-proposal')
  chooseQuoteAsProposal(
    @Param('id') id: string,
    @Body() body: { payment_key?: string | null; down_payment?: number | null },
    @Authenticated() user: AuthUser,
  ) {
    return this.quotesService.markAsChosenProposal(id, user.tenant_id, {
      payment_key: body?.payment_key,
      down_payment: body?.down_payment,
    });
  }

  /** Onda 14.33 — Desmarca proposta escolhida (volta ao estado neutro). */
  @Post('quotes/:id/unchoose-as-proposal')
  unchooseQuoteAsProposal(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.quotesService.unmarkChosenProposal(id, user.tenant_id);
  }

  // ─── Onda 1 (Fase 24) — Listagem global + funil + WhatsApp ──────

  /** Lista TODOS os orcamentos do tenant (pagina /atendimento/orcamentos) */
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

  /** Dashboard funil — counts/valores por status + conversao + expirando */
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

  /** Envia orcamento por WhatsApp com link do portal */
  @Post('quotes/:id/send-whatsapp')
  sendQuoteByWhatsapp(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.sendByWhatsapp(id, tenantId, req.user?.id);
  }

  /** Admin: forca auto-expiracao agora (idempotente) */
  @Post('quotes/expire-old')
  expireOldQuotes(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.expireOldQuotes(tenantId);
  }

  // ─── Onda 2 (Fase 24) — PDF + Templates + Cupons ───────────────

  /** Gera PDF profissional do orcamento */
  @Get('quotes/:id/pdf')
  async quotePdf(
    @Param('id') id: string,
    @Request() req: any,
    @Res() res: Response,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const buffer = await this.pdfService.generatePdf(id, tenantId);
    res.set('Content-Type', 'application/pdf');
    res.set(
      'Content-Disposition',
      `inline; filename="orcamento-${id.slice(0, 8)}.pdf"`,
    );
    res.set('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  // Templates
  @Get('quote-templates')
  listTemplates(@Request() req: any, @Query('activeOnly') activeOnly?: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.templatesService.list(tenantId, {
      activeOnly: activeOnly === 'true' || activeOnly === '1',
    });
  }

  @Get('quote-templates/:id')
  findTemplate(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.templatesService.findOne(id, tenantId);
  }

  @Post('quote-templates')
  createTemplate(@Request() req: any, @Body() dto: CreateTemplateDto) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.templatesService.create(tenantId, dto);
  }

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

  @Delete('quote-templates/:id')
  removeTemplate(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.templatesService.remove(id, tenantId);
  }

  /** Aplica template a um orcamento existente — copia items */
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
  @Get('quote-coupons')
  listCoupons(@Request() req: any, @Query('activeOnly') activeOnly?: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.couponsService.list(tenantId, {
      activeOnly: activeOnly === 'true' || activeOnly === '1',
    });
  }

  @Get('quote-coupons/:id')
  findCoupon(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.couponsService.findOne(id, tenantId);
  }

  @Post('quote-coupons')
  createCoupon(@Request() req: any, @Body() dto: CreateCouponDto) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.couponsService.create(tenantId, dto);
  }

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

  @Delete('quote-coupons/:id')
  removeCoupon(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.couponsService.remove(id, tenantId);
  }

  /** Aplica cupom a um orcamento — valida + atualiza desconto + incrementa used_count */
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
  @Delete('quotes/:id/coupon')
  removeCouponFromQuote(@Param('id') quoteId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.couponsService.removeFromQuote(quoteId, tenantId);
  }

  // ─── Onda 3 (Fase 24) — Anexos do orcamento ──────────────────

  /** Lista anexos do orcamento (metadata, sem o binário) */
  @Get('quotes/:id/attachments')
  listAttachments(@Param('id') quoteId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.attachmentsService.list(quoteId, tenantId);
  }

  /** Upload de anexo (multipart, campo "file" + opcional category/description) */
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
  @Get('quotes/:id/versions')
  listVersions(@Param('id') quoteId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.versionsService.list(quoteId, tenantId);
  }

  /** Detalhe de uma versao com snapshot completo (pra modal de comparar) */
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
  @Post('quotes/:id/duplicate-as-option')
  duplicateAsOption(@Param('id') quoteId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.id;
    if (!tenantId || !userId) throw new BadRequestException('Contexto ausente');
    return this.versionsService.duplicateAsOption(quoteId, tenantId, userId);
  }

  // ─── QuoteItems ───────────────────────────────────────────────

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
}
