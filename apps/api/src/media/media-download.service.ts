import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MediaS3Service } from './s3.service';
import { SettingsService } from '../settings/settings.service';
import { GoogleDriveService } from '../google-drive/google-drive.service';
import axios from 'axios';
import * as crypto from 'crypto';

/**
 * Servico de download sincrono de midia — estilo Chatwoot.
 *
 * Baixa midia da Evolution API, faz upload para S3 e cria o record Media,
 * tudo no mesmo processo da API (sem BullMQ). Usado pelo webhook handler
 * para entregar mensagens JA COM midia via WebSocket.
 */
@Injectable()
export class MediaDownloadService {
  private readonly logger = new Logger(MediaDownloadService.name);

  /** Timeout maximo para o download de midia da Evolution API (ms) */
  private static readonly DOWNLOAD_TIMEOUT = 15_000;

  constructor(
    private prisma: PrismaService,
    private s3: MediaS3Service,
    private settings: SettingsService,
    private driveService: GoogleDriveService,
  ) {}

  /**
   * Baixa midia da Evolution API, faz upload para S3, cria record no Prisma.
   * Retorna o Media record criado ou null em caso de falha.
   */
  async downloadAndStore(params: {
    messageId: string;
    conversationId: string;
    externalMessageId: string;
    instanceName?: string;
    mediaData: any;
  }): Promise<any | null> {
    const { messageId, conversationId, externalMessageId, instanceName, mediaData } = params;

    try {
      // 1. Config da Evolution
      const { apiUrl, apiKey } = await this.settings.getWhatsAppConfig();
      if (!apiUrl) {
        this.logger.warn('[MEDIA-SYNC] EVOLUTION_API_URL nao configurada');
        return null;
      }

      const instance = instanceName || process.env.EVOLUTION_INSTANCE_NAME || '';

      // 2. Download base64 da Evolution API (COM timeout)
      const response = await axios.post(
        `${apiUrl}/chat/getBase64FromMediaMessage/${instance}`,
        { message: { key: { id: externalMessageId } } },
        {
          headers: { apikey: apiKey },
          timeout: MediaDownloadService.DOWNLOAD_TIMEOUT,
        },
      );

      const base64Data = response.data?.base64;
      const mimeType = response.data?.mimetype || 'application/octet-stream';

      if (!base64Data) {
        this.logger.warn(`[MEDIA-SYNC] Sem base64 retornado para msg ${messageId}`);
        return null;
      }

      // 3. Buffer, checksum, tamanho
      const buffer = Buffer.from(base64Data, 'base64');
      const checksum = crypto.createHash('md5').update(buffer).digest('hex');
      const size = buffer.length;

      // 4. Upload S3
      const mimeBase = mimeType.split(';')[0].trim();
      const ext = mimeBase.split('/')[1] || 'bin';
      const s3Key = `media/${messageId}.${ext}`;
      await this.s3.uploadBuffer(s3Key, buffer, mimeType);

      // 5. Criar Media record
      const duration: number | null = mediaData?.seconds ?? null;
      const originalUrl: string | null = mediaData?.url ?? null;
      const originalName: string | null = mediaData?.fileName ?? null;

      const media = await this.prisma.media.create({
        data: {
          message_id: messageId,
          s3_key: s3Key,
          mime_type: mimeType,
          size,
          checksum,
          duration,
          original_url: originalUrl,
          original_name: originalName,
        },
      });

      this.logger.log(`[MEDIA-SYNC] Midia baixada e salva: ${s3Key} (${size} bytes)`);

      // 6. Google Drive auto-upload (fire-and-forget, nao bloqueia)
      this.uploadToDriveIfNeeded(media, messageId, conversationId).catch(e =>
        this.logger.warn(`[MEDIA-SYNC][DRIVE] Falha: ${e.message}`),
      );

      return media;
    } catch (e: any) {
      const reason = e.code === 'ECONNABORTED' ? 'timeout' : e.message;
      this.logger.warn(`[MEDIA-SYNC] Falha no download para msg ${messageId}: ${reason}`);
      return null;
    }
  }

  /**
   * Upload automatico de documentos/imagens para Google Drive do lead.
   */
  private async uploadToDriveIfNeeded(
    media: any,
    messageId: string,
    conversationId: string,
  ): Promise<void> {
    if (!media?.s3_key || !media?.mime_type) return;

    // So faz upload de documentos e imagens (nao audios)
    const isDocument = media.mime_type.startsWith('application/') || media.mime_type.startsWith('image/');
    if (!isDocument) return;

    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { lead: { select: { id: true, name: true, google_drive_folder_id: true } } },
    });

    if (!conv?.lead?.google_drive_folder_id) return;

    const configured = await this.driveService.isConfigured();
    if (!configured) return;

    const fileBuffer = await this.s3.getFileBuffer(media.s3_key);
    if (!fileBuffer) return;

    const fileName = media.original_name || `${messageId}${this.getExtension(media.mime_type)}`;

    await this.driveService.uploadFile(
      conv.lead.google_drive_folder_id,
      fileName,
      media.mime_type,
      fileBuffer,
    );

    this.logger.log(`[MEDIA-SYNC][DRIVE] "${fileName}" enviado ao Drive`);
  }

  private getExtension(mimeType: string): string {
    const map: Record<string, string> = {
      'application/pdf': '.pdf',
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/msword': '.doc',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    };
    return map[mimeType] || '';
  }
}
