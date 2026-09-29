import { Module } from '@nestjs/common';
import { PayablesController } from './payables.controller';
import { PayablesService } from './payables.service';
import { FinanceiroModule } from '../financeiro/financeiro.module';
import { CaixaModule } from '../caixa/caixa.module';

/**
 * Contas a Pagar. Reusa o FinanceiroService (CRUD/summary de DESPESA) e o
 * CaixaService (conciliação: gasto/pagamento em dinheiro entra no fechamento
 * do dia) — ambos exportados pelos seus módulos.
 */
@Module({
  imports: [FinanceiroModule, CaixaModule],
  controllers: [PayablesController],
  providers: [PayablesService],
})
export class PayablesModule {}
