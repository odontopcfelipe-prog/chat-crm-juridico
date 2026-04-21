import {
  Controller, Get, Post, Patch, Body, Param, Query, Request, UseGuards, BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { InstallmentsService } from './installments.service';
import {
  CreateInstallmentDto, GenerateFromQuoteDto, PayInstallmentDto,
  UpdateInstallmentDto, RenegotiateDto,
} from './dto/installment.dto';

function parseBool(v?: string): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return v === 'true' || v === '1';
}

@UseGuards(JwtAuthGuard)
@Controller()
export class InstallmentsController {
  constructor(private readonly service: InstallmentsService) {}

  @Post('installments')
  create(@Body() dto: CreateInstallmentDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.create(tenantId, dto);
  }

  /** Gera N parcelas a partir de uma Quote ACCEPTED — 1x por quote. */
  @Post('quotes/:quoteId/generate-installments')
  generate(
    @Param('quoteId') quoteId: string,
    @Body() dto: GenerateFromQuoteDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.generateFromQuote(tenantId, quoteId, dto);
  }

  @Get('installments')
  findAll(
    @Request() req: any,
    @Query('patient_id') patient_id?: string,
    @Query('status') status?: string,
    @Query('quote_id') quote_id?: string,
    @Query('overdue') overdue?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.findAll(tenantId, {
      patient_id, status, quote_id,
      overdue: parseBool(overdue),
      from, to,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('installments/overdue-summary')
  overdueSummary(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.overdueSummary(tenantId);
  }

  @Get('installments/:id')
  findOne(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.findOne(tenantId, id);
  }

  @Patch('installments/:id')
  update(@Param('id') id: string, @Body() dto: UpdateInstallmentDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.update(tenantId, id, dto);
  }

  @Post('installments/:id/pay')
  pay(@Param('id') id: string, @Body() dto: PayInstallmentDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.pay(tenantId, id, dto);
  }

  @Post('installments/:id/cancel')
  cancel(@Param('id') id: string, @Body() body: { reason?: string }, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.cancel(tenantId, id, body?.reason);
  }

  @Post('installments/:id/renegotiate')
  renegotiate(@Param('id') id: string, @Body() dto: RenegotiateDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.renegotiate(tenantId, id, dto);
  }
}
