import { Module } from '@nestjs/common';
import { PassosCadController } from './passos-cad.controller';
import { PassosCadService } from './passos-cad.service';

@Module({
  controllers: [PassosCadController],
  providers: [PassosCadService],
})
export class PassosCadModule {}
