import { Controller, Post, Get, Body, Query, UseGuards } from '@nestjs/common';
import { AnalyticsService, TrackEventDto } from './analytics.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly service: AnalyticsService) {}

  /** Público — chamado pelo tracking script nas LPs */
  @Post('track')
  track(@Body() dto: TrackEventDto) {
    return this.service.track(dto);
  }

  /** Protegido — lista todas as páginas com métricas agregadas */
  @UseGuards(JwtAuthGuard)
  @Get('pages')
  getPages() {
    return this.service.getPages();
  }

  /** Protegido — detalhe de uma página específica */
  @UseGuards(JwtAuthGuard)
  @Get('detail')
  getDetail(@Query('path') path: string) {
    return this.service.getPageDetail(decodeURIComponent(path));
  }

  /** Protegido — resumo do Google Analytics 4 (últimos 30 dias + 7 dias diário) */
  @UseGuards(JwtAuthGuard)
  @Get('ga4')
  getGa4() {
    return this.service.getGa4Summary();
  }

  /** Protegido — retorna status de configuração GA4 */
  @UseGuards(JwtAuthGuard)
  @Get('ga4-config')
  getGa4Config() {
    return this.service.getGa4Config();
  }

  /** Protegido — salva Property ID e Service Account JSON no banco */
  @UseGuards(JwtAuthGuard)
  @Post('ga4-config')
  saveGa4Config(@Body() body: { propertyId: string; serviceAccountJson: string }) {
    return this.service.saveGa4Config(body.propertyId, body.serviceAccountJson);
  }
}
