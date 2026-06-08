import {
  Controller, Get, Query, Request, UseGuards, BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequiresPermission } from '../auth/decorators/requires-permission.decorator';
import { ReportsService } from './reports.service';

@UseGuards(JwtAuthGuard)
// Onda 17.32.128 — Fase 6: relatorios exigem view_reports
@RequiresPermission('view_reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('dashboard')
  dashboard(
    @Request() req: any,
    @Query('period') period?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.reports.dashboard(tenantId, { period, from, to });
  }

  @Get('catalog')
  catalog() {
    return this.reports.catalog();
  }
}
