import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * Assina e valida URLs da rota publica de midia (GET /media/:id).
 *
 * Por que: a rota e publica porque a Evolution (envio outbound) e as tags
 * <img>/<audio>/<video> do front baixam dela sem header de auth. Sem
 * assinatura, qualquer um com o id (UUID) baixa a midia do paciente (IDOR).
 * O token HMAC + expiracao fecha isso: so links gerados pelo backend (pra
 * usuario logado / pra Evolution no envio) abrem.
 *
 * Rollout expand-contract (pra nao quebrar a midia do chat, que e uso diario):
 *   1. infra + rota valida quando o token vem, mas ainda serve sem ele  <- ESTA ETAPA
 *   2. backend gera URLs assinadas (outbound + payload de mensagens) e o front usa
 *   3. rota passa a EXIGIR token valido (fail-closed) -> IDOR fechado
 *
 * Segredo: MEDIA_URL_SECRET com fallback p/ JWT_SECRET (presente em api e
 * worker, garantindo tokens compativeis entre os dois servicos).
 */
@Injectable()
export class MediaUrlService {
  private readonly logger = new Logger(MediaUrlService.name);
  private readonly secret =
    process.env.MEDIA_URL_SECRET || process.env.JWT_SECRET || '';
  // Validade do link. O front regenera o token toda vez que carrega a conversa,
  // entao nao precisa ser longa; 7 dias cobrem reuso/cache com folga.
  private readonly defaultTtlMs = 7 * 24 * 60 * 60 * 1000;

  constructor() {
    if (!this.secret) {
      this.logger.warn(
        '[MEDIA-URL] Nenhum MEDIA_URL_SECRET/JWT_SECRET configurado — tokens de midia ficarao fracos.',
      );
    }
  }

  /** Gera { token, exp } para um messageId. */
  sign(messageId: string, ttlMs: number = this.defaultTtlMs): { token: string; exp: number } {
    const exp = Date.now() + ttlMs;
    return { token: this.hmac(messageId, exp), exp };
  }

  /** Querystring assinada pronta pra anexar: `token=...&exp=...`. */
  signedQuery(messageId: string): string {
    const { token, exp } = this.sign(messageId);
    return `token=${token}&exp=${exp}`;
  }

  /** Valida o par token/exp para o messageId (timing-safe, checa expiracao). */
  verify(messageId: string, token?: string, exp?: string | number): boolean {
    if (!token || exp === undefined || exp === null || exp === '') return false;
    const expNum = typeof exp === 'string' ? Number(exp) : exp;
    if (!Number.isFinite(expNum) || Date.now() > expNum) return false;
    const expected = this.hmac(messageId, expNum);
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private hmac(messageId: string, exp: number): string {
    return crypto
      .createHmac('sha256', this.secret)
      .update(`${messageId}.${exp}`)
      .digest('hex');
  }
}
