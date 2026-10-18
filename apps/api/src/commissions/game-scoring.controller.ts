import {
  Controller, Get, Put, Delete, Param, Body, Request, UseGuards,
  BadRequestException, NotFoundException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_SCORING, gameScoringKey, mergeScoring, parseScoringInput, readScoringOverride,
} from './game-rules';

/**
 * Out/2026 — Pontuação do "Meu jogo" POR PROFISSIONAL, editada no cadastro do
 * dentista (Configurações → Usuários). Só ADMIN; sempre dentro da clínica do
 * admin (anti-IDOR: o usuário alvo tem que ser do mesmo tenant).
 *
 * Guarda só o que difere do padrão em TenantSetting `GAME_SCORING_<userId>`.
 * Body (inline, validado à mão em parseScoringInput — campo vazio = padrão):
 *   { pontos?: { procedimento, atendimento, avaliacao, conversao, missao },
 *     niveis?: { prata, ouro, diamante } }
 */
@UseGuards(JwtAuthGuard)
@Controller()
export class GameScoringController {
  constructor(private readonly prisma: PrismaService) {}

  private async assertSameTenant(userId: string, tenantId: string | undefined) {
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const u = await this.prisma.user.findFirst({ where: { id: userId, tenant_id: tenantId }, select: { id: true } });
    if (!u) throw new NotFoundException('Usuário não encontrado');
    return tenantId;
  }

  @Roles('ADMIN')
  @Get('users/:id/game-scoring')
  async get(@Param('id') id: string, @Request() req: any) {
    const tenantId = await this.assertSameTenant(id, req.user?.tenant_id);
    const override = await readScoringOverride(this.prisma, tenantId, id);
    return { padrao: DEFAULT_SCORING, override: override ?? {}, efetiva: mergeScoring(override) };
  }

  @Roles('ADMIN')
  @Put('users/:id/game-scoring')
  async put(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    const tenantId = await this.assertSameTenant(id, req.user?.tenant_id);
    let override;
    try {
      override = parseScoringInput(body);
    } catch (e: any) {
      throw new BadRequestException(e?.message || 'Pontuação inválida');
    }
    const key = gameScoringKey(id);
    const vazio = !override.pontos && !override.niveis;
    if (vazio) {
      // Tudo em branco = volta pro padrão.
      await this.prisma.tenantSetting.deleteMany({ where: { tenant_id: tenantId, key } });
    } else {
      const value = JSON.stringify(override);
      await this.prisma.tenantSetting.upsert({
        where: { tenant_id_key: { tenant_id: tenantId, key } },
        create: { tenant_id: tenantId, key, value },
        update: { value },
      });
    }
    return { override: vazio ? {} : override, efetiva: mergeScoring(vazio ? null : override) };
  }

  @Roles('ADMIN')
  @Delete('users/:id/game-scoring')
  async reset(@Param('id') id: string, @Request() req: any) {
    const tenantId = await this.assertSameTenant(id, req.user?.tenant_id);
    await this.prisma.tenantSetting.deleteMany({ where: { tenant_id: tenantId, key: gameScoringKey(id) } });
    return { override: {}, efetiva: mergeScoring(null) };
  }
}
