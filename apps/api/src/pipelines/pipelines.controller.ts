import { Body, Controller, Delete, Get, Param, Patch, Post, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PipelinesService } from './pipelines.service';

@UseGuards(JwtAuthGuard)
@Controller('pipelines')
export class PipelinesController {
  constructor(private readonly svc: PipelinesService) {}

  @Get()
  findAll(@Request() req: any) {
    return this.svc.findAll(req.user?.tenant_id);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: any) {
    return this.svc.findOne(id, req.user?.tenant_id);
  }

  @Post()
  @Roles('ADMIN')
  create(
    @Body()
    data: {
      name: string;
      slug: string;
      description?: string | null;
      color?: string | null;
      is_default?: boolean;
      position?: number;
    },
    @Request() req: any,
  ) {
    return this.svc.create({ ...data, tenant_id: req.user?.tenant_id });
  }

  /** Cria pipeline + stages numa transação — usado pelo modal "Novo funil" da UI. */
  @Post('full')
  @Roles('ADMIN')
  createFull(
    @Body()
    data: {
      name: string;
      slug: string;
      description?: string | null;
      color?: string | null;
      is_default?: boolean;
      position?: number;
      stages: Array<{
        name: string;
        slug: string;
        color?: string | null;
        emoji?: string | null;
        description?: string | null;
        position?: number;
        is_initial?: boolean;
        is_won?: boolean;
        is_lost?: boolean;
        auto_actions?: any;
      }>;
    },
    @Request() req: any,
  ) {
    return this.svc.createFull({ ...data, tenant_id: req.user?.tenant_id });
  }

  @Get('templates')
  listTemplates() {
    return this.svc.listTemplates();
  }

  @Post('from-template/:key')
  @Roles('ADMIN')
  createFromTemplate(
    @Param('key') key: string,
    @Body() overrides: { name?: string; slug?: string; is_default?: boolean },
    @Request() req: any,
  ) {
    return this.svc.createFromTemplate(key, { ...overrides, tenant_id: req.user?.tenant_id });
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(
    @Param('id') id: string,
    @Body()
    data: {
      name?: string;
      slug?: string;
      description?: string | null;
      color?: string | null;
      is_default?: boolean;
      is_active?: boolean;
      position?: number;
    },
    @Request() req: any,
  ) {
    return this.svc.update(id, data, req.user?.tenant_id);
  }

  @Delete(':id')
  @Roles('ADMIN')
  remove(@Param('id') id: string, @Request() req: any) {
    return this.svc.remove(id, req.user?.tenant_id);
  }

  // ─── Stages ───────────────────────────────────────────

  @Post(':id/stages')
  @Roles('ADMIN')
  createStage(
    @Param('id') pipelineId: string,
    @Body()
    data: {
      name: string;
      slug: string;
      color?: string | null;
      emoji?: string | null;
      description?: string | null;
      position?: number;
      is_initial?: boolean;
      is_won?: boolean;
      is_lost?: boolean;
      auto_actions?: any;
    },
    @Request() req: any,
  ) {
    return this.svc.createStage(pipelineId, data, req.user?.tenant_id);
  }

  @Patch(':id/stages/reorder')
  @Roles('ADMIN')
  reorderStages(
    @Param('id') pipelineId: string,
    @Body('items') items: Array<{ id: string; position: number }>,
    @Request() req: any,
  ) {
    return this.svc.reorderStages(pipelineId, items, req.user?.tenant_id);
  }

  @Patch(':id/stages/:stageId')
  @Roles('ADMIN')
  updateStage(
    @Param('id') pipelineId: string,
    @Param('stageId') stageId: string,
    @Body()
    data: {
      name?: string;
      slug?: string;
      color?: string | null;
      emoji?: string | null;
      description?: string | null;
      position?: number;
      is_initial?: boolean;
      is_won?: boolean;
      is_lost?: boolean;
      auto_actions?: any;
    },
    @Request() req: any,
  ) {
    return this.svc.updateStage(pipelineId, stageId, data, req.user?.tenant_id);
  }

  @Delete(':id/stages/:stageId')
  @Roles('ADMIN')
  removeStage(
    @Param('id') pipelineId: string,
    @Param('stageId') stageId: string,
    @Request() req: any,
  ) {
    return this.svc.removeStage(pipelineId, stageId, req.user?.tenant_id);
  }
}
