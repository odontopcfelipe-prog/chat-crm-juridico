import { Controller, Post, Param, Query, Request, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { EvolutionService } from './evolution.service';
import { PrismaService } from '../prisma/prisma.service';
import { Roles } from '../auth/decorators/roles.decorator';

/**
 * Endpoint administrativo para disparar manualmente o resync de mensagens
 * de uma instância do WhatsApp.
 *
 * Use quando:
 *  - O CRM caiu e mensagens chegaram durante a queda
 *  - Você suspeita que webhooks da Evolution API falharam silenciosamente
 *  - Precisa recuperar um histórico maior que a janela padrão do cron (2h)
 *
 * Protegido pelo JwtAuthGuard global — requer token de usuário logado.
 */
@Controller('whatsapp/instances')
export class EvolutionAdminController {
  private readonly logger = new Logger(EvolutionAdminController.name);

  constructor(
    private readonly evolutionService: EvolutionService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * POST /whatsapp/instances/:name/resync?hours=168
   *
   * Query params:
   *  - hours: janela de tempo a recuperar (1–720, default 168 = 7 dias)
   */
  // Onda 17.61 (segurança/RBAC-04) — operação pesada (até 720h). Era acionável por
  // QUALQUER logado contra QUALQUER instância. Agora: só ADMIN/SUPER_ADMIN e a
  // instância TEM que ser do tenant do chamador (404 no mismatch, sem virar oráculo).
  @Roles('ADMIN', 'SUPER_ADMIN')
  @Post(':name/resync')
  async resync(
    @Param('name') name: string,
    @Query('hours') hours?: string,
    @Request() req?: any,
  ): Promise<{
    scheduled: true;
    instance: string;
    cutoffHours: number;
    newConvsCreated: number;
    conversationsResynced: number;
    message: string;
  }> {
    const parsed = hours ? parseInt(hours, 10) : 168;
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 720) {
      throw new BadRequestException('hours deve ser um inteiro entre 1 e 720');
    }

    const tenantId = req?.user?.tenant_id;
    if (tenantId) {
      const inst = await this.prisma.instance.findFirst({ where: { name }, select: { tenant_id: true } });
      if (!inst || inst.tenant_id !== tenantId) {
        throw new NotFoundException('Instância não encontrada');
      }
    }

    this.logger.log(`[MANUAL RESYNC] Instância=${name}, janela=${parsed}h`);

    const result = await this.evolutionService.scheduleResyncAfterReconnect(name, {
      cutoffHours: parsed,
      stabilizeDelayMs: 0, // manual → roda imediato
      triggerReason: 'manual',
    });

    return {
      scheduled: true,
      instance: name,
      cutoffHours: parsed,
      newConvsCreated: result.newConvsCreated,
      conversationsResynced: result.conversationsResynced,
      message:
        `Resync manual agendado para instância "${name}" (últimas ${parsed}h). ` +
        `${result.newConvsCreated} conversa(s) nova(s) criada(s) a partir de chats recentes. ` +
        `${result.conversationsResynced} conversa(s) ativa(s) enfileirada(s) para importação de mensagens.`,
    };
  }
}
