import { Module } from '@nestjs/common';
import { EstheticApplicationsController } from './esthetic-applications.controller';
import { EstheticApplicationsService } from './esthetic-applications.service';

@Module({
  controllers: [EstheticApplicationsController],
  providers: [EstheticApplicationsService],
  exports: [EstheticApplicationsService],
})
export class EstheticModule {}
