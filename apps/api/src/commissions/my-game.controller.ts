import { Controller, Get, Query, Request, UseGuards, BadRequestException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { computeMyGame, maceioMonthKey, monthBounds, readGameScoring, readMissionsConfig } from './game-rules';
import { groupProcedures } from './procedure-groups';

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
    // Pontuação DESTE profissional (o admin pode ajustar no cadastro dele).
    const [missions, scoring] = await Promise.all([
      readMissionsConfig(this.prisma, tenantId),
      readGameScoring(this.prisma, tenantId, selfUserId),
    ]);
    return computeMyGame(this.prisma, tenantId, selfUserId, ref, missions, scoring);
  }

  /**
   * Out/2026 — "Procedimentos do mês" do painel do dentista: o que ELE executou
   * no mês, agrupado por família (Limpeza, Restauração…). Só contagem, nada de
   * valor. Mesmo anti-IDOR: sempre o usuário logado.
   */
  @Get('my-procedures')
  async myProcedures(@Request() req: any, @Query('month') month?: string) {
    const tenantId = req.user?.tenant_id;
    const selfUserId = req.user?.id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!selfUserId) throw new BadRequestException('user_id ausente');
    const ref = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : maceioMonthKey();
    const b = monthBounds(ref);
    const done = await this.prisma.treatmentPlanItem.findMany({
      where: {
        status: 'DONE', executed_by_user_id: selfUserId,
        executed_at: { gte: b.realStart, lte: b.realEnd },
        treatment_plan: { patient: { tenant_id: tenantId } },
      },
      select: { procedure: { select: { name: true, category: true } } },
      take: 5000,
    });
    return { month: ref, ...groupProcedures(done.map((d) => d.procedure)) };
  }
}
