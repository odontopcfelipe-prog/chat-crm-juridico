import { Controller, Post, Get, Body, Query, UseGuards, Request } from '@nestjs/common';
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

  /**
   * Protegido — resumo do Google Analytics 4 da clínica do login (últimos 30
   * dias + 7 dias diário). A conta vem do token, nunca da requisição.
   */
  @UseGuards(JwtAuthGuard)
  @Get('ga4')
  getGa4(@Request() req: any) {
    return this.service.getGa4Summary(req.user?.tenant_id ?? null);
  }

  /** Protegido — status de configuração do GA4 da clínica do login (sem a credencial) */
  @UseGuards(JwtAuthGuard)
  @Get('ga4-config')
  getGa4Config(@Request() req: any) {
    return this.service.getGa4Config(req.user?.tenant_id ?? null);
  }

  /**
   * Protegido — salva Property ID e Service Account JSON da clínica do login.
   * Só o administrador da clínica (403 para os demais; ver ga4-config.ts).
   */
  @UseGuards(JwtAuthGuard)
  @Post('ga4-config')
  saveGa4Config(@Request() req: any, @Body() body: { propertyId: string; serviceAccountJson: string }) {
    return this.service.saveGa4Config(req.user, body?.propertyId, body?.serviceAccountJson);
  }
}
