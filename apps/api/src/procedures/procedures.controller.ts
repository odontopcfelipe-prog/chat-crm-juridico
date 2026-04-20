import {
  Controller, Get, Post, Body, Patch, Delete, Param, Query, UseGuards, Request, BadRequestException,
} from '@nestjs/common';
import { ProceduresService } from './procedures.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateProcedureDto, UpdateProcedureDto } from './dto/procedure.dto';

@UseGuards(JwtAuthGuard)
@Controller('procedures')
export class ProceduresController {
  constructor(private readonly proceduresService: ProceduresService) {}

  @Post()
  @Roles('ADMIN')
  create(@Body() dto: CreateProcedureDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.proceduresService.create(tenantId, dto);
  }

  @Get()
  findAll(
    @Request() req: any,
    @Query('specialtyId') specialtyId?: string,
    @Query('includeInactive') includeInactive?: string,
    @Query('search') search?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.proceduresService.findAll(tenantId, {
      specialtyId,
      includeInactive: includeInactive === 'true',
      search,
    });
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.proceduresService.findOne(id, tenantId);
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(@Param('id') id: string, @Body() dto: UpdateProcedureDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.proceduresService.update(id, tenantId, dto);
  }

  @Delete(':id')
  @Roles('ADMIN')
  remove(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.proceduresService.remove(id, tenantId);
  }
}
