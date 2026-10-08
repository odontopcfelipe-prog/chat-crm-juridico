import { Module, Global, forwardRef } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';
import { AiTestChatService } from './ai-test-chat.service';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Global()
@Module({
  imports: [forwardRef(() => WhatsappModule)],
  providers: [SettingsService, AiTestChatService],
  controllers: [SettingsController],
  exports: [SettingsService],
})
export class SettingsModule {}
