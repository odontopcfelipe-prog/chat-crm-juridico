/**
 * F1 do laboratório — tipo de negócio da conta (tenant): CLÍNICA ou LABORATÓRIO.
 *
 * O laboratório de prótese é o MESMO sistema da clínica com outros nomes, e os
 * dados das duas nunca se cruzam (cada conta é um tenant). O tipo mora na tabela
 * TenantBusinessProfile; conta SEM linha é clínica — todas as contas de hoje.
 *
 * Regra de ouro: só o valor EXATO 'LABORATORIO' liga o caminho do laboratório.
 * Qualquer outra coisa (ausente, null, '', minúsculas, espaço sobrando, objeto,
 * número) é CLÍNICA, para que nenhum dado torto mude o que a clínica vê ou envia.
 *
 * Módulo puro (sem Prisma, sem Nest): API, worker e web importam daqui.
 */
import { canAccessRoute, type Permission } from './sectors.config';

export const BT_CLINICA = 'CLINICA' as const;
export const BT_LABORATORIO = 'LABORATORIO' as const;
export type BusinessType = typeof BT_CLINICA | typeof BT_LABORATORIO;

/** true SÓ para o valor exato 'LABORATORIO'. */
export function isLab(bt: unknown): boolean {
  return bt === BT_LABORATORIO;
}

/** Qualquer valor → 'CLINICA' | 'LABORATORIO' (na dúvida, clínica). */
export function normalizeBusinessType(bt: unknown): BusinessType {
  return isLab(bt) ? BT_LABORATORIO : BT_CLINICA;
}

/**
 * Escolhe o texto/valor pelo tipo de negócio: pickBt(bt, daClinica, doLab).
 * O 1º argumento é o que a clínica vê HOJE e não pode mudar — o CI confere
 * (scripts/ci/check-pick-literals.mjs). Consts de texto do lab começam com LAB_.
 */
export function pickBt<T>(bt: unknown, clinica: T, lab: T): T {
  return isLab(bt) ? lab : clinica;
}

/**
 * Tipo de negócio a partir do payload do JWT / req.user. O token de clínica NÃO
 * carrega o tipo (o payload da clínica fica idêntico — retrato auth-payload);
 * só o token de laboratório levará o claim `bt`. Sem claim = clínica.
 */
export function resolveBtFromJwtPayload(payload: unknown): BusinessType {
  if (!payload || typeof payload !== 'object') return BT_CLINICA;
  return normalizeBusinessType((payload as { bt?: unknown }).bt);
}

/**
 * Lê o payload de um JWT SEM verificar a assinatura — só para decidir o que a
 * tela mostra; quem autoriza é o servidor. Pega o 2º segmento (base64url),
 * decodifica e devolve o objeto. Qualquer falha (sem token, segmento faltando,
 * base64 ou JSON inválido, resultado que não é objeto plano) devolve null.
 */
export function decodeJwtPayload(token: unknown): Record<string, unknown> | null {
  try {
    if (typeof token !== 'string') return null;
    const segmento = token.split('.')[1];
    if (!segmento) return null;
    let b64 = segmento.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const g = globalThis as { atob?: (dado: string) => string };
    if (typeof g.atob !== 'function') return null;
    const payload: unknown = JSON.parse(g.atob(b64));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const proto = Object.getPrototypeOf(payload);
    if (proto !== Object.prototype && proto !== null) return null;
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Tipo de negócio direto do JWT (string do localStorage). Token ilegível = clínica. */
export function resolveBtFromToken(token: unknown): BusinessType {
  return resolveBtFromJwtPayload(decodeJwtPayload(token));
}

/**
 * Entrada da lista de rotas do laboratório:
 *   - string = prefixo de caminho por segmento ('/atendimento/chat' abre também
 *     '/atendimento/chat/abc', mas não '/atendimento/chat-antigo');
 *   - { path, exact: true } = só aquela rota (com ou sem barra final, query ou #).
 */
export type LabRouteEntry = string | Readonly<{ path: string; exact: true }>;

/**
 * Rotas que um usuário de LABORATÓRIO pode acessar. Negação por padrão: tela
 * fora desta lista fica fechada no laboratório, e cada tela entra aqui só
 * quando estiver pronta para ele. '/atendimento' e '/atendimento/settings' são
 * EXATAS: como prefixo, abririam todas as telas de baixo delas.
 * A clínica não passa por esta lista (ver canAccessRouteBt).
 * (O nome não começa com LAB_ de propósito: LAB_* é reservado a TEXTO de lab.)
 */
export const ALLOWED_LAB_ROUTES: readonly LabRouteEntry[] = Object.freeze([
  Object.freeze({ path: '/atendimento', exact: true as const }),
  '/atendimento/chat',
  '/atendimento/split',
  '/atendimento/dashboard',
  '/atendimento/caixa',
  '/atendimento/ponto',
  Object.freeze({ path: '/atendimento/settings', exact: true as const }),
  '/atendimento/settings/whatsapp',
  '/atendimento/settings/inboxes',
  '/atendimento/settings/canned-responses',
  '/atendimento/settings/notifications',
  '/atendimento/settings/identidade',
  '/atendimento/settings/ponto',
]);

/** Caminho sem query/# e sem barra final ('/' continua '/'). */
function semSobra(caminho: string): string {
  return caminho.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
}

/** O laboratório pode abrir esta rota? Só se ela casar com uma entrada da lista. */
export function labAllowsRoute(path: unknown, allowlist: readonly LabRouteEntry[] = ALLOWED_LAB_ROUTES): boolean {
  if (typeof path !== 'string' || !path.startsWith('/')) return false;
  const limpo = semSobra(path);
  return allowlist.some((p) => {
    if (typeof p === 'string') {
      const base = p.replace(/\/+$/, '') || '/';
      return limpo === base || limpo.startsWith(`${base}/`);
    }
    if (!p || typeof p !== 'object' || p.exact !== true || typeof p.path !== 'string') return false;
    return limpo === semSobra(p.path);
  });
}

/**
 * Acesso por tela com o tipo de negócio: a regra de sempre (canAccessRoute) e,
 * SÓ no laboratório, também a lista de rotas do laboratório. Para a clínica
 * (bt diferente de 'LABORATORIO') é exatamente canAccessRoute.
 */
export function canAccessRouteBt(pathname: string, has: (perm: Permission) => boolean, bt: unknown): boolean {
  return canAccessRoute(pathname, has) && (!isLab(bt) || labAllowsRoute(pathname));
}
