/**
 * Configuração da pesquisa pós-atendimento (NPS) POR CONTA.
 *
 * Lê `POST_CARE_CONFIG_<tenantId>`; sem ela, a conta legada herda a global antiga
 * `POST_CARE_CONFIG` (como antes) e a conta nova fica no padrão do código. Grava
 * SEMPRE na chave da conta — a global antiga não é mais escrita pelas telas.
 *
 * Funções puras com o Prisma por parâmetro: o FollowupService (Central de
 * Disparos) usa sem injetar o PostCareService (sem import novo entre módulos).
 */
import {
  POST_CARE_CONFIG_CAMPOS,
  POST_CARE_CONFIG_KEY,
  lerConfigDaConta,
  postCareConfigKey,
} from '@crm/shared';
import type { PostCareConfig } from './post-care-templates';

type PrismaLeitura = Parameters<typeof lerConfigDaConta>[0];
type PrismaEscrita = {
  globalSetting: {
    upsert(args: {
      where: { key: string };
      create: { key: string; value: string };
      update: { value: string };
    }): Promise<unknown>;
  };
};

function parse(raw: string | null): Record<string, any> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * JSON efetivo da conta (sem o padrão aplicado): a chave da conta; senão a
 * global antiga se a conta for legada; senão null. Sem conta: a global antiga.
 */
export async function lerPostCareConfigBruta(
  prisma: PrismaLeitura,
  tenantId: string | null | undefined,
  avisar?: (msg: string) => void,
): Promise<Record<string, any> | null> {
  return parse(await lerConfigDaConta(prisma, POST_CARE_CONFIG_KEY, tenantId, avisar));
}

/**
 * Só os 8 campos da configuração, e só os que vieram. Campo a mais é IGNORADO
 * (nunca recusado): a tela devolve o objeto inteiro que recebeu do GET.
 */
export function escolherCamposPostCare(corpo: unknown): Partial<PostCareConfig> {
  const fonte = corpo && typeof corpo === 'object' ? (corpo as Record<string, unknown>) : {};
  const saida: Record<string, unknown> = {};
  for (const campo of POST_CARE_CONFIG_CAMPOS) {
    if (Object.prototype.hasOwnProperty.call(fonte, campo) && fonte[campo] !== undefined) {
      saida[campo] = fonte[campo];
    }
  }
  return saida as Partial<PostCareConfig>;
}

/** Grava o JSON na chave DA CONTA (nunca na global antiga). */
export async function gravarPostCareConfigDaConta(
  prisma: PrismaEscrita,
  tenantId: string,
  cfg: Record<string, unknown>,
): Promise<void> {
  const key = postCareConfigKey(tenantId);
  const value = JSON.stringify(cfg);
  await prisma.globalSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}
