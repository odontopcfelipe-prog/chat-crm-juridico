import { Module } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { ConversationsController } from './conversations.controller';
import { ConversationOwnershipGuard } from './conversation-ownership.guard';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [WhatsappModule],
  controllers: [ConversationsController],
  providers: [ConversationsService, ConversationOwnershipGuard],
  exports: [ConversationsService],
})
export class ConversationsModule {}
