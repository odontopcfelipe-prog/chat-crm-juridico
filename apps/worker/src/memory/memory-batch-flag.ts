/**
 * "Extração automática diária" da Base de Conhecimento — POR CONTA.
 *
 * A tela da clínica grava `MEMORY_BATCH_ENABLED_<tenantId>` (PUT /settings). Sem
 * a chave da conta, a conta legada herda a global antiga `MEMORY_BATCH_ENABLED`
 * (como antes) e a conta nova fica no padrão (ligada). Ver conta-legada.ts.
 *
 * A limpeza de duplicadas (memory-dedup) segue só com a chave global.
 * Função pura com o Prisma por parâmetro (sem provider Nest).
 */
import { lerConfigDaConta } from '@crm/shared';

export const MEMORY_BATCH_KEY = 'MEMORY_BATCH_ENABLED';

type PrismaFlag = Parameters<typeof lerConfigDaConta>[0];

/** A extração/consolidação diária está ligada para a conta? */
export async function memoryBatchLigado(
  prisma: PrismaFlag,
  tenantId: string,
  avisar?: (msg: string) => void,
): Promise<boolean> {
  const valor = await lerConfigDaConta(prisma, MEMORY_BATCH_KEY, tenantId, avisar);
  return (valor ?? 'true').toLowerCase() !== 'false';
}
