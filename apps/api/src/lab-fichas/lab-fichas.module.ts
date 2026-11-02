import { Module } from '@nestjs/common';
import { LabFichasController } from './lab-fichas.controller';
import { LabFichasService } from './lab-fichas.service';

/**
 * F8 do laboratório — módulo FOLHA: sem imports e sem exports. Só usa o
 * PrismaService (módulo @Global), então não fecha ciclo de DI com ninguém.
 * Nenhum outro módulo injeta o LabFichasService: quem precisa do caso no PDF usa
 * a função pura lerCasoParaPdf (caso-do-orcamento.ts).
 */
@Module({
  controllers: [LabFichasController],
  providers: [LabFichasService],
})
export class LabFichasModule {}
