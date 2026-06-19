import {
  Controller, Get, Post, Patch, Body, Param, UseGuards, Request, BadRequestException,
} from '@nestjs/common';
import { MedicalRecordsService } from './medical-records.service';
import { ClinicalNotesService } from './clinical-notes.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
// Onda 17.52 — Etapa 4/5: prontuário exige view_clinical (ler) / edit_clinical
// (escrever). Têm por default: dentista, ACD/ASB, recepção e admin.
import { RequiresPermission } from '../auth/decorators/requires-permission.decorator';
import {
  UpdateMedicalRecordDto,
  CreateClinicalNoteDto,
  UpdateClinicalNoteDto,
  AddAddendumDto,
} from './dto/clinical-records.dto';

@UseGuards(JwtAuthGuard)
@Controller()
export class ClinicalRecordsController {
  constructor(
    private readonly medicalRecordsService: MedicalRecordsService,
    private readonly clinicalNotesService: ClinicalNotesService,
  ) {}

  // ─── MedicalRecord ────────────────────────────────────────────

  @RequiresPermission('view_clinical')
  @Get('patients/:patientId/medical-record')
  getMedicalRecord(@Param('patientId') patientId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.medicalRecordsService.getOrCreate(patientId, tenantId);
  }

  @RequiresPermission('edit_clinical')
  @Patch('patients/:patientId/medical-record')
  updateMedicalRecord(
    @Param('patientId') patientId: string,
    @Body() dto: UpdateMedicalRecordDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.medicalRecordsService.update(patientId, tenantId, dto);
  }

  @RequiresPermission('edit_clinical')
  @Post('patients/:patientId/medical-record/close')
  closeMedicalRecord(@Param('patientId') patientId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.medicalRecordsService.close(patientId, tenantId);
  }

  // ─── ClinicalNote ─────────────────────────────────────────────

  @RequiresPermission('edit_clinical')
  @Post('patients/:patientId/clinical-notes')
  createNote(
    @Param('patientId') patientId: string,
    @Body() dto: CreateClinicalNoteDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.id;
    if (!tenantId || !userId) throw new BadRequestException('Contexto ausente');
    return this.clinicalNotesService.create(patientId, tenantId, userId, dto);
  }

  @RequiresPermission('view_clinical')
  @Get('patients/:patientId/clinical-notes')
  listNotes(@Param('patientId') patientId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.clinicalNotesService.findByPatient(patientId, tenantId);
  }

  @RequiresPermission('view_clinical')
  @Get('clinical-notes/:id')
  findNote(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.clinicalNotesService.findOne(id, tenantId);
  }

  @RequiresPermission('edit_clinical')
  @Patch('clinical-notes/:id')
  updateNote(
    @Param('id') id: string,
    @Body() dto: UpdateClinicalNoteDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.id;
    if (!tenantId || !userId) throw new BadRequestException('Contexto ausente');
    return this.clinicalNotesService.update(id, tenantId, userId, dto);
  }

  @RequiresPermission('edit_clinical')
  @Post('clinical-notes/:id/finalize')
  finalizeNote(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.id;
    if (!tenantId || !userId) throw new BadRequestException('Contexto ausente');
    return this.clinicalNotesService.finalize(id, tenantId, userId);
  }

  @RequiresPermission('edit_clinical')
  @Post('clinical-notes/:id/addendum')
  addAddendum(@Param('id') id: string, @Body() dto: AddAddendumDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.id;
    if (!tenantId || !userId) throw new BadRequestException('Contexto ausente');
    return this.clinicalNotesService.addAddendum(id, tenantId, userId, dto.addendum);
  }
}
