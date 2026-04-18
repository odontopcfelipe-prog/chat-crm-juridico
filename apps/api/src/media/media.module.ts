import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MediaController } from './media.controller';
import { MediaS3Service } from './s3.service';
import { FileStorageService } from './filesystem.service';
import { MediaEventsService } from './media-events.service';
import { AiEventsService } from './ai-events.service';
import { MediaDownloadService } from './media-download.service';
import { GoogleDriveModule } from '../google-drive/google-drive.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'media-jobs',
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
    forwardRef(() => GoogleDriveModule),
    SettingsModule,
  ],
  controllers: [MediaController],
  providers: [MediaS3Service, FileStorageService, MediaEventsService, AiEventsService, MediaDownloadService],
  exports: [MediaS3Service, FileStorageService, MediaDownloadService],
})
export class MediaModule {}
