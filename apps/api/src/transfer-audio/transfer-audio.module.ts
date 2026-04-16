import { Module } from '@nestjs/common';
import { TransferAudioController } from './transfer-audio.controller';
import { TransferAudioService } from './transfer-audio.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MediaModule } from '../media/media.module';

@Module({
  imports: [PrismaModule, MediaModule],
  controllers: [TransferAudioController],
  providers: [TransferAudioService],
  exports: [TransferAudioService],
})
export class TransferAudioModule {}
