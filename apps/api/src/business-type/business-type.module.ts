import { Module } from '@nestjs/common';
import { LabSentinelService } from './lab-sentinel.service';

/**
 * F2 parte 4 do laboratório — vigia diária do laboratório. Folha: só usa Prisma e
 * MailService (globais), não importa módulo de domínio nenhum (sem ciclo de DI).
 * O LabTenantGuard é registrado como APP_GUARD no AppModule.
 */
@Module({
  providers: [LabSentinelService],
})
export class BusinessTypeModule {}
