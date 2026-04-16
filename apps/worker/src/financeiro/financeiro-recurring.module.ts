import { Module } from '@nestjs/common';
import { RecurringExpensesService } from './recurring-expenses.service';
import { OverdueAlertsService } from './overdue-alerts.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [RecurringExpensesService, OverdueAlertsService],
})
export class FinanceiroRecurringModule {}
