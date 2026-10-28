import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { SettingsService } from '../../settings/settings.service';

/** Uma linha de vigia por chip e motivo a cada 10 min, com a contagem do intervalo. */
const VIGIA_INTERVALO_MS = 10 * 60_000;
/** Chips distintos acompanhados por vez; acima disso a contagem vai para "outros". */
const VIGIA_MAX_CHAVES = 200;
const VIGIA_MAX_TEXTO = 60;

/** Nome curto e de uma linha só para o log (chip e evento vêm do corpo do aviso). */
function paraLog(v: unknown): string {
  if (typeof v !== 'string' || !v) return '?';
  const limpo = v.replace(/[^A-Za-z0-9_.@:-]/g, '_');
  return limpo.length > VIGIA_MAX_TEXTO ? `${limpo.slice(0, VIGIA_MAX_TEXTO)}...` : limpo;
}

/**
 * Verifica assinatura HMAC-SHA256 dos webhooks da Evolution API.
 * Header esperado: `x-webhook-signature` ou `x-signature`.
 *
 * Comportamento por configuração:
 * - WEBHOOK_HMAC_REQUIRED=true  → rejeita qualquer webhook sem apiKey ou sem assinatura válida (fail-closed)
 * - WEBHOOK_HMAC_REQUIRED=false → permite webhooks quando apiKey não está configurada (compatibilidade)
 *
 * Vigia: aviso aceito sem assinatura conferida gera `[WEBHOOK-VIGIA] evolution ...` no log
 * (uma linha por chip e motivo a cada 10 min, com a contagem). É só medição: não consulta
 * nada fora nem o banco e não muda o que entra ou é recusado.
 */
@Injectable()
export class HmacGuard implements CanActivate {
  private readonly logger = new Logger(HmacGuard.name);
  private readonly vigia = new Map<string, { at: number; n: number }>();

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
      this.registrarVigia(req, 'sem chave configurada para conferir a assinatura');
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
      this.registrarVigia(req, 'sem assinatura');
      return true;
    }

    // O body ja foi parseado pelo NestJS; recalcular HMAC sobre o JSON stringificado
    const rawBody = JSON.stringify(req.body);
    const expected = crypto
      .createHmac('sha256', apiKey)
      .update(rawBody)
      .digest('hex');

    const sigBuf = Buffer.from(String(signature));
    const expBuf = Buffer.from(expected);
    // timingSafeEqual lanca RangeError se os buffers tiverem tamanhos diferentes
    // (assinatura forjada/curta) — checar o length antes evita 500 e devolve 401 limpo.
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      this.logger.warn('[HMAC] Assinatura invalida no webhook — rejeitado');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    return true;
  }

  /**
   * Só registra: só lê o que já chegou na requisição e a memória do processo.
   * Qualquer falha aqui é engolida — o aviso entra do mesmo jeito.
   */
  private registrarVigia(req: any, motivo: string) {
    try {
      const body = req?.body;
      const chip = paraLog(body?.instance || body?.instanceId);
      const evento = paraLog(body?.event);
      const agora = Date.now();

      let chave = `${motivo}|${chip}`;
      if (!this.vigia.has(chave) && this.vigia.size >= VIGIA_MAX_CHAVES) {
        for (const [k, r] of this.vigia) {
          if (agora - r.at >= VIGIA_INTERVALO_MS) this.vigia.delete(k);
        }
        if (this.vigia.size >= VIGIA_MAX_CHAVES) chave = `${motivo}|*`;
      }

      const r = this.vigia.get(chave);
      if (r && agora - r.at < VIGIA_INTERVALO_MS) {
        r.n++;
        return;
      }
      this.vigia.set(chave, { at: agora, n: 0 });
      const quem = chave.endsWith('|*') ? 'outros chips' : `chip ${chip}`;
      const extra = r?.n ? ` (+${r.n} iguais nos últimos ${VIGIA_INTERVALO_MS / 60_000} min)` : '';
      this.logger.warn(`[WEBHOOK-VIGIA] evolution: aviso aceito ${motivo} (${quem}, evento ${evento})${extra}`);
    } catch {
      // medição nunca interfere na entrada do aviso
    }
  }
}
