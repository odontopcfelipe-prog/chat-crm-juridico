import { Logger } from '@nestjs/common';
import type { ToolHandler, ToolContext } from '../tool-executor';

/**
 * Handler genérico para tools do tipo "webhook".
 * Faz HTTP POST/GET para a URL configurada e retorna o response body.
 */
export class WebhookHandler implements ToolHandler {
  private readonly logger = new Logger('WebhookHandler');
  name: string;
  private config: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
  };

  constructor(name: string, config: any) {
    this.name = name;
    this.config = config || {};
  }

  async execute(params: Record<string, any>, context: ToolContext): Promise<any> {
    const { url, method = 'POST', headers = {} } = this.config;

    if (!url) {
      return { error: 'URL do webhook não configurada' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const body = method.toUpperCase() === 'GET' ? undefined : JSON.stringify({
        ...params,
        _context: {
          conversationId: context.conversationId,
          leadId: context.leadId,
          leadPhone: context.leadPhone,
        },
      });

      const response = await fetch(url, {
        method: method.toUpperCase(),
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body,
        signal: controller.signal,
      });

      const text = await response.text();
      this.logger.log(`[Webhook] ${this.name} → ${response.status} (${text.length} chars)`);

      try {
        return JSON.parse(text);
      } catch {
        return { status: response.status, body: text };
      }
    } catch (err: any) {
      this.logger.error(`[Webhook] ${this.name} falhou: ${err.message}`);
      return { error: `Webhook falhou: ${err.message}` };
    } finally {
      clearTimeout(timeout);
    }
  }
}
