import { Module, forwardRef } from '@nestjs/common';
import { QuotesService } from './quotes.service';
import { TreatmentPlansService } from './treatment-plans.service';
import { TreatmentPlanContractService } from './treatment-plan-contract.service';
import { TreatmentPlanBillingService } from './treatment-plan-billing.service';
import { CommercialController } from './commercial.controller';
import { ClicksignModule } from '../clicksign/clicksign.module';
import { PaymentGatewayModule } from '../payment-gateway/payment-gateway.module';
import { ReferralsModule } from '../referrals/referrals.module';

@Module({
  imports: [ClicksignModule, PaymentGatewayModule, forwardRef(() => ReferralsModule)],
  controllers: [CommercialController],
  providers: [
    QuotesService,
    TreatmentPlansService,
    TreatmentPlanContractService,
    TreatmentPlanBillingService,
  ],
  exports: [
    QuotesService,
    TreatmentPlansService,
    TreatmentPlanContractService,
    TreatmentPlanBillingService,
  ],
})
export class CommercialModule {}
