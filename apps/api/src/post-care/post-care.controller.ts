import {
  Controller, Get, Patch, Post, Body, Query, UseGuards, BadRequestException, Request,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PostCareService } from './post-care.service';
import { PostCareConfig, INITIAL_CHOICES, DEFAULT_TEMPLATES } from './post-care-templates';

@UseGuards(JwtAuthGuard)
@Controller('post-care')
export class PostCareController {
  constructor(private readonly service: PostCareService) {}

  @Get('surveys')
  list(
    @Request() req: any,
    @Query('status') status?: string,
    @Query('sentiment') sentiment?: string,
    @Query('dentist_id') dentistId?: string,
    @Query('days') days?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    let from: Date | undefined;
    if (days) {
      const n = parseInt(days, 10);
      if (n > 0 && n <= 365) {
        from = new Date();
        from.setDate(from.getDate() - n);
      }
    }
    return this.service.listSurveys(tenantId, {
      status, sentiment, dentist_id: dentistId, from,
    });
  }

  @Get('stats')
  stats(@Request() req: any, @Query('days') days?: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const n = days ? parseInt(days, 10) : 30;
    return this.service.getStats(tenantId, n > 0 && n <= 365 ? n : 30);
  }

  /** Config da CONTA do usuário (com a herança da global antiga para conta legada). */
  @Get('config')
  getConfig(@Request() req: any) {
    return this.service.getConfig(req.user?.tenant_id).then((cfg) => ({
      ...cfg,
      // expoe as opcoes pra UI sem precisar do front conhecer
      _meta: {
        choices: INITIAL_CHOICES,
        defaults: DEFAULT_TEMPLATES,
      },
    }));
  }

  /**
   * Grava na chave da CONTA do usuário (nunca na global antiga). Sem classe/DTO de
   * propósito: a tela manda o objeto inteiro do GET; o service escolhe os 8 campos
   * e ignora o resto.
   */
  @Patch('config')
  @Roles('ADMIN')
  updateConfig(@Request() req: any, @Body() patch: Partial<PostCareConfig>) {
    return this.service.updateConfig(req.user?.tenant_id, patch);
  }

  /** Gatilho manual — util pra testar sem esperar 2h. Só consulta da própria conta. */
  @Post('test-send')
  @Roles('ADMIN')
  testSend(@Request() req: any, @Body() body: { appointment_id: string }) {
    if (!body?.appointment_id) throw new BadRequestException('appointment_id obrigatorio');
    const tenantId = req.user?.tenant_id;
    const isSuper = Array.isArray(req.user?.roles) && req.user.roles.includes('SUPER_ADMIN');
    if (!tenantId && !isSuper) throw new BadRequestException('tenant_id ausente');
    return this.service.ensureSurveyForAppointment(body.appointment_id, undefined, tenantId);
  }
}
