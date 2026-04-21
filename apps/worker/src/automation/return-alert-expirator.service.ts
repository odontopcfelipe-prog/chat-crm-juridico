import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Cron diario que expira ReturnAlert.status=PENDENTE com scheduled_for
 * mais antigo que EXPIRATION_DAYS dias (default 30). Limpa a lista da
 * recepcao de retornos esquecidos que ja perderam relevancia.
 *
 * Executa todo dia as 03:00 (Maceio) — fora do horario de trabalho da clinica.
 */
@Injectable()
export class ReturnAlertExpiratorService {
  private readonly logger = new Logger(ReturnAlertExpiratorService.name);
  private readonly EXPIRATION_DAYS = 30;

  constructor(private prisma: PrismaService) {}

  @Cron('0 3 * * *', { timeZone: 'America/Maceio' })
  async expireOldAlerts() {
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - this.EXPIRATION_DAYS);

      const result = await this.prisma.returnAlert.updateMany({
        where: {
          status: 'PENDENTE',
          scheduled_for: { lt: cutoff },
        },
        data: { status: 'EXPIRADO' },
      });

      if (result.count > 0) {
        this.logger.log(
          `[ReturnAlertExpirator] ${result.count} alerta(s) expirado(s) ` +
          `(scheduled_for < ${cutoff.toISOString().slice(0, 10)})`,
        );
      }
    } catch (e: any) {
      this.logger.error(`[ReturnAlertExpirator] Erro: ${e.message}`);
    }
  }
}
