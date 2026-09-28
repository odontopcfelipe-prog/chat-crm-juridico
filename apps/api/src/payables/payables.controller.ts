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
import { CreateInstallmentPlanDto, CreatePayableDto, UpdatePayableDto } from './payables.dto';

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
      status,
      category,
      startDate,
      endDate,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Get('categories')
  categories(@Request() req: any) {
    return this.service.getCategories(req.user.tenant_id);
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

  @Patch('transactions/:id')
  update(@Param('id') id: string, @Body() body: UpdatePayableDto, @Request() req: any) {
    return this.service.updatePayable(id, body, req.user.tenant_id, req.user.id);
  }

  @Delete('transactions/:id')
  remove(@Param('id') id: string, @Request() req: any) {
    return this.service.deletePayable(id, req.user.tenant_id, req.user.id);
  }
}
