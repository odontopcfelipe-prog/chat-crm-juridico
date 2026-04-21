import { Module } from '@nestjs/common';
import { ReturnAlertExpiratorService } from './return-alert-expirator.service';
import { GoalsRecalculatorService } from './goals-recalculator.service';
import { AppointmentConfirmationSchedulerService } from './appointment-confirmation-scheduler.service';
import { PrismaModule } from '../prisma/prisma.module';

/**
 * Modulo de automacoes cron — Fase 10.
 *
 * Cron jobs:
 *  - ReturnAlertExpirator: diario 03:00 — expira ReturnAlert antigos
 *  - GoalsRecalculator: horario — atualiza current/projected_value de Goals
 *  - AppointmentConfirmationScheduler: horario — cria AppointmentConfirmation
 *    pendente para agendamentos em 24-25h
 */
@Module({
  imports: [PrismaModule],
  providers: [
    ReturnAlertExpiratorService,
    GoalsRecalculatorService,
    AppointmentConfirmationSchedulerService,
  ],
})
export class AutomationModule {}
