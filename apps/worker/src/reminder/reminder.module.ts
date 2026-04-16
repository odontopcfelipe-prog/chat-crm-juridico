import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ReminderProcessor } from './reminder.processor';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'calendar-reminders',
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential' as const, delay: 2000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 200 },
      },
    }),
  ],
  providers: [ReminderProcessor],
})
export class ReminderModule {}
