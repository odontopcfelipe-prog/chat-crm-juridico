import { Controller, Get, Query, Request, UseGuards, BadRequestException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { computeMyGame, maceioMonthKey, readMissionsConfig } from './game-rules';

/**
 * Out/2026 — "Meu jogo": pontuação, nível, metas e missões do profissional LOGADO.
 *
 * Substitui "Minha comissão" na visão do dentista (decisão do dono: com os
 * profissionais não se fala em comissão/dinheiro). Nada em R$ sai daqui.
 *
 * Segurança igual à MyCommissionsController: só JwtAuthGuard e o profissional é
 * SEMPRE req.user.id (anti-IDOR — não existe parâmetro de usuário).
 */
@UseGuards(JwtAuthGuard)
@Controller()
export class MyGameController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('my-game')
  async myGame(@Request() req: any, @Query('month') month?: string) {
    const tenantId = req.user?.tenant_id;
    const selfUserId = req.user?.id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!selfUserId) throw new BadRequestException('user_id ausente');
    const ref = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : maceioMonthKey();
    const missions = await readMissionsConfig(this.prisma, tenantId);
    return computeMyGame(this.prisma, tenantId, selfUserId, ref, missions);
  }
}
