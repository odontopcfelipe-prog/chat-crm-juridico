import { Module } from '@nestjs/common';
import { ProceduresService } from './procedures.service';
import { ProceduresController } from './procedures.controller';
import { FileStorageService } from '../media/filesystem.service';

@Module({
  controllers: [ProceduresController],
  providers: [ProceduresService, FileStorageService],
  exports: [ProceduresService],
})
export class ProceduresModule {}
