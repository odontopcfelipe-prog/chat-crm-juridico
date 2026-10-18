import { Module } from '@nestjs/common';
import { CommissionsController } from './commissions.controller';
import { MyCommissionsController } from './my-commissions.controller';
// Out/2026 — "Meu jogo" do profissional (pontos/metas/missões, sem R$).
import { MyGameController } from './my-game.controller';
import { CommissionRulesService } from './commission-rules.service';
import { CommissionsService } from './commissions.service';
import { GoalsService } from './goals.service';

@Module({
  controllers: [CommissionsController, MyCommissionsController, MyGameController],
  providers: [CommissionRulesService, CommissionsService, GoalsService],
  exports: [CommissionRulesService, CommissionsService, GoalsService],
})
export class CommissionsModule {}
