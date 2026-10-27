/**
 * F2 parte 4 do laboratório — conta de laboratório CONGELADA: o guard devolve 403
 * TENANT_INACTIVE em toda rota autenticada, mesmo com o token antigo (o JWT vale
 * 365 dias e a suspensão, sozinha, só barra o login — auth.service.ts).
 *
 * Congela quando: o Tenant está SUSPENDED ou DELETED, a configuração da
 * plataforma LAB_FREEZE = 'true' (todos os laboratórios — contenção imediata, sem
 * deploy) ou LAB_FREEZE_<conta> = 'true' (só aquele). Vale em até 60 s (cache).
 *
 * Só é chamada para conta de laboratório: clínica nunca passa por aqui.
 * Função pura com o Prisma por parâmetro (sem provider Nest — ver CLAUDE.md).
 */
import { ForbiddenException } from '@nestjs/common';

const CACHE_MS = 60_000;
const STATUS_CONGELADO = new Set(['SUSPENDED', 'DELETED']);

/** Chave da plataforma que congela todos os laboratórios de uma vez. */
export const CHAVE_CONGELA_TODOS = 'LAB_FREEZE';
/** Chave da plataforma que congela um laboratório só. */
export const chaveCongelaConta = (tenantId: string) => `${CHAVE_CONGELA_TODOS}_${tenantId}`;

type PrismaCongelamento = {
  tenant: { findUnique(args: any): Promise<{ status: string } | null> };
  globalSetting: { findMany(args: any): Promise<Array<{ key: string; value: string }>> };
};

const cache = new Map<string, { congelado: boolean; ate: number }>();

/**
 * O laboratório está congelado? Cache de 60 s por conta. Se a leitura falhar,
 * fica com a última resposta conhecida (ou "não congelado") por mais 60 s e
 * avisa — a política de rotas continua valendo do mesmo jeito.
 */
export async function laboratorioCongelado(
  prisma: PrismaCongelamento,
  tenantId: string,
  avisar: (msg: string) => void = (msg) => console.warn(msg),
): Promise<boolean> {
  const agora = Date.now();
  const guardado = cache.get(tenantId);
  if (guardado && guardado.ate > agora) return guardado.congelado;
  let congelado: boolean;
  try {
    const [tenant, chaves] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { status: true } }),
      prisma.globalSetting.findMany({
        where: { key: { in: [CHAVE_CONGELA_TODOS, chaveCongelaConta(tenantId)] } },
        select: { key: true, value: true },
      }),
    ]);
    congelado =
      STATUS_CONGELADO.has(String(tenant?.status ?? '')) ||
      chaves.some((c) => String(c.value ?? '').trim().toLowerCase() === 'true');
  } catch (e) {
    congelado = guardado?.congelado ?? false;
    try {
      avisar(`[lab-congelamento] falha ao ler a conta ${tenantId}: ${(e as Error)?.message ?? e}`);
    } catch {
      // o aviso nunca derruba quem chamou
    }
  }
  if (cache.size > 1000) cache.clear();
  cache.set(tenantId, { congelado, ate: agora + CACHE_MS });
  return congelado;
}

/** Só para os testes: esquece o cache. */
export function __limparCacheCongelamento(): void {
  cache.clear();
}

/** Código da recusa da conta congelada (o front distingue da falta de permissão). */
export const CODIGO_CONTA_INATIVA = 'TENANT_INACTIVE';

export function contaInativa(): ForbiddenException {
  return new ForbiddenException({
    message: 'Acesso suspenso. Entre em contato com o suporte.',
    code: CODIGO_CONTA_INATIVA,
  });
}
