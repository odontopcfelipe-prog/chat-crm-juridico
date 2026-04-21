import {
  Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, Request, BadRequestException,
} from '@nestjs/common';
import { QuotesService } from './quotes.service';
import { TreatmentPlansService } from './treatment-plans.service';
import { TreatmentPlanContractService } from './treatment-plan-contract.service';
import { TreatmentPlanBillingService } from './treatment-plan-billing.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  CreateQuoteDto, UpdateQuoteDto, CreateQuoteItemDto, UpdateQuoteItemDto, RejectQuoteDto,
  UpdateTreatmentPlanDto, UpdateTreatmentPlanItemDto, ExecuteTreatmentPlanItemDto,
} from './dto/commercial.dto';

@UseGuards(JwtAuthGuard)
@Controller()
export class CommercialController {
  constructor(
    private readonly quotesService: QuotesService,
    private readonly plansService: TreatmentPlansService,
    private readonly contractService: TreatmentPlanContractService,
    private readonly billingService: TreatmentPlanBillingService,
  ) {}

  // ─── Quotes ───────────────────────────────────────────────────

  @Post('patients/:patientId/quotes')
  createQuote(
    @Param('patientId') patientId: string,
    @Body() dto: CreateQuoteDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.sub;
    if (!tenantId || !userId) throw new BadRequestException('Contexto ausente');
    return this.quotesService.create(patientId, tenantId, userId, dto);
  }

  @Get('patients/:patientId/quotes')
  listQuotes(@Param('patientId') patientId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.findByPatient(patientId, tenantId);
  }

  @Get('quotes/:id')
  findQuote(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.findOne(id, tenantId);
  }

  @Patch('quotes/:id')
  updateQuote(@Param('id') id: string, @Body() dto: UpdateQuoteDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.update(id, tenantId, dto as any);
  }

  @Delete('quotes/:id')
  removeQuote(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.remove(id, tenantId);
  }

  @Post('quotes/:id/send')
  sendQuote(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.send(id, tenantId);
  }

  @Post('quotes/:id/accept')
  acceptQuote(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.accept(id, tenantId);
  }

  @Post('quotes/:id/reject')
  rejectQuote(@Param('id') id: string, @Body() dto: RejectQuoteDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.quotesService.reject(id, tenantId, dto?.rejection_reason);
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
    const userId = req.user?.sub;
    if (!tenantId || !userId) throw new BadRequestException('Contexto ausente');
    return this.plansService.executeItem(id, tenantId, userId, dto);
  }
}
