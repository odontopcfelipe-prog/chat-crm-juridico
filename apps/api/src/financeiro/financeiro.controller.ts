import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { FinanceiroService } from './financeiro.service';
import { FinanceiroChargesService } from './financeiro-charges.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequiresPermission } from '../auth/decorators/requires-permission.decorator';
import {
  CreateTransactionDto,
  UpdateTransactionDto,
  CreateCategoryDto,
  UpdateCategoryDto,
  CreateDailyRateTransactionDto,
} from './financeiro.dto';

@UseGuards(JwtAuthGuard)
// Onda 17.32.128 — Fase 6: financeiro exige permissao view_financial
// (setores financeiro + admin tem por default; demais ganham via
// extra_grants quando ADMIN do tenant liberar)
@RequiresPermission('view_financial')
@Controller('financeiro')
export class FinanceiroController {
  constructor(
    private readonly service: FinanceiroService,
    private readonly chargesService: FinanceiroChargesService,
  ) {}

  // ─── Transactions ──────────────────────────────────────

  @Get('transactions')
  findAllTransactions(
    @Query('type') type: string,
    @Query('category') category: string,
    @Query('status') status: string,
    @Query('legalCaseId') legalCaseId: string,
    @Query('leadId') leadId: string,
    @Query('dentistId') dentistId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('limit') limit: string,
    @Query('offset') offset: string,
    @Request() req: any,
  ) {
    return this.service.findAllTransactions({
      tenantId: req.user.tenant_id,
      type,
      category,
      status,
      legalCaseId,
      leadId,
      dentistId,
      startDate,
      endDate,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @RequiresPermission('manage_financial')
  @Post('transactions')
  createTransaction(
    @Body() body: CreateTransactionDto,
    @Request() req: any,
  ) {
    return this.service.createTransaction({
      ...body,
      tenant_id: req.user.tenant_id,
      actor_id: req.user.id,
    });
  }

  @RequiresPermission('manage_financial')
  @Patch('transactions/:id')
  updateTransaction(
    @Param('id') id: string,
    @Body() body: UpdateTransactionDto,
    @Request() req: any,
  ) {
    return this.service.updateTransaction(id, body, req.user.tenant_id, req.user.id);
  }

  @RequiresPermission('manage_financial')
  @Delete('transactions/:id')
  deleteTransaction(
    @Param('id') id: string,
    @Request() req: any,
  ) {
    return this.service.deleteTransaction(id, req.user.tenant_id, req.user.id);
  }

  // Fase 5 — Lançar Diária (DESPESA category='DIARIA' a partir do daily_rate).
  // Só admin/financeiro (manage_financial); o dentista NÃO lança.
  @RequiresPermission('manage_financial')
  @Post('daily-rate')
  createDailyRate(
    @Body() body: CreateDailyRateTransactionDto,
    @Request() req: any,
  ) {
    return this.service.createDailyRateTransaction({
      ...body,
      tenant_id: req.user.tenant_id,
      actor_id: req.user.id,
    });
  }

  // Fase 5 — picker tenant-scoped (gateado por manage_financial) dos profissionais
  // que TÊM diária configurada. Evita depender de GET /users (@Roles ADMIN), que viria
  // vazio pro financeiro não-admin.
  @RequiresPermission('manage_financial')
  @Get('professionals-with-rate')
  professionalsWithRate(@Request() req: any) {
    return this.service.professionalsWithDailyRate(req.user.tenant_id);
  }

  @RequiresPermission('manage_financial')
  @Post('transactions/:id/partial-payment')
  partialPayment(
    @Param('id') id: string,
    @Body() body: { amount: number; payment_method?: string },
    @Request() req: any,
  ) {
    return this.service.partialPayment(id, body.amount, body.payment_method, req.user.tenant_id, req.user.id);
  }

  @Get('audit-log')
  getAuditLog(
    @Query('dentistId') dentistId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('limit') limit: string,
    @Query('offset') offset: string,
    @Request() req: any,
  ) {
    return this.service.getAuditLog(req.user.tenant_id, dentistId, startDate, endDate, parseInt(limit || '50'), parseInt(offset || '0'));
  }

  // ─── Summary & Cash Flow ───────────────────────────────

  @Get('summary')
  getSummary(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('dentistId') dentistId: string,
    @Request() req: any,
  ) {
    return this.service.getSummary(req.user.tenant_id, startDate, endDate, dentistId);
  }

  @Get('cash-flow')
  getCashFlow(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('groupBy') groupBy: 'day' | 'week' | 'month',
    @Query('dentistId') dentistId: string,
    @Request() req: any,
  ) {
    return this.service.getCashFlow(
      req.user.tenant_id,
      startDate,
      endDate,
      groupBy || 'month',
      dentistId,
    );
  }

  // ─── Categories ────────────────────────────────────────

  @Get('categories')
  findAllCategories(@Request() req: any) {
    return this.service.findAllCategories(req.user.tenant_id);
  }

  @RequiresPermission('manage_financial')
  @Post('categories')
  createCategory(
    @Body() body: CreateCategoryDto,
    @Request() req: any,
  ) {
    return this.service.createCategory(body, req.user.tenant_id);
  }

  @RequiresPermission('manage_financial')
  @Patch('categories/:id')
  updateCategory(
    @Param('id') id: string,
    @Body() body: UpdateCategoryDto,
    @Request() req: any,
  ) {
    return this.service.updateCategory(id, body, req.user.tenant_id);
  }

  @RequiresPermission('manage_financial')
  @Delete('categories/:id')
  deleteCategory(
    @Param('id') id: string,
    @Request() req: any,
  ) {
    return this.service.deleteCategory(id, req.user.tenant_id);
  }

  // ─── Tax / Impostos ────────────────────────────────────────
  // Módulo de imposto sobre honorário (IRPF do advogado) removido na transição
  // odonto. A Fase 4+ vai reimplementar IRPJ/ISS para clínica.

  // ─── Dashboard Odontologico (Onda 16) ──────────────────────
  // Endpoints que agregam PaymentGatewayCharge (sinal/entrada/parcelas) para
  // a tela financeira principal. Separado do summary legado (que mexe com
  // FinancialTransaction + LeadHonorarioPayment juridicos).

  @Get('dashboard')
  getDashboard(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('dentistId') dentistId: string,
    @Request() req: any,
  ) {
    return this.chargesService.getDashboard({
      tenantId: req.user.tenant_id,
      startDate,
      endDate,
      dentistId,
    });
  }

  @Get('charges')
  findCharges(
    @Query('status') status: string,
    @Query('statusGroup') statusGroup: string,
    @Query('kind') kind: string,
    @Query('billingType') billingType: string,
    @Query('patientId') patientId: string,
    @Query('dentistId') dentistId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('limit') limit: string,
    @Query('offset') offset: string,
    @Request() req: any,
  ) {
    return this.chargesService.findCharges({
      tenantId: req.user.tenant_id,
      status,
      statusGroup: statusGroup as any,
      kind,
      billingType,
      patientId,
      dentistId,
      startDate,
      endDate,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Get('patients-summary')
  getPatientsSummary(
    @Query('orderBy') orderBy: string,
    @Query('dentistId') dentistId: string,
    @Query('limit') limit: string,
    @Request() req: any,
  ) {
    return this.chargesService.getPatientsSummary({
      tenantId: req.user.tenant_id,
      dentistId,
      orderBy: orderBy as any,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}
