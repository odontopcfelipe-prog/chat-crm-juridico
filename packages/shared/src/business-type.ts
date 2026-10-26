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
 * Rotas que um usuário de LABORATÓRIO pode acessar. Negação por padrão: a lista
 * começa VAZIA e cada tela/rota entra aqui só quando estiver pronta para o lab.
 * Entrada = prefixo de caminho (ex. '/atendimento/pacientes').
 * (O nome não começa com LAB_ de propósito: LAB_* é reservado a TEXTO de lab.)
 */
export const ALLOWED_LAB_ROUTES: readonly string[] = Object.freeze([]);

/** O laboratório pode abrir esta rota? Com a lista vazia, nunca. */
export function labAllowsRoute(path: unknown, allowlist: readonly string[] = ALLOWED_LAB_ROUTES): boolean {
  if (typeof path !== 'string' || !path.startsWith('/')) return false;
  const limpo = path.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  return allowlist.some((p) => {
    const base = p.replace(/\/+$/, '') || '/';
    return limpo === base || limpo.startsWith(`${base}/`);
  });
}
