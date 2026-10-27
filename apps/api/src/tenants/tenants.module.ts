import { Module } from '@nestjs/common';
import { TenantsController, TenantsMeController, SignupController } from './tenants.controller';
import { TenantsService } from './tenants.service';
import { LabWaitlistController } from './lab-waitlist.controller';
import { LabWaitlistService } from './lab-waitlist.service';
import { CriacaoLaboratorioController } from './criacao-laboratorio.controller';
import { CriacaoLaboratorioService } from './criacao-laboratorio.service';
import { PadroesLaboratorioService } from './padroes-laboratorio.service';
import { PrismaModule } from '../prisma/prisma.module';

// Onda 17.32.106 — ORDEM IMPORTA. TenantsMeController PRECISA vir
// antes do TenantsController. Os dois usam @Controller('tenants'),
// e o TenantsController tem @Get(':id') + @SuperAdmin(). Se ele for
// registrado primeiro, GET /tenants/me da match em /tenants/:id
// (id="me") e bate no SuperAdminGuard -> 403 pra qualquer ADMIN
// comum do tenant. Botando o "Me" antes, o NestJS resolve as rotas
// estaticas (/me, /me/usage) corretamente.
@Module({
  imports: [PrismaModule],
  controllers: [TenantsMeController, TenantsController, SignupController, LabWaitlistController, CriacaoLaboratorioController],
  providers: [TenantsService, LabWaitlistService, CriacaoLaboratorioService, PadroesLaboratorioService],
  exports: [TenantsService],
})
export class TenantsModule {}
