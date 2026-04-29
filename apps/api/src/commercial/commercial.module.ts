import { Module, forwardRef } from '@nestjs/common';
import { QuotesService } from './quotes.service';
import { TreatmentPlansService } from './treatment-plans.service';
import { TreatmentPlanContractService } from './treatment-plan-contract.service';
import { TreatmentPlanBillingService } from './treatment-plan-billing.service';
import { CommercialController } from './commercial.controller';
import { ClicksignModule } from '../clicksign/clicksign.module';
import { PaymentGatewayModule } from '../payment-gateway/payment-gateway.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { PortalModule } from '../portal/portal.module';

@Module({
  imports: [
    ClicksignModule,
    PaymentGatewayModule,
    forwardRef(() => ReferralsModule),
    // Onda 1 do modulo de orcamentos (Fase 24)
    forwardRef(() => WhatsappModule),
    PortalModule,
  ],
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
