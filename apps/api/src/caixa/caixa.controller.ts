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
import { CaixaService } from './caixa.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequiresPermission } from '../auth/decorators/requires-permission.decorator';
import {
  CreateAccountDto,
  UpdateAccountDto,
  AddMovementDto,
  CloseDayDto,
  ValidateDayDto,
} from './caixa.dto';

// Onda 18.x — Caixa do dia. Classe exige operate_cash (recepção opera SEM ver
// cobranças). Validar/devolver sobrescreve com manage_financial (admin/financeiro).
@UseGuards(JwtAuthGuard)
@RequiresPermission('operate_cash')
@Controller('caixa')
export class CaixaController {
  constructor(private readonly service: CaixaService) {}

  // ─── Contas ────────────────────────────────────────────
  @Get('accounts')
  listAccounts(@Request() req: any) {
    return this.service.listAccounts(req.user.tenant_id);
  }

  @Post('accounts')
  createAccount(@Body() body: CreateAccountDto, @Request() req: any) {
    return this.service.createAccount(req.user.tenant_id, body);
  }

  @Patch('accounts/:id')
  updateAccount(@Param('id') id: string, @Body() body: UpdateAccountDto, @Request() req: any) {
    return this.service.updateAccount(id, req.user.tenant_id, body);
  }

  // ─── Caixa do dia (recepção) ───────────────────────────
  @Get('today')
  today(@Request() req: any) {
    return this.service.getToday(req.user.tenant_id, req.user.id);
  }

  @Post('movements')
  addMovement(@Body() body: AddMovementDto, @Request() req: any) {
    return this.service.addMovement(req.user.tenant_id, req.user.id, body);
  }

  @Delete('movements/:id')
  deleteMovement(@Param('id') id: string, @Request() req: any) {
    return this.service.deleteMovement(id, req.user.tenant_id, req.user.id);
  }

  @Post('close')
  closeDay(@Body() body: CloseDayDto, @Request() req: any) {
    return this.service.closeDay(req.user.tenant_id, req.user.id, body);
  }

  // ─── Fechamentos ───────────────────────────────────────
  @Get('closings')
  listClosings(@Query('status') status: string, @Request() req: any) {
    return this.service.listClosings(req.user.tenant_id, status);
  }

  @Get('closings/:id')
  getClosing(@Param('id') id: string, @Request() req: any) {
    return this.service.getClosing(id, req.user.tenant_id);
  }

  // Validar/devolver: só quem gerencia o financeiro (admin/financeiro).
  @RequiresPermission('manage_financial')
  @Post('closings/:id/validate')
  validate(@Param('id') id: string, @Body() body: ValidateDayDto, @Request() req: any) {
    return this.service.validateDay(id, req.user.tenant_id, req.user.id, body);
  }

  @RequiresPermission('manage_financial')
  @Post('closings/:id/return')
  returnDay(@Param('id') id: string, @Body() body: ValidateDayDto, @Request() req: any) {
    return this.service.returnDay(id, req.user.tenant_id, req.user.id, body);
  }
}
