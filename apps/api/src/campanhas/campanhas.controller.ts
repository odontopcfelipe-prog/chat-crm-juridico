import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../auth/decorators/roles.decorator';
import { CampanhasService } from './campanhas.service';

const tenantDe = (req: any): string => {
  const t = req.user?.tenant_id;
  if (!t) throw new BadRequestException('tenant_id ausente');
  return t;
};

/** Campanha manual (Central de Disparos). Só ADMIN; tudo escopado na clínica do usuário. */
@Roles('ADMIN')
@Controller('campanhas')
export class CampanhasController {
  constructor(private readonly svc: CampanhasService) {}

  @Get()
  listar(@Query('setor') setor: string | undefined, @Request() req: any) {
    return this.svc.listar(tenantDe(req), setor);
  }

  /** Prévia do público (quantos recebem, quem fica de fora e por quê). Antes de :id. */
  @Post('publico/previa')
  previa(@Body() body: { filters?: any }, @Request() req: any) {
    return this.svc.previa(tenantDe(req), body?.filters || {});
  }

  @Post()
  criar(@Body() body: any, @Request() req: any) {
    return this.svc.criar(tenantDe(req), req.user?.id, body);
  }

  @Get(':id')
  detalhe(@Param('id') id: string, @Request() req: any) {
    return this.svc.detalhe(tenantDe(req), id);
  }

  @Patch(':id')
  atualizar(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.svc.atualizar(tenantDe(req), id, body);
  }

  @Delete(':id')
  excluir(@Param('id') id: string, @Request() req: any) {
    return this.svc.excluir(tenantDe(req), id);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post(':id/midias')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 16 * 1024 * 1024 } }))
  anexar(@Param('id') id: string, @UploadedFile() file: Express.Multer.File, @Request() req: any) {
    return this.svc.anexar(tenantDe(req), id, file);
  }

  @Delete(':id/midias/:mid')
  removerAnexo(@Param('id') id: string, @Param('mid') mid: string, @Request() req: any) {
    return this.svc.removerAnexo(tenantDe(req), id, mid);
  }

  @Get(':id/midias/:mid/arquivo')
  async arquivo(@Param('id') id: string, @Param('mid') mid: string, @Request() req: any, @Res() res: any) {
    const { buffer, mime } = await this.svc.arquivoAnexo(tenantDe(req), id, mid);
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(buffer);
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post(':id/teste')
  testar(@Param('id') id: string, @Body() body: { telefone?: string }, @Request() req: any) {
    return this.svc.testar(tenantDe(req), id, body?.telefone || '');
  }

  @Post(':id/iniciar')
  iniciar(@Param('id') id: string, @Body() body: { agendar_para?: string | null }, @Request() req: any) {
    return this.svc.iniciar(tenantDe(req), id, body?.agendar_para || null);
  }

  @Post(':id/pausar')
  pausar(@Param('id') id: string, @Request() req: any) {
    return this.svc.pausar(tenantDe(req), id);
  }

  @Post(':id/retomar')
  retomar(@Param('id') id: string, @Request() req: any) {
    return this.svc.retomar(tenantDe(req), id);
  }

  @Post(':id/cancelar')
  cancelar(@Param('id') id: string, @Request() req: any) {
    return this.svc.cancelar(tenantDe(req), id);
  }

  @Get(':id/itens')
  itens(@Param('id') id: string, @Query('status') status: string | undefined, @Request() req: any) {
    return this.svc.itens(tenantDe(req), id, status);
  }
}
