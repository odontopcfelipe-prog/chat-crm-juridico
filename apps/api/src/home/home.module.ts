import { Module } from '@nestjs/common';
import { HomeHighlightsController } from './home-highlights.controller.js';
import { HomeHighlightsService } from './home-highlights.service.js';
import { HomePreviewService } from './home-preview.service.js';
import { HomeModuleBadgesService } from './home-module-badges.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';

@Module({
  imports: [PrismaModule],
  controllers: [HomeHighlightsController],
  providers: [HomeHighlightsService, HomePreviewService, HomeModuleBadgesService],
})
export class HomeModule {}
