import { Module } from '@nestjs/common';
import { GlobalAnamnesisController } from './global-anamnesis.controller.js';
import { GlobalAnamnesisService } from './global-anamnesis.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';

@Module({
  imports: [PrismaModule],
  controllers: [GlobalAnamnesisController],
  providers: [GlobalAnamnesisService],
})
export class GlobalAnamnesisModule {}
