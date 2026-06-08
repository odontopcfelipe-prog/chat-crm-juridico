import { Module } from '@nestjs/common';
import { HomeHighlightsController } from './home-highlights.controller.js';
import { HomeHighlightsService } from './home-highlights.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';

@Module({
  imports: [PrismaModule],
  controllers: [HomeHighlightsController],
  providers: [HomeHighlightsService],
})
export class HomeModule {}
