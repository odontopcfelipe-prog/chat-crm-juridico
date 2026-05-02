import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MaintenanceService } from './maintenance.service';
import { MaintenanceController } from './maintenance.controller';

/**
 * MaintenanceModule — gestao de tasks de manutencao/recall (Fase 25 Onda 5).
 *
 * Exporta MaintenanceService pra que outros modulos (esthetic, treatment-plans)
 * possam criar tasks automaticamente apos suas operacoes.
 */
@Module({
  imports: [PrismaModule],
  controllers: [MaintenanceController],
  providers: [MaintenanceService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
