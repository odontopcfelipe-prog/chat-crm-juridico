import { Module } from '@nestjs/common';
import { PetitionsController } from './petitions.controller';
import { PetitionsService } from './petitions.service';
import { PetitionAiService } from './petition-ai.service';
import { PetitionChatService } from './petition-chat.service';
import { GoogleDriveModule } from '../google-drive/google-drive.module';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  imports: [GoogleDriveModule, GatewayModule],
  controllers: [PetitionsController],
  providers: [PetitionsService, PetitionAiService, PetitionChatService],
  exports: [PetitionsService],
})
export class PetitionsModule {}
