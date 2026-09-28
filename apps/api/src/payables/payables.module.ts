import { Module } from '@nestjs/common';
import { PayablesController } from './payables.controller';
import { PayablesService } from './payables.service';
import { FinanceiroModule } from '../financeiro/financeiro.module';

/**
 * Contas a Pagar. Reusa o FinanceiroService (exportado por FinanceiroModule)
 * pros CRUD/summary de DESPESA e adiciona o gerador de parcelamento exato.
 */
@Module({
  imports: [FinanceiroModule],
  controllers: [PayablesController],
  providers: [PayablesService],
})
export class PayablesModule {}
