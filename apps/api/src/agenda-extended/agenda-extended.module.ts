import { Module } from '@nestjs/common';
import { AgendaExtendedController } from './agenda-extended.controller';
import { RoomsService } from './rooms.service';
import { MarkersService } from './markers.service';
import { ConfirmationsService } from './confirmations.service';
import { ReturnAlertsService } from './return-alerts.service';

@Module({
  controllers: [AgendaExtendedController],
  providers: [RoomsService, MarkersService, ConfirmationsService, ReturnAlertsService],
  exports: [RoomsService, MarkersService, ConfirmationsService, ReturnAlertsService],
})
export class AgendaExtendedModule {}
