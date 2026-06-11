import { Controller, Get, Patch, Post, Param, Body, Request, UseGuards, ForbiddenException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { EmailAutomationService } from './email-automation.service';

/**
 * Onda 17.32.181 — E-mails automaticos do TENANT (estilo Nuvemshop).
 * Diferente do SMTP global (/settings/smtp, SUPER_ADMIN), aqui cada
 * ADMIN de clinica gerencia os templates DA PROPRIA clinica.
 */
@UseGuards(JwtAuthGuard)
@Controller('email-automation')
export class EmailAutomationController {
  constructor(private readonly service: EmailAutomationService) {}

  private tenantIdOf(req: any): string {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new ForbiddenException('Usuário sem clínica vinculada.');
    return tenantId;
  }

  /** Lista os eventos com o template efetivo (default ou customizado). */
  @Get()
  @Roles('ADMIN')
  list(@Request() req: any) {
    return this.service.listForTenant(this.tenantIdOf(req));
  }

  /** Edita assunto/corpo/liga-desliga de um evento. */
  @Patch(':key')
  @Roles('ADMIN')
  update(
    @Request() req: any,
    @Param('key') key: string,
    @Body() body: { enabled?: boolean; subject?: string; body?: string },
  ) {
    return this.service.update(this.tenantIdOf(req), key, body || {});
  }

  /** Restaura o template padrao do sistema. */
  @Post(':key/reset')
  @Roles('ADMIN')
  reset(@Request() req: any, @Param('key') key: string) {
    return this.service.resetToDefault(this.tenantIdOf(req), key);
  }

  /** Envia o template com dados de exemplo pro e-mail do proprio admin. */
  @Post(':key/test')
  @Roles('ADMIN')
  test(@Request() req: any, @Param('key') key: string) {
    return this.service.sendTest(this.tenantIdOf(req), key, req.user.email);
  }
}
