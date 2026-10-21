import { Controller, Get, Post, Put, Patch, Delete, Param, Body, Query, Req, UseGuards } from '@nestjs/common';
import { PontoService } from './ponto.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequiresPermission } from '../auth/decorators/requires-permission.decorator';
import { Authenticated, type AuthUser } from '../auth/decorators/authenticated.decorator';
import { clientIp } from './ponto-geo';
import {
  CreateMemberDto,
  ManualPunchDto,
  PontoLocalDto,
  PunchDto,
  ScheduleDto,
  UpdateMemberDto,
  VoidPunchDto,
} from './ponto.dto';

// Relógio de ponto. Duas centrais:
//  - Funcionário (qualquer logado): bate e vê SÓ o próprio ponto (me/status/punch).
//  - Adm (manage_users): equipe toda, espelhos, ajustes, relatório pra contabilidade
//    e a configuração (local base + equipe do ponto e horários).
@UseGuards(JwtAuthGuard)
@Controller('ponto')
export class PontoController {
  constructor(private readonly service: PontoService) {}

  // ─── Funcionário ────────────────────────────────────────
  @Get('me')
  me(@Query('month') month: string, @Authenticated() user: AuthUser) {
    return this.service.me(user.tenant_id, user.id, month);
  }

  @Get('status')
  status(@Authenticated() user: AuthUser) {
    return this.service.status(user.tenant_id, user.id);
  }

  @Post('punch')
  punch(@Body() body: PunchDto, @Authenticated() user: AuthUser, @Req() req: any) {
    const ua = req?.headers?.['user-agent'];
    return this.service.punch(user.tenant_id, user.id, body, clientIp(req), typeof ua === 'string' ? ua : null);
  }

  // ─── Adm: equipe, espelhos e ajustes ────────────────────
  @RequiresPermission('manage_users')
  @Get('team')
  team(@Query('month') month: string, @Authenticated() user: AuthUser) {
    return this.service.team(user.tenant_id, month);
  }

  @RequiresPermission('manage_users')
  @Get('report')
  report(@Query('month') month: string, @Authenticated() user: AuthUser) {
    return this.service.report(user.tenant_id, month);
  }

  @RequiresPermission('manage_users')
  @Get('users/:userId')
  espelho(@Param('userId') userId: string, @Query('month') month: string, @Authenticated() user: AuthUser) {
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

  // ─── Adm: configuração (Configurações › Ponto) ──────────
  @RequiresPermission('manage_users')
  @Get('config')
  config(@Authenticated() user: AuthUser) {
    return this.service.configView(user.tenant_id);
  }

  @RequiresPermission('manage_users')
  @Put('config/local')
  saveLocal(@Body() body: PontoLocalDto, @Authenticated() user: AuthUser) {
    return this.service.saveLocal(user.tenant_id, body);
  }

  // Link do "Compartilhar" do Google Maps → coordenadas (o navegador não abre o link curto).
  @RequiresPermission('manage_users')
  @Get('config/resolve-map')
  resolveMap(@Query('url') url: string) {
    return this.service.resolveMapLink(url);
  }

  @RequiresPermission('manage_users')
  @Post('members')
  createMember(@Body() body: CreateMemberDto, @Authenticated() user: AuthUser) {
    return this.service.createMember(user.tenant_id, user.id, body);
  }

  @RequiresPermission('manage_users')
  @Patch('members/:userId')
  updateMember(@Param('userId') userId: string, @Body() body: UpdateMemberDto, @Authenticated() user: AuthUser) {
    return this.service.updateMember(user.tenant_id, userId, body);
  }

  @RequiresPermission('manage_users')
  @Put('members/:userId/schedule')
  saveSchedule(@Param('userId') userId: string, @Body() body: ScheduleDto, @Authenticated() user: AuthUser) {
    return this.service.saveSchedule(user.tenant_id, user.id, userId, body);
  }

  @RequiresPermission('manage_users')
  @Delete('members/:userId/schedules/:validFrom')
  deleteSchedule(@Param('userId') userId: string, @Param('validFrom') validFrom: string, @Authenticated() user: AuthUser) {
    return this.service.deleteSchedule(user.tenant_id, userId, validFrom);
  }
}
