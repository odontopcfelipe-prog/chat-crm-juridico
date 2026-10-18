import { Module } from '@nestjs/common';
import { DisparoAnexosController } from './disparo-anexos.controller';

/**
 * Anexos (fotos/áudio) dos disparos automáticos da Central. Só o controller (CRUD); o
 * envio são funções simples em disparo-anexos-envio.ts chamadas por quem já manda o texto
 * — sem injeção entre módulos (não cria ciclo). PrismaService vem do módulo global.
 */
@Module({
  controllers: [DisparoAnexosController],
})
export class DisparoAnexosModule {}
