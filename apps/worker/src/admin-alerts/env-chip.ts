/**
 * F0b — o chip padrão do servidor (env EVOLUTION_INSTANCE_NAME) só serve à
 * clínica DONA dele.
 *
 * Vários avisos (tarefa vencida, notificação por WhatsApp, follow-up legado sem
 * chip na conversa) saíam sempre por esse chip — o número de UMA clínica — para
 * a equipe e os leads de TODAS. Agora:
 *   - dono = Instance.tenant_id → Inbox.tenant_id do chip → (chip sem registro
 *     ou sem dono) a clínica mais antiga, que é quem sempre usou esse chip;
 *   - clínica dona (ou envio sem clínica, legado): o chip, como antes;
 *   - outra clínica: null + log "[alert-chip] sem chip próprio" — NÃO envia.
 *     Nunca escolhe outro chip (não cria envio novo por número nenhum).
 *
 * Prisma direto, sem injetar serviço (ver CLAUDE.md: ciclo de DI).
 */
import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@crm/shared';

const logger = new Logger('AlertChip');
const CACHE_MS = 60_000;
let cache: { chip: string; owner: string | null; ate: number } | null = null;

type PrismaChip = Pick<PrismaClient, 'instance' | 'tenant'>;

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
 * Chip padrão do servidor para um envio da clínica `tenantId`, ou null se o chip
 * é de outra clínica. `padrao` é o nome usado quando a env está vazia (cada
 * chamador já tinha o seu: 'whatsapp' ou '').
 */
export async function resolveOwnedEnvChip(
  prisma: PrismaChip,
  tenantId: string | null | undefined,
  contexto: string,
  padrao = '',
): Promise<string | null> {
  const chip = process.env.EVOLUTION_INSTANCE_NAME || padrao;
  if (!chip) return null;
  if (!tenantId) return chip;
  let owner: string | null;
  try {
    owner = await donoDoChip(prisma, chip);
  } catch (e: any) {
    // Sem como conferir o dono: não arrisca mandar pelo número de outra clínica.
    logger.warn(`[alert-chip] ${contexto}: falha ao conferir o dono do chip padrão (${e?.message}) — não envia`);
    return null;
  }
  if (owner === tenantId) return chip;
  logger.warn(`[alert-chip] ${contexto}: clínica ${tenantId} sem chip próprio — o chip padrão é de outra clínica, não envia`);
  return null;
}

/** Só para testes. */
export function __limparCacheEnvChip() {
  cache = null;
}
