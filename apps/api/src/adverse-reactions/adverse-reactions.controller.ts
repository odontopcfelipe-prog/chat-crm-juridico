import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Request,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdverseReactionsService } from './adverse-reactions.service';
import {
  CreateAdverseReactionDto,
  UpdateAdverseReactionDto,
  ReportNotivisaDto,
} from './dto/adverse-reaction.dto';

function parseBool(v?: string): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return v === 'true' || v === '1';
}

@UseGuards(JwtAuthGuard)
@Controller()
export class AdverseReactionsController {
  constructor(private readonly service: AdverseReactionsService) {}

  @Post('patients/:patientId/adverse-reactions')
  create(
    @Param('patientId') patientId: string,
    @Body() dto: CreateAdverseReactionDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.create(tenantId, patientId, userId, dto);
  }

  @Get('patients/:patientId/adverse-reactions')
  listByPatient(@Param('patientId') patientId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.findByPatient(tenantId, patientId);
  }

  @Get('adverse-reactions')
  listAll(
    @Request() req: any,
    @Query('severity') severity?: string,
    @Query('reaction_type') reaction_type?: string,
    @Query('notivisa_reported') notivisa_reported?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.findAll(tenantId, {
      severity,
      reaction_type,
      notivisa_reported: parseBool(notivisa_reported),
      from,
      to,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('adverse-reactions/:id')
  findOne(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.findOne(tenantId, id);
  }

  @Patch('adverse-reactions/:id')
  update(@Param('id') id: string, @Body() dto: UpdateAdverseReactionDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.update(tenantId, id, dto);
  }

  /** Marca como reportado ao NOTIVISA com o protocolo recebido. */
  @Post('adverse-reactions/:id/report-notivisa')
  reportNotivisa(@Param('id') id: string, @Body() dto: ReportNotivisaDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.reportNotivisa(tenantId, id, dto);
  }
}
