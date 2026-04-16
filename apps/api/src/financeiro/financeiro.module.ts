import { Module } from '@nestjs/common';
import { FinanceiroService } from './financeiro.service';
import { TaxService } from './tax.service';
import { FinanceiroController } from './financeiro.controller';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  imports: [GatewayModule],
  controllers: [FinanceiroController],
  providers: [FinanceiroService, TaxService],
  exports: [FinanceiroService, TaxService],
})
export class FinanceiroModule {}
