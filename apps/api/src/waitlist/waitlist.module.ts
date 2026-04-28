import { Module, forwardRef } from '@nestjs/common';
import { WaitlistController } from './waitlist.controller';
import { WaitlistService } from './waitlist.service';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [forwardRef(() => WhatsappModule)],
  controllers: [WaitlistController],
  providers: [WaitlistService],
  exports: [WaitlistService], // exportado pra worker poder usar findMatchesForSlot
})
export class WaitlistModule {}
