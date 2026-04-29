/**
 * ReferralsController — endpoints REST pra Indicação Premiada (Fase 21).
 *
 * Rotas:
 *  GET    /referrals?status=EARNED&referrerId=...  — listar indicações
 *  GET    /referrals/stats                          — totais por status
 *  GET    /referrals/rule                           — config do programa
 *  PATCH  /referrals/rule                           — alterar config
 *  GET    /referrals/:id                            — detalhe
 *  PATCH  /referrals/:id                            — editar (status, reward, notas)
 *  POST   /referrals/:id/mark-paid                  — atalho pra marcar PAID
 *  DELETE /referrals/:id                            — remover
 */
import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, Request, UseGuards, BadRequestException,
} from '@nestjs/common';
import { ReferralsService } from './referrals.service';
import type { UpdateReferralDto, UpdateRuleDto } from './referrals.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('referrals')
export class ReferralsController {
  constructor(private service: ReferralsService) {}

  @Get()
  list(
    @Request() req: any,
    @Query('status') status?: string,
    @Query('referrerId') referrerId?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.list(tenantId, { status, referrerId });
  }

  @Get('stats')
  stats(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.stats(tenantId);
  }

  @Get('rule')
  getRule(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.getRule(tenantId);
  }

  @Patch('rule')
  updateRule(@Request() req: any, @Body() body: UpdateRuleDto) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.updateRule(tenantId, body);
  }

  @Get(':id')
  findOne(@Request() req: any, @Param('id') id: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.findOne(id, tenantId);
  }

  @Patch(':id')
  update(@Request() req: any, @Param('id') id: string, @Body() body: UpdateReferralDto) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.update(id, tenantId, body);
  }

  @Post(':id/mark-paid')
  markPaid(@Request() req: any, @Param('id') id: string, @Body() body?: { notes?: string }) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.markPaid(id, tenantId, body?.notes);
  }

  @Delete(':id')
  remove(@Request() req: any, @Param('id') id: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.remove(id, tenantId);
  }
}
