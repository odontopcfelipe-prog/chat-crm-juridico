import { Module, forwardRef } from '@nestjs/common';
import { DjenService } from './djen.service';
import { DjenController } from './djen.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { CalendarModule } from '../calendar/calendar.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [PrismaModule, SettingsModule, CalendarModule, forwardRef(() => WhatsappModule)],
  controllers: [DjenController],
  providers: [DjenService],
  exports: [DjenService],
})
export class DjenModule {}
