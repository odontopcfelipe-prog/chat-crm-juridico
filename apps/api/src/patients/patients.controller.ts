import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Delete,
  Param,
  Query,
  UseGuards,
  Request,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Res,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { PatientsService } from './patients.service';
import { LeadsService } from '../leads/leads.service';
import { AffiliateService } from './affiliate.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
// Onda 17.52 — Etapa 3: leitura de paciente exige view_patients (antes aberta a
// qualquer logado). Todos os 6 setores têm view_patients por default.
import { RequiresPermission } from '../auth/decorators/requires-permission.decorator';
import { CreatePatientDto, UpdatePatientDto } from './dto/create-patient.dto';
import {
  canEditPatientPersonalData,
  canArchivePatient,
} from '../common/utils/permissions.util';
import { isAdmin } from '../common/utils/permissions.util';

@UseGuards(JwtAuthGuard)
@Controller('patients')
export class PatientsController {
  constructor(
    private readonly patientsService: PatientsService,
    private readonly leadsService: LeadsService,
    private readonly affiliateService: AffiliateService,
  ) {}

  // Onda 17.52 — Etapa 7: cadastrar paciente exige edit_patients (antes era
  // checagem por papel). Têm por default: recepção, dentista, CRC e admin.
  @RequiresPermission('edit_patients')
  @Post()
  create(@Body() dto: CreatePatientDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.patientsService.create(tenantId, {
      ...dto,
      birth_date: dto.birth_date ? new Date(dto.birth_date) : undefined,
    });
  }

  @RequiresPermission('view_patients')
  @Get()
  findAll(
    @Request() req: any,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('activity') activity?: string,
    @Query('dentistId') dentistId?: string,
    @Query('tagId') tagId?: string,
    @Query('noVisitMonths') noVisitMonths?: string,
    @Query('withActivePlan') withActivePlan?: string,
    @Query('withoutAnamnesis') withoutAnamnesis?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.patientsService.findAll(tenantId, {
      search,
      status,
      activity,
      dentistId,
      tagId,
      noVisitMonths: noVisitMonths ? parseInt(noVisitMonths, 10) : undefined,
      withActivePlan: withActivePlan === 'true' || withActivePlan === '1',
      withoutAnamnesis: withoutAnamnesis === 'true' || withoutAnamnesis === '1',
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @RequiresPermission('view_patients')
  @Get('stats')
  getStats(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.patientsService.getStats(tenantId);
  }

  /**
   * Onda 14.50 — Funil "Pacientes Clínica": pacientes em tratamento anotados
   * com lista de procedimentos ativos. Usado pelo PacientesClinicaKanban
   * (3o botao centralizado no header do CRM) pra renderizar cards 1x em
   * cada coluna de procedimento agendado/em-progresso.
   */
  @RequiresPermission('view_patients')
  @Get('funil-clinica')
  findFunilClinica(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.patientsService.findFunilClinica(tenantId);
  }

  /**
   * Admin: backfill de dados antigos. Vincula CalendarEvents que tem
   * lead_id mas patient_id null, e recalcula first/last_visit_at de
   * todos os pacientes. Idempotente — pode chamar várias vezes.
   */
  @Post('backfill-visit-dates')
  backfillVisitDates(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.patientsService.backfillVisitDates(tenantId);
  }

  /** Onda 17.56 — adiciona o +55 nos telefones já salvos sem código de país. */
  @Post('backfill-phone-ddi')
  @RequiresPermission('edit_patients')
  backfillPhoneDdi(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.patientsService.backfillPhoneDdi(tenantId);
  }

  /** Aniversariantes do periodo (today | week | month). */
  @RequiresPermission('view_patients')
  @Get('birthdays')
  getBirthdays(@Request() req: any, @Query('period') period?: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const validPeriods = ['today', 'week', 'month'];
    const p = (validPeriods.includes(period as any) ? period : 'today') as 'today' | 'week' | 'month';
    return this.patientsService.getBirthdays(tenantId, p);
  }

  /**
   * Funil 2 — botao "Atender" da ficha do paciente.
   * Gradua o lead vinculado pra "Em Fechamento" (etapa oculta do Kanban CRM,
   * visivel em /atendimento/fechamentos). Mesma logica usada pelo hook do
   * QuotesService.create — aqui standalone, sem criar Quote.
   *
   * Idempotente: nao regride won/lost/em-fechamento, e nao falha se patient
   * sem lead, lead sem pipeline, ou pipeline sem stage 'em-fechamento'.
   *
   * Retorna { graduated: boolean } — true se moveu, false se nada a fazer.
   */
  @Post(':id/start-attending')
  async startAttending(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    // Valida que o paciente existe + pertence ao tenant antes de tentar graduar
    await this.patientsService.findOne(id, tenantId);
    const lead = await this.leadsService.graduateLeadToEmFechamento(id, tenantId, userId);
    return { graduated: !!lead, lead_id: lead?.id ?? null };
  }

  @RequiresPermission('view_patients')
  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.patientsService.findOne(id, tenantId);
  }

  /** Timeline unificada: agrega consultas + procedimentos + pagamentos + retornos + anamneses */
  @RequiresPermission('view_patients')
  @Get(':id/timeline')
  getTimeline(@Param('id') id: string, @Request() req: any, @Query('limit') limit?: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const lim = limit ? Math.min(500, Math.max(10, parseInt(limit, 10))) : 100;
    return this.patientsService.getTimeline(id, tenantId, lim);
  }

  // Onda 17.52 — Etapa 7: editar dados do paciente exige edit_patients (antes
  // era só ADMIN). Decisão do usuário: recepção/dentista/CRC passam a editar;
  // arquivar/excluir continua só admin (canArchivePatient, nos DELETE abaixo).
  @RequiresPermission('edit_patients')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePatientDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.patientsService.update(id, tenantId, {
      ...dto,
      birth_date: dto.birth_date ? new Date(dto.birth_date) : undefined,
    });
  }

  /**
   * Onda 14.27 — Atualiza dados pra consulta de credito (CPF/RG/telefone/
   * endereco/etc). Diferente do PATCH /patients/:id (apenas ADMIN), este
   * endpoint e acessivel pra qualquer role autenticada — operador esta
   * coletando dados durante fluxo de venda, faz sentido salvar no cadastro
   * sem precisar admin.
   *
   * Aceita subset restrito de campos: CPF, RG, nome, birth_date, phone,
   * endereco completo (address/number/neighborhood/city/state/zip_code).
   * Campos clinicos / status / tags NAO sao alteraveis aqui.
   */
  @Patch(':id/credit-check-data')
  updateCreditCheckData(@Param('id') id: string, @Body() dto: UpdatePatientDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');

    // Restringe a um subset de campos seguros pra fluxo de credit-check
    const allowedFields = [
      'name', 'cpf', 'rg', 'birth_date', 'phone', 'email',
      'address', 'address_number', 'address_complement', 'neighborhood',
      'city', 'state', 'zip_code',
    ] as const;
    const sanitized: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (dto[field] !== undefined) sanitized[field] = dto[field];
    }

    return this.patientsService.update(id, tenantId, {
      ...sanitized,
      birth_date: sanitized.birth_date
        ? new Date(sanitized.birth_date as string)
        : undefined,
    } as Parameters<typeof this.patientsService.update>[2]);
  }

