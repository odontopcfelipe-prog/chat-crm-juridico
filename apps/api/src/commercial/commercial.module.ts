import { Module } from '@nestjs/common';
import { QuotesService } from './quotes.service';
import { TreatmentPlansService } from './treatment-plans.service';
import { CommercialController } from './commercial.controller';

@Module({
  controllers: [CommercialController],
  providers: [QuotesService, TreatmentPlansService],
  exports: [QuotesService, TreatmentPlansService],
})
export class CommercialModule {}
