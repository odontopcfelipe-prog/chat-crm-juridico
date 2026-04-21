import { Module } from '@nestjs/common';
import { QuotesService } from './quotes.service';
import { TreatmentPlansService } from './treatment-plans.service';
import { TreatmentPlanContractService } from './treatment-plan-contract.service';
import { CommercialController } from './commercial.controller';
import { ClicksignModule } from '../clicksign/clicksign.module';

@Module({
  imports: [ClicksignModule],
  controllers: [CommercialController],
  providers: [QuotesService, TreatmentPlansService, TreatmentPlanContractService],
  exports: [QuotesService, TreatmentPlansService, TreatmentPlanContractService],
})
export class CommercialModule {}
