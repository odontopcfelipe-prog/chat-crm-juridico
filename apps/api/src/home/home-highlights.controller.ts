/**
 * Onda 17.32.126 — Endpoint dos chips do bloco em destaque por setor.
 * Qualquer usuario autenticado pode consultar (so devolve dados do
 * tenant dele).
 */
import { Controller, Get, Query, Req } from '@nestjs/common';
import { HomeHighlightsService } from './home-highlights.service.js';

@Controller('home')
export class HomeHighlightsController {
  constructor(private readonly service: HomeHighlightsService) {}

  @Get('highlights')
  async highlights(@Req() req: any, @Query('sector') sector?: string) {
    const tenantId = req.user?.tenant_id;
    const userId   = req.user?.sub ?? req.user?.id;
    if (!tenantId) return { chips: [] };
    return this.service.forSector(tenantId, sector ?? 'admin', userId);
  }
}
