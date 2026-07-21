import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Request,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RoomsService } from './rooms.service';
import { MarkersService } from './markers.service';
import { ConfirmationsService } from './confirmations.service';
import { ReturnAlertsService } from './return-alerts.service';
import { CreateRoomDto, UpdateRoomDto } from './dto/room.dto';
import { CreateMarkerDto, UpdateMarkerDto } from './dto/marker.dto';
import { CreateConfirmationDto, RespondConfirmationDto } from './dto/confirmation.dto';
import {
  CreateReturnAlertDto,
  UpdateReturnAlertDto,
  ContactReturnAlertDto,
} from './dto/return-alert.dto';

function parseBool(v?: string): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return v === 'true' || v === '1';
}

@UseGuards(JwtAuthGuard)
@Controller()
export class AgendaExtendedController {
  constructor(
    private readonly rooms: RoomsService,
    private readonly markers: MarkersService,
    private readonly confirmations: ConfirmationsService,
    private readonly returnAlerts: ReturnAlertsService,
  ) {}

  // ─── Rooms ────────────────────────────────────────────────

  @Post('rooms')
  createRoom(@Body() dto: CreateRoomDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.rooms.create(tenantId, dto);
  }

  @Get('rooms')
  listRooms(@Request() req: any, @Query('active') active?: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.rooms.findAll(tenantId, { active: parseBool(active) });
  }

  @Get('rooms/:id')
  getRoom(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.rooms.findOne(tenantId, id);
  }

  @Patch('rooms/:id')
  updateRoom(@Param('id') id: string, @Body() dto: UpdateRoomDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.rooms.update(tenantId, id, dto);
  }

  @Delete('rooms/:id')
  archiveRoom(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.rooms.archive(tenantId, id);
  }

  // ─── Markers ────────────────────────────────────────────────

  @Post('appointment-markers')
  createMarker(@Body() dto: CreateMarkerDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.markers.create(tenantId, dto);
  }

  @Get('appointment-markers')
  listMarkers(@Request() req: any, @Query('active') active?: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.markers.findAll(tenantId, { active: parseBool(active) });
  }

  @Patch('appointment-markers/:id')
  updateMarker(@Param('id') id: string, @Body() dto: UpdateMarkerDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.markers.update(tenantId, id, dto);
  }

  @Delete('appointment-markers/:id')
  archiveMarker(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.markers.archive(tenantId, id);
  }

  /** Vincula marker a um agendamento (idempotente). */
  @Post('appointments/:appointmentId/markers/:markerId')
  attachMarker(
    @Param('appointmentId') appointmentId: string,
    @Param('markerId') markerId: string,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.markers.attach(tenantId, appointmentId, markerId);
  }

  @Delete('appointments/:appointmentId/markers/:markerId')
  detachMarker(
    @Param('appointmentId') appointmentId: string,
    @Param('markerId') markerId: string,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.markers.detach(tenantId, appointmentId, markerId);
  }

  @Get('appointments/:appointmentId/markers')
  listAppointmentMarkers(@Param('appointmentId') appointmentId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.markers.listByAppointment(tenantId, appointmentId);
  }

  // ─── Confirmations ────────────────────────────────────────────────

  @Post('appointments/:appointmentId/confirmations')
  createConfirmation(
    @Param('appointmentId') appointmentId: string,
    @Body() dto: CreateConfirmationDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.confirmations.create(tenantId, appointmentId, dto);
  }

  @Get('appointments/:appointmentId/confirmations')
  listConfirmations(@Param('appointmentId') appointmentId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.confirmations.findByAppointment(tenantId, appointmentId);
  }

  /** Registra resposta do paciente. Atualiza status do CalendarEvent quando aplicavel. */
  @Post('appointment-confirmations/:id/respond')
  respondConfirmation(
    @Param('id') id: string,
    @Body() dto: RespondConfirmationDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.confirmations.respond(tenantId, id, dto);
  }

  @Get('appointment-confirmations/pending')
  listPendingConfirmations(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.confirmations.findPending(tenantId);
  }

  // ─── Return Alerts ────────────────────────────────────────────────

  @Post('return-alerts')
  createReturnAlert(@Body() dto: CreateReturnAlertDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.returnAlerts.create(tenantId, userId, dto);
  }

  @Get('return-alerts')
  listReturnAlerts(
    @Request() req: any,
    @Query('status') status?: string,
    @Query('professional_user_id') professional_user_id?: string,
    @Query('patient_id') patient_id?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.returnAlerts.findAll(tenantId, {
      status,
      professional_user_id,
      patient_id,
      from,
      to,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  /** Lista da recepcao: alertas vencidos ou de hoje, status PENDENTE. */
  @Get('return-alerts/pending-now')
  pendingNow(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.returnAlerts.findPendingNow(tenantId);
  }

  /** Quadro de MANUTENÇÃO: recalls por procedimento (intervalo de revisão) + tratamento
   *  concluído. O front agrupa em abas + por mês. DEVE vir antes de :id. */
  @Get('return-alerts/maintenance-board')
  maintenanceBoard(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.returnAlerts.getMaintenanceBoard(tenantId);
  }

  /** Config dos Retornos (padrão da clínica + intervalo por procedimento). DEVE vir antes de :id. */
  @Get('return-alerts/config')
  getRecallConfig(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.returnAlerts.getRecallConfig(tenantId);
  }

  /** Ajusta o padrão da clínica (meses). Só ADMIN. DEVE vir antes de :id. */
  @Roles('ADMIN')
  @Patch('return-alerts/config')
  setRecallConfig(@Body() body: { default_months: number }, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.returnAlerts.setRecallConfig(tenantId, Number(body?.default_months));
  }

  @Get('return-alerts/:id')
  getReturnAlert(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.returnAlerts.findOne(tenantId, id);
  }

  @Patch('return-alerts/:id')
  updateReturnAlert(
    @Param('id') id: string,
    @Body() dto: UpdateReturnAlertDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.returnAlerts.update(tenantId, id, dto);
  }

  /** Marca como contatado (ou AGENDADO/REJEITADO via dto.result). */
  @Post('return-alerts/:id/contact')
  contactReturnAlert(
    @Param('id') id: string,
    @Body() dto: ContactReturnAlertDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!userId) throw new BadRequestException('user nao autenticado');
    return this.returnAlerts.contact(tenantId, id, userId, dto);
  }
}
