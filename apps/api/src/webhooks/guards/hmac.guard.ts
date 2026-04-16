import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { SettingsService } from '../../settings/settings.service';

/**
 * Verifica assinatura HMAC-SHA256 dos webhooks da Evolution API.
 * Header esperado: `x-webhook-signature` ou `x-signature`.
 *
 * Comportamento por configuração:
 * - WEBHOOK_HMAC_REQUIRED=true  → rejeita qualquer webhook sem apiKey ou sem assinatura válida (fail-closed)
 * - WEBHOOK_HMAC_REQUIRED=false → permite webhooks quando apiKey não está configurada (compatibilidade)
 */
@Injectable()
export class HmacGuard implements CanActivate {
  private readonly logger = new Logger(HmacGuard.name);

  constructor(private readonly settings: SettingsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const hmacRequired = process.env.WEBHOOK_HMAC_REQUIRED === 'true';

    const { apiKey } = await this.settings.getWhatsAppConfig();
    if (!apiKey) {
      if (hmacRequired) {
        this.logger.warn(
          '[HMAC] WEBHOOK_HMAC_REQUIRED=true mas nenhuma API key configurada — rejeitando webhook. ' +
          'Configure a API key do WhatsApp em Ajustes > Integração.',
        );
        throw new UnauthorizedException('Webhook HMAC não configurado no servidor.');
      }
      // Sem apiKey e HMAC não obrigatório — permitir para compatibilidade com Evolution API
      return true;
    }

    const signature =
      req.headers['x-webhook-signature'] ||
      req.headers['x-signature'] ||
      '';

    if (!signature) {
      // Se WEBHOOK_HMAC_REQUIRED=true, rejeitar sem assinatura (fail-closed)
      if (process.env.WEBHOOK_HMAC_REQUIRED === 'true') {
        this.logger.warn('[HMAC] Webhook sem assinatura — rejeitado (HMAC obrigatório)');
        throw new UnauthorizedException('Webhook signature required');
      }
      // Evolution API nao envia assinatura por padrao — permitir passagem (compat)
      return true;
    }

    // O body ja foi parseado pelo NestJS; recalcular HMAC sobre o JSON stringificado
    const rawBody = JSON.stringify(req.body);
    const expected = crypto
      .createHmac('sha256', apiKey)
      .update(rawBody)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      this.logger.warn('[HMAC] Assinatura invalida no webhook — rejeitado');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    return true;
  }
}
