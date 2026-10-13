import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { AdminAgendamentoAlertService } from './admin-agendamento-alert.service';

/**
 * Avisos internos aos ADMs (worker).
 *   - Novo agendamento (IA / equipe) → número de aviso dos ADMs (1/1 min).
 *
 * O envio é o helper PURO ./admin-alert (sendAdminAlert/adminAlertPhones), que
 * outros módulos (ex.: ai.processor) importam direto — sem injetar este módulo.
 * Importa SÓ Prisma e Settings: sem módulos de IA/fila, sem risco de ciclo de DI.
 */
@Module({
  imports: [PrismaModule, SettingsModule],
  providers: [AdminAgendamentoAlertService],
})
export class AdminAlertsModule {}
