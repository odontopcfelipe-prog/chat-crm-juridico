import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, Request, UseGuards, BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CommissionRulesService } from './commission-rules.service';
import { CommissionsService } from './commissions.service';
import { GoalsService } from './goals.service';
import { CreateCommissionRuleDto, UpdateCommissionRuleDto } from './dto/commission-rule.dto';
import { CreateCommissionDto, PayCommissionDto, UpdateCommissionDto } from './dto/commission.dto';
import { CreateGoalDto, UpdateGoalDto } from './dto/goal.dto';

function parseBool(v?: string): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return v === 'true' || v === '1';
}

@UseGuards(JwtAuthGuard)
@Controller()
export class CommissionsController {
  constructor(
    private readonly rules: CommissionRulesService,
    private readonly commissions: CommissionsService,
    private readonly goals: GoalsService,
  ) {}

  // ─── Commission Rules ────────────────────────────────────────────

  @Post('commission-rules')
  createRule(@Body() dto: CreateCommissionRuleDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.rules.create(tenantId, dto);
  }

  @Get('commission-rules')
  listRules(
    @Request() req: any,
    @Query('professional_user_id') professional_user_id?: string,
    @Query('active') active?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.rules.findAll(tenantId, {
      professional_user_id,
      active: parseBool(active),
    });
  }

  @Patch('commission-rules/:id')
  updateRule(@Param('id') id: string, @Body() dto: UpdateCommissionRuleDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.rules.update(tenantId, id, dto);
  }

  @Delete('commission-rules/:id')
  archiveRule(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.rules.archive(tenantId, id);
  }

  // ─── Commissions ────────────────────────────────────────────

  @Post('commissions')
  createCommission(@Body() dto: CreateCommissionDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.commissions.create(tenantId, dto);
  }

  @Get('commissions')
  listCommissions(
    @Request() req: any,
    @Query('professional_user_id') professional_user_id?: string,
    @Query('patient_id') patient_id?: string,
    @Query('status') status?: string,
    @Query('reference_month') reference_month?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.commissions.findAll(tenantId, {
      professional_user_id, patient_id, status, reference_month, from, to,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('commissions/summary')
  summary(@Request() req: any, @Query('reference_month') reference_month?: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.commissions.summary(tenantId, { reference_month });
  }

  @Get('commissions/payable')
  payable(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.commissions.payable(tenantId);
  }

  @Get('commissions/:id')
  getCommission(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.commissions.findOne(tenantId, id);
  }

  @Patch('commissions/:id')
  updateCommission(@Param('id') id: string, @Body() dto: UpdateCommissionDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.commissions.update(tenantId, id, dto);
  }

  @Post('commissions/:id/release')
  releaseCommission(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.commissions.release(tenantId, id);
  }

  @Post('commissions/:id/pay')
  payCommission(@Param('id') id: string, @Body() dto: PayCommissionDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.commissions.pay(tenantId, id, dto);
  }

  // ─── Goals ────────────────────────────────────────────

  @Post('goals')
  createGoal(@Body() dto: CreateGoalDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.goals.create(tenantId, dto);
  }

  @Get('goals')
  listGoals(
    @Request() req: any,
    @Query('active') active?: string,
    @Query('scope') scope?: string,
    @Query('professional_user_id') professional_user_id?: string,
    @Query('metric') metric?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.goals.findAll(tenantId, {
      active: parseBool(active),
      scope,
      professional_user_id,
      metric,
    });
  }

  @Get('goals/active')
  activeGoals(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.goals.findActive(tenantId);
  }

  @Get('goals/:id')
  getGoal(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.goals.findOne(tenantId, id);
  }

  @Patch('goals/:id')
  updateGoal(@Param('id') id: string, @Body() dto: UpdateGoalDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.goals.update(tenantId, id, dto);
  }

  @Delete('goals/:id')
  deleteGoal(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.goals.remove(tenantId, id);
  }

  @Post('goals/:id/recalculate')
  recalculateGoal(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.goals.recalculate(tenantId, id);
  }

  @Post('goals/recalculate-all')
  recalculateAll(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.goals.recalculateActive(tenantId);
  }
}
