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
import { PayablesService } from './payables.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequiresPermission } from '../auth/decorators/requires-permission.decorator';
import { CreateInstallmentPlanDto, CreatePayableDto, UpdatePayableDto, PayViaCaixaDto, CreateCompanyDto, UpdateCompanyDto } from './payables.dto';

/**
 * Contas a Pagar — acesso restrito a ADM/gerente (manage_payables).
 * Separado do FinanceiroController (view_financial/manage_financial) de propósito:
 * o setor financeiro/recepção NÃO deve ver contas sensíveis (aluguel, folha,
 * fornecedor). "Gerente" = usuário com manage_payables concedido via extra_grants.
 * Só mexe em DESPESA de origem PAYABLES — nunca RECEITA nem despesa de outra origem.
 */
@UseGuards(JwtAuthGuard)
@RequiresPermission('manage_payables')
@Controller('payables')
export class PayablesController {
  constructor(private readonly service: PayablesService) {}

  @Get('transactions')
  list(
    @Query('companyId') companyId: string,
    @Query('status') status: string,
    @Query('category') category: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('limit') limit: string,
    @Query('offset') offset: string,
    @Request() req: any,
  ) {
    return this.service.listPayables({
      tenantId: req.user.tenant_id,
      companyId: companyId || undefined, // undefined = clínica (padrão)
      status,
      category,
      startDate,
      endDate,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  // "Gastos do dia" — todas as saídas avulsas (inclui comissão/diária/caixa na clínica).
  @Get('gastos')
  gastos(
    @Query('companyId') companyId: string,
    @Query('status') status: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('limit') limit: string,
    @Request() req: any,
  ) {
    return this.service.listGastos({
      tenantId: req.user.tenant_id,
      companyId: companyId || undefined,
      status,
      startDate,
      endDate,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('categories')
  categories(@Request() req: any) {
    return this.service.getCategories(req.user.tenant_id);
  }

  // ─── Empresas (multi-empresa; a clínica é o padrão, não aparece aqui) ───────
  @Get('companies')
  companies(@Request() req: any) {
    return this.service.listCompanies(req.user.tenant_id);
  }

  @Post('companies')
  createCompany(@Body() body: CreateCompanyDto, @Request() req: any) {
    return this.service.createCompany(body, req.user.tenant_id);
  }

  @Patch('companies/:id')
  updateCompany(@Param('id') id: string, @Body() body: UpdateCompanyDto, @Request() req: any) {
    return this.service.updateCompany(id, body, req.user.tenant_id);
  }

  // Contas do caixa (pra escolher onde saiu o dinheiro na conciliação).
  @Get('accounts')
  accounts(@Request() req: any) {
    return this.service.getAccounts(req.user.tenant_id);
  }

  // Lançar conta / gasto do dia / conta recorrente (sempre DESPESA + source=PAYABLES)
  @Post('transactions')
  create(@Body() body: CreatePayableDto, @Request() req: any) {
    return this.service.createPayable(body, req.user.tenant_id, req.user.id);
  }

  // Compra PARCELADA (valores exatos, N vezes)
  @Post('installment-plan')
  installmentPlan(@Body() body: CreateInstallmentPlanDto, @Request() req: any) {
    return this.service.createInstallmentPlan(body, req.user.tenant_id, req.user.id);
  }

  // Pagar debitando o caixa do dia (conta + forma) — entra no fechamento.
  @Post('transactions/:id/pay')
  pay(@Param('id') id: string, @Body() body: PayViaCaixaDto, @Request() req: any) {
    return this.service.payViaCaixa(id, body, req.user.tenant_id, req.user.id);
  }

  @Patch('transactions/:id')
  update(@Param('id') id: string, @Body() body: UpdatePayableDto, @Request() req: any) {
    return this.service.updatePayable(id, body, req.user.tenant_id, req.user.id);
  }

  @Delete('transactions/:id')
  remove(@Param('id') id: string, @Request() req: any) {
    return this.service.deletePayable(id, req.user.tenant_id, req.user.id);
  }
}
