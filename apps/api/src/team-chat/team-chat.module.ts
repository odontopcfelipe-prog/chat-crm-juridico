import { Module } from '@nestjs/common';
import { TeamChatService } from './team-chat.service';
import { TeamChatController } from './team-chat.controller';

// Conversa da equipe. PrismaModule e GatewayModule são globais — não precisa importar.
@Module({
  controllers: [TeamChatController],
  providers: [TeamChatService],
})
export class TeamChatModule {}
