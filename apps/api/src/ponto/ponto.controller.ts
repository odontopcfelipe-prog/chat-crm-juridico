import { Controller, Get, Post, Put, Param, Body, Query, Req, UseGuards } from '@nestjs/common';
import { PontoService } from './ponto.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequiresPermission } from '../auth/decorators/requires-permission.decorator';
import { Authenticated, type AuthUser } from '../auth/decorators/authenticated.decorator';
import { clientIp } from './ponto-geo';
import { ManualPunchDto, PontoConfigDto, PunchDto, UserScheduleDto, VoidPunchDto } from './ponto.dto';

// Relógio de ponto (out/2026). Bater e ver o PRÓPRIO espelho: qualquer usuário logado.
// Equipe, ajustes e configuração: quem gerencia usuários (admin/gerente).
@UseGuards(JwtAuthGuard)
@Controller('ponto')
export class PontoController {
  constructor(private readonly service: PontoService) {}

  @Get('me')
  me(@Query('month') month: string, @Authenticated() user: AuthUser) {
    return this.service.me(user.tenant_id, user.id, month);
  }

  @Post('punch')
  punch(@Body() body: PunchDto, @Authenticated() user: AuthUser, @Req() req: any) {
    const ua = req?.headers?.['user-agent'];
    return this.service.punch(user.tenant_id, user.id, body, clientIp(req), typeof ua === 'string' ? ua : null);
  }

  // ─── Gestor ─────────────────────────────────────────────
  @RequiresPermission('manage_users')
  @Get('team')
  team(@Query('month') month: string, @Authenticated() user: AuthUser) {
    return this.service.team(user.tenant_id, month);
  }

  @RequiresPermission('manage_users')
  @Get('users/:userId')
  async espelho(@Param('userId') userId: string, @Query('month') month: string, @Authenticated() user: AuthUser) {
    await this.service.assertPerson(user.tenant_id, userId);
    return this.service.espelho(user.tenant_id, userId, month);
  }

  @RequiresPermission('manage_users')
  @Post('users/:userId/punches')
  addManual(@Param('userId') userId: string, @Body() body: ManualPunchDto, @Authenticated() user: AuthUser) {
    return this.service.addManual(user.tenant_id, user.id, userId, body);
  }

  @RequiresPermission('manage_users')
  @Post('punches/:id/void')
  voidPunch(@Param('id') id: string, @Body() body: VoidPunchDto, @Authenticated() user: AuthUser) {
    return this.service.voidPunch(user.tenant_id, user.id, id, body.reason);
  }

  @RequiresPermission('manage_users')
  @Put('users/:userId/schedule')
  schedule(@Param('userId') userId: string, @Body() body: UserScheduleDto, @Authenticated() user: AuthUser) {
    return this.service.saveUserSchedule(user.tenant_id, userId, body.minutes);
  }

  @RequiresPermission('manage_users')
  @Get('config')
  config(@Authenticated() user: AuthUser, @Req() req: any) {
    return this.service.adminConfig(user.tenant_id, clientIp(req));
  }

  @RequiresPermission('manage_users')
  @Put('config')
  saveConfig(@Body() body: PontoConfigDto, @Authenticated() user: AuthUser, @Req() req: any) {
    return this.service.saveConfig(user.tenant_id, body, clientIp(req));
  }
}
