import { Module, forwardRef } from '@nestjs/common';
import { HonorariosController } from './honorarios.controller';
import { HonorariosService } from './honorarios.service';
import { FinanceiroModule } from '../financeiro/financeiro.module';

@Module({
  imports: [forwardRef(() => FinanceiroModule)],
  controllers: [HonorariosController],
  providers: [HonorariosService],
  exports: [HonorariosService],
})
export class HonorariosModule {}
