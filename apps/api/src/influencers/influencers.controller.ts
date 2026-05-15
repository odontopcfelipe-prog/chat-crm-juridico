/**
 * InfluencersController — REST endpoints (acesso restrito a ADMIN).
 *
 *  GET    /influencers?status=ATIVO&q=ana   — listar (filtros opcionais)
 *  GET    /influencers/:id                   — detalhe
 *  POST   /influencers                       — criar
 *  PATCH  /influencers/:id                   — editar
 *  DELETE /influencers/:id                   — remover
 */
import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, Request, BadRequestException,
} from '@nestjs/common';
import { InfluencersService } from './influencers.service';
import type { CreateInfluencerDto, UpdateInfluencerDto } from './influencers.service';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('influencers')
export class InfluencersController {
  constructor(private service: InfluencersService) {}

  @Get()
  @Roles('ADMIN')
  list(
    @Request() req: any,
    @Query('status') status?: string,
    @Query('q') q?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.list(tenantId, { status, q });
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
  create(@Request() req: any, @Body() body: CreateInfluencerDto) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.create(tenantId, body);
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(@Request() req: any, @Param('id') id: string, @Body() body: UpdateInfluencerDto) {
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
