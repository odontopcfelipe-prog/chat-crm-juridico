import { Module } from '@nestjs/common';
import { ReactivationController } from './reactivation.controller';
import { ReactivationService } from './reactivation.service';

/**
 * Régua de reativação de leads (follow-up do chip COMERCIAL) — painel e config.
 * Depende SÓ do Prisma (@Global): o envio é do worker. Não importar WhatsApp/
 * Conversations/Leads aqui — ciclo de DI já derrubou a API (out/2026).
 */
@Module({
  controllers: [ReactivationController],
  providers: [ReactivationService],
})
export class ReactivationModule {}
