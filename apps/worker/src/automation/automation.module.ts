import { Module } from '@nestjs/common';
import { ReturnAlertExpiratorService } from './return-alert-expirator.service';
import { GoalsRecalculatorService } from './goals-recalculator.service';
import { AppointmentConfirmationSchedulerService } from './appointment-confirmation-scheduler.service';
import { AppointmentConfirmationDispatcherService } from './appointment-confirmation-dispatcher.service';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';

/**
 * Modulo de automacoes cron — Fase 10.
 *
 * Cron jobs:
 *  - ReturnAlertExpirator: diario 03:00 — expira ReturnAlert antigos
 *  - GoalsRecalculator: horario — atualiza current/projected_value de Goals
 *  - AppointmentConfirmationScheduler: horario XX:00 — cria
 *    AppointmentConfirmation pendente para agendamentos em 24-25h
 *  - AppointmentConfirmationDispatcher: horario XX:05 — envia via
 *    Evolution API as confirmacoes pendentes (sent_at IS NULL)
 */
@Module({
  imports: [PrismaModule, SettingsModule],
  providers: [
    ReturnAlertExpiratorService,
    GoalsRecalculatorService,
    AppointmentConfirmationSchedulerService,
    AppointmentConfirmationDispatcherService,
  ],
})
export class AutomationModule {}
