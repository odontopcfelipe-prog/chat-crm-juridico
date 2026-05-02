import {
  Controller, Get, Post, Patch, Delete, Body, Param, UseGuards,
} from '@nestjs/common';
import { OdontogramService } from './odontogram.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Authenticated } from '../auth/decorators/authenticated.decorator';
import type { AuthUser } from '../auth/decorators/authenticated.decorator';
import {
  UpdateOdontogramDto,
  CreateToothRecordDto,
  UpdateToothRecordDto,
} from './dto/odontogram.dto';

/**
 * Onda 2.1 (Fase 25) — Controller migrado pra @Authenticated() decorator.
 * Antes usava req.user?.sub (typo!) — bug silencioso que retornava undefined.
 * Agora user.id eh garantido pelo decorator (lanca 401 se faltar).
 */
@UseGuards(JwtAuthGuard)
@Controller()
export class OdontogramController {
  constructor(private readonly odontogramService: OdontogramService) {}

  @Get('patients/:patientId/odontogram')
  get(@Param('patientId') patientId: string, @Authenticated() user: AuthUser) {
    return this.odontogramService.getOrCreate(patientId, user.tenant_id);
  }

  @Patch('patients/:patientId/odontogram')
  updateMeta(
    @Param('patientId') patientId: string,
    @Body() dto: UpdateOdontogramDto,
    @Authenticated() user: AuthUser,
  ) {
    return this.odontogramService.updateMeta(patientId, user.tenant_id, dto.meta || {}, user.id);
  }

  @Post('patients/:patientId/odontogram/teeth')
  addTooth(
    @Param('patientId') patientId: string,
    @Body() dto: CreateToothRecordDto,
    @Authenticated() user: AuthUser,
  ) {
    return this.odontogramService.addTooth(patientId, user.tenant_id, user.id, dto);
  }

  @Patch('tooth-records/:id')
  updateTooth(@Param('id') id: string, @Body() dto: UpdateToothRecordDto, @Authenticated() user: AuthUser) {
    return this.odontogramService.updateTooth(id, user.tenant_id, user.id, dto);
  }

  @Delete('tooth-records/:id')
  removeTooth(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.odontogramService.removeTooth(id, user.tenant_id, user.id);
  }
}
