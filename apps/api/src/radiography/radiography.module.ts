import { Module } from '@nestjs/common';
import { RadiographyController } from './radiography.controller';
import { RadiographyService } from './radiography.service';
import { S3Module } from '../s3/s3.module';

@Module({
  imports: [S3Module],
  controllers: [RadiographyController],
  providers: [RadiographyService],
  exports: [RadiographyService],
})
export class RadiographyModule {}
