import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { PrismaModule } from '../../prisma/prisma.module';

/**
 * Onda 17.32.179 — Modulo global de e-mail: MailService injetavel em
 * qualquer lugar sem precisar importar o modulo (auth, users, tenants,
 * calendar...). SettingsService ja vem do SettingsModule @Global.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
