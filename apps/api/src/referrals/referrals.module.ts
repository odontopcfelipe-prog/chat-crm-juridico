import { Module } from '@nestjs/common';
import { ReferralsService } from './referrals.service';
import { ReferralsController } from './referrals.controller';

@Module({
  controllers: [ReferralsController],
  providers: [ReferralsService],
  exports: [ReferralsService], // PatientsService e TreatmentPlansService precisam acionar hooks
})
export class ReferralsModule {}
