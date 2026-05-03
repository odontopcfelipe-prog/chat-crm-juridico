import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards, Request, Put, Res, ForbiddenException } from '@nestjs/common';
import type { Response } from 'express';
import { CalendarService } from './calendar.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
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

  @Get('events')
  findAll(
    @Query('start') start: string | undefined,
    @Query('end') end: string | undefined,
    @Query('type') type: string | undefined,
    @Query('userId') userId: string | undefined,
    @Query('leadId') leadId: string | undefined,
    @Query('search') search: string | undefined,
    @Query('showAll') showAll: string | undefined,
    @Request() req: any,
  ) {
    // Default: mostra apenas eventos do usuario logado
    // showAll=true: ADMIN vê tudo, DENTIST vê eventos dos seus casos
    const isAdmin = req.user?.roles?.includes('ADMIN');
    const isDentist = req.user?.roles?.includes('DENTIST');
    const canViewAll = isAdmin || (showAll === 'true' && isDentist);
    const effectiveUserId = canViewAll ? undefined : (userId || req.user.id);
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

  @Get('events/:id')
  findOne(@Param('id') id: string) {
    return this.calendarService.findOne(id);
  }

  @Post('events')
  create(@Body() data: CreateEventDto, @Request() req: any) {
    return this.calendarService.create({
      ...data,
      created_by_id: req.user.id,
      tenant_id: req.user?.tenant_id,
    });
  }

  @Patch('events/:id')
  async update(
    @Param('id') id: string,
    @Body() data: UpdateEventDto,
    @Query('updateScope') updateScope: string | undefined,
    @Request() req: any,
  ) {
    const canEdit = await this.calendarService.checkOwnership(id, req.user.id, req.user.roles, req.user?.tenant_id);
    if (!canEdit) throw new ForbiddenException('Sem permissao para editar este evento');

    if (updateScope === 'all') {
      return this.calendarService.updateRecurrenceAll(id, data);
    }
    return this.calendarService.update(id, data);
  }

  @Patch('events/:id/status')
  async updateStatus(@Param('id') id: string, @Body('status') status: string, @Request() req: any) {
    const canEdit = await this.calendarService.checkOwnership(id, req.user.id, req.user.roles, req.user?.tenant_id);
    if (!canEdit) throw new ForbiddenException('Sem permissao para alterar status deste evento');
    return this.calendarService.updateStatus(id, status);
  }

  @Post('events/:id/notify')
  async notifyEvent(@Param('id') id: string) {
    return this.calendarService.notifyEvent(id);
  }

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

  @Get('availability/:userId')
  getAvailability(
    @Param('userId') userId: string,
    @Query('date') date: string,
    @Query('duration') duration: string,
    @Request() req: any,
  ) {
    return this.calendarService.getAvailability(userId, date, parseInt(duration) || 30, req.user?.tenant_id);
  }

  @Get('schedule/:userId')
  getSchedule(@Param('userId') userId: string) {
    return this.calendarService.getSchedule(userId);
  }

  @Put('schedule/:userId')
  setSchedule(
    @Param('userId') userId: string,
    @Body('slots') slots: { day_of_week: number; start_time: string; end_time: string }[],
  ) {
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
  updateAppointmentType(@Param('id') id: string, @Body() data: UpdateAppointmentTypeDto) {
    return this.calendarService.updateAppointmentType(id, data);
  }

  @Delete('appointment-types/:id')
  @Roles('ADMIN')
  deleteAppointmentType(@Param('id') id: string) {
    return this.calendarService.deleteAppointmentType(id);
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
  updateHoliday(@Param('id') id: string, @Body() data: UpdateHolidayDto) {
    return this.calendarService.updateHoliday(id, data);
  }

  @Delete('holidays/:id')
  @Roles('ADMIN')
  deleteHoliday(@Param('id') id: string) {
    return this.calendarService.deleteHoliday(id);
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
      return this.calendarService.updateScheduleBlock(id, data);
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
      return this.calendarService.deleteScheduleBlock(id);
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
