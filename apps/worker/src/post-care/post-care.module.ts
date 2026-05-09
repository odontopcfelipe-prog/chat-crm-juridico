import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { PostCareCronService } from './post-care-cron.service';

@Module({
  imports: [PrismaModule, SettingsModule],
  providers: [PostCareCronService],
})
export class PostCareModule {}
