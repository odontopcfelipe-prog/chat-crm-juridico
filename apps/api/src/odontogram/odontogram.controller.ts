import {
  Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, Request, BadRequestException,
} from '@nestjs/common';
import { OdontogramService } from './odontogram.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  UpdateOdontogramDto,
  CreateToothRecordDto,
  UpdateToothRecordDto,
} from './dto/odontogram.dto';

@UseGuards(JwtAuthGuard)
@Controller()
export class OdontogramController {
  constructor(private readonly odontogramService: OdontogramService) {}

  @Get('patients/:patientId/odontogram')
  get(@Param('patientId') patientId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.odontogramService.getOrCreate(patientId, tenantId);
  }

  @Patch('patients/:patientId/odontogram')
  updateMeta(
    @Param('patientId') patientId: string,
    @Body() dto: UpdateOdontogramDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.sub;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.odontogramService.updateMeta(patientId, tenantId, dto.meta || {}, userId);
  }

  @Post('patients/:patientId/odontogram/teeth')
  addTooth(
    @Param('patientId') patientId: string,
    @Body() dto: CreateToothRecordDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.sub;
    if (!tenantId || !userId) throw new BadRequestException('Contexto ausente');
    return this.odontogramService.addTooth(patientId, tenantId, userId, dto);
  }

  @Patch('tooth-records/:id')
  updateTooth(@Param('id') id: string, @Body() dto: UpdateToothRecordDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.sub;
    if (!tenantId || !userId) throw new BadRequestException('Contexto ausente');
    return this.odontogramService.updateTooth(id, tenantId, userId, dto);
  }

  @Delete('tooth-records/:id')
  removeTooth(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.sub;
    if (!tenantId || !userId) throw new BadRequestException('Contexto ausente');
    return this.odontogramService.removeTooth(id, tenantId, userId);
  }
}
