import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Request, BadRequestException,
} from '@nestjs/common';
import { InfluencerTemplatesService } from './influencer-templates.service';
import type { CreateTemplateDto, UpdateTemplateDto } from './influencer-templates.service';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('influencers/templates')
export class InfluencerTemplatesController {
  constructor(private service: InfluencerTemplatesService) {}

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
  create(@Request() req: any, @Body() body: CreateTemplateDto) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.create(tenantId, body);
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(@Request() req: any, @Param('id') id: string, @Body() body: UpdateTemplateDto) {
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
}
