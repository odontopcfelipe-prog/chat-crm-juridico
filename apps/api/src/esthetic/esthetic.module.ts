import { Module } from '@nestjs/common';
import { EstheticApplicationsController } from './esthetic-applications.controller';
import { EstheticApplicationsService } from './esthetic-applications.service';
import { MaintenanceModule } from '../maintenance/maintenance.module';

@Module({
  // Onda 5 (Fase 25) — depende de MaintenanceModule pra auto-criar tasks
  imports: [MaintenanceModule],
  controllers: [EstheticApplicationsController],
  providers: [EstheticApplicationsService],
  exports: [EstheticApplicationsService],
})
export class EstheticModule {}
