import {
  Controller, Get, Post, Body, Patch, Delete, Param, Query, UseGuards, Request, BadRequestException,
} from '@nestjs/common';
import { SpecialtiesService } from './specialties.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateSpecialtyDto, UpdateSpecialtyDto } from './dto/specialty.dto';

@UseGuards(JwtAuthGuard)
@Controller('specialties')
export class SpecialtiesController {
  constructor(private readonly specialtiesService: SpecialtiesService) {}

  @Post()
  @Roles('ADMIN')
  create(@Body() dto: CreateSpecialtyDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.specialtiesService.create(tenantId, dto);
  }

  @Get()
  findAll(@Request() req: any, @Query('includeInactive') includeInactive?: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.specialtiesService.findAll(tenantId, includeInactive === 'true');
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.specialtiesService.findOne(id, tenantId);
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(@Param('id') id: string, @Body() dto: UpdateSpecialtyDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.specialtiesService.update(id, tenantId, dto);
  }

  @Delete(':id')
  @Roles('ADMIN')
  remove(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.specialtiesService.remove(id, tenantId);
  }

  @Post(':id/dentists/:userId')
  @Roles('ADMIN')
  addDentist(@Param('id') id: string, @Param('userId') userId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.specialtiesService.addDentist(id, userId, tenantId);
  }

  @Delete(':id/dentists/:userId')
  @Roles('ADMIN')
  removeDentist(@Param('id') id: string, @Param('userId') userId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.specialtiesService.removeDentist(id, userId, tenantId);
  }
}
