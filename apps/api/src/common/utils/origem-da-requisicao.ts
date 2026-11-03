import { clientIp } from '../../ponto/ponto-geo';

/** De onde veio o pedido: IP e navegador (só registro; nunca decide nada). */
export interface OrigemDaRequisicao {
  ip: string | null;
  user_agent: string | null;
}

/**
 * IP pelo mesmo leitor do relógio de ponto (atrás do Cloudflare vale o
 * cf-connecting-ip) e o navegador, os dois cortados num tamanho fixo.
 */
export function origemDaRequisicao(req: any): OrigemDaRequisicao {
  const ip = clientIp(req);
  const ua = req?.headers?.['user-agent'];
  const navegador = typeof ua === 'string' ? ua.trim().slice(0, 300) : '';
  return { ip: ip ? ip.slice(0, 64) : null, user_agent: navegador || null };
}
