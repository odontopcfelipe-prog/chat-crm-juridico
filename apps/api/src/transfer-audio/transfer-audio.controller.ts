import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  UploadedFile,
  UseInterceptors,
  UseGuards,
  Request,
  Res,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { TransferAudioService } from './transfer-audio.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('transfer-audios')
export class TransferAudioController {
  constructor(private readonly service: TransferAudioService) {}

  /** Upload de áudio de transferência (multipart/form-data, campo: audio) */
  @Post('upload/:conversationId')
  @UseInterceptors(FileInterceptor('audio'))
  async upload(
    @Param('conversationId') conversationId: string,
    @UploadedFile() file: Express.Multer.File,
    @Request() req: any,
  ) {
    const record = await this.service.upload(
      conversationId,
      file.buffer,
      file.mimetype || 'audio/webm',
      file.size,
      req.user?.id,
    );
    return { id: record.id, mime_type: record.mime_type, size: record.size };
  }

  /** Buscar lista de áudios ativos de uma conversa */
  @Get('by-conversation/:conversationId')
  findByConversation(@Param('conversationId') conversationId: string) {
    return this.service.findByConversation(conversationId);
  }

  /** Stream/download de um áudio */
  @Get(':id/stream')
  async stream(@Param('id') id: string, @Res() res: Response) {
    const { stream, contentType, contentLength } = await this.service.stream(id);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    stream.pipe(res);
  }

  /** Deletar um áudio */
  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
