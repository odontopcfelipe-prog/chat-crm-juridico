import { Controller, Get, Post, Body, Patch, Delete, Param, Query, UseGuards, Request, BadRequestException, Res } from '@nestjs/common';
import { LeadsService } from './leads.service';
import { LeadsCleanupService } from './leads-cleanup.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateLeadDto, UpdateLeadDto, UpdateLeadStageDto } from './dto/create-lead.dto';

@UseGuards(JwtAuthGuard)
@Controller('leads')
export class LeadsController {
  constructor(
    private readonly leadsService: LeadsService,
    private readonly leadsCleanupService: LeadsCleanupService,
  ) {}

  @Post()
  create(@Body() dto: CreateLeadDto, @Request() req: any) {
    return this.leadsService.create({
      name: dto.name,
      phone: dto.phone,
      email: dto.email,
      origin: dto.origin,
      tags: dto.tags,
      tenant: req.user?.tenant_id ? { connect: { id: req.user.tenant_id } } : undefined,
    });
  }

  @Get()
  findAll(
    @Request() req: any,
    @Query('inboxId') inboxId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('stage') stage?: string,
    @Query('pipeline_id') pipelineId?: string,
  ) {
    const p = page ? parseInt(page, 10) : undefined;
    const l = limit ? parseInt(limit, 10) : undefined;
    return this.leadsService.findAll(req.user?.tenant_id, inboxId, p, l, search, stage, req.user?.id, pipelineId);
  }

  @Get('check-phone')
  checkPhone(@Request() req: any, @Query('phone') phone: string) {
    if (!phone) throw new BadRequestException('phone e obrigatorio');
    // Onda 17.36 — escopo por tenant: a checagem só enxerga leads da própria
    // clínica (antes vazava existência/dados de lead de outro tenant).
    return this.leadsService.checkPhone(phone, req.user?.tenant_id ?? null);
  }

  // Onda 5e v31 (Fase 25) — leads que ja realizaram a avaliacao clinica.
  // Usado pela aba "Pos-Avaliacao" do CRM. Default = 60 dias.
  @Get('post-avaliacao')
  findPostAvaliacao(
    @Request() req: any,
    @Query('days') days?: string,
  ) {
    const d = days ? Math.max(1, Math.min(365, parseInt(days, 10) || 60)) : 60;
    return this.leadsService.findPostAvaliacao(req.user?.tenant_id, d);
  }

  @Get('export')
  async exportCsv(
    @Request() req: any,
    @Query('search') search: string,
    @Res() res: any,
  ) {
    const csv = await this.leadsService.exportCsv(req.user?.tenant_id, search, req.user?.id);
    const filename = `leads_${new Date().toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + csv); // BOM UTF-8 para Excel abrir corretamente
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: any) {
    return this.leadsService.findOne(id, req.user?.tenant_id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: UpdateLeadDto,
    @Request() req: any,
  ) {
    return this.leadsService.update(id, body, req.user?.tenant_id);
  }

  @Patch(':id/stage')
  updateStage(@Param('id') id: string, @Body() body: UpdateLeadStageDto, @Request() req: any) {
    return this.leadsService.updateStatus(
      id,
      body.stage,
      req.user?.tenant_id,
      body.loss_reason,
      req.user?.id,
      body.stage_id,
    );
  }

  @Get(':id/timeline')
  getTimeline(@Param('id') id: string, @Request() req: any) {
    return this.leadsService.getTimeline(id, req.user?.tenant_id);
  }

  @Post(':id/summary')
  summarize(@Param('id') id: string, @Request() req: any) {
    return this.leadsService.summarizeLead(id, req.user?.tenant_id);
  }

  /**
   * Garante que existe Patient pra este lead (idempotente). Usado pra
   * reparar leads antigos criados antes do hook automático em updateStatus,
   * OU como fallback caso o hook falhe.
   *
   * Retorna o Patient (criado ou existente).
   */
  @Post(':id/ensure-patient')
  ensurePatient(@Param('id') id: string, @Request() req: any) {
    return this.leadsService.ensurePatient(id, req.user?.tenant_id);
  }

  /**
   * Onda 17.32.58 — Promove Lead -> Cliente manualmente.
   *
   * Usado quando operador quer mover o contato pra aba "Clientes" sem
   * passar pelo fluxo padrao (encaminhar ao financeiro / pagamento).
   * Casos comuns: paciente pagou em dinheiro fora do Asaas, cliente
   * recorrente que voltou, etc.
   *
   * Resolve patient via lead -> patient (cria se necessario via
   * ensurePatient) e chama graduateLeadToClient.
   */
  @Post(':id/promote-to-client')
  async promoteToClient(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.id;
    if (!tenantId) throw new Error('tenant_id ausente no JWT');
    // Garante que o paciente existe (best-effort — se ja existe, retorna)
    const patient = await this.leadsService.ensurePatient(id, tenantId);
    if (!patient?.id) {
      return { ok: false, error: 'Nao foi possivel criar/encontrar paciente vinculado' };
    }
    return this.leadsService.graduateLeadToClient(patient.id, tenantId, userId);
  }

  /**
   * Onda 17.32.58 — Demove Cliente -> Lead manualmente (reverte a
   * promocao). Usado quando operador marcou cliente por engano.
   */
  @Post(':id/demote-to-lead')
  async demoteToLead(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new Error('tenant_id ausente no JWT');
    const patient = await this.leadsService['prisma'].patient.findFirst({
      where: { lead_id: id, tenant_id: tenantId },
      select: { id: true },
    });
    if (!patient?.id) {
      return { ok: false, error: 'Paciente nao encontrado pra esse lead' };
    }
    return this.leadsService.demoteLeadFromClient(patient.id, tenantId);
  }

  @Delete(':id/memory')
  resetMemory(@Param('id') id: string, @Request() req: any) {
    return this.leadsService.resetMemory(id, req.user?.tenant_id);
  }

  // DELETE /leads/:id — exclui contato e TODOS os seus dados (somente ADMIN)
  @Delete(':id')
  @Roles('ADMIN')
  deleteContact(@Param('id') id: string, @Request() req: any) {
    return this.leadsService.deleteContact(id, req.user?.tenant_id);
  }

  @Post('cleanup/deduplicate')
  @Roles('ADMIN')
  deduplicatePhones(@Request() req: any) {
    // Scoped ao tenant do admin (unifica só os contatos da própria clínica +
    // normaliza os telefones dos pacientes dela). Merge nunca cruza tenant.
    // HARD-FAIL sem tenant: um SUPER_ADMIN com tenant_id nulo cairia no modo
    // GLOBAL do serviço e mesclaria/deletaria leads de TODAS as clínicas.
    const tenantId = req.user?.tenant_id;
    if (!tenantId) {
      throw new BadRequestException('Ação disponível apenas no contexto de uma clínica.');
    }
    return this.leadsCleanupService.deduplicatePhones(tenantId);
  }
}
