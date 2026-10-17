import { Module } from '@nestjs/common';
import { AgendaExtendedController } from './agenda-extended.controller';
import { RoomsService } from './rooms.service';
import { MarkersService } from './markers.service';
import { ConfirmationsService } from './confirmations.service';
import { ReturnAlertsService } from './return-alerts.service';
import { RetornoDisparosService } from './retorno-disparos.service';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  // WhatsappModule: envio dos disparos de retorno (RetornoDisparosService).
  imports: [WhatsappModule],
  controllers: [AgendaExtendedController],
  providers: [RoomsService, MarkersService, ConfirmationsService, ReturnAlertsService, RetornoDisparosService],
  exports: [RoomsService, MarkersService, ConfirmationsService, ReturnAlertsService],
})
export class AgendaExtendedModule {}
