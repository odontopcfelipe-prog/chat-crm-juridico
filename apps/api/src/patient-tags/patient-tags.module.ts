import { Module } from '@nestjs/common';
import { PatientTagsService } from './patient-tags.service';
import { PatientTagsController } from './patient-tags.controller';

@Module({
  controllers: [PatientTagsController],
  providers: [PatientTagsService],
  exports: [PatientTagsService],
})
export class PatientTagsModule {}
