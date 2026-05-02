import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, Request, Res, BadRequestException, NotFoundException,
  UseInterceptors, UploadedFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { QuotesService } from './quotes.service';
import { QuotePdfService } from './quote-pdf.service';
import { QuoteTemplatesService } from './quote-templates.service';
import type { CreateTemplateDto, UpdateTemplateDto } from './quote-templates.service';
import { QuoteCouponsService } from './quote-coupons.service';
import type { CreateCouponDto, UpdateCouponDto } from './quote-coupons.service';
import { QuoteAttachmentsService } from './quote-attachments.service';
import { QuoteVersionsService } from './quote-versions.service';
import { TreatmentPlansService } from './treatment-plans.service';
import { TreatmentPlanContractService } from './treatment-plan-contract.service';
import { TreatmentPlanBillingService } from './treatment-plan-billing.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Authenticated } from '../auth/decorators/authenticated.decorator';
import type { AuthUser } from '../auth/decorators/authenticated.decorator';
import {
  CreateQuoteDto, UpdateQuoteDto, CreateQuoteItemDto, UpdateQuoteItemDto, RejectQuoteDto,
  UpdateTreatmentPlanDto, UpdateTreatmentPlanItemDto, ExecuteTreatmentPlanItemDto,
} from './dto/commercial.dto';

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
    return this.quotesService.getOrCreateDraft(patientId, user.tenant_id, user.id);
  }

  @Get('patients/:patientId/quotes')
  listQuotes(@Param('patientId') patientId: string, @Authenticated() user: AuthUser) {
    return this.quotesService.findByPatient(patientId, user.tenant_id);
  }

  @Get('quotes/:id')
  findQuote(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.quotesService.findOne(id, user.tenant_id);
  }

  @Patch('quotes/:id')
  updateQuote(@Param('id') id: string, @Body() dto: UpdateQuoteDto, @Authenticated() user: AuthUser) {
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
      throw new BadRequestException('item_ids[] eh obrigatorio (selecione ao menos 1)');
    }
    return this.quotesService.acceptPartial(id, user.tenant_id, body.item_ids, user.id);
  }

  @Post('quotes/:id/reject')
  rejectQuote(@Param('id') id: string, @Body() dto: RejectQuoteDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.reject(id, tenantId, dto?.rejection_reason, req.user?.id);
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
  async quotePdf(@Param('id') id: string, @Request() req: any, @Res() res: Response) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const buffer = await this.pdfService.generatePdf(id, tenantId);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="orcamento-${id.slice(0, 8)}.pdf"`);
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
  updateTemplate(@Param('id') id: string, @Request() req: any, @Body() dto: UpdateTemplateDto) {
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
    if (!body?.template_id) throw new BadRequestException('template_id obrigatorio');
    return this.templatesService.applyToQuote(quoteId, body.template_id, tenantId);
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
  updateCoupon(@Param('id') id: string, @Request() req: any, @Body() dto: UpdateCouponDto) {
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
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
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
    const { buffer, mime_type, filename } = await this.attachmentsService.getFileBuffer(attachmentId, tenantId);
    res.set('Content-Type', mime_type);
    res.set('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
    res.set('Content-Length', String(buffer.length));
    res.set('Cache-Control', 'private, max-age=3600');
    res.end(buffer);
  }

  /** Remove anexo (apaga arquivo + registro) */
  @Delete('quote-attachments/:attachmentId')
  removeAttachment(@Param('attachmentId') attachmentId: string, @Request() req: any) {
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
    return this.versionsService.renegotiate(quoteId, tenantId, userId, body?.note);
  }

  // ─── QuoteItems ───────────────────────────────────────────────

  @Post('quotes/:id/items')
  addQuoteItem(@Param('id') id: string, @Body() dto: CreateQuoteItemDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.addItem(id, tenantId, dto);
  }

  @Patch('quote-items/:id')
  updateQuoteItem(@Param('id') id: string, @Body() dto: UpdateQuoteItemDto, @Request() req: any) {
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

  @Get('treatment-plans/:id')
  findPlan(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.plansService.findOne(id, tenantId);
  }

  @Patch('treatment-plans/:id')
  updatePlan(@Param('id') id: string, @Body() dto: UpdateTreatmentPlanDto, @Request() req: any) {
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
    @Body() dto: { billingType: 'PIX' | 'BOLETO' | 'CREDIT_CARD'; installmentCount: number; firstDueDate?: string },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!dto?.billingType) throw new BadRequestException('billingType obrigatorio (PIX, BOLETO, CREDIT_CARD)');
    if (!dto?.installmentCount) throw new BadRequestException('installmentCount obrigatorio (1-24)');
    return this.billingService.createInstallmentCharges(id, tenantId, dto);
  }

  @Get('treatment-plans/:id/charges')
  listPlanCharges(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.billingService.listCharges(id, tenantId);
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
}
