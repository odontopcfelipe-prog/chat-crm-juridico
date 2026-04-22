import { Module } from '@nestjs/common';
import { SmileDesignController } from './smile-design.controller';
import { SmileDesignService } from './smile-design.service';
import { S3Module } from '../s3/s3.module';

@Module({
  imports: [S3Module],
  controllers: [SmileDesignController],
  providers: [SmileDesignService],
  exports: [SmileDesignService],
})
export class SmileDesignModule {}
