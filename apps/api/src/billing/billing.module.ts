import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { AssinaturaDoLaboratorioService } from './assinatura-do-laboratorio.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentGatewayModule } from '../payment-gateway/payment-gateway.module';

@Module({
  imports: [PrismaModule, PaymentGatewayModule],
  controllers: [BillingController],
  providers: [BillingService, AssinaturaDoLaboratorioService],
  exports: [BillingService],
})
export class BillingModule {}
