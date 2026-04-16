import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MediaProcessor } from './media.processor';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'media-jobs',
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential' as const, delay: 2000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 200 },
      },
    }),
  ],
  providers: [MediaProcessor],
})
export class MediaModule {}
