/**
 * F0b — envio SEM chip na API: o chip padrão do servidor só serve à clínica
 * DONA dele (espelho do apps/worker/src/admin-alerts/env-chip.ts).
 *
 * Antes, sendText/sendMedia sem chip caíam no chip padrão (GlobalSetting ou env
 * EVOLUTION_INSTANCE_NAME, vazia → 'whatsapp') — o número de UMA clínica — para
 * o paciente de QUALQUER clínica, inclusive na consulta do número
 * (chat/whatsappNumbers). Agora, para um envio sem chip:
 *   - sem clínica: null — não envia (todo chamador da API tem a clínica à mão);
 *   - override legado DA clínica (TenantSetting EVOLUTION_INSTANCE_NAME): ele,
 *     como hoje;
 *   - senão o chip padrão do servidor (GlobalSetting || env || 'whatsapp'), SÓ
 *     se a clínica for a dona dele: Instance.tenant_id → Inbox.tenant_id →
 *     (chip sem registro ou sem dono) a clínica mais antiga, que é quem sempre
 *     usou esse chip;
 *   - outra clínica, ou falha ao conferir o dono: null + log — NÃO envia.
 *     Nunca escolhe outro chip (não cria envio novo por número nenhum).
 *
 * Prisma por parâmetro, sem injetar serviço (ver CLAUDE.md: ciclo de DI).
 */
import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@crm/shared';

const logger = new Logger('EnvioChip');
const CACHE_MS = 60_000;
let cache: { chip: string; owner: string | null; ate: number } | null = null;

type PrismaChip = Pick<PrismaClient, 'instance' | 'tenant' | 'tenantSetting' | 'globalSetting'>;

async function donoDoChip(prisma: PrismaChip, chip: string): Promise<string | null> {
  if (cache && cache.chip === chip && cache.ate > Date.now()) return cache.owner;
  const inst = await prisma.instance.findUnique({
    where: { name: chip },
    select: { tenant_id: true, inbox: { select: { tenant_id: true } } },
  });
  let owner = inst?.tenant_id ?? inst?.inbox?.tenant_id ?? null;
  if (!owner) {
    const maisAntiga = await prisma.tenant.findFirst({ orderBy: { created_at: 'asc' }, select: { id: true } });
    owner = maisAntiga?.id ?? null;
  }
  cache = { chip, owner, ate: Date.now() + CACHE_MS };
  return owner;
}

/**
 * Chip para um envio SEM chip da clínica `tenantId`, ou null (não envia).
 * `contexto` só entra no log (ex.: 'sendText').
 */
export async function chipPadraoDaClinica(
  prisma: PrismaChip,
  tenantId: string | null | undefined,
  contexto: string,
): Promise<string | null> {
  if (!tenantId) {
    logger.warn(`[envio-chip] ${contexto}: sem chip e sem clínica — não envia`);
    return null;
  }
  // Override legado DA própria clínica (igual hoje: lido antes do chip do servidor).
  const legado = await prisma.tenantSetting
    .findUnique({
      where: { tenant_id_key: { tenant_id: tenantId, key: 'EVOLUTION_INSTANCE_NAME' } },
      select: { value: true },
    })
    .catch(() => null);
  if (legado?.value) return legado.value;

  const global = await prisma.globalSetting
    .findUnique({ where: { key: 'EVOLUTION_INSTANCE_NAME' }, select: { value: true } })
    .catch(() => null);
  const chip = global?.value || process.env.EVOLUTION_INSTANCE_NAME || 'whatsapp';
  let owner: string | null;
  try {
    owner = await donoDoChip(prisma, chip);
  } catch (e: any) {
    // Sem como conferir o dono: não arrisca mandar pelo número de outra clínica.
    logger.warn(`[envio-chip] ${contexto}: falha ao conferir o dono do chip padrão (${e?.message}) — não envia`);
    return null;
  }
  if (owner === tenantId) return chip;
  logger.warn(`[envio-chip] ${contexto}: clínica ${tenantId} sem chip próprio — o chip padrão (${chip}) é de outra clínica, não envia`);
  return null;
}

/** Só para testes. */
export function __limparCacheEnvChip() {
  cache = null;
}
