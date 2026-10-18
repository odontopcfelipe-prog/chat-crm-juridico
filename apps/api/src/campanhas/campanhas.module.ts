import { Module } from '@nestjs/common';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { MediaModule } from '../media/media.module';
import { CampanhasController } from './campanhas.controller';
import { CampanhasService } from './campanhas.service';
import { CampanhasEnvioService } from './campanhas-envio.service';

/**
 * Campanha manual (Central de Disparos › setor › "Campanha manual"): rascunho, público por
 * filtro, fotos/áudio, teste, iniciar/agendar e o motor de envio no ritmo seguro.
 * Tabelas próprias (ManualCampaign*); não toca nos disparos automáticos.
 */
@Module({
  imports: [WhatsappModule, MediaModule],
  controllers: [CampanhasController],
  providers: [CampanhasService, CampanhasEnvioService],
})
export class CampanhasModule {}
