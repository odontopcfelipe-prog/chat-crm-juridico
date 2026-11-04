import {
  Controller, Get, Post, Put, Body, Patch, Delete, Param, Query, UseGuards, Request, BadRequestException,
  NotFoundException, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import { createHash } from 'crypto';
import type { Response } from 'express';
import { ProceduresService } from './procedures.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequiresPermission } from '../auth/decorators/requires-permission.decorator';
import { AparenciaVendaDto, CreateProcedureDto, UpdateProcedureDto } from './dto/procedure.dto';

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

  /** Aba Produtos da Venda Rápida. Rota literal: tem de vir ANTES de @Get(':id'). */
  @RequiresPermission('manage_proposals')
  @Get('catalogo')
  catalogo(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.proceduresService.catalogo(tenantId);
  }

  /** Edição básica: quem vende lê para montar a tela; só o ADMIN muda. Literal: antes de @Get(':id'). */
  @RequiresPermission('manage_proposals')
  @Get('aparencia-venda')
  aparenciaVenda(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.proceduresService.aparenciaVenda(tenantId);
  }

  @Put('aparencia-venda')
  @Roles('ADMIN')
  salvarAparenciaVenda(@Body() dto: AparenciaVendaDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.proceduresService.salvarAparenciaVenda(tenantId, dto);
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
    return this.proceduresService.update(id, tenantId, dto, req.user?.id);
  }

  @Delete(':id')
  @Roles('ADMIN')
  remove(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.proceduresService.remove(id, tenantId);
  }

  /** Envia/troca a foto: POST /procedures/:id/photo (multipart, campo "file"). */
  @Post(':id/photo')
  @Roles('ADMIN')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  uploadPhoto(@Param('id') id: string, @UploadedFile() file: any, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!file) throw new BadRequestException('Nenhum arquivo enviado.');
    return this.proceduresService.updatePhoto(id, tenantId, file.buffer, file.mimetype);
  }

  /** Serve a foto. Fora do throttle (uma por cartão da vitrine), com ETag do conteúdo. */
  @SkipThrottle()
  @Get(':id/photo')
  async getPhoto(@Param('id') id: string, @Request() req: any, @Res() res: Response) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const foto = await this.proceduresService.getPhoto(id, tenantId);
    if (!foto) throw new NotFoundException('Foto nao encontrada.');
    const etag = `"${createHash('sha1').update(foto.buffer).digest('hex')}"`;
    res.set('ETag', etag);
    res.set('Cache-Control', 'private, max-age=0, must-revalidate');
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.set('Content-Type', foto.mimeType);
    res.end(foto.buffer);
  }

  /** Remove a foto. */
  @Delete(':id/photo')
  @Roles('ADMIN')
  removePhoto(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.proceduresService.removePhoto(id, tenantId);
  }
}
