import {
  Controller, Get, Post, Delete, Body, Param, Request, UseGuards,
  UseInterceptors, UploadedFiles, BadRequestException, Res,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SmileDesignService } from './smile-design.service';
import { parseRegion } from './smile-image.util';

@UseGuards(JwtAuthGuard)
@Controller()
export class SmileDesignController {
  constructor(private readonly service: SmileDesignService) {}

  /** A tela pergunta se há IA configurada antes de oferecer "Nova simulação". */
  @Get('smile-design/status')
  status() {
    return this.service.status();
  }

  /**
   * POST /patients/:patientId/smile-simulations
   * multipart/form-data:
   *   file: foto (a tela manda PNG já no tamanho da IA)
   *   mask: opcional, PNG do mesmo tamanho — transparente = boca (onde a IA mexe)
   *   region: opcional, JSON {cx,cy,rx,ry} da elipse da boca (0..1)
   *   treatment: COMPLETO | CLAREAMENTO | ALINHAMENTO | REABILITACAO
   *   shade: NATURAL | BRANCO | EXTRA
   *   prompt: opcional — pedido livre do dentista pra IA
   *   patient_consent: 'true' (obrigatorio)
   *   notes: opcional
   */
  @Post('patients/:patientId/smile-simulations')
  @UseInterceptors(FileFieldsInterceptor(
    [{ name: 'file', maxCount: 1 }, { name: 'mask', maxCount: 1 }],
    { limits: { fileSize: 20 * 1024 * 1024 } },
  ))
  async create(
    @Param('patientId') patientId: string,
    @UploadedFiles() files: { file?: any[]; mask?: any[] },
    @Body() body: {
      simulation_type?: string;
      treatment?: string;
      shade?: string;
      region?: string;
      prompt?: string;
      patient_consent?: string;
      notes?: string;
    },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.id;
    if (!tenantId || !userId) throw new BadRequestException('tenant_id ou user ausente');
    const file = files?.file?.[0];
    const mask = files?.mask?.[0];
    if (!file) throw new BadRequestException('Arquivo (campo "file") obrigatorio');
    if (!file.mimetype?.startsWith('image/')) {
      throw new BadRequestException('Arquivo deve ser imagem');
    }
    if (mask && mask.mimetype !== 'image/png') {
      throw new BadRequestException('A máscara deve ser PNG');
    }
    return this.service.create(tenantId, userId, {
      patient_id: patientId,
      simulation_type: body.simulation_type,
      treatment: body.treatment,
      shade: body.shade,
      prompt: body.prompt,
      patient_consent: body.patient_consent === 'true' || (body.patient_consent as any) === true,
      notes: body.notes,
      before_buffer: file.buffer,
      before_mime: file.mimetype,
      mask_buffer: mask?.buffer || null,
      region: parseRegion(body.region),
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

  /** "Gerar outra versão" — mesma foto/marcação, tratamento e cor podem mudar. */
  @Post('smile-simulations/:id/regenerate')
  regenerate(
    @Param('id') id: string,
    @Body() body: { treatment?: string; shade?: string; prompt?: string; notes?: string },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.id;
    if (!tenantId || !userId) throw new BadRequestException('tenant_id ou user ausente');
    return this.service.regenerate(tenantId, userId, id, body || {});
  }

  /** Bytes da imagem (before ou after) — a tela busca como blob autenticado. */
  @Get('smile-simulations/:id/image/:kind')
  async getImage(
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Request() req: any,
    @Res() res: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (kind !== 'before' && kind !== 'after') throw new BadRequestException('kind invalido');
    const { buffer, contentType } = await this.service.getImage(tenantId, id, kind);
    res.setHeader('Content-Type', contentType);
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
