import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { Response, Request } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);
  private readonly auditLogger = new Logger('AccessAudit');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // Se a resposta já foi enviada (ex: stream), não tenta responder de novo
    if (response.headersSent) return;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Erro interno do servidor';
    let code: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exResponse = exception.getResponse();
      if (typeof exResponse === 'string') {
        message = exResponse;
      } else {
        message = (exResponse as any).message || exception.message;
        // Propaga um code discriminador (ex.: PERMISSION_DENIED) quando a
        // exceção o carrega — pro frontend distinguir "falta de autorização
        // que o admin pode liberar" dos demais 403 legítimos.
        code = (exResponse as any).code;
      }
    }

    // ─── Audit log: registra tentativas de acesso negado (403) ───────────
    if (status === HttpStatus.FORBIDDEN) {
      const user = (request as any).user;
      this.auditLogger.warn(
        `ACESSO_NEGADO | ` +
        `user=${user?.id ?? 'anon'} | ` +
        `roles=${(user?.roles || [user?.role]).filter(Boolean).join(',') || '-'} | ` +
        `${request.method} ${request.url} | ` +
        `ip=${request.ip ?? request.headers['x-forwarded-for'] ?? '-'} | ` +
        `motivo="${message}"`,
      );
    }

    // Log apenas erros 5xx (não polui log com 4xx intencionais)
    if (status >= 500) {
      this.logger.error(
        `[${request.method} ${request.url}] ${status} — ${exception instanceof Error ? exception.stack : exception}`,
      );
    }

    response.status(status).json({
      statusCode: status,
      message,
      ...(code ? { code } : {}),
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
