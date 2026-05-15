import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { InfluencerMessagesCronService } from './influencer-messages-cron.service';

/**
 * Worker InfluencerMessagesModule.
 * Cron a cada minuto que dispara mensagens agendadas via Evolution API.
 */
@Module({
  imports: [PrismaModule, SettingsModule],
  providers: [InfluencerMessagesCronService],
})
export class InfluencerMessagesModule {}
