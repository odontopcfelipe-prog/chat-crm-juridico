import { Module } from '@nestjs/common';
import { PostCareService } from './post-care.service';
import { PostCareController } from './post-care.controller';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [SettingsModule],
  controllers: [PostCareController],
  providers: [PostCareService],
  exports: [PostCareService],
})
export class PostCareModule {}
