/**
 * Onda 17.32.126 — Endpoint dos chips do bloco em destaque por setor.
 * Qualquer usuario autenticado pode consultar (so devolve dados do
 * tenant dele).
 */
import { Controller, Get, Query, Req } from '@nestjs/common';
import { HomeHighlightsService } from './home-highlights.service.js';
import { HomePreviewService } from './home-preview.service.js';
import { HomeModuleBadgesService } from './home-module-badges.service.js';

@Controller('home')
export class HomeHighlightsController {
  constructor(
    private readonly service: HomeHighlightsService,
    private readonly preview: HomePreviewService,
    private readonly badges: HomeModuleBadgesService,
  ) {}

  @Get('highlights')
  async highlights(@Req() req: any, @Query('sector') sector?: string) {
    const tenantId = req.user?.tenant_id;
    const userId   = req.user?.sub ?? req.user?.id;
    if (!tenantId) return { chips: [] };
    return this.service.forSector(tenantId, sector ?? 'admin', userId);
  }

  // Onda 17.58 — badges de contagem ao vivo por módulo (cards "MÓDULOS").
  // `sector` via @Query pra não esbarrar no forbidNonWhitelisted (igual /highlights).
  @Get('module-badges')
  async moduleBadges(@Req() req: any, @Query('sector') sector?: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) return { badges: {} };
    return this.badges.forSector(tenantId, sector ?? 'admin');
  }

  // Onda 17.52 — Prévia (top ~5 itens reais) do balão. `key` via @Query pra
  // não esbarrar no forbidNonWhitelisted do ValidationPipe.
  @Get('preview')
  async previewBalao(@Req() req: any, @Query('key') key?: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId || !key) return { key: key ?? '', items: [] };
    return this.preview.getPreview(tenantId, key);
  }
}
