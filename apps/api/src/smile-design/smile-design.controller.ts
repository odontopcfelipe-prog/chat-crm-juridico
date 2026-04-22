import {
  Controller, Get, Post, Delete, Body, Param, Request, UseGuards,
  UseInterceptors, UploadedFile, BadRequestException, Res,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SmileDesignService } from './smile-design.service';
import { S3Service } from '../s3/s3.service';

@UseGuards(JwtAuthGuard)
@Controller()
export class SmileDesignController {
  constructor(
    private readonly service: SmileDesignService,
    private readonly s3: S3Service,
  ) {}

  /**
   * POST /patients/:patientId/smile-simulations
   * multipart/form-data:
   *   file: foto antes (image/*)
   *   simulation_type: SMILE | FACE_HARMONY | LIPS | RHINOMODULATION | OTHER
   *   prompt: opcional, string
   *   patient_consent: 'true' | 'false' (obrigatorio)
   *   notes: opcional
   */
  @Post('patients/:patientId/smile-simulations')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024 } }))
  async create(
    @Param('patientId') patientId: string,
    @UploadedFile() file: any,
    @Body() body: {
      simulation_type: string;
      prompt?: string;
      patient_consent?: string;
      notes?: string;
    },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.id;
    if (!tenantId || !userId) throw new BadRequestException('tenant_id ou user ausente');
    if (!file) throw new BadRequestException('Arquivo (campo "file") obrigatorio');
    if (!file.mimetype?.startsWith('image/')) {
      throw new BadRequestException('Arquivo deve ser imagem');
    }
    return this.service.create(tenantId, userId, {
      patient_id: patientId,
      simulation_type: body.simulation_type,
      prompt: body.prompt,
      patient_consent: body.patient_consent === 'true' || (body.patient_consent as any) === true,
      notes: body.notes,
      before_buffer: file.buffer,
      before_mime: file.mimetype,
    });
  }

  @Get('patients/:patientId/smile-simulations')
  list(@Param('patientId') patientId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.findByPatient(tenantId, patientId);
  }

  @Get('smile-simulations/:id')
  findOne(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.findOne(tenantId, id);
  }

  /** Stream da imagem (before ou after) por id da simulacao. */
  @Get('smile-simulations/:id/image/:kind')
  async getImage(
    @Param('id') id: string,
    @Param('kind') kind: 'before' | 'after',
    @Request() req: any,
    @Res() res: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const sim = await this.service.findOne(tenantId, id);
    const key = kind === 'after' ? sim.after_s3_key : sim.before_s3_key;
    if (!key) throw new BadRequestException(`Imagem '${kind}' indisponivel`);
    const { buffer, contentType } = await this.s3.getObjectBuffer(key);
    res.setHeader('Content-Type', contentType || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buffer);
  }

  @Delete('smile-simulations/:id')
  remove(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.service.remove(tenantId, id);
  }
}
