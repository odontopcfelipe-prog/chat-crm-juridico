import { Module } from '@nestjs/common';
import { SectorsController } from './sectors.controller.js';
import { SectorsService } from './sectors.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';

@Module({
  imports: [PrismaModule],
  controllers: [SectorsController],
  providers: [SectorsService],
  exports: [SectorsService],
})
export class SectorsModule {}
