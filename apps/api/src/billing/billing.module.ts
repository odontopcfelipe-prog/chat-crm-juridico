import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { AssinaturaDoLaboratorioService } from './assinatura-do-laboratorio.service';
import { ContaDaPlataformaController } from './conta-da-plataforma.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentGatewayModule } from '../payment-gateway/payment-gateway.module';

@Module({
  imports: [PrismaModule, PaymentGatewayModule],
  controllers: [BillingController, ContaDaPlataformaController],
  providers: [BillingService, AssinaturaDoLaboratorioService],
  exports: [BillingService],
})
export class BillingModule {}
