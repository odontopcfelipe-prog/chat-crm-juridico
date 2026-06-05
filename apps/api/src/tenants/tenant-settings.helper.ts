/**
 * Onda 17.32.80 — SaaS Fase 2: helper de leitura de settings por tenant.
 *
 * Ordem de precedencia:
 *   1. TenantSetting{tenant_id, key}      — config especifica do tenant
 *   2. GlobalSetting{key}                  — fallback compartilhado (legado)
 *   3. Env var (passada como argumento)    — ultimo recurso
 *
 * Usado pelas integracoes (Asaas, Evolution, ClickSign) pra que cada
 * tenant tenha sua propria conta sem precisar refatorar todos os
 * callers de uma vez (migracao gradual).
 *
 * Cache em memoria por tenant+key (1 min TTL) pra reduzir queries
 * em integracoes chamadas em loop.
 */
import { PrismaService } from '../prisma/prisma.service';

interface CacheEntry { value: string | null; expiresAt: number; }
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000; // 1 min

function cacheKey(tenantId: string | undefined | null, key: string): string {
  return `${tenantId || '_'}:${key}`;
}

export function invalidateTenantSetting(tenantId: string | null | undefined, key: string) {
  cache.delete(cacheKey(tenantId, key));
}

export function invalidateAllSettings() {
  cache.clear();
}

/**
 * Le um setting com fallback automatico (TenantSetting -> GlobalSetting -> envVar).
 * Retorna null se nada encontrado.
 */
export async function getTenantSetting(
  prisma: PrismaService,
  key: string,
  tenantId: string | null | undefined,
  envFallback?: string,
): Promise<string | null> {
  const ck = cacheKey(tenantId, key);
  const cached = cache.get(ck);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;

  let value: string | null = null;

  // 1. TenantSetting
  if (tenantId) {
    try {
      const ts = await prisma.tenantSetting.findUnique({
        where: { tenant_id_key: { tenant_id: tenantId, key } },
      });
      if (ts?.value) value = ts.value;
    } catch {
      // Tabela pode nao existir ainda (antes da migration) — ignora
    }
  }

  // 2. GlobalSetting fallback
  if (!value) {
    try {
      const gs = await prisma.globalSetting.findUnique({ where: { key } });
      if (gs?.value) value = gs.value;
    } catch { /* ignora */ }
  }

  // 3. Env var fallback
  if (!value && envFallback) {
    const envVal = process.env[envFallback];
    if (envVal) value = envVal;
  }

  cache.set(ck, { value, expiresAt: now + TTL_MS });
  return value;
}

/**
 * Grava um setting por tenant (override do global). Use no admin UI
 * pra cada tenant editar suas integracoes proprias.
 */
export async function setTenantSetting(
  prisma: PrismaService,
  tenantId: string,
  key: string,
  value: string,
): Promise<void> {
  await prisma.tenantSetting.upsert({
    where: { tenant_id_key: { tenant_id: tenantId, key } },
    create: { tenant_id: tenantId, key, value },
    update: { value },
  });
  invalidateTenantSetting(tenantId, key);
}

/** Remove o override do tenant — volta a usar global/env. */
export async function deleteTenantSetting(
  prisma: PrismaService,
  tenantId: string,
  key: string,
): Promise<void> {
  await prisma.tenantSetting.deleteMany({
    where: { tenant_id: tenantId, key },
  });
  invalidateTenantSetting(tenantId, key);
}
