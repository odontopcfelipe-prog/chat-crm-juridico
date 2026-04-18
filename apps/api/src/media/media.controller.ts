import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Res,
  Req,
  NotFoundException,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { MediaS3Service } from './s3.service';
import { FileStorageService } from './filesystem.service';
import { Public } from '../auth/decorators/public.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import * as https from 'https';
import * as http from 'http';

@Controller('media')
export class MediaController {
  private readonly logger = new Logger(MediaController.name);

  constructor(
    private prisma: PrismaService,
    private s3: MediaS3Service,
    private fileStorage: FileStorageService,
    @InjectQueue('media-jobs') private mediaQueue: Queue,
  ) {}

  /**
   * POST /media/:messageId/retry — re-enfileira download de mídia para mensagens com problema.
   */
  @Post(':messageId/retry')
  @UseGuards(JwtAuthGuard)
  async retryMediaDownload(@Param('messageId') messageId: string) {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: { media: true, conversation: { select: { id: true, instance_name: true } } },
    });

    if (!message) throw new NotFoundException('Mensagem não encontrada');

    // Se já tem mídia no filesystem, não precisa re-baixar
    if (message.media?.file_path) {
      const exists = await this.fileStorage.exists(message.media.file_path);
      if (exists) {
        return { ok: true, message: 'Mídia já existe no storage', alreadyExists: true };
      }
      await this.prisma.media.delete({ where: { id: message.media.id } });
      this.logger.warn(`[RETRY] Media record deletado para msg ${messageId} (arquivo ausente)`);
    }

    // Fallback: checa S3 legado
    if (message.media?.s3_key) {
      try {
        await this.s3.getObjectStream(message.media.s3_key);
        return { ok: true, message: 'Mídia já existe no S3 (legado)', alreadyExists: true };
      } catch {
        await this.prisma.media.delete({ where: { id: message.media.id } });
        this.logger.warn(`[RETRY] Media record deletado para msg ${messageId} (S3 key ausente)`);
      }
    }

    if (!message.external_message_id) {
      throw new NotFoundException('Mensagem sem external_message_id — não é possível re-baixar');
    }

    const instanceName = message.conversation?.instance_name
      || process.env.EVOLUTION_INSTANCE_NAME || '';

    await this.mediaQueue.add('download_media', {
      message_id: message.id,
      conversation_id: message.conversation_id,
      media_data: null,
      remote_jid: null,
      msg_id: message.external_message_id,
      instance_name: instanceName,
    });

    this.logger.log(`[RETRY] Job de mídia re-enfileirado para msg ${messageId}`);
    return { ok: true, message: 'Download de mídia re-enfileirado' };
  }

  // Rota pública (sem JWT) para que a Evolution API possa baixar o áudio
  @Public()
  @Get(':messageId')
  async getMedia(
    @Param('messageId') messageId: string,
    @Query('dl') dl: string,
    @Req() req: any,
    @Res() res: any,
  ) {
    const media = await this.prisma.media.findUnique({
      where: { message_id: messageId },
    });

    if (!media) throw new NotFoundException('Mídia não encontrada');

    const disposition = dl === '1' ? 'attachment' : 'inline';

    // ── 1. Filesystem (novo storage) ─────────────────────────────────────────
    if (media.file_path) {
      const exists = await this.fileStorage.exists(media.file_path);
      if (exists) {
        try {
          const { size } = await this.fileStorage.getStream(media.file_path);
          const filename = this.buildFilename(media);
          const safeFilename = encodeURIComponent(filename);
          const rangeHeader = req.headers['range'] as string | undefined;

          if (rangeHeader && size) {
            const [startStr, endStr] = rangeHeader.replace('bytes=', '').split('-');
            const start = parseInt(startStr, 10);
            const end = endStr ? parseInt(endStr, 10) : size - 1;
            const chunkSize = end - start + 1;
            const { stream } = await this.fileStorage.getStream(media.file_path, start, end);
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Length', String(chunkSize));
            res.setHeader('Content-Type', media.mime_type || 'application/octet-stream');
            res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${safeFilename}`);
            res.setHeader('Cache-Control', 'private, max-age=3600');
            stream.pipe(res);
            return;
          }

          const { stream } = await this.fileStorage.getStream(media.file_path);
          res.setHeader('Content-Type', media.mime_type || 'application/octet-stream');
          res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${safeFilename}`);
          res.setHeader('Cache-Control', 'private, max-age=3600');
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Content-Length', String(size));
          stream.pipe(res);
          return;
        } catch (e: any) {
          this.logger.warn(`[MediaController] Erro ao servir do filesystem para ${messageId}: ${e.message}`);
        }
      }
    }

    // ── 2. MinIO/S3 (legado — mídias anteriores à migração) ──────────────────
    if (media.s3_key) {
      try {
        const s3Result = await this.s3.getObjectStream(media.s3_key);
        const { stream, contentType, contentLength } = s3Result;
        const filename = this.buildFilename(media);
        const safeFilename = encodeURIComponent(filename);
        const rangeHeader = req.headers['range'] as string | undefined;

        if (rangeHeader && contentLength) {
          const [startStr, endStr] = rangeHeader.replace('bytes=', '').split('-');
          const start = parseInt(startStr, 10);
          const end = endStr ? parseInt(endStr, 10) : contentLength - 1;
          const chunkSize = end - start + 1;
          stream.destroy();
          const ranged = await this.s3.getObjectStream(media.s3_key, start, end);
          res.status(206);
          res.setHeader('Content-Range', `bytes ${start}-${end}/${contentLength}`);
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Content-Length', String(chunkSize));
          res.setHeader('Content-Type', contentType);
          res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${safeFilename}`);
          res.setHeader('Cache-Control', 'private, max-age=3600');
          ranged.stream.pipe(res);
          return;
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${safeFilename}`);
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.setHeader('Accept-Ranges', 'bytes');
        if (contentLength) res.setHeader('Content-Length', String(contentLength));
        stream.pipe(res);
        return;
      } catch (s3Err) {
        this.logger.warn(`[MediaController] S3 indisponível para ${messageId}: ${(s3Err as Error).message}`);
      }
    }

    // ── 3. Fallback Evolution CDN (URL original, expira em ~48h) ─────────────
    if (media.original_url) {
      this.logger.log(`[MediaController] Servindo via original_url para ${messageId}`);
      const protocol = media.original_url.startsWith('https') ? https : http;
      await new Promise<void>((resolve, reject) => {
        const proxyReq = protocol.get(media.original_url!, (proxyRes) => {
          const proxyCt = proxyRes.headers['content-type'] || '';
          const ct = (proxyCt && proxyCt !== 'application/octet-stream') ? proxyCt : (media.mime_type || 'application/octet-stream');
          const cl = proxyRes.headers['content-length'];
          res.setHeader('Content-Type', ct);
          res.setHeader('Cache-Control', 'private, max-age=86400');
          res.setHeader('Accept-Ranges', 'none');
          if (cl) res.setHeader('Content-Length', cl);
          proxyRes.pipe(res);
          proxyRes.on('end', resolve);
          proxyRes.on('error', reject);
        });
        proxyReq.on('error', reject);
      });
      return;
    }

    throw new NotFoundException('Arquivo não encontrado no storage e sem URL de origem');
  }

  private buildFilename(media: any): string {
    if (media.original_name) return media.original_name;
    const ext = (media.file_path || media.s3_key || '').split('.').pop()?.split(';')[0]?.trim() || 'bin';
    const mime = (media.mime_type || '').toLowerCase();
    if (mime.startsWith('image/')) return `imagem.${ext}`;
    if (mime.startsWith('audio/')) return `audio.${ext}`;
    if (mime.startsWith('video/')) return `video.${ext}`;
    return `arquivo.${ext}`;
  }
}
