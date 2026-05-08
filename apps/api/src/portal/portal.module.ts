import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PortalController } from './portal.controller';
import { PortalAuthService } from './portal-auth.service';
import { PortalService } from './portal.service';
import { PortalJwtGuard } from './portal-jwt.guard';
import { SettingsModule } from '../settings/settings.module';
import { AnamnesisModule } from '../anamnesis/anamnesis.module';

@Module({
  imports: [
    SettingsModule,
    AnamnesisModule,
    // Registra JwtModule local — usa mesmo JWT_SECRET global, mas com
    // expiresIn 30d (sessao do paciente). PortalJwtGuard valida claim
    // kind='patient' para isolar de tokens de funcionario.
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: process.env.JWT_SECRET || '__INSECURE_DEV_FALLBACK_CHANGE_ME__',
        signOptions: { expiresIn: '30d' },
      }),
    }),
  ],
  controllers: [PortalController],
  providers: [PortalAuthService, PortalService, PortalJwtGuard],
  exports: [PortalAuthService],
})
export class PortalModule {}
