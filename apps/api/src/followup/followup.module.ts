import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { FollowupController } from './followup.controller';
import { FollowupService } from './followup.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({ name: 'followup-jobs' }),
  ],
  controllers: [FollowupController],
  providers: [FollowupService],
  exports: [FollowupService],
})
export class FollowupModule {}
