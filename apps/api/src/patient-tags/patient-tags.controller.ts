/**
 * PatientTagsController — endpoints REST pra Fase 20 (tags de paciente).
 *
 * Rotas:
 *  GET    /patient-tags                        — listar tags do tenant
 *  POST   /patient-tags                        — criar tag (admin)
 *  PATCH  /patient-tags/:id                    — editar tag (admin)
 *  DELETE /patient-tags/:id                    — remover tag (admin)
 *  GET    /patients/:id/tags                   — listar tags do paciente
 *  PUT    /patients/:id/tags                   — substituir tags do paciente (idempotente)
 */
import {
  Controller, Get, Post, Patch, Put, Delete,
  Body, Param, Request, UseGuards, BadRequestException, ForbiddenException,
} from '@nestjs/common';
import { PatientTagsService } from './patient-tags.service';
import type { CreateTagDto, UpdateTagDto } from './patient-tags.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { isAdmin } from '../common/utils/permissions.util';

@UseGuards(JwtAuthGuard)
@Controller()
export class PatientTagsController {
  constructor(private service: PatientTagsService) {}

  // ─── /patient-tags (admin de tags) ────────────────────────────

  @Get('patient-tags')
  list(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.list(tenantId);
  }

  @Post('patient-tags')
  create(@Request() req: any, @Body() data: CreateTagDto) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.create(tenantId, data);
  }

  @Patch('patient-tags/:id')
  update(@Request() req: any, @Param('id') id: string, @Body() data: UpdateTagDto) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.update(id, tenantId, data);
  }

  @Delete('patient-tags/:id')
  remove(@Request() req: any, @Param('id') id: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    // Onda 17.34 — excluir e destrutivo (some de TODOS os pacientes que a
    // usam): so ADMIN. Criar/editar continuam livres pra operacao (design
    // documentado no service — recepcao cria tags no proprio cadastro).
    if (!isAdmin(req.user?.roles)) {
      throw new ForbiddenException('Apenas ADMIN pode excluir etiquetas');
    }
    return this.service.remove(id, tenantId);
  }

  // ─── /patients/:id/tags (atribuição) ──────────────────────────

  @Get('patients/:id/tags')
  getForPatient(@Request() req: any, @Param('id') id: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    // Onda 17.33 — passa tenantId pro service validar ownership do paciente
    // (antes vazava etiquetas entre tenants via enumeration de id).
    return this.service.getTagsForPatient(id, tenantId);
  }

  @Put('patients/:id/tags')
  setForPatient(
    @Request() req: any,
    @Param('id') id: string,
    @Body() body: { tag_ids: string[] },
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!Array.isArray(body?.tag_ids)) throw new BadRequestException('tag_ids deve ser array');
    return this.service.setTagsForPatient(id, tenantId, body.tag_ids);
  }
}
