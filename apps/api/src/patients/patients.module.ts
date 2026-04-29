import { Module, forwardRef } from '@nestjs/common';
import { PatientsService } from './patients.service';
import { PatientsController } from './patients.controller';
import { FileStorageService } from '../media/filesystem.service';
import { ReferralsModule } from '../referrals/referrals.module';

@Module({
  imports: [forwardRef(() => ReferralsModule)],
  controllers: [PatientsController],
  providers: [PatientsService, FileStorageService],
  exports: [PatientsService],
})
export class PatientsModule {}
