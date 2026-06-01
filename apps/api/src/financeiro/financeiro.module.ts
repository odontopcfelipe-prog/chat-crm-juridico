import { Module } from '@nestjs/common';
import { FinanceiroService } from './financeiro.service';
import { FinanceiroChargesService } from './financeiro-charges.service';
import { FinanceiroController } from './financeiro.controller';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  imports: [GatewayModule],
  controllers: [FinanceiroController],
  providers: [FinanceiroService, FinanceiroChargesService],
  exports: [FinanceiroService],
})
export class FinanceiroModule {}