  @Delete(':id')
  archive(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!canArchivePatient(req.user?.roles)) {
      throw new ForbiddenException('Apenas ADMIN pode arquivar paciente');
    }
    return this.patientsService.archive(id, tenantId);
  }

  /**
   * Onda 14 — Exclusao permanente (HARD DELETE).
   * So ADMIN. Bloqueia se paciente tem consultas/orcamentos/parcelas pagas
   * (operador deve arquivar nesse caso).
   */
  @Delete(':id/permanent')
  permanentlyDelete(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!canArchivePatient(req.user?.roles)) {
      throw new ForbiddenException('Apenas ADMIN pode excluir paciente permanentemente');
    }
    return this.patientsService.permanentlyDelete(id, tenantId);
  }

  /**
   * Onda 14.1 — Preview detalhado das dependencias antes de excluir.
   * Frontend chama isso pra mostrar o que sera apagado se forcar exclusao.
   */
  @Get(':id/deletion-preview')
  getDeletionPreview(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!canArchivePatient(req.user?.roles)) {
      throw new ForbiddenException('Apenas ADMIN');
    }
    return this.patientsService.getDeletionPreview(id, tenantId);
  }

  /**
   * Onda 14.1 — Exclusao forcada em cascade (apaga paciente + tudo).
   * So ADMIN. Frontend deve mostrar preview + confirmacao dupla antes.
   */
  @Delete(':id/permanent/force')
  forceDelete(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!canArchivePatient(req.user?.roles)) {
      throw new ForbiddenException('Apenas ADMIN pode forçar exclusao em cascade');
    }
    return this.patientsService.forceDelete(id, tenantId);
  }

  /** Converte Lead em Patient. Se ja existe, retorna o Patient vinculado. */
  @Post('convert/:leadId')
  convertFromLead(@Param('leadId') leadId: string, @Body() extra: Partial<CreatePatientDto>, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.patientsService.convertFromLead(leadId, tenantId, {
      ...extra,
      birth_date: extra.birth_date ? new Date(extra.birth_date) : undefined,
    });
  }

  /**
   * v35: Garante Lead + Conversation pra paciente existente que foi cadastrado
   * direto na ficha (sem ter chegado via WhatsApp). Util pra "reparar" pacientes
   * antigos que estao invisiveis na inbox WhatsApp.
   */
  @Post(':id/ensure-conversation')
  async ensureConversation(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.patientsService.ensureLeadAndConversationPublic(id, tenantId);
  }

  // ─── Allergies ────────────────────────────────────────────────

  @Post(':id/allergies')
  addAllergy(
    @Param('id') id: string,
    @Body() dto: { allergen: string; severity?: string; notes?: string },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!dto?.allergen) throw new BadRequestException('allergen e obrigatorio');
    return this.patientsService.addAllergy(id, tenantId, dto);
  }

  @Delete('allergies/:allergyId')
  removeAllergy(@Param('allergyId') allergyId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.patientsService.removeAllergy(allergyId, tenantId);
  }

  // ─── Medications ──────────────────────────────────────────────

  @Post(':id/medications')
  addMedication(
    @Param('id') id: string,
    @Body()
    dto: {
      medication: string;
      dosage?: string;
      frequency?: string;
      reason?: string;
      started_at?: string;
      ended_at?: string;
    },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!dto?.medication) throw new BadRequestException('medication e obrigatorio');
    return this.patientsService.addMedication(id, tenantId, {
      ...dto,
      started_at: dto.started_at ? new Date(dto.started_at) : undefined,
      ended_at: dto.ended_at ? new Date(dto.ended_at) : undefined,
    });
  }

  @Delete('medications/:medicationId')
  removeMedication(@Param('medicationId') medicationId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.patientsService.removeMedication(medicationId, tenantId);
  }

  // ─── Avatar / Foto do paciente ────────────────────────────────

  /**
   * Onda 17.32.62 — Sincroniza foto do WhatsApp pro paciente.
   * Busca lead.profile_picture_url e faz copia pro nosso S3.
   * POST /patients/:id/sync-whatsapp-avatar
   */
  @Post(':id/sync-whatsapp-avatar')
  async syncWhatsappAvatar(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const patient = await this.patientsService['prisma'].patient.findUnique({
      where: { id },
      select: { lead_id: true, tenant_id: true },
    });
    if (!patient) throw new NotFoundException('Paciente nao encontrado');
    if (patient.tenant_id !== tenantId) throw new ForbiddenException('Acesso negado');
    if (!patient.lead_id) {
      return { ok: false, error: 'Paciente sem lead vinculado (cadastro direto, sem WhatsApp)' };
    }
    const lead = await this.patientsService['prisma'].lead.findUnique({
      where: { id: patient.lead_id },
      select: { profile_picture_url: true },
    });
    if (!lead?.profile_picture_url) {
      return { ok: false, error: 'Lead sem foto do WhatsApp registrada' };
    }
    try {
      await this.patientsService.copyWhatsappAvatarToPatient(
        id,
        tenantId,
        lead.profile_picture_url,
      );
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Falha ao copiar foto' };
    }
  }

  /** Upload da foto: POST /patients/:id/avatar (multipart, campo "file") */
  @Post(':id/avatar')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  async uploadAvatar(
    @Param('id') id: string,
    @UploadedFile() file: any,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!file) throw new BadRequestException('Nenhum arquivo enviado.');
    // Foto eh dado pessoal — SO ADMIN troca.
    if (!canEditPatientPersonalData(req.user?.roles)) {
      throw new ForbiddenException('Apenas ADMIN pode alterar a foto do paciente');
    }
    return this.patientsService.updateAvatar(id, tenantId, file.buffer, file.mimetype);
  }

  /** Servir a foto: GET /patients/:id/avatar */
  @Get(':id/avatar')
  async getAvatar(@Param('id') id: string, @Request() req: any, @Res() res: Response) {
    // Onda 17.34 — valida tenant: sem isso, qualquer usuario autenticado de
    // OUTRO tenant baixava a foto so enumerando ids (dado pessoal/LGPD).
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const result = await this.patientsService.getAvatarBuffer(id, tenantId);
    if (!result) throw new NotFoundException('Foto nao encontrada.');
    res.set('Content-Type', result.mimeType);
    res.set('Cache-Control', 'private, max-age=86400');
    res.end(result.buffer);
  }

  /** Remove a foto: DELETE /patients/:id/avatar */
  @Delete(':id/avatar')
  async removeAvatar(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!canEditPatientPersonalData(req.user?.roles)) {
      throw new ForbiddenException('Apenas ADMIN pode remover a foto do paciente');
    }
    return this.patientsService.removeAvatar(id, tenantId);
  }

  // ─── Programa de Afiliado (Onda 5e v34, Fase 25) ─────────────────────

  /**
   * Onda 5e v36 — dashboard GLOBAL de afiliados do tenant (admin only).
   * Lista todos os afiliados ativos com KPIs agregados + top 5 do mes.
   * Usado pela rota /atendimento/afiliados.
   *
   * IMPORTANTE: declarado ANTES de :id/affiliate pra Nest nao tratar
   * 'affiliates' como id de paciente.
   */
  @Get('affiliates')
  listAffiliatesDashboard(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!isAdmin(req.user?.roles)) {
      throw new ForbiddenException('Apenas ADMIN pode ver dashboard de afiliados');
    }
    return this.affiliateService.listAffiliatesDashboard(tenantId);
  }

  /**
   * Onda 5e v36 — lista de saques pendentes pra aprovacao (admin).
   */
  @Get('affiliates/pending-withdrawals')
  listPendingWithdrawals(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!isAdmin(req.user?.roles)) {
      throw new ForbiddenException('Apenas ADMIN pode listar saques');
    }
    return this.affiliateService.listPendingWithdrawals(tenantId);
  }

  /**
   * Onda 17.63 — config de FAIXAS de afiliado por volume (admin lê/edita).
   * Declarado ANTES de :id pra Nest nao tratar 'affiliates' como id.
   */
  @Get('affiliates/tiers')
  getAffiliateTiers(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!isAdmin(req.user?.roles)) {
      throw new ForbiddenException('Apenas ADMIN pode ver faixas de afiliado');
    }
    return this.affiliateService.getTiers(tenantId);
  }

  @Patch('affiliates/tiers')
  setAffiliateTiers(
    @Body()
    body: {
      enabled?: boolean;
      tiers: { label: string; min: number; pct: number }[];
    },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!isAdmin(req.user?.roles)) {
      throw new ForbiddenException('Apenas ADMIN pode editar faixas de afiliado');
    }
    return this.affiliateService.setTiers(tenantId, body);
  }

  /**
   * Dashboard do afiliado: saldo (disponivel/acumulado/sacado/pendente)
   * + indicacoes + historico de saques.
   */
  @Get(':id/affiliate')
  async getAffiliateDashboard(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.affiliateService.getDashboard(id, tenantId);
  }

  /**
   * Solicita saque do saldo disponivel. Cria AffiliateWithdrawal
   * com status='solicitado'. Admin depois confirma com POST
   * /patients/:id/affiliate/withdraw/:withdrawalId/pay
   */
  @Post(':id/affiliate/withdraw')
  async requestAffiliateWithdrawal(
    @Param('id') id: string,
    @Body() body: { amount: number; method: 'PIX' | 'DINHEIRO' | 'CREDITO_TRATAMENTO'; pix_key?: string; notes?: string },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.affiliateService.requestWithdrawal(id, tenantId, body);
  }

  /** Admin confirma pagamento de saque solicitado. */
  @Post(':id/affiliate/withdraw/:withdrawalId/pay')
  async confirmAffiliateWithdrawalPaid(
    @Param('withdrawalId') withdrawalId: string,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!isAdmin(req.user?.roles)) {
      throw new ForbiddenException('Apenas ADMIN pode confirmar pagamento de saque');
    }
    return this.affiliateService.confirmWithdrawalPaid(withdrawalId, tenantId, req.user.id);
  }

  /** Admin recusa saque solicitado (libera saldo). */
  @Post(':id/affiliate/withdraw/:withdrawalId/refuse')
  async refuseAffiliateWithdrawal(
    @Param('withdrawalId') withdrawalId: string,
    @Body() body: { notes?: string },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!isAdmin(req.user?.roles)) {
      throw new ForbiddenException('Apenas ADMIN pode recusar saque');
    }
    return this.affiliateService.refuseWithdrawal(withdrawalId, tenantId, body?.notes);
  }
}
