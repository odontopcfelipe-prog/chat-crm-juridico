import { Module } from '@nestjs/common';
import { DiskSentinelService } from './disk-sentinel.service';

/**
 * Vigias de operação do servidor. Só lê e avisa (Prisma e MailService são
 * globais) — não importa módulo de domínio nenhum, então não cria ciclo de DI.
 */
@Module({
  providers: [DiskSentinelService],
})
export class OpsModule {}
