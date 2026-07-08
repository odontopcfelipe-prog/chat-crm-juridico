import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards, Request, Put, Res, ForbiddenException } from '@nestjs/common';
import type { Response } from 'express';
import { CalendarService } from './calendar.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
// Onda 17.52 — Etapa 3: leitura da agenda exige view_agenda (antes aberta a
// qualquer logado). Todos os 6 setores têm view_agenda por default.
import { RequiresPermission } from '../auth/decorators/requires-permission.decorator';
import {
  canViewAllAgenda,
  canDeleteAgendaEvent,
} from '../common/utils/permissions.util';
import {
  CreateEventDto,
  UpdateEventDto,
  CreateAppointmentTypeDto,
  UpdateAppointmentTypeDto,
  CreateHolidayDto,
  UpdateHolidayDto,
  CreateScheduleBlockDto,
  UpdateScheduleBlockDto,
} from './dto/calendar.dto';

@UseGuards(JwtAuthGuard)
@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendarService: CalendarService) {}

  // ─── Events CRUD ──────────────────────────────────────

  @RequiresPermission('view_agenda')
  @Get('events')
  findAll(
    @Query('start') start: string | undefined,
    @Query('end') end: string | undefined,
    @Query('type') type: string | undefined,
    @Query('userId') userId: string | undefined,
    @Query('leadId') leadId: string | undefined,
    @Query('search') search: string | undefined,
    @Query('showAll') _showAll: string | undefined,
    @Request() req: any,
  ) {
    // Restricao por role:
    //   - ADMIN/OPERADOR (secretaria)/ASSISTANT: veem tudo do tenant.
    //     Filtro userId opcional (pra escolher uma agenda especifica).
    //   - DENTIST/FINANCEIRO/outros: forcado a ver SO os proprios eventos
    //     (assigned_user_id = self). Param userId e ignorado — backend
    //     impoe pra evitar bypass via query string.
    const canViewAll = canViewAllAgenda(req.user?.roles);
    const effectiveUserId = canViewAll ? userId : req.user.id;
    return this.calendarService.findAll({
      start,
      end,
      type,
      userId: effectiveUserId,
      leadId,
      search,
      tenantId: req.user?.tenant_id,
    });
  }

  // ─── Rotas LITERAIS de eventos — DEVEM vir ANTES de @Get('events/:id') ──
  // No NestJS as rotas casam por ORDEM de declaracao. Se 'events/pending-validation'
  // ficar depois de @Get('events/:id'), a request bate em findOne (id='pending-validation')
  // → checkOwnership/NotFound — a lista de validacao nunca carrega.
  /**
   * Lista atendimentos pendentes de validacao (Fase 23 PR2).
   * Default: so do dentista logado, ultimos 30 dias, no passado.
   * Admin pode passar onlyMine=false pra ver todos.
   */
  @Get('events/pending-validation')
  async pendingValidation(
    @Request() req: any,
    @Query('onlyMine') onlyMine?: string,
    @Query('daysBack') daysBack?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new ForbiddenException('tenant_id ausente');
    const isAdmin = (req.user.roles || []).includes('ADMIN');
    return this.calendarService.listPendingValidation({
      tenantId,
      actorUserId: req.user.id,
      isAdmin,
      onlyMine: onlyMine === 'true' || onlyMine === '1' || !isAdmin,
      daysBack: daysBack ? parseInt(daysBack, 10) : 30,
    });
  }

  @RequiresPermission('view_agenda')
  @Get('events/:id')
  async findOne(@Param('id') id: string, @Request() req: any) {
    // Tampa furo: antes qualquer user logado abria qualquer evento por ID.
    // Agora respeita a mesma regra do findAll — DENTIST so ve os proprios.
    const canAccess = await this.calendarService.checkOwnership(id, req.user.id, req.user.roles, req.user?.tenant_id);
    if (!canAccess) throw new ForbiddenException('Sem permissao para ver este evento');
    return this.calendarService.findOne(id);
  }

  // Onda 17.52 — Etapa 7: criar evento exige manage_agenda (antes era por papel).
  // Têm por default: recepção, CRC e admin. Editar/validar o PRÓPRIO evento
  // (PATCH abaixo) segue por checkOwnership — dentista continua validando.
  @RequiresPermission('manage_agenda')
  @Post('events')
  create(@Body() data: CreateEventDto, @Request() req: any) {
    return this.calendarService.create({
      ...data,
      created_by_id: req.user.id,
      tenant_id: req.user?.tenant_id,
    });
  }

  /**
   * Campos que DENTIST/FINANCEIRO podem alterar do proprio evento.
   * Cobre o fluxo clinico: dentista marca status (CONCLUIDO/CONFIRMADO/etc)
   * e/ou valida atendimento. Mudancas estruturais (titulo, datas, paciente,
   * dentista responsavel) ficam restritas a ADMIN/OPERADOR/ASSISTANT.
   */
  private static readonly DENTIST_EDITABLE_FIELDS = new Set([
    'status',
    'validated_at',
    'validated_by_user_id',
    'validation_notes',
  ]);

  @Patch('events/:id')
  async update(
    @Param('id') id: string,
    @Body() data: UpdateEventDto,
    @Query('updateScope') updateScope: string | undefined,
    @Request() req: any,
  ) {
    const canEdit = await this.calendarService.checkOwnership(id, req.user.id, req.user.roles, req.user?.tenant_id);
    if (!canEdit) throw new ForbiddenException('Sem permissao para editar este evento');

    // DENTIST/FINANCEIRO so podem mexer no status do proprio evento.
    // Bloqueia tentativa de mudar titulo, datas, paciente, dentista, etc.
    if (!canViewAllAgenda(req.user?.roles)) {
      const blocked = Object.keys(data || {}).filter(
        k => !CalendarController.DENTIST_EDITABLE_FIELDS.has(k),
      );
      if (blocked.length > 0) {
        throw new ForbiddenException(
          `Sem permissao para alterar: ${blocked.join(', ')}. Dentista pode mudar apenas o status do proprio evento.`,
        );
      }
    }

    if (updateScope === 'all') {
      return this.calendarService.updateRecurrenceAll(id, data);
    }
    return this.calendarService.update(id, data);
  }

  // Mudar o STATUS do agendamento (Agendado/Confirmado/Chegou/Em atendimento/
  // Atendido/Desmarcou/Faltou) é liberado pra QUALQUER pessoa com acesso à agenda
  // (view_agenda) — recepção, qualquer dentista ou assistente marcam o andamento
  // de QUALQUER paciente, não só dos próprios eventos. NÃO exige posse/assigned.
  // Mantém isolamento de tenant (anti-IDOR entre clínicas). Apagar continua
  // exclusivo do ADMIN (ver @Delete abaixo).
  @RequiresPermission('view_agenda')
  @Patch('events/:id/status')
  async updateStatus(@Param('id') id: string, @Body('status') status: string, @Request() req: any) {
    const sameTenant = await this.calendarService.checkSameTenant(id, req.user?.tenant_id);
    if (!sameTenant) throw new ForbiddenException('Sem permissao para alterar status deste evento');
    return this.calendarService.updateStatus(id, status);
  }

  @Post('events/:id/notify')
  async notifyEvent(@Param('id') id: string, @Request() req: any) {
    // Onda 17.61 (segurança/IDOR) — era a única rota de evento sem checagem; dispara
    // WhatsApp. Exige posse/tenant como as vizinhas antes de delegar.
    const canAccess = await this.calendarService.checkOwnership(id, req.user.id, req.user.roles, req.user?.tenant_id);
    if (!canAccess) throw new ForbiddenException('Sem permissao para notificar este evento');
    return this.calendarService.notifyEvent(id);
  }

  /**
   * Valida atendimento clinicamente (Fase 23).
   * Apenas o assigned_user (dentista responsavel) OU admin pode validar.
   * Marca validated_at + validated_by_user_id, atualiza last_visit_at do
   * paciente, e fecha status pra CONCLUIDO se necessario.
   */
  @Post('events/:id/validate')
  async validate(
    @Param('id') id: string,
    @Body() body: { notes?: string },
    @Request() req: any,
  ) {
    const isAdmin = (req.user.roles || []).includes('ADMIN');
    return this.calendarService.validate(id, req.user.id, isAdmin, body?.notes);
  }

  /**
   * Reverte validacao clinica — apenas admin (Fase 23).
   * Permite trocar dentista atribuido ou re-validar com outro profissional.
   */
  @Post('events/:id/unvalidate')
  async unvalidate(@Param('id') id: string, @Request() req: any) {
    const isAdmin = (req.user.roles || []).includes('ADMIN');
    return this.calendarService.unvalidate(id, isAdmin);
  }

  @Delete('events/:id')
  async remove(
    @Param('id') id: string,
    @Query('deleteScope') deleteScope: string | undefined,
    @Request() req: any,
  ) {
    // Apagar evento e exclusivo do ADMIN. Secretaria/dentista que precisar
    // remover deve marcar o status como CANCELADO (preserva historico).
    if (!canDeleteAgendaEvent(req.user?.roles)) {
      throw new ForbiddenException('Apenas ADMIN pode remover eventos da agenda. Use o status CANCELADO no lugar.');
    }
    // checkOwnership ainda garante que o evento pertence ao tenant
    const canEdit = await this.calendarService.checkOwnership(id, req.user.id, req.user.roles, req.user?.tenant_id);
    if (!canEdit) throw new ForbiddenException('Sem permissao para remover este evento');

    if (deleteScope === 'all') {
      return this.calendarService.removeRecurrenceAll(id);
    }
    return this.calendarService.remove(id);
  }

  // ─── Event Comments ──────────────────────────────────

  @Get('events/:id/comments')
  async findComments(@Param('id') id: string, @Request() req: any) {
    const canAccess = await this.calendarService.checkOwnership(id, req.user.id, req.user.roles, req.user?.tenant_id);
    if (!canAccess) throw new ForbiddenException('Sem permissao para acessar este evento');
    return this.calendarService.findComments(id);
  }

  @Post('events/:id/comments')
  async addComment(@Param('id') id: string, @Body('text') text: string, @Request() req: any) {
    const canAccess = await this.calendarService.checkOwnership(id, req.user.id, req.user.roles, req.user?.tenant_id);
    if (!canAccess) throw new ForbiddenException('Sem permissao para comentar neste evento');
    return this.calendarService.addComment(id, req.user.id, text);
  }

  // ─── Conflict Detection ─────────────────────────────────

  @Get('conflicts')
  checkConflicts(
    @Query('userId') userId: string,
    @Query('start') start: string,
    @Query('end') end: string,
    @Query('excludeId') excludeId: string | undefined,
    @Request() req: any,
  ) {
    // Usuários não-admin só podem checar conflitos da própria agenda
    const isAdmin = req.user?.roles?.includes('ADMIN');
    const effectiveUserId = isAdmin ? (userId || req.user.id) : req.user.id;
    return this.calendarService.checkConflicts(effectiveUserId, start, end, excludeId, req.user?.tenant_id);
  }

  // ─── Availability ─────────────────────────────────────

  @RequiresPermission('view_agenda')
  @Get('availability/:userId')
  getAvailability(
    @Param('userId') userId: string,
    @Query('date') date: string,
    @Query('duration') duration: string,
    @Request() req: any,
  ) {
    return this.calendarService.getAvailability(userId, date, parseInt(duration) || 30, req.user?.tenant_id);
  }

  @RequiresPermission('view_agenda')
  @Get('schedule/:userId')
  getSchedule(@Param('userId') userId: string) {
    return this.calendarService.getSchedule(userId);
  }

  @Put('schedule/:userId')
  setSchedule(
    @Param('userId') userId: string,
    @Body('slots') slots: {
      day_of_week: number;
      start_time: string;
      end_time: string;
      lunch_start?: string | null;
      lunch_end?: string | null;
      label?: string | null;
      sort_order?: number;
    }[],
    @Request() req: any,
  ) {
    // Onda 5e v10 (Fase 25) — ANTES nao validava nada: qualquer user
    // autenticado podia editar agenda de qualquer outro. Agora exigimos
    // ADMIN OU dono da agenda. Sem isso, recepcao podia mexer no
    // expediente do dentista sem permissao.
    const isAdmin = req.user?.roles?.includes('ADMIN');
    if (!isAdmin && req.user?.id !== userId) {
      throw new ForbiddenException('Apenas ADMIN ou o proprio dentista pode editar essa agenda');
    }
    return this.calendarService.setSchedule(userId, slots);
  }

  // ─── Appointment Types ────────────────────────────────

  @Get('appointment-types')
  findAppointmentTypes(@Request() req: any) {
    return this.calendarService.findAppointmentTypes(req.user?.tenant_id);
  }

  @Post('appointment-types')
  @Roles('ADMIN')
  createAppointmentType(@Body() data: CreateAppointmentTypeDto, @Request() req: any) {
    return this.calendarService.createAppointmentType({
      ...data,
      tenant_id: req.user?.tenant_id,
    });
  }

  @Patch('appointment-types/:id')
  @Roles('ADMIN')
  updateAppointmentType(@Param('id') id: string, @Body() data: UpdateAppointmentTypeDto, @Request() req: any) {
    return this.calendarService.updateAppointmentType(id, data, req.user?.tenant_id);
  }

  @Delete('appointment-types/:id')
  @Roles('ADMIN')
  deleteAppointmentType(@Param('id') id: string, @Request() req: any) {
    return this.calendarService.deleteAppointmentType(id, req.user?.tenant_id);
  }

  // ─── Metricas (Onda 5e v18, Fase C.2) ────────────────
  // Agregados de status pra dashboard mostrar saude da agenda
  // (% confirmacao, % no-show, etc) no periodo selecionado.

  @Get('metrics')
  getAgendaMetrics(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Request() req: any,
  ) {
    return this.calendarService.getAgendaMetrics({
      from,
      to,
      tenant_id: req.user?.tenant_id,
    });
  }

  // ─── Backfill de Reminders (Onda 5e v19) ────────────────
  // ADMIN-ONLY. Cria EventReminders default (1d, 1h, 30min) pra eventos
  // futuros sem reminders + enfileira no BullMQ. Idempotente.
  // Use ?dry_run=true pra ver quantos seriam criados sem efetivar.

  @Post('reminders/backfill')
  @Roles('ADMIN')
  backfillReminders(
    @Query('dry_run') dryRun: string | undefined,
    @Request() req: any,
  ) {
    return this.calendarService.backfillReminders({
      tenant_id: req.user?.tenant_id,
      dry_run: dryRun === 'true' || dryRun === '1',
    });
  }

  // ─── Listagem/gerencia de Reminders pra Dashboard (v21) ─────────────
  // Aba "Lembretes" dentro de Follow-up IA usa esses endpoints pra mostrar
  // disparos feitos e a fazer + permitir reenviar/cancelar.

  @Get('reminders')
  listReminders(
    @Query('status') status: 'pendente' | 'enviado' | 'falhou' | 'todos' | undefined,
    @Query('channel') channel: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('limit') limit: string | undefined,
    @Request() req: any,
  ) {
    return this.calendarService.listReminders({
      status,
      channel,
      from,
      to,
      tenant_id: req.user?.tenant_id,
      limit: limit ? parseInt(limit) : undefined,
    });
  }

  @Get('reminders/summary')
  getRemindersSummary(@Request() req: any) {
    return this.calendarService.getRemindersSummary({
      tenant_id: req.user?.tenant_id,
    });
  }

  @Post('reminders/:id/resend')
  resendReminder(@Param('id') id: string, @Request() req: any) {
    return this.calendarService.resendReminder(id, req.user?.tenant_id);
  }

  @Post('reminders/:id/cancel')
  cancelReminder(@Param('id') id: string, @Request() req: any) {
    return this.calendarService.cancelReminder(id, req.user?.tenant_id);
  }

  // v24 (Onda B): preview do conteudo do lembrete + respostas do paciente
  @Get('reminders/:id/preview')
  getReminderPreview(@Param('id') id: string, @Request() req: any) {
    return this.calendarService.getReminderPreview(id, req.user?.tenant_id);
  }

  // v27 (Onda config): admin gerencia defaults de antecedencia + templates de mensagem.
  // Persistido em GlobalSetting JSON. Aplicado tanto na UI da agenda
  // (defaults pre-preenchidos) quanto no worker (templates de envio).

  @Get('reminders/config')
  getReminderConfig(@Request() req: any) {
    return this.calendarService.getReminderConfig(req.user?.tenant_id);
  }

  @Put('reminders/config')
  @Roles('ADMIN')
  setReminderConfig(@Body() body: any, @Request() req: any) {
    return this.calendarService.setReminderConfig(req.user?.tenant_id, body);
  }

  // ─── Resumo Diario pra Dentistas (Onda 5e v30, Fase 25) ──────────────
  // Disparo unico no inicio do dia listando os atendimentos do dia do
  // dentista. Config separada dos lembretes por evento.

  @Get('dentist-daily-summary/config')
  getDentistDailySummaryConfig(@Request() req: any) {
    return this.calendarService.getDentistDailySummaryConfig(req.user?.tenant_id);
  }

  @Put('dentist-daily-summary/config')
  @Roles('ADMIN')
  setDentistDailySummaryConfig(@Body() body: any, @Request() req: any) {
    return this.calendarService.setDentistDailySummaryConfig(req.user?.tenant_id, body);
  }

  // ─── Confirmação de agendamento (Onda 17.56) — mensagem editável ──────
  @Get('appointment-confirmation/config')
  getAppointmentConfirmationConfig(@Request() req: any) {
    return this.calendarService.getAppointmentConfirmationConfig(req.user?.tenant_id);
  }

  @Put('appointment-confirmation/config')
  @Roles('ADMIN')
  setAppointmentConfirmationConfig(@Body() body: any, @Request() req: any) {
    return this.calendarService.setAppointmentConfirmationConfig(req.user?.tenant_id, body);
  }

  // ─── Confirmação de ORTODONTIA (Onda 18.x) — por ordem de chegada ─────
  @Get('appointment-confirmation-orto/config')
  getAppointmentConfirmationOrtoConfig(@Request() req: any) {
    return this.calendarService.getAppointmentConfirmationOrtoConfig(req.user?.tenant_id);
  }

  @Put('appointment-confirmation-orto/config')
  @Roles('ADMIN')
  setAppointmentConfirmationOrtoConfig(@Body() body: any, @Request() req: any) {
    return this.calendarService.setAppointmentConfirmationOrtoConfig(req.user?.tenant_id, body);
  }

  // ─── Lembrete de ORTODONTIA · ~1h antes (portões) — Onda 18.x ─────────
  @Get('appointment-orto-reminder/config')
  getAppointmentOrtoReminderConfig(@Request() req: any) {
    return this.calendarService.getAppointmentOrtoReminderConfig(req.user?.tenant_id);
  }

  @Put('appointment-orto-reminder/config')
  @Roles('ADMIN')
  setAppointmentOrtoReminderConfig(@Body() body: any, @Request() req: any) {
    return this.calendarService.setAppointmentOrtoReminderConfig(req.user?.tenant_id, body);
  }

  // ─── Confirmação de agendamento de ORTODONTIA · IMEDIATA (Onda 18.x) ──
  @Get('appointment-orto-immediate/config')
  getAppointmentOrtoImmediateConfig(@Request() req: any) {
    return this.calendarService.getAppointmentOrtoImmediateConfig(req.user?.tenant_id);
  }

  @Put('appointment-orto-immediate/config')
  @Roles('ADMIN')
  setAppointmentOrtoImmediateConfig(@Body() body: any, @Request() req: any) {
    return this.calendarService.setAppointmentOrtoImmediateConfig(req.user?.tenant_id, body);
  }

  // ─── Re-agendamento (Onda 17.59) — mensagem editável ──────────────────
  @Get('appointment-rescheduled/config')
  getAppointmentRescheduledConfig(@Request() req: any) {
    return this.calendarService.getAppointmentRescheduledConfig(req.user?.tenant_id);
  }

  @Put('appointment-rescheduled/config')
  @Roles('ADMIN')
  setAppointmentRescheduledConfig(@Body() body: any, @Request() req: any) {
    return this.calendarService.setAppointmentRescheduledConfig(req.user?.tenant_id, body);
  }

  // ─── Aniversário (Onda 17.59) — expõe o get/set pra editar a mensagem na Central ──
  @Get('birthday-greeting/config')
  getBirthdayGreetingConfig(@Request() req: any) {
    return this.calendarService.getBirthdayGreetingConfig(req.user?.tenant_id);
  }

  @Put('birthday-greeting/config')
  @Roles('ADMIN')
  setBirthdayGreetingConfig(@Body() body: any, @Request() req: any) {
    return this.calendarService.setBirthdayGreetingConfig(req.user?.tenant_id, body);
  }

  // Onda 17.60 — aniversariantes de hoje + próximos N dias (pra tela do disparo).
  @Get('birthday-greeting/upcoming')
  getUpcomingBirthdays(@Request() req: any, @Query('days') days?: string) {
    return this.calendarService.getUpcomingBirthdays(req.user?.tenant_id, days ? parseInt(days, 10) : 30);
  }

  // Onda 17.61 — abre (ou cria) a conversa interna do paciente; o ícone do WhatsApp
  // da tela de aniversariantes usa isso pra sempre cair no nosso chat.
  @Get('birthday-greeting/open-conversation')
  openConversation(@Request() req: any, @Query('patient_id') patientId?: string) {
    return this.calendarService.openOrCreateConversation(req.user?.tenant_id, patientId || '');
  }

  // Envia um teste da mensagem de confirmação pra um número (admin) — testa entrega.
  @Post('appointment-confirmation/send-test')
  @Roles('ADMIN')
  sendTestConfirmation(@Body() body: { phone: string }, @Request() req: any) {
    return this.calendarService.sendTestConfirmation(req.user?.tenant_id, body?.phone);
  }

  // Teste genérico — envia a mensagem de qualquer disparo pra um número (admin).
  @Post('disparo/send-test')
  @Roles('ADMIN')
  sendTestDisparo(@Body() body: { disparo: string; phone: string; text?: string }, @Request() req: any) {
    return this.calendarService.sendTestDisparo(req.user?.tenant_id, body?.disparo, body?.phone, body?.text);
  }

  // Trigger manual — admin clica "Enviar agora" pra teste ou disparo
  // antecipado. O cron diario continua funcionando independente.
  @Post('dentist-daily-summary/send-now')
  @Roles('ADMIN')
  sendDentistDailySummaryNow(@Request() req: any) {
    return this.calendarService.sendDentistDailySummaryNow(req.user?.tenant_id);
  }

  // v25 (Onda C #11): metricas de saude dos lembretes (taxa entrega, leitura, etc)
  @Get('reminders/health')
  getRemindersHealth(
    @Query('days') days: string | undefined,
    @Request() req: any,
  ) {
    return this.calendarService.getRemindersHealth({
      tenant_id: req.user?.tenant_id,
      days: days ? parseInt(days) : undefined,
    });
  }

  // v25 (Onda C #12): export CSV dos lembretes filtrados
  @Get('reminders/export.csv')
  async exportRemindersCSV(
    @Query('status') status: 'pendente' | 'enviado' | 'falhou' | 'todos' | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Request() req: any,
    @Res() res: Response,
  ) {
    const csv = await this.calendarService.exportRemindersCSV({
      status,
      from,
      to,
      tenant_id: req.user?.tenant_id,
    });
    const filename = `lembretes-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('﻿' + csv); // BOM pra Excel abrir UTF-8 corretamente
  }

  // ─── Holidays ─────────────────────────────────────────

  @Get('holidays')
  findHolidays(@Request() req: any) {
    return this.calendarService.findHolidays(req.user?.tenant_id);
  }

  @Post('holidays')
  @Roles('ADMIN')
  createHoliday(@Body() data: CreateHolidayDto, @Request() req: any) {
    return this.calendarService.createHoliday({
      ...data,
      tenant_id: req.user?.tenant_id,
    });
  }

  @Patch('holidays/:id')
  @Roles('ADMIN')
  updateHoliday(@Param('id') id: string, @Body() data: UpdateHolidayDto, @Request() req: any) {
    return this.calendarService.updateHoliday(id, data, req.user?.tenant_id);
  }

  @Delete('holidays/:id')
  @Roles('ADMIN')
  deleteHoliday(@Param('id') id: string, @Request() req: any) {
    return this.calendarService.deleteHoliday(id, req.user?.tenant_id);
  }

  // ─── Schedule Blocks (Fase 25 — Onda 5e v9) ──────────
  // Bloqueio pontual de agenda do dentista (ferias, doenca, curso).
  // Permissao: ADMIN ou o proprio dentista podem criar/editar.

  @Get('blocks')
  findScheduleBlocks(
    @Query('userId') userId: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Request() req: any,
  ) {
    return this.calendarService.findScheduleBlocks({
      user_id: userId,
      from,
      to,
      tenant_id: req.user?.tenant_id,
    });
  }

  @Post('blocks')
  createScheduleBlock(@Body() data: CreateScheduleBlockDto, @Request() req: any) {
    // Permissao: ADMIN cria pra qualquer um; nao-admin so cria pra si proprio
    const isAdmin = req.user?.roles?.includes('ADMIN');
    if (!isAdmin && data.user_id !== req.user?.id) {
      throw new ForbiddenException('Apenas ADMIN pode bloquear agenda de outro dentista');
    }
    return this.calendarService.createScheduleBlock({
      ...data,
      tenant_id: req.user?.tenant_id,
      created_by: req.user?.id,
    });
  }

  @Patch('blocks/:id')
  updateScheduleBlock(
    @Param('id') id: string,
    @Body() data: UpdateScheduleBlockDto,
    @Request() req: any,
  ) {
    // Permissao: so ADMIN ou o dono do bloqueio pode editar.
    // Checa via lookup pra evitar leak (nao revelar existencia se forbidden)
    return (async () => {
      const block = await this.calendarService.findScheduleBlocks({
        tenant_id: req.user?.tenant_id,
      });
      const target = block.find((b: any) => b.id === id);
      const isAdmin = req.user?.roles?.includes('ADMIN');
      if (!target) throw new ForbiddenException('Bloqueio nao encontrado');
      if (!isAdmin && target.user_id !== req.user?.id) {
        throw new ForbiddenException('Sem permissao pra editar esse bloqueio');
      }
      return this.calendarService.updateScheduleBlock(id, data, req.user?.tenant_id);
    })();
  }

  @Delete('blocks/:id')
  deleteScheduleBlock(@Param('id') id: string, @Request() req: any) {
    return (async () => {
      const blocks = await this.calendarService.findScheduleBlocks({
        tenant_id: req.user?.tenant_id,
      });
      const target = blocks.find((b: any) => b.id === id);
      const isAdmin = req.user?.roles?.includes('ADMIN');
      if (!target) throw new ForbiddenException('Bloqueio nao encontrado');
      if (!isAdmin && target.user_id !== req.user?.id) {
        throw new ForbiddenException('Sem permissao pra remover esse bloqueio');
      }
      return this.calendarService.deleteScheduleBlock(id, req.user?.tenant_id);
    })();
  }

  // ─── Search ───────────────────────────────────────────

  @Get('search')
  search(@Query('q') q: string, @Request() req: any) {
    return this.calendarService.search(q || '', req.user?.tenant_id);
  }

  // ─── ICS Export ───────────────────────────────────────

  @Get('export/ics/:id')
  async exportEventIcs(@Param('id') id: string, @Res() res: Response) {
    const icsContent = await this.calendarService.exportICS([id]);
    res.set({
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="event-${id}.ics"`,
    });
    res.send(icsContent);
  }

  @Get('export/ics')
  async exportRangeIcs(
    @Query('start') start: string,
    @Query('end') end: string,
    @Query('userId') userId: string | undefined,
    @Request() req: any,
    @Res() res: Response,
  ) {
    const events = await this.calendarService.findAll({
      start,
      end,
      userId,
      tenantId: req.user?.tenant_id,
    });
    const ids = events.map((e: any) => e.id);
    const icsContent = await this.calendarService.exportICS(ids);
    res.set({
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="calendar-export.ics"',
    });
    res.send(icsContent);
  }

  // ─── Migration ────────────────────────────────────────

  @Post('migrate-tasks')
  @Roles('ADMIN')
  async migrateTasks() {
    return this.calendarService.migrateOrphanTasks();
  }
}
