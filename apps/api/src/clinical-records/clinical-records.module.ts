import { Module } from '@nestjs/common';
import { MedicalRecordsService } from './medical-records.service';
import { ClinicalNotesService } from './clinical-notes.service';
import { ClinicalRecordsController } from './clinical-records.controller';

@Module({
  controllers: [ClinicalRecordsController],
  providers: [MedicalRecordsService, ClinicalNotesService],
  exports: [MedicalRecordsService, ClinicalNotesService],
})
export class ClinicalRecordsModule {}
