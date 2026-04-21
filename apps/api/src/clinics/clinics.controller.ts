import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, Request, UseGuards, BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ClinicsService } from './clinics.service';
import { CreateClinicDto, UpdateClinicDto, AssignUserClinicDto } from './dto/clinic.dto';

function parseBool(v?: string): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return v === 'true' || v === '1';
}

@UseGuards(JwtAuthGuard)
@Controller()
export class ClinicsController {
  constructor(private readonly service: ClinicsService) {}

  @Post('clinics')
  create(@Body() dto: CreateClinicDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.create(tenantId, dto);
  }

  @Get('clinics')
  findAll(@Request() req: any, @Query('active') active?: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.findAll(tenantId, { active: parseBool(active) });
  }

  @Get('clinics/ranking')
  ranking(@Request() req: any, @Query('from') from?: string, @Query('to') to?: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.ranking(tenantId, { from, to });
  }

  @Get('clinics/:id')
  findOne(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.findOne(tenantId, id);
  }

  @Patch('clinics/:id')
  update(@Param('id') id: string, @Body() dto: UpdateClinicDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.update(tenantId, id, dto);
  }

  @Delete('clinics/:id')
  archive(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.archive(tenantId, id);
  }

  @Post('clinics/:id/users')
  assignUser(@Param('id') id: string, @Body() dto: AssignUserClinicDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.assignUser(tenantId, id, dto);
  }

  @Delete('clinics/:id/users/:userId')
  unassignUser(@Param('id') id: string, @Param('userId') userId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.unassignUser(tenantId, id, userId);
  }
}
