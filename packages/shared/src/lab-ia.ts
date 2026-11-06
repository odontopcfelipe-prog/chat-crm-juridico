/**
 * IA no atendimento do laboratório — quando ela pode rodar numa conta de laboratório.
 *
 * Duas chaves, as duas da própria conta:
 *  - a conta em status exato 'ACTIVE' (assinatura paga ou criada pelo dono). TRIAL,
 *    SUSPENDED, DELETED, conta congelada e qualquer outro valor contam como desligado:
 *    a chave da OpenAI é compartilhada e não há limite de uso;
 *  - TenantSetting AI_ENABLED_<PURPOSE> com o valor exato 'true'. A chave global nunca
 *    entra aqui, nem WHATSAPP_AI_ENABLED nem AI_ENABLED_<PURPOSE> da GlobalSetting.
 *
 * Erro de leitura é "desligado". Só é chamado para conta de laboratório: a clínica
 * nunca passa por aqui. Funções puras com o Prisma por parâmetro (sem provider Nest).
 */
import { aiEnabledKey, isAiChipPurpose } from './ai-profile';

/**
 * Nome que a conta salvou no perfil do chip ('' = não preencheu). normalizeAiChipProfile
 * troca o vazio pelo nome padrão da clínica: o laboratório lê o salvo por aqui.
 */
export function nomeSalvoDaIa(perfil: unknown): string {
  let o: any = perfil;
  if (typeof perfil === 'string') {
    try {
      o = JSON.parse(perfil);
    } catch {
      o = null;
    }
  }
  return String(o?.assistantName ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

/** O status que libera a IA do laboratório. */
export const STATUS_QUE_LIBERA_IA = 'ACTIVE';

/** Os status em que a conta de laboratório envia mensagem automática. */
const STATUS_QUE_ENVIAM = new Set(['ACTIVE', 'TRIAL']);

const CHAVE_CONGELA_TODOS = 'LAB_FREEZE';

type PrismaContaDoLab = {
  tenant: { findUnique(args: any): Promise<{ status?: string | null } | null> };
  globalSetting: { findMany(args: any): Promise<Array<{ value?: string | null }>> };
};

type PrismaIaDoLab = PrismaContaDoLab & {
  tenantSetting: { findUnique(args: any): Promise<{ value?: string | null } | null> };
};

/** true só para o valor exato 'ACTIVE'. */
export function statusLiberaIa(status: unknown): boolean {
  return status === STATUS_QUE_LIBERA_IA;
}

/** Status da conta e as chaves de congelamento dela. Lança em erro de leitura. */
async function lerContaDoLab(prisma: PrismaContaDoLab, tenantId: string): Promise<{ status: unknown; congelada: boolean }> {
  const [tenant, chaves] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { status: true } }),
    prisma.globalSetting.findMany({
      where: { key: { in: [CHAVE_CONGELA_TODOS, `${CHAVE_CONGELA_TODOS}_${tenantId}`] } },
      select: { value: true },
    }),
  ]);
  return {
    status: tenant?.status,
    congelada: chaves.some((c) => String(c?.value ?? '').trim().toLowerCase() === 'true'),
  };
}

/** A conta de laboratório está liberada para usar a IA (status + sem congelamento)? */
export async function contaDoLabLiberaIa(prisma: PrismaIaDoLab, tenantId: unknown): Promise<boolean> {
  if (typeof tenantId !== 'string' || tenantId === '') return false;
  try {
    const { status, congelada } = await lerContaDoLab(prisma, tenantId);
    return !congelada && statusLiberaIa(status);
  } catch {
    return false;
  }
}

/**
 * A conta de laboratório pode enviar mensagem automática (cobrança, disparo, aviso de
 * agenda, e-mail)? true em ACTIVE e TRIAL. false em SUSPENDED, DELETED, qualquer outro
 * valor, conta congelada (LAB_FREEZE ou LAB_FREEZE_<conta>) e erro de leitura.
 *
 * Lê o banco a cada chamada (sem cache): a conta que volta a ficar ativa volta a enviar
 * no ciclo seguinte. Só é chamada para conta de laboratório: a clínica nunca passa aqui.
 */
export async function contaDoLabPodeEnviar(prisma: PrismaContaDoLab, tenantId: unknown): Promise<boolean> {
  if (typeof tenantId !== 'string' || tenantId === '') return false;
  try {
    const { status, congelada } = await lerContaDoLab(prisma, tenantId);
    return !congelada && STATUS_QUE_ENVIAM.has(String(status));
  } catch {
    return false;
  }
}

/** A IA deste chip está ligada nesta conta de laboratório? */
export async function chipDoLabComIa(prisma: PrismaIaDoLab, tenantId: unknown, purpose: unknown): Promise<boolean> {
  if (typeof tenantId !== 'string' || tenantId === '' || !isAiChipPurpose(purpose)) return false;
  try {
    const linha = await prisma.tenantSetting.findUnique({
      where: { tenant_id_key: { tenant_id: tenantId, key: aiEnabledKey(purpose) } },
      select: { value: true },
    });
    if (linha?.value !== 'true') return false;
  } catch {
    return false;
  }
  return contaDoLabLiberaIa(prisma, tenantId);
}

/**
 * A única conta destes ids (null e '' não contam). Ids de contas diferentes, ou
 * nenhum: null. A IA do laboratório só roda quando conversa, contato e chip são da
 * mesma conta.
 */
export function contaUnicaDaConversa(ids: readonly unknown[]): string | null {
  const contas = new Set(ids.filter((t): t is string => typeof t === 'string' && t !== ''));
  return contas.size === 1 ? [...contas][0] : null;
}
