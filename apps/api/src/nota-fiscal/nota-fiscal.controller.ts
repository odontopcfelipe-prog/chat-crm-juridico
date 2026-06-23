import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { NotaFiscalService } from './nota-fiscal.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequiresPermission } from '../auth/decorators/requires-permission.decorator';
import { EmitNotaFiscalDto } from './nota-fiscal.dto';

@UseGuards(JwtAuthGuard)
// Onda 17.61 (segurança/RBAC-06) — NF era emitível/cancelável por qualquer papel.
// Leitura: view_financial; emitir/cancelar: manage_financial (abaixo).
@RequiresPermission('view_financial')
@Controller('nota-fiscal')
export class NotaFiscalController {
  constructor(private readonly service: NotaFiscalService) {}

  @Get()
  findAll(
    @Query('leadId') leadId: string,
    @Query('status') status: string,
    @Query('limit') limit: string,
    @Query('offset') offset: string,
    @Request() req: any,
  ) {
    return this.service.findAll({
      tenantId: req.user.tenant_id,
      leadId,
      status,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Get('config')
  getConfig(@Request() req: any) {
    return this.service.getConfig(req.user.tenant_id);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: any) {
    return this.service.findOne(id, req.user.tenant_id);
  }

  @RequiresPermission('manage_financial')
  @Post('emit')
  emit(@Body() body: EmitNotaFiscalDto, @Request() req: any) {
    return this.service.emit(body.transactionId, req.user.tenant_id);
  }

  @RequiresPermission('manage_financial')
  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Request() req: any) {
    return this.service.cancel(id, req.user.tenant_id);
  }
}
