import {
  Controller, Get, Post, Body, Param, Headers, Request, UseGuards, BadRequestException, Res,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Public } from '../auth/decorators/public.decorator';
import { RadiographyService } from './radiography.service';
import { S3Service } from '../s3/s3.service';
import { WebhookPayloadDto, CreateProviderDto, LinkPatientDto } from './dto/webhook.dto';

@Controller()
export class RadiographyController {
  constructor(
    private readonly service: RadiographyService,
    private readonly s3: S3Service,
  ) {}

  // ─── Webhook publico ────────────────────────────────────────────

  /** POST /webhooks/radiography (publico, autenticado por header). */
  @Public()
  @Post('webhooks/radiography')
  webhook(
    @Body() body: WebhookPayloadDto,
    @Headers('x-radiography-provider-key') headerKey: string,
  ) {
    return this.service.webhook(headerKey, body);
  }

  // ─── Provider management (CRM autenticado) ──────────────────────

  @UseGuards(JwtAuthGuard)
  @Post('radiography-providers')
  createProvider(@Body() dto: CreateProviderDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.createProvider(tenantId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('radiography-providers')
  listProviders(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.listProviders(tenantId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('radiography-providers/:id/toggle')
  toggleProvider(
    @Param('id') id: string,
    @Body() body: { active: boolean },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.toggleProvider(tenantId, id, !!body?.active);
  }

  // ─── Exam listing/management ────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Get('patients/:patientId/radiography-exams')
  findByPatient(@Param('patientId') patientId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.findByPatient(tenantId, patientId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('radiography-exams/backlog')
  backlog(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.backlog(tenantId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('radiography-exams/:id')
  findOne(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.findOne(tenantId, id);
  }

  /** Stream da imagem do exame. */
  @UseGuards(JwtAuthGuard)
  @Get('radiography-exams/:id/image')
  async getImage(@Param('id') id: string, @Request() req: any, @Res() res: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const exam = await this.service.findOne(tenantId, id);
    const { buffer, contentType } = await this.s3.getObjectBuffer(exam.image_s3_key);
    res.setHeader('Content-Type', contentType || exam.mime_type);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(buffer);
  }

  @UseGuards(JwtAuthGuard)
  @Post('radiography-exams/:id/link')
  link(@Param('id') id: string, @Body() dto: LinkPatientDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.id;
    if (!tenantId || !userId) throw new BadRequestException('tenant_id ou user ausente');
    return this.service.linkPatient(tenantId, id, userId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('radiography-exams/:id/discard')
  discard(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.discard(tenantId, id);
  }
}
