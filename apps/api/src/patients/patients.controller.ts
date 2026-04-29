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
  NotFoundException,
  Res,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { PatientsService } from './patients.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreatePatientDto, UpdatePatientDto } from './dto/create-patient.dto';

@UseGuards(JwtAuthGuard)
@Controller('patients')
export class PatientsController {
  constructor(private readonly patientsService: PatientsService) {}

  @Post()
  create(@Body() dto: CreatePatientDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.patientsService.create(tenantId, {
      ...dto,
      birth_date: dto.birth_date ? new Date(dto.birth_date) : undefined,
    });
  }

  @Get()
  findAll(
    @Request() req: any,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('dentistId') dentistId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.patientsService.findAll(tenantId, {
      search,
      status,
      dentistId,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('stats')
  getStats(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.patientsService.getStats(tenantId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.patientsService.findOne(id, tenantId);
  }

  /** Timeline unificada: agrega consultas + procedimentos + pagamentos + retornos + anamneses */
  @Get(':id/timeline')
  getTimeline(@Param('id') id: string, @Request() req: any, @Query('limit') limit?: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const lim = limit ? Math.min(500, Math.max(10, parseInt(limit, 10))) : 100;
    return this.patientsService.getTimeline(id, tenantId, lim);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePatientDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.patientsService.update(id, tenantId, {
      ...dto,
      birth_date: dto.birth_date ? new Date(dto.birth_date) : undefined,
    });
  }

  @Delete(':id')
  archive(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.patientsService.archive(id, tenantId);
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
    return this.patientsService.updateAvatar(id, tenantId, file.buffer, file.mimetype);
  }

  /** Servir a foto: GET /patients/:id/avatar */
  @Get(':id/avatar')
  async getAvatar(@Param('id') id: string, @Res() res: Response) {
    const result = await this.patientsService.getAvatarBuffer(id);
    if (!result) throw new NotFoundException('Foto nao encontrada.');
    res.set('Content-Type', result.mimeType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.end(result.buffer);
  }

  /** Remove a foto: DELETE /patients/:id/avatar */
  @Delete(':id/avatar')
  async removeAvatar(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.patientsService.removeAvatar(id, tenantId);
  }
}
