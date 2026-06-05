import { Module } from '@nestjs/common';
import { TenantsController, TenantsMeController } from './tenants.controller';
import { TenantsService } from './tenants.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [TenantsController, TenantsMeController],
  providers: [TenantsService],
  exports: [TenantsService],
})
export class TenantsModule {}
