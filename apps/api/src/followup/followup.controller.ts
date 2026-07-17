import { Controller, Get, Post, Patch, Put, Delete, Body, Param, Query, UseGuards, Request, ForbiddenException } from '@nestjs/common';
import { FollowupService } from './followup.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequiresPermission } from '../auth/decorators/requires-permission.decorator';

@UseGuards(JwtAuthGuard)
// Onda 17.32.128 — Fase 6: follow-up exige view_marketing
// (crc + admin por default)
@RequiresPermission('view_marketing')
@Controller('followup')
export class FollowupController {
  constructor(private readonly svc: FollowupService) {}

  @Get('stats')
  getStats(@Request() req: any) { return this.svc.getStats(req.user?.tenant_id); }

  // ─── Painel "Operacional" (Onda 17.49) ───────────────────────────────────
  @Get('operacional')
  getOperacional(@Request() req: any) { return this.svc.getOperacional(req.user?.tenant_id); }

  // ─── Histórico unificado de disparos (Onda 17.60) ─────────────────────────
  @Get('disparos')
  getDisparoHistory(
    @Request() req: any,
    @Query('days') days?: string,
    @Query('limit') limit?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
  ) {
    return this.svc.getDisparoHistory(req.user?.tenant_id, {
      days: days ? parseInt(days, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      type: type || undefined,
      status: status || undefined,
    });
  }

  // ─── Fase 3 — texto do recall de revisão (worker lê a mesma key) ──────────
  @Get('recall-template')
  getRecallTemplate(@Request() req: any) {
    return this.svc.getRecallTemplate(req.user?.tenant_id);
  }

  @Put('recall-template')
  setRecallTemplate(@Body() body: { template?: string }, @Request() req: any) {
    const roles: string[] = req.user?.roles || [];
    if (!roles.includes('ADMIN') && !roles.includes('SUPER_ADMIN')) {
      throw new ForbiddenException('Apenas ADMIN pode editar a mensagem do recall');
    }
    return this.svc.setRecallTemplate(req.user?.tenant_id, body?.template);
  }

  // ─── Central 2.0 — resumo de UM disparo (pra quem mandou, quando, status) ──
  @Get('disparo-detail')
  getDisparoDetail(@Request() req: any, @Query('id') id?: string, @Query('days') days?: string) {
    return this.svc.getDisparoDetail(req.user?.tenant_id, id || '', days ? parseInt(days, 10) : 30);
  }

  @Patch('operacional/toggle')
  setOperacionalToggle(@Body() body: { which: string; enabled: boolean }, @Request() req: any) {
    // Ler as metricas e liberado pra view_marketing (crc+admin), mas LIGAR/DESLIGAR
    // os robos de mensageria do paciente e ato administrativo — so ADMIN.
    const roles: string[] = req.user?.roles || [];
    if (!roles.includes('ADMIN') && !roles.includes('SUPER_ADMIN')) {
      throw new ForbiddenException('Apenas ADMIN pode ligar/desligar as automações');
    }
    return this.svc.setOperacionalToggle(req.user?.tenant_id, body?.which, !!body?.enabled);
  }

  // ─── Templates de cobrança (Onda 18.17) — ver/editar o texto de cada estágio ─
  @Get('cobranca-template/:stage')
  getCobrancaTemplate(@Param('stage') stage: string, @Request() req: any) {
    return this.svc.getCobrancaTemplate(req.user?.tenant_id, stage);
  }

  @Put('cobranca-template/:stage')
  setCobrancaTemplate(@Param('stage') stage: string, @Body() body: { template?: string }, @Request() req: any) {
    // Editar o texto que o paciente recebe = ato administrativo -> so ADMIN.
    const roles: string[] = req.user?.roles || [];
    if (!roles.includes('ADMIN') && !roles.includes('SUPER_ADMIN')) {
      throw new ForbiddenException('Apenas ADMIN pode editar as mensagens de cobrança');
    }
    return this.svc.setCobrancaTemplate(req.user?.tenant_id, stage, body?.template ?? '');
  }

  // ─── Sequências ──────────────────────────────────────────────────────────
  @Get('sequences')
  listSequences(@Query('tenant_id') tenantId?: string) {
    return this.svc.listSequences(tenantId);
  }

  @Post('sequences')
  createSequence(@Body() body: any) { return this.svc.createSequence(body); }

  @Patch('sequences/:id')
  updateSequence(@Param('id') id: string, @Body() body: any) {
    return this.svc.updateSequence(id, body);
  }

  @Delete('sequences/:id')
  deleteSequence(@Param('id') id: string) { return this.svc.deleteSequence(id); }

  @Post('sequences/:id/steps')
  addStep(@Param('id') id: string, @Body() body: any) { return this.svc.addStep(id, body); }

  @Patch('steps/:id')
  updateStep(@Param('id') id: string, @Body() body: any) { return this.svc.updateStep(id, body); }

  @Delete('steps/:id')
  deleteStep(@Param('id') id: string) { return this.svc.deleteStep(id); }

  // ─── Enrollments ─────────────────────────────────────────────────────────
  @Get('enrollments')
  listEnrollments(@Query() q: { status?: string; sequence_id?: string; lead_id?: string }) {
    return this.svc.listEnrollments(q);
  }

  @Post('enrollments')
  enrollLead(@Body() body: { lead_id: string; sequence_id: string }) {
    return this.svc.enrollLead(body.lead_id, body.sequence_id);
  }

  @Patch('enrollments/:id/pause')
  pauseEnrollment(@Param('id') id: string, @Body() body: { reason?: string }) {
    return this.svc.pauseEnrollment(id, body.reason);
  }

  @Patch('enrollments/:id/resume')
  resumeEnrollment(@Param('id') id: string) { return this.svc.resumeEnrollment(id); }

  @Patch('enrollments/:id/cancel')
  cancelEnrollment(@Param('id') id: string) { return this.svc.cancelEnrollment(id); }

  @Patch('enrollments/:id/converted')
  markConverted(@Param('id') id: string) { return this.svc.markConverted(id); }

  // ─── Aprovações ──────────────────────────────────────────────────────────
  @Get('approvals')
  listPendingApprovals(@Request() req: any) { return this.svc.listPendingApprovals(req.user?.tenant_id); }

  @Patch('messages/:id/approve')
  approveMessage(@Param('id') id: string, @Body() body: { edited_text?: string }, @Request() req: any) {
    return this.svc.approveMessage(id, req.user?.name || 'Sistema', body.edited_text);
  }

  @Patch('messages/:id/reject')
  rejectMessage(@Param('id') id: string, @Request() req: any) {
    return this.svc.rejectMessage(id, req.user?.name || 'Sistema');
  }

  @Post('messages/:id/regenerate')
  regenerateMessage(@Param('id') id: string) { return this.svc.regenerateMessage(id); }

  // ─── Disparos em Massa (Broadcasts) ─────────────────────────────────────
  @Get('broadcasts/preview')
  previewBroadcast(@Query('type') type: string, @Query('days_ahead') daysAhead: string, @Request() req: any) {
    return this.svc.previewBroadcast(type || 'AUDIENCIA', parseInt(daysAhead) || 7, req.user?.tenant_id);
  }

  @Get('broadcasts')
  listBroadcasts(@Request() req: any) {
    return this.svc.listBroadcasts(req.user?.tenant_id);
  }

  @Get('broadcasts/:id')
  getBroadcast(@Param('id') id: string) {
    return this.svc.getBroadcast(id);
  }

  @Post('broadcasts')
  createBroadcast(@Body() body: { type: string; days_ahead: number; interval_ms: number; custom_prompt?: string }, @Request() req: any) {
    return this.svc.createBroadcast(body, req.user.id, req.user?.tenant_id);
  }

  @Patch('broadcasts/:id/cancel')
  cancelBroadcast(@Param('id') id: string) {
    return this.svc.cancelBroadcast(id);
  }

  // ─── Seed ────────────────────────────────────────────────────────────────
  @Post('seed-defaults')
  seedDefaultSequences() { return this.svc.seedDefaultSequences(); }
}
