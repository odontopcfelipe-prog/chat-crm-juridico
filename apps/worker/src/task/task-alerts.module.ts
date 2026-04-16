import { Module } from '@nestjs/common';
import { TaskAlertsCronService } from './task-alerts-cron.service';

@Module({
  providers: [TaskAlertsCronService],
})
export class TaskAlertsModule {}
