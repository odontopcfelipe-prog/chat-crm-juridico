import { Module } from '@nestjs/common';
import { ReturnAlertExpiratorService } from './return-alert-expirator.service';
import { GoalsRecalculatorService } from './goals-recalculator.service';
import { AppointmentConfirmationSchedulerService } from './appointment-confirmation-scheduler.service';
import { AppointmentConfirmationDispatcherService } from './appointment-confirmation-dispatcher.service';
import { CollectionEngineService } from './collection-engine.service';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';

/**
 * Modulo de automacoes cron — Fases 10 + 11.
 *
 * Cron jobs:
 *  - ReturnAlertExpirator: diario 03:00 — expira ReturnAlert antigos (>30d)
 *  - GoalsRecalculator: horario — atualiza current/projected_value de Goals
 *  - AppointmentConfirmationScheduler: horario XX:00 — cria
 *    AppointmentConfirmation pendente para agendamentos em 24-25h
 *  - AppointmentConfirmationDispatcher: horario XX:05 — envia via
 *    Evolution API as confirmacoes pendentes (sent_at IS NULL)
 *  - CollectionEngine: diario 09:00 — regua de cobranca (Fase 11): scan
 *    de Installment ABERTA/PARCIAL/ATRASADA, gera CollectionAttempt nas
 *    etapas D-3/D/D+1/D+7/D+15/D+30 e dispara WhatsApp via Evolution
 */
@Module({
  imports: [PrismaModule, SettingsModule],
  providers: [
    ReturnAlertExpiratorService,
    GoalsRecalculatorService,
    AppointmentConfirmationSchedulerService,
    AppointmentConfirmationDispatcherService,
    CollectionEngineService,
  ],
})
export class AutomationModule {}
