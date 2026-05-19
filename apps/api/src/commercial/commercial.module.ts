import { Module, forwardRef } from '@nestjs/common';
import { QuotesService } from './quotes.service';
import { QuotePdfService } from './quote-pdf.service';
import { QuoteTemplatesService } from './quote-templates.service';
import { QuoteCouponsService } from './quote-coupons.service';
import { QuoteAttachmentsService } from './quote-attachments.service';
import { QuoteVersionsService } from './quote-versions.service';
import { TreatmentPlansService } from './treatment-plans.service';
import { TreatmentPlanContractService } from './treatment-plan-contract.service';
import { TreatmentPlanBillingService } from './treatment-plan-billing.service';
import { CreditCheckService } from './credit-check.service';
import { ContractsService } from './contracts.service';
import { ContractPdfService } from './contract-pdf.service';
import { CommercialController } from './commercial.controller';
import { ClicksignModule } from '../clicksign/clicksign.module';
import { PaymentGatewayModule } from '../payment-gateway/payment-gateway.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { PortalModule } from '../portal/portal.module';
import { MaintenanceModule } from '../maintenance/maintenance.module';
import { LeadsModule } from '../leads/leads.module';
import { FileStorageService } from '../media/filesystem.service';

@Module({
  imports: [
    ClicksignModule,
    PaymentGatewayModule,
    forwardRef(() => ReferralsModule),
    // Onda 1 do modulo de orcamentos (Fase 24)
    forwardRef(() => WhatsappModule),
    PortalModule,
    // Onda 5 (Fase 25) — auto-cria task quando TreatmentPlanItem vira DONE
    MaintenanceModule,
    // Hook Funil 2: ao criar Quote, move Lead vinculado pra "Em Fechamento"
    // (LeadsService resolvido via ModuleRef em QuotesService.advanceLeadToEmFechamento)
    LeadsModule,
  ],
  controllers: [CommercialController],
  providers: [
    QuotesService,
    QuotePdfService,
    QuoteTemplatesService,
    QuoteCouponsService,
    QuoteAttachmentsService,
    QuoteVersionsService,
    TreatmentPlansService,
    TreatmentPlanContractService,
    TreatmentPlanBillingService,
    CreditCheckService,
    ContractsService,
    ContractPdfService,
    FileStorageService,
  ],
  exports: [
    QuotesService,
    QuotePdfService,
    QuoteTemplatesService,
    QuoteCouponsService,
    QuoteAttachmentsService,
    QuoteVersionsService,
    TreatmentPlansService,
    TreatmentPlanContractService,
    TreatmentPlanBillingService,
    CreditCheckService,
    ContractsService,
    ContractPdfService,
  ],
})
export class CommercialModule {}
