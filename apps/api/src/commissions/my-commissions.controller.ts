import { Controller, Get, Query, Request, UseGuards, BadRequestException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CommissionsService } from './commissions.service';

/**
 * "Minha comissão" — visão escopada ao usuário LOGADO (o dentista vê só a dele).
 *
 * Segurança: SÓ @UseGuards(JwtAuthGuard), SEM @RequiresPermission — o dentista não
 * tem view_financial (esse gate fica no CommissionsController, p/ adm/financeiro).
 * Aqui o escopo vem do próprio JWT, então não há folha da clínica exposta.
 *
 * ANTI-IDOR: o profissional NUNCA vem da query — sempre forçamos req.user.id. Não
 * existe parâmetro professional_user_id nestas rotas; o serviço filtra por selfUserId.
 */
@UseGuards(JwtAuthGuard)
@Controller()
export class MyCommissionsController {
  constructor(private readonly commissions: CommissionsService) {}

  @Get('commissions/mine/summary')
  mineSummary(@Request() req: any, @Query('reference_month') reference_month?: string) {
    const tenantId = req.user?.tenant_id;
    const selfUserId = req.user?.id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!selfUserId) throw new BadRequestException('user_id ausente');
    return this.commissions.summary(tenantId, { reference_month, selfUserId });
  }

  @Get('commissions/mine/payable')
  minePayable(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    const selfUserId = req.user?.id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!selfUserId) throw new BadRequestException('user_id ausente');
    return this.commissions.payable(tenantId, { selfUserId });
  }
}
