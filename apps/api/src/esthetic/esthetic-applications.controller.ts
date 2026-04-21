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
import { EstheticApplicationsService } from './esthetic-applications.service';
import {
  CreateEstheticApplicationDto,
  UpdateEstheticApplicationDto,
} from './dto/esthetic-application.dto';

@UseGuards(JwtAuthGuard)
@Controller()
export class EstheticApplicationsController {
  constructor(private readonly service: EstheticApplicationsService) {}

  @Post('patients/:patientId/esthetic-applications')
  create(
    @Param('patientId') patientId: string,
    @Body() dto: CreateEstheticApplicationDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.create(tenantId, patientId, userId, dto);
  }

  @Get('patients/:patientId/esthetic-applications')
  listByPatient(
    @Param('patientId') patientId: string,
    @Request() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.findByPatient(tenantId, patientId, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  /** Aplicacoes com retorno previsto nos proximos N dias. */
  @Get('esthetic-applications/upcoming-revisits')
  upcoming(@Request() req: any, @Query('days') days?: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.findUpcomingRevisits(tenantId, days ? parseInt(days, 10) : 30);
  }

  @Get('esthetic-applications/:id')
  findOne(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.findOne(tenantId, id);
  }

  @Patch('esthetic-applications/:id')
  update(@Param('id') id: string, @Body() dto: UpdateEstheticApplicationDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.update(tenantId, id, dto);
  }

  /**
   * Cancelamento "soft" — registra anotacao de cancelamento dentro de 24h.
   * Auditoria ANVISA: o registro nunca e deletado fisicamente.
   */
  @Delete('esthetic-applications/:id')
  cancel(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!userId) throw new BadRequestException('user nao autenticado');
    return this.service.cancel(tenantId, id, userId, body?.reason || '');
  }
}
