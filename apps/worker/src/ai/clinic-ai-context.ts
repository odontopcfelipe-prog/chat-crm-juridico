import { Logger } from '@nestjs/common';
import {
  AI_CLINIC_HOURS_KEY,
  DEFAULT_AI_CHIP_PROFILE,
  aiProfileKey,
  formatClinicHours,
  formatTenantAddress,
  isAiChipPurpose,
  normalizeAiChipProfile,
  normalizeClinicHours,
  type AiChipProfile,
  type ClinicHours,
} from '@crm/shared';

/**
 * Contexto da CLÍNICA pra IA — perfil do chip + dados de contato do tenant.
 *
 * Tudo POR CLÍNICA (nunca global, nunca de outro tenant):
 *   - profile:   TenantSetting AI_PROFILE_<PURPOSE> (nome da assistente, assinatura,
 *                tamanho das respostas, instruções do canal). Sem purpose válido → padrão.
 *   - firmName / phone / address: do próprio Tenant (endereço via formatTenantAddress).
 *   - hoursText: TenantSetting AI_CLINIC_HOURS (dias/horários estruturados) e, se
 *                não houver, o texto livre Tenant.business_hours.
 *
 * As skills no banco são GLOBAIS e falam "Sophia do Instituto Odonto Passos" fixo —
 * por isso nome da assistente/clínica vêm DAQUI e são reafirmados no fim do prompt.
 *
 * Tolerante a erro: qualquer falha → log + defaults (a IA segue respondendo).
 * O tenant '00000000-0000-0000-0000-000000000000' é o Instituto (clínica real):
 * é tratado como qualquer outro tenant aqui.
 */
export interface ClinicAiContext {
  profile: AiChipProfile;
  /** Nome da clínica ('' se o tenant não foi encontrado). */
  firmName: string;
  phone: string;
  address: string;
  hoursText: string;
  /** Grade estruturada (AI_CLINIC_HOURS) — null se a clínica não cadastrou. */
  hours: ClinicHours | null;
}

const logger = new Logger('ClinicAiContext');

export async function loadClinicAiContext(
  prisma: any,
  tenantId: string | null | undefined,
  purpose: string | null | undefined,
): Promise<ClinicAiContext> {
  const ctx: ClinicAiContext = {
    profile: { ...DEFAULT_AI_CHIP_PROFILE },
    firmName: '',
    phone: '',
    address: '',
    hoursText: '',
    hours: null,
  };
  if (!tenantId) return ctx;

  const profileKey = isAiChipPurpose(purpose) ? aiProfileKey(purpose) : null;
  try {
    const [tenant, hoursRow, profileRow] = await Promise.all([
      prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          name: true,
          phone: true,
          address: true,
          address_number: true,
          address_complement: true,
          neighborhood: true,
          city: true,
          state: true,
          zip_code: true,
          business_hours: true,
        },
      }),
      prisma.tenantSetting.findUnique({
        where: { tenant_id_key: { tenant_id: tenantId, key: AI_CLINIC_HOURS_KEY } },
      }),
      profileKey
        ? prisma.tenantSetting.findUnique({
            where: { tenant_id_key: { tenant_id: tenantId, key: profileKey } },
          })
        : null,
    ]);

    if (profileRow?.value) ctx.profile = normalizeAiChipProfile(profileRow.value);
    ctx.firmName = String(tenant?.name || '').trim();
    ctx.phone = String(tenant?.phone || '').trim();
    ctx.address = formatTenantAddress(tenant);
    ctx.hours = normalizeClinicHours(hoursRow?.value);
    ctx.hoursText = formatClinicHours(ctx.hours) || String(tenant?.business_hours || '').trim();
  } catch (e: any) {
    logger.warn(
      `[AI] Falha ao carregar contexto da clínica (tenant=${tenantId}, purpose=${purpose || '-'}): ${e?.message} — usando padrão`,
    );
  }
  return ctx;
}
