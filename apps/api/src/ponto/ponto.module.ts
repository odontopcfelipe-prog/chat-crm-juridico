import { Module } from '@nestjs/common';
import { PontoService } from './ponto.service';
import { PontoController } from './ponto.controller';

// Relógio de ponto. PrismaModule é global — não precisa importar aqui.
@Module({
  controllers: [PontoController],
  providers: [PontoService],
})
export class PontoModule {}
