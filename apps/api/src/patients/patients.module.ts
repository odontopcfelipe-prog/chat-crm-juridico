import { Module, forwardRef } from '@nestjs/common';
import { PatientsService } from './patients.service';
import { PatientsController } from './patients.controller';
import { FileStorageService } from '../media/filesystem.service';
import { ReferralsModule } from '../referrals/referrals.module';
import { LeadsModule } from '../leads/leads.module';

@Module({
  imports: [
    forwardRef(() => ReferralsModule),
    // Endpoint POST /patients/:id/start-attending precisa de LeadsService
    // pra graduar o lead vinculado pra "Em Fechamento" (Funil 2).
    LeadsModule,
  ],
  controllers: [PatientsController],
  providers: [PatientsService, FileStorageService],
  exports: [PatientsService],
})
export class PatientsModule {}
