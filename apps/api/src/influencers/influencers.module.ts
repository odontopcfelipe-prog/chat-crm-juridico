import { Module } from '@nestjs/common';
import { InfluencersService } from './influencers.service';
import { InfluencersController } from './influencers.controller';
import { InfluencerTemplatesService } from './influencer-templates.service';
import { InfluencerTemplatesController } from './influencer-templates.controller';
import { InfluencerSchedulesService } from './influencer-schedules.service';
import { InfluencerSchedulesController } from './influencer-schedules.controller';
import { InfluencerMessagesService } from './influencer-messages.service';
import { InfluencerMessagesController } from './influencer-messages.controller';

@Module({
  controllers: [
    InfluencersController,
    InfluencerTemplatesController,
    InfluencerSchedulesController,
    InfluencerMessagesController,
  ],
  providers: [
    InfluencersService,
    InfluencerTemplatesService,
    InfluencerSchedulesService,
    InfluencerMessagesService,
  ],
  exports: [
    InfluencersService,
    InfluencerTemplatesService,
    InfluencerSchedulesService,
  ],
})
export class InfluencersModule {}
