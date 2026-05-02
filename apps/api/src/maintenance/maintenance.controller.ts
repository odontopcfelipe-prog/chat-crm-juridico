import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards,
} from '@nestjs/common';
import { MaintenanceService } from './maintenance.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Authenticated } from '../auth/decorators/authenticated.decorator';
import type { AuthUser } from '../auth/decorators/authenticated.decorator';
import {
  CreateMaintenanceTaskDto,
  UpdateMaintenanceTaskDto,
} from './dto/maintenance.dto';

/**
 * MaintenanceController — endpoints de manutencao/recall (Fase 25 Onda 5).
 *
 * Endpoints:
 *   GET  /patients/:id/maintenance-tasks  - lista do paciente (tab Manutencoes)
 *   GET  /maintenance-tasks               - lista do tenant (?overdue=1 pra so atrasadas)
 *                                           usado pelo dashboard widget
 *   POST /maintenance-tasks               - cria task manual
 *   PATCH /maintenance-tasks/:id          - atualiza (status, agendamento, etc)
 *   DELETE /maintenance-tasks/:id         - remove (so PENDING)
 */
@UseGuards(JwtAuthGuard)
@Controller()
export class MaintenanceController {
  constructor(private readonly svc: MaintenanceService) {}

  @Get('patients/:id/maintenance-tasks')
  listByPatient(
    @Param('id') patientId: string,
    @Authenticated() user: AuthUser,
  ) {
    return this.svc.listByPatient(patientId, user.tenant_id);
  }

  @Get('maintenance-tasks')
  listAll(
    @Query('overdue') overdue: string | undefined,
    @Authenticated() user: AuthUser,
  ) {
    return this.svc.listOverdueOrUpcoming(user.tenant_id, overdue === '1' || overdue === 'true');
  }

  @Post('maintenance-tasks')
  create(
    @Body() dto: CreateMaintenanceTaskDto,
    @Authenticated() user: AuthUser,
  ) {
    return this.svc.createManual(user.tenant_id, user.id, dto);
  }

  @Patch('maintenance-tasks/:id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateMaintenanceTaskDto,
    @Authenticated() user: AuthUser,
  ) {
    return this.svc.update(id, user.tenant_id, user.id, dto as any);
  }

  @Delete('maintenance-tasks/:id')
  remove(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.svc.remove(id, user.tenant_id);
  }
}
