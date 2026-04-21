import { Module } from '@nestjs/common';
import { CommissionsController } from './commissions.controller';
import { CommissionRulesService } from './commission-rules.service';
import { CommissionsService } from './commissions.service';
import { GoalsService } from './goals.service';

@Module({
  controllers: [CommissionsController],
  providers: [CommissionRulesService, CommissionsService, GoalsService],
  exports: [CommissionRulesService, CommissionsService, GoalsService],
})
export class CommissionsModule {}
