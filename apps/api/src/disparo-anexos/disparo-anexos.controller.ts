import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Request,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { DISPARO_ANEXO_LIMITE_BYTES, DISPARO_ANEXO_MAX, disparoAnexoTipo, isDisparoComAnexo } from '@crm/shared';
import { Roles } from '../auth/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { limparCacheAnexos } from './disparo-anexos-envio';

const tenantDe = (req: any): string => {
  const t = req.user?.tenant_id;
  if (!t) throw new BadRequestException('tenant_id ausente');
  return t;
};
const exigeCard = (id: string) => {
  if (!isDisparoComAnexo(id)) throw new BadRequestException('Este disparo não aceita anexos');
};

/**
 * Anexos (fotos/áudio) dos disparos automáticos — editor de cada card da Central.
 * Só ADMIN; escopado na clínica do usuário. O motor de cada disparo manda depois do texto.
 */
@Roles('ADMIN')
@Controller('disparos')
export class DisparoAnexosController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':disparo/anexos')
  async listar(@Param('disparo') disparo: string, @Request() req: any) {
    exigeCard(disparo);
    return this.prisma.disparoAnexo.findMany({
      where: { tenant_id: tenantDe(req), disparo_id: disparo },
      orderBy: { position: 'asc' },
      select: { id: true, kind: true, mime_type: true, size: true, original_name: true, position: true },
    });
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post(':disparo/anexos')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 11 * 1024 * 1024 } }))
  async anexar(@Param('disparo') disparo: string, @UploadedFile() file: Express.Multer.File, @Request() req: any) {
    exigeCard(disparo);
    const tenantId = tenantDe(req);
    if (!file?.buffer?.length) throw new BadRequestException('Arquivo vazio');
    const kind = disparoAnexoTipo(file.mimetype);
    if (!kind) throw new BadRequestException('Só fotos (JPG, PNG, WEBP), vídeos MP4 e áudios (MP3, OGG, M4A, WAV, WEBM) — vídeo .MOV do iPhone: compartilhe como MP4');
    if (file.size > DISPARO_ANEXO_LIMITE_BYTES[kind]) {
      throw new BadRequestException(`${kind === 'image' ? 'Foto' : kind === 'video' ? 'Vídeo' : 'Áudio'} muito grande (máx. ${DISPARO_ANEXO_LIMITE_BYTES[kind] / 1024 / 1024} MB)`);
    }
    const qtd = await this.prisma.disparoAnexo.count({ where: { tenant_id: tenantId, disparo_id: disparo } });
    if (qtd >= DISPARO_ANEXO_MAX) throw new BadRequestException(`Máximo de ${DISPARO_ANEXO_MAX} anexos por disparo`);
    const criado = await this.prisma.disparoAnexo.create({
      data: {
        tenant_id: tenantId,
        disparo_id: disparo,
        kind,
        mime_type: file.mimetype.toLowerCase().split(';')[0].trim(),
        size: file.size,
        original_name: (file.originalname || '').slice(0, 120) || null,
        position: qtd,
        data: new Uint8Array(file.buffer),
      },
      select: { id: true, kind: true, mime_type: true, size: true, original_name: true, position: true },
    });
    limparCacheAnexos(tenantId, disparo);
    return criado;
  }

  @Delete(':disparo/anexos/:aid')
  async remover(@Param('disparo') disparo: string, @Param('aid') aid: string, @Request() req: any) {
    exigeCard(disparo);
    const tenantId = tenantDe(req);
    const r = await this.prisma.disparoAnexo.deleteMany({ where: { id: aid, tenant_id: tenantId, disparo_id: disparo } });
    if (!r.count) throw new NotFoundException('Anexo não encontrado');
    limparCacheAnexos(tenantId, disparo);
    return { ok: true };
  }

  @Get(':disparo/anexos/:aid/arquivo')
  async arquivo(@Param('disparo') disparo: string, @Param('aid') aid: string, @Request() req: any, @Res() res: any) {
    exigeCard(disparo);
    const a = await this.prisma.disparoAnexo.findFirst({
      where: { id: aid, tenant_id: tenantDe(req), disparo_id: disparo },
      select: { data: true, mime_type: true },
    });
    if (!a) throw new NotFoundException('Anexo não encontrado');
    res.setHeader('Content-Type', a.mime_type);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(Buffer.from(a.data));
  }
}
