import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { MaintenanceRecallCronService } from './maintenance-recall-cron.service';

/**
 * Worker MaintenanceModule (Fase 25 Onda 5.4).
 * Cron diario que envia WhatsApp de recall pra revisitas em <= 7 dias
 * + auto-marca como MISSED tasks com >= 1d de atraso.
 */
@Module({
  imports: [PrismaModule, SettingsModule],
  providers: [MaintenanceRecallCronService],
})
export class WorkerMaintenanceModule {}
