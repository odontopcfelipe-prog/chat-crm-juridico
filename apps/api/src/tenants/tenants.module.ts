import { Module } from '@nestjs/common';
import { TenantsController, TenantsMeController, SignupController } from './tenants.controller';
import { TenantsService } from './tenants.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [TenantsController, TenantsMeController, SignupController],
  providers: [TenantsService],
  exports: [TenantsService],
})
export class TenantsModule {}
