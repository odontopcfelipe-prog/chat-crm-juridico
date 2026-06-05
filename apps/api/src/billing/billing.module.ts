import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentGatewayModule } from '../payment-gateway/payment-gateway.module';

@Module({
  imports: [PrismaModule, PaymentGatewayModule],
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
