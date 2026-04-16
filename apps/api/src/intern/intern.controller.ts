import { Controller, Get, UseGuards, Request } from '@nestjs/common';
import { InternService } from './intern.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('intern')
export class InternController {
  constructor(private readonly internService: InternService) {}

  @Get('dashboard')
  getDashboard(@Request() req: any) {
    return this.internService.getDashboard(req.user.id, req.user?.tenant_id);
  }

  @Get('kanban')
  getKanban(@Request() req: any) {
    return this.internService.getKanbanDashboard(req.user.id, req.user?.tenant_id);
  }

  /** GET /intern/badge-count — count de petições pendentes (para badge na sidebar) */
  @Get('badge-count')
  getBadgeCount(@Request() req: any) {
    return this.internService.getBadgeCount(req.user.id);
  }
}
