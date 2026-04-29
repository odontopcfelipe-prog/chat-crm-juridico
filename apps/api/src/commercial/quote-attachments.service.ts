/**
 * QuoteAttachmentsService — anexos de orçamento (Fase 24 — Onda 3).
 *
 * Use cases prioritarios:
 *  - Foto antes/depois pra estetica facial (vende mais)
 *  - Exames (raio-X, panorama, periapical) que justificam o tratamento
 *  - TCLE pre-preenchido pro paciente assinar
 *  - Documentos auxiliares (laudo, autorizacao, etc)
 *
 * Validacoes:
 *  - Tipos aceitos: image/* + application/pdf + Word (doc/docx)
 *  - Tamanho max: 10 MB por arquivo (configuravel)
 *  - Quote nao pode estar em status terminal (REJECTED/EXPIRED)
 *
 * Storage: FileStorageService (mesma infra de avatar do paciente)
 *  - Path: quote-attachments/{attachment_id}.{ext}
 */
import {
  Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FileStorageService } from '../media/filesystem.service';

// MIME types aceitos -> extensao no filesystem
const ALLOWED_MIMES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

@Injectable()
export class QuoteAttachmentsService {
  private readonly logger = new Logger(QuoteAttachmentsService.name);

  constructor(
    private prisma: PrismaService,
    private fileStorage: FileStorageService,
  ) {}

  async list(quoteId: string, tenantId: string) {
    await this.assertQuoteBelongsToTenant(quoteId, tenantId);
    return (this.prisma as any).quoteAttachment.findMany({
      where: { quote_id: quoteId },
      orderBy: { created_at: 'desc' },
      include: {
        uploaded_by: { select: { id: true, name: true } },
      },
    });
  }

  async upload(
    quoteId: string,
    tenantId: string,
    userId: string,
    file: { buffer: Buffer; mimetype: string; originalname: string; size: number },
    meta: { category?: string; description?: string } = {},
  ) {
    if (!file?.buffer) throw new BadRequestException('Arquivo nao recebido');

    const ext = ALLOWED_MIMES[file.mimetype?.toLowerCase()];
    if (!ext) {
      throw new BadRequestException(
        `Tipo nao suportado: ${file.mimetype}. Use JPEG, PNG, WebP, HEIC, PDF, DOC ou DOCX.`,
      );
    }
    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException(
        `Arquivo muito grande (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximo 10 MB.`,
      );
    }

    const quote = await this.assertQuoteBelongsToTenant(quoteId, tenantId);
    if (['REJECTED', 'EXPIRED'].includes(quote.status)) {
      throw new BadRequestException('Nao pode anexar em orcamento ' + quote.status);
    }

    // Cria registro primeiro pra ter o ID, depois grava arquivo com esse ID
    const created = await (this.prisma as any).quoteAttachment.create({
      data: {
        quote_id: quoteId,
        uploaded_by_id: userId,
        filename: file.originalname || `arquivo.${ext}`,
        mime_type: file.mimetype,
        size_bytes: file.size,
        file_path: '', // preenchido abaixo
        category: meta.category?.trim() || null,
        description: meta.description?.trim() || null,
      },
    });

    const filePath = `quote-attachments/${created.id}.${ext}`;
    try {
      await this.fileStorage.write(filePath, file.buffer);
    } catch (e: any) {
      // rollback se filesystem falhou
      await (this.prisma as any).quoteAttachment.delete({ where: { id: created.id } }).catch(() => {});
      throw new BadRequestException(`Falha ao gravar arquivo: ${e?.message}`);
    }

    const updated = await (this.prisma as any).quoteAttachment.update({
      where: { id: created.id },
      data: { file_path: filePath },
      include: { uploaded_by: { select: { id: true, name: true } } },
    });

    this.logger.log(
      `[QUOTE-ATTACH] ${file.originalname} (${(file.size / 1024).toFixed(0)} KB) anexado ao orcamento ${quoteId}`,
    );
    return updated;
  }

  /** Retorna o buffer + mime type pra servir via HTTP */
  async getFileBuffer(attachmentId: string, tenantId: string) {
    const att = await (this.prisma as any).quoteAttachment.findUnique({
      where: { id: attachmentId },
      include: { quote: { include: { patient: { select: { tenant_id: true } } } } },
    });
    if (!att) throw new NotFoundException('Anexo nao encontrado');
    if (att.quote.patient.tenant_id !== tenantId) {
      throw new ForbiddenException('Acesso negado');
    }
    const buffer = await this.fileStorage.read(att.file_path);
    if (!buffer) throw new NotFoundException('Arquivo nao encontrado no storage');
    return { buffer, mime_type: att.mime_type, filename: att.filename };
  }

  async remove(attachmentId: string, tenantId: string) {
    const att = await (this.prisma as any).quoteAttachment.findUnique({
      where: { id: attachmentId },
      include: { quote: { include: { patient: { select: { tenant_id: true } } } } },
    });
    if (!att) throw new NotFoundException('Anexo nao encontrado');
    if (att.quote.patient.tenant_id !== tenantId) {
      throw new ForbiddenException('Acesso negado');
    }
    if (['REJECTED', 'EXPIRED'].includes(att.quote.status)) {
      throw new BadRequestException('Nao pode remover anexo de orcamento ' + att.quote.status);
    }

    // Apaga do storage primeiro (best-effort), depois do banco
    await this.fileStorage.delete(att.file_path).catch((e) =>
      this.logger.warn(`[QUOTE-ATTACH] Falha apagando arquivo ${att.file_path}: ${e?.message}`),
    );
    await (this.prisma as any).quoteAttachment.delete({ where: { id: attachmentId } });
    return { ok: true };
  }

  // ─── Helper ──────────────────────────────────────────────────

  private async assertQuoteBelongsToTenant(quoteId: string, tenantId: string) {
    const quote = await this.prisma.quote.findUnique({
      where: { id: quoteId },
      select: {
        id: true, status: true,
        patient: { select: { tenant_id: true } },
      },
    });
    if (!quote) throw new NotFoundException('Orcamento nao encontrado');
    if (quote.patient.tenant_id !== tenantId) {
      throw new ForbiddenException('Acesso negado');
    }
    return quote;
  }
}
