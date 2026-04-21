import { Module } from '@nestjs/common';
import { AdverseReactionsController } from './adverse-reactions.controller';
import { AdverseReactionsService } from './adverse-reactions.service';

@Module({
  controllers: [AdverseReactionsController],
  providers: [AdverseReactionsService],
  exports: [AdverseReactionsService],
})
export class AdverseReactionsModule {}
