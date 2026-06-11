import { Global, Module } from '@nestjs/common';
import { EmailAutomationService } from './email-automation.service';
import { EmailAutomationController } from './email-automation.controller';
import { PrismaModule } from '../prisma/prisma.module';

/**
 * Onda 17.32.181 — Global pros gatilhos (payment-gateway, calendar)
 * injetarem o EmailAutomationService sem importar o modulo.
 */
@Global()
@Module({
  imports: [PrismaModule],
  controllers: [EmailAutomationController],
  providers: [EmailAutomationService],
  exports: [EmailAutomationService],
})
export class EmailAutomationModule {}
