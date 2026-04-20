import { Module } from '@nestjs/common';
import { AnamnesisService } from './anamnesis.service';
import { AnamnesisTemplatesService } from './anamnesis-templates.service';
import { AnamnesisController } from './anamnesis.controller';

@Module({
  controllers: [AnamnesisController],
  providers: [AnamnesisService, AnamnesisTemplatesService],
  exports: [AnamnesisService, AnamnesisTemplatesService],
})
export class AnamnesisModule {}
