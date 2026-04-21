import {
  Controller, Get, Post, Body, Param, Request, UseGuards, BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Public } from '../auth/decorators/public.decorator';
import { PortalAuthService } from './portal-auth.service';
import { PortalService } from './portal.service';
import { PortalJwtGuard } from './portal-jwt.guard';

@Controller()
export class PortalController {
  constructor(
    private readonly auth: PortalAuthService,
    private readonly portal: PortalService,
  ) {}

  // ─── Autenticacao ───────────────────────────────────────────────

  /** Recepcao gera magic link. Requer JWT de funcionario. */
  @UseGuards(JwtAuthGuard)
  @Post('portal/magic-link')
  createMagicLink(
    @Body() body: { patient_id: string; channel?: string },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!body?.patient_id) throw new BadRequestException('patient_id obrigatorio');
    return this.auth.createMagicLink(tenantId, body.patient_id, body.channel);
  }

  /** Publico — paciente troca token magico por JWT. */
  @Public()
  @Post('portal/auth/exchange')
  exchangeToken(@Body() body: { token: string }, @Request() req: any) {
    if (!body?.token) throw new BadRequestException('token obrigatorio');
    return this.auth.exchangeToken(
      body.token,
      req.ip,
      req.headers?.['user-agent'],
    );
  }

  // ─── Rotas autenticadas como paciente ─────────────────────────

  @Public()
  @UseGuards(PortalJwtGuard)
  @Get('portal/me')
  getMe(@Request() req: any) {
    const { tenant_id, patient_id } = req.patient;
    return this.portal.getMe(tenant_id, patient_id);
  }

  @Public()
  @UseGuards(PortalJwtGuard)
  @Get('portal/appointments')
  getAppointments(@Request() req: any) {
    const { tenant_id, patient_id } = req.patient;
    return this.portal.getAppointments(tenant_id, patient_id);
  }

  @Public()
  @UseGuards(PortalJwtGuard)
  @Post('portal/appointments/:id/confirm')
  confirmAppointment(@Param('id') id: string, @Request() req: any) {
    const { tenant_id, patient_id } = req.patient;
    return this.portal.confirmAppointment(tenant_id, patient_id, id);
  }

  @Public()
  @UseGuards(PortalJwtGuard)
  @Post('portal/appointments/:id/cancel')
  cancelAppointment(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @Request() req: any,
  ) {
    const { tenant_id, patient_id } = req.patient;
    return this.portal.cancelAppointment(tenant_id, patient_id, id, body?.reason);
  }

  @Public()
  @UseGuards(PortalJwtGuard)
  @Get('portal/installments')
  getInstallments(@Request() req: any) {
    const { tenant_id, patient_id } = req.patient;
    return this.portal.getInstallments(tenant_id, patient_id);
  }

  @Public()
  @UseGuards(PortalJwtGuard)
  @Get('portal/anamneses')
  getAnamneses(@Request() req: any) {
    const { tenant_id, patient_id } = req.patient;
    return this.portal.getAnamneses(tenant_id, patient_id);
  }
}
