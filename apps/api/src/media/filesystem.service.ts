import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';

@Injectable()
export class FileStorageService implements OnModuleInit {
  private readonly logger = new Logger(FileStorageService.name);
  private readonly basePath: string;

  constructor() {
    this.basePath = process.env.MEDIA_STORAGE_PATH || '/var/lib/crm-media';
  }

  async onModuleInit() {
    try {
      await fs.promises.mkdir(this.basePath, { recursive: true, mode: 0o700 });
      this.logger.log(`Storage de mídia iniciado em: ${this.basePath}`);
    } catch (e: any) {
      this.logger.error(`Falha ao inicializar diretório de mídia: ${e.message}`);
    }
  }

  /**
   * Resolve o path absoluto de forma segura (previne path traversal).
   */
  private resolvePath(relativePath: string): string {
    const resolved = path.resolve(this.basePath, relativePath);
    if (!resolved.startsWith(this.basePath)) {
      throw new Error(`Path inválido: ${relativePath}`);
    }
    return resolved;
  }

  /**
   * Gera o path relativo para um arquivo: YYYY/MM/{messageId}.{ext}
   */
  buildRelativePath(messageId: string, ext: string): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return path.join(String(year), month, `${messageId}.${ext}`);
  }

  /**
   * Salva buffer no filesystem. Retorna o path relativo salvo.
   */
  async write(relativePath: string, buffer: Buffer): Promise<string> {
    const fullPath = this.resolvePath(relativePath);
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(fullPath, buffer, { mode: 0o600 });
    this.logger.log(`[FS] Arquivo salvo: ${relativePath} (${buffer.length} bytes)`);
    return relativePath;
  }

  /**
   * Verifica se o arquivo existe.
   */
  async exists(relativePath: string): Promise<boolean> {
    try {
      const fullPath = this.resolvePath(relativePath);
      await fs.promises.access(fullPath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Retorna stream de leitura + metadados para servir o arquivo.
   */
  async getStream(relativePath: string, rangeStart?: number, rangeEnd?: number): Promise<{
    stream: Readable;
    size: number;
  }> {
    const fullPath = this.resolvePath(relativePath);
    const stat = await fs.promises.stat(fullPath);
    const options: { start?: number; end?: number } = {};
    if (rangeStart !== undefined) options.start = rangeStart;
    if (rangeEnd !== undefined) options.end = rangeEnd;
    const stream = fs.createReadStream(fullPath, options);
    return { stream, size: stat.size };
  }

  /**
   * Retorna o conteúdo completo como Buffer.
   */
  async getBuffer(relativePath: string): Promise<Buffer | null> {
    try {
      const fullPath = this.resolvePath(relativePath);
      return await fs.promises.readFile(fullPath);
    } catch {
      return null;
    }
  }

  /**
   * Remove o arquivo do disco.
   */
  async delete(relativePath: string): Promise<void> {
    try {
      const fullPath = this.resolvePath(relativePath);
      await fs.promises.unlink(fullPath);
    } catch {
      // Ignora se já não existir
    }
  }
}
