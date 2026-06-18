import { Module } from '@nestjs/common';
import { HomeHighlightsController } from './home-highlights.controller.js';
import { HomeHighlightsService } from './home-highlights.service.js';
import { HomePreviewService } from './home-preview.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';

@Module({
  imports: [PrismaModule],
  controllers: [HomeHighlightsController],
  providers: [HomeHighlightsService, HomePreviewService],
})
export class HomeModule {}
