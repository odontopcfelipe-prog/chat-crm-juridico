import {
  Controller, Get, Post, Body, Patch, Param, UseGuards, Request, BadRequestException,
} from '@nestjs/common';
import { AnamnesisTemplatesService } from './anamnesis-templates.service';
import { AnamnesisService } from './anamnesis.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  CreateAnamnesisTemplateDto,
  UpdateAnamnesisTemplateDto,
  CreateAnamnesisDto,
  UpdateAnamnesisDto,
} from './dto/anamnesis.dto';

@UseGuards(JwtAuthGuard)
@Controller()
export class AnamnesisController {
  constructor(
    private readonly templatesService: AnamnesisTemplatesService,
    private readonly anamnesisService: AnamnesisService,
  ) {}

  // ─── Template (admin) ─────────────────────────────────────────

  @Get('anamnesis-templates')
  findAllTemplates(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.templatesService.findAll(tenantId);
  }

  @Get('anamnesis-templates/active')
  findActiveTemplate(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.templatesService.findActive(tenantId);
  }

  @Get('anamnesis-templates/:id')
  findOneTemplate(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.templatesService.findOne(id, tenantId);
  }

  @Post('anamnesis-templates')
  @Roles('ADMIN')
  createTemplate(@Body() dto: CreateAnamnesisTemplateDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.templatesService.create(tenantId, dto.schema, dto.notes);
  }

  @Patch('anamnesis-templates/:id')
  @Roles('ADMIN')
  updateTemplate(
    @Param('id') id: string,
    @Body() dto: UpdateAnamnesisTemplateDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.templatesService.update(id, tenantId, dto as any);
  }

  // ─── Anamnese do paciente ─────────────────────────────────────

  @Post('patients/:patientId/anamneses')
  create(@Param('patientId') patientId: string, @Body() dto: CreateAnamnesisDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.anamnesisService.create(patientId, tenantId, dto, req.user?.sub);
  }

  @Get('patients/:patientId/anamneses')
  findByPatient(@Param('patientId') patientId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.anamnesisService.findByPatient(patientId, tenantId);
  }

  @Get('anamneses/:id')
  findOne(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.anamnesisService.findOne(id, tenantId);
  }

  @Patch('anamneses/:id')
  update(@Param('id') id: string, @Body() dto: UpdateAnamnesisDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!dto.answers) throw new BadRequestException('answers obrigatorio');
    return this.anamnesisService.update(id, tenantId, dto.answers);
  }
}
