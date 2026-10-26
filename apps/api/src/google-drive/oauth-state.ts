/**
 * `state` do OAuth do Google Drive: prova, no retorno do Google (rota pública),
 * que o fluxo foi aberto por um usuário logado do sistema há pouco tempo.
 *
 * Formato: `<userId em base64url>.<expira em ms>.<HMAC-SHA256 em base64url>`,
 * assinado com ENCRYPTION_KEY (ou JWT_SECRET, o mesmo segredo da criptografia
 * das configurações). Validade: 15 minutos.
 *
 * Funções puras (crypto do Node), sem provider Nest.
 */
import { createHmac, timingSafeEqual } from 'crypto';

export const OAUTH_STATE_VALIDADE_MS = 15 * 60 * 1000;

function segredo(): string | null {
  return process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || null;
}

function assinatura(conteudo: string, chave: string): string {
  return createHmac('sha256', chave).update(`gdrive-oauth-state:${conteudo}`).digest('base64url');
}

/** Gera o state para o usuário. Sem segredo configurado, falha (não abre fluxo sem prova). */
export function assinarEstadoOAuth(userId: string, agoraMs: number = Date.now()): string {
  const chave = segredo();
  if (!chave) throw new Error('Segredo ausente (ENCRYPTION_KEY/JWT_SECRET) para assinar o retorno do Google');
  if (!userId) throw new Error('Usuário ausente para assinar o retorno do Google');
  const conteudo = `${Buffer.from(userId, 'utf8').toString('base64url')}.${agoraMs + OAUTH_STATE_VALIDADE_MS}`;
  return `${conteudo}.${assinatura(conteudo, chave)}`;
}

/**
 * Confere o state do retorno do Google. Devolve o userId de quem abriu o fluxo,
 * ou null se faltar, estiver adulterado, vencido ou sem segredo configurado.
 */
export function verificarEstadoOAuth(state: unknown, agoraMs: number = Date.now()): string | null {
  const chave = segredo();
  if (!chave || typeof state !== 'string' || !state) return null;
  const partes = state.split('.');
  if (partes.length !== 3) return null;
  const [usuario64, expiraTxt, assinado] = partes;
  if (!/^\d+$/.test(expiraTxt)) return null;
  const esperado = Buffer.from(assinatura(`${usuario64}.${expiraTxt}`, chave));
  const recebido = Buffer.from(assinado);
  if (esperado.length !== recebido.length || !timingSafeEqual(esperado, recebido)) return null;
  if (Number(expiraTxt) < agoraMs) return null;
  const userId = Buffer.from(usuario64, 'base64url').toString('utf8');
  return userId || null;
}
