import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Request, BadRequestException,
} from '@nestjs/common';
import { InfluencerSchedulesService } from './influencer-schedules.service';
import type { CreateScheduleDto, UpdateScheduleDto } from './influencer-schedules.service';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('influencers/schedules')
export class InfluencerSchedulesController {
  constructor(private service: InfluencerSchedulesService) {}

  @Get()
  @Roles('ADMIN')
  list(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.list(tenantId);
  }

  @Get(':id')
  @Roles('ADMIN')
  findOne(@Request() req: any, @Param('id') id: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.findOne(id, tenantId);
  }

  @Post()
  @Roles('ADMIN')
  create(@Request() req: any, @Body() body: CreateScheduleDto) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.create(tenantId, body);
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(@Request() req: any, @Param('id') id: string, @Body() body: UpdateScheduleDto) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.update(id, tenantId, body);
  }

  @Delete(':id')
  @Roles('ADMIN')
  remove(@Request() req: any, @Param('id') id: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.remove(id, tenantId);
  }

  @Post(':id/run-now')
  @Roles('ADMIN')
  runNow(@Request() req: any, @Param('id') id: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.runNow(id, tenantId);
  }
}
