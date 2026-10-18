import { Module } from '@nestjs/common';
import { SmileDesignController } from './smile-design.controller';
import { SmileDesignService } from './smile-design.service';
import { S3Module } from '../s3/s3.module';
import { FileStorageService } from '../media/filesystem.service';

// Fotos novas vão pro disco da API (volume crm_media, mesmo das fotos de
// paciente); o S3 fica só pra ler simulações antigas.
@Module({
  imports: [S3Module],
  controllers: [SmileDesignController],
  providers: [SmileDesignService, FileStorageService],
  exports: [SmileDesignService],
})
export class SmileDesignModule {}
