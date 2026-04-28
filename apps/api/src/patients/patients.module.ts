import { Module } from '@nestjs/common';
import { PatientsService } from './patients.service';
import { PatientsController } from './patients.controller';
import { FileStorageService } from '../media/filesystem.service';

@Module({
  controllers: [PatientsController],
  providers: [PatientsService, FileStorageService],
  exports: [PatientsService],
})
export class PatientsModule {}
