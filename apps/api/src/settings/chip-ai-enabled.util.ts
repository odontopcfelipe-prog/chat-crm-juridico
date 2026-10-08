import { aiEnabledKey, isAiChipPurpose } from '@crm/shared';

/**
 * A IA está LIGADA neste chip, nesta clínica? Mesma regra do webhook
 * (evolution.service) e dos toggles da tela (SettingsService.getChipAiEnabledMap):
 *   1. TenantSetting AI_ENABLED_<P> da clínica;
 *   2. GlobalSetting AI_ENABLED_<P> (regra antiga, de antes de ser por clínica);
 *   3. kill switch global WHATSAPP_AI_ENABLED.
 * Função pura sobre o Prisma (sem DI) — pode ser usada em qualquer service sem
 * criar import entre módulos (ciclos de DI já derrubaram a API).
 */
export async function isChipAiEnabled(
  prisma: any,
  tenantId: string | null | undefined,
  purpose: string | null | undefined,
): Promise<boolean> {
  const kill = await prisma.globalSetting.findUnique({ where: { key: 'WHATSAPP_AI_ENABLED' } }).catch(() => null);
  const master = (kill?.value ?? 'true') !== 'false';
  if (!isAiChipPurpose(purpose)) return master;
  if (tenantId) {
    const row = await prisma.tenantSetting
      .findUnique({ where: { tenant_id_key: { tenant_id: tenantId, key: aiEnabledKey(purpose) } } })
      .catch(() => null);
    if (row) return row.value !== 'false';
  }
  const flag = await prisma.globalSetting.findUnique({ where: { key: aiEnabledKey(purpose) } }).catch(() => null);
  return flag?.value != null ? flag.value !== 'false' : master;
}
