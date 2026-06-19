import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { OdontogramService } from './odontogram.service';
import { StateSuggestionsService } from './state-suggestions.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
// Onda 17.52 — Etapa 4/5: odontograma é prontuário (view_clinical/edit_clinical).
import { RequiresPermission } from '../auth/decorators/requires-permission.decorator';
import { Authenticated } from '../auth/decorators/authenticated.decorator';
import type { AuthUser } from '../auth/decorators/authenticated.decorator';
import {
  UpdateOdontogramDto,
  CreateToothRecordDto,
  UpdateToothRecordDto,
} from './dto/odontogram.dto';
import {
  CreateStateSuggestionDto,
  UpdateStateSuggestionDto,
} from './dto/state-suggestion.dto';

/**
 * Onda 2.1 (Fase 25) — Controller migrado pra @Authenticated() decorator.
 * Antes usava req.user?.sub (typo!) — bug silencioso que retornava undefined.
 * Agora user.id eh garantido pelo decorator (lanca 401 se faltar).
 */
@UseGuards(JwtAuthGuard)
@Controller()
export class OdontogramController {
  constructor(
    private readonly odontogramService: OdontogramService,
    private readonly suggestionsService: StateSuggestionsService,
  ) {}

  @RequiresPermission('view_clinical')
  @Get('patients/:patientId/odontogram')
  get(@Param('patientId') patientId: string, @Authenticated() user: AuthUser) {
    return this.odontogramService.getOrCreate(patientId, user.tenant_id);
  }

  @RequiresPermission('edit_clinical')
  @Patch('patients/:patientId/odontogram')
  updateMeta(
    @Param('patientId') patientId: string,
    @Body() dto: UpdateOdontogramDto,
    @Authenticated() user: AuthUser,
  ) {
    return this.odontogramService.updateMeta(
      patientId,
      user.tenant_id,
      dto.meta || {},
      user.id,
    );
  }

  @RequiresPermission('edit_clinical')
  @Post('patients/:patientId/odontogram/teeth')
  addTooth(
    @Param('patientId') patientId: string,
    @Body() dto: CreateToothRecordDto,
    @Authenticated() user: AuthUser,
  ) {
    return this.odontogramService.addTooth(
      patientId,
      user.tenant_id,
      user.id,
      dto,
    );
  }

  @RequiresPermission('edit_clinical')
  @Patch('tooth-records/:id')
  updateTooth(
    @Param('id') id: string,
    @Body() dto: UpdateToothRecordDto,
    @Authenticated() user: AuthUser,
  ) {
    return this.odontogramService.updateTooth(id, user.tenant_id, user.id, dto);
  }

  @RequiresPermission('edit_clinical')
  @Delete('tooth-records/:id')
  removeTooth(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.odontogramService.removeTooth(id, user.tenant_id, user.id);
  }

  // ─── Onda 3.2 — Sugestoes automaticas (mapping estado clinico -> procedimento) ───

  @Get('state-suggestions')
  listSuggestions(
    @Query('state') state: string | undefined,
    @Authenticated() user: AuthUser,
  ) {
    return this.suggestionsService.list(user.tenant_id, state);
  }

  @Post('state-suggestions')
  createSuggestion(
    @Body() dto: CreateStateSuggestionDto,
    @Authenticated() user: AuthUser,
  ) {
    return this.suggestionsService.create(user.tenant_id, dto);
  }

  @Patch('state-suggestions/:id')
  updateSuggestion(
    @Param('id') id: string,
    @Body() dto: UpdateStateSuggestionDto,
    @Authenticated() user: AuthUser,
  ) {
    return this.suggestionsService.update(id, user.tenant_id, dto);
  }

  @Delete('state-suggestions/:id')
  removeSuggestion(@Param('id') id: string, @Authenticated() user: AuthUser) {
    return this.suggestionsService.remove(id, user.tenant_id);
  }
}
