import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { ReativacaoPlanejadorService } from './reativacao-planejador.service';
import { ReativacaoRedatorService } from './reativacao-redator.service';
import { ReativacaoDespachanteService } from './reativacao-despachante.service';

/**
 * Régua de REATIVAÇÃO de leads (follow-up do chip COMERCIAL) — worker.
 *
 *   - Planejador (30/30 min): coloca na régua quem está parado numa coluna ligada.
 *   - Redator (15/15 min): a IA escreve o texto de cada toque das próximas 24h.
 *   - Despachante (1/1 min): envia pelo chip Comercial, com marca-passo por chip.
 *
 * Liga/desliga por clínica na Central de Disparos (catálogo em
 * packages/shared/src/reativacao-leads.ts). Importa SÓ Prisma e Settings (como o
 * WorkerMaintenanceModule): nada de módulos de IA/fila — sem risco de ciclo de DI.
 * NÃO confundir com o AiReactivationCronService (religa o ai_mode — outra coisa).
 */
@Module({
  imports: [PrismaModule, SettingsModule],
  providers: [ReativacaoPlanejadorService, ReativacaoRedatorService, ReativacaoDespachanteService],
})
export class ReativacaoLeadsModule {}
