import { Controller, Get, Post, Put, Body, Param, Query, UseGuards, Request, HttpCode } from '@nestjs/common';
import { ReactivationService } from './reactivation.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequiresPermission } from '../auth/decorators/requires-permission.decorator';
import { Roles } from '../auth/decorators/roles.decorator';

/**
 * Régua de reativação de leads — painel do CRC (Previstos / Enviados ✓) e a
 * personalização da Central de Disparos (teto e textos por toque).
 *
 * O liga/desliga NÃO mora aqui: é o mesmo PATCH /followup/operacional/toggle dos
 * outros disparos (ids reativacao_*), pra Central tratar tudo igual.
 *
 * Tenant SEMPRE de req.user.tenant_id (snake_case — o camelCase já vazou dado).
 * Bodies tipados inline (como o followup): o ValidationPipe global
 * (whitelist + forbidNonWhitelisted) só valida DTO de classe; a validação de
 * conteúdo fica no service.
 */
@UseGuards(JwtAuthGuard)
@RequiresPermission('view_marketing')
@Controller('reactivation')
export class ReactivationController {
  constructor(private readonly svc: ReactivationService) {}

  @Get('summary')
  getSummary(@Request() req: any) {
    return this.svc.getSummary(req.user?.tenant_id);
  }

  @Get('scheduled')
  getScheduled(@Request() req: any, @Query('coluna') coluna?: string, @Query('days') days?: string) {
    return this.svc.getScheduled(req.user?.tenant_id, coluna, days);
  }

  @Get('sent')
  getSent(@Request() req: any, @Query('coluna') coluna?: string, @Query('days') days?: string) {
    return this.svc.getSent(req.user?.tenant_id, coluna, days);
  }

  @Post('dispatches/:id/skip')
  @HttpCode(200)
  skipDispatch(@Param('id') id: string, @Request() req: any) {
    return this.svc.skipDispatch(req.user?.tenant_id, id, req.user?.id);
  }

  @Post('leads/:leadId/stop')
  @HttpCode(200)
  stopLead(@Param('leadId') leadId: string, @Body() body: { opt_out?: boolean }, @Request() req: any) {
    return this.svc.stopLead(req.user?.tenant_id, leadId, body?.opt_out === true, req.user?.id);
  }

  // ─── Configuração (Central de Disparos) — ler é view_marketing, gravar é ADMIN ─
  @Get('config')
  getConfig(@Request() req: any) {
    return this.svc.getConfig(req.user?.tenant_id);
  }

  @Put('config')
  @Roles('ADMIN', 'SUPER_ADMIN')
  setConfig(@Body() body: { teto?: number }, @Request() req: any) {
    return this.svc.setConfig(req.user?.tenant_id, body?.teto);
  }

  @Get('template/:coluna/:toque')
  getTemplate(@Param('coluna') coluna: string, @Param('toque') toque: string, @Request() req: any) {
    return this.svc.getTemplate(req.user?.tenant_id, coluna, toque);
  }

  @Put('template/:coluna/:toque')
  @Roles('ADMIN', 'SUPER_ADMIN')
  setTemplate(
    @Param('coluna') coluna: string,
    @Param('toque') toque: string,
    @Body() body: { template?: string },
    @Request() req: any,
  ) {
    return this.svc.setTemplate(req.user?.tenant_id, coluna, toque, body?.template);
  }
}
