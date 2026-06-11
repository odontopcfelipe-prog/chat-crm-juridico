import { Module, forwardRef } from '@nestjs/common';
import { PatientsService } from './patients.service';
import { PatientsController } from './patients.controller';
import { AffiliateService } from './affiliate.service';
import { FileStorageService } from '../media/filesystem.service';
import { ReferralsModule } from '../referrals/referrals.module';
import { LeadsModule } from '../leads/leads.module';
import { PatientTagsModule } from '../patient-tags/patient-tags.module';

@Module({
  imports: [
    forwardRef(() => ReferralsModule),
    // Endpoint POST /patients/:id/start-attending precisa de LeadsService
    // pra graduar o lead vinculado pra "Em Fechamento" (Funil 2).
    LeadsModule,
    // Onda 17.33 — aplicar etiquetas ja na criacao do paciente
    PatientTagsModule,
  ],
  controllers: [PatientsController],
  providers: [PatientsService, FileStorageService, AffiliateService],
  exports: [PatientsService, AffiliateService],
})
export class PatientsModule {}
