import { Controller, Get, Post, Request, UseGuards, BadRequestException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { applyDentistBackfill, loadDentistBackfill, summarizeBackfill } from './dentist-backfill';

/**
 * Out/2026 — "Organizar pacientes por dentista" (dados antigos). Só ADMIN, sempre
 * na clínica do admin. GET = prévia (não grava); POST = recalcula e grava SÓ o
 * que ainda está vazio (nunca troca dentista já escolhido).
 */
@UseGuards(JwtAuthGuard)
@Controller('dentist-links')
export class DentistLinksController {
  constructor(private readonly prisma: PrismaService) {}

  @Roles('ADMIN')
  @Get('backfill')
  async preview(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const { dentists, plan } = await loadDentistBackfill(this.prisma, tenantId);
    return summarizeBackfill(dentists, plan);
  }

  @Roles('ADMIN')
  @Post('backfill')
  async apply(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const { plan } = await loadDentistBackfill(this.prisma, tenantId);
    const gravados = await applyDentistBackfill(this.prisma, plan);
    return { gravados };
  }
}
