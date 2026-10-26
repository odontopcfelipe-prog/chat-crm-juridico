/**
 * F2 parte 3a do laboratório — o que a conta de laboratório pode ler da
 * GlobalSetting (chave → valor, sem conta).
 *
 * Regra: cada conta tem a sua configuração e os seus dados; o que é de todas é só
 * a PLATAFORMA (créditos/chaves de IA e modelos, servidor Evolution, SMTP, Web
 * Push e os vigias de operação). Configuração, texto, liga/desliga e conta de
 * terceiro (Asaas, ClickSign, Drive, GA4...) guardados na global são das clínicas
 * que já rodavam: o laboratório não herda, usa a dele ou o padrão do código.
 *
 * Para a clínica nada muda: ela continua lendo a global como hoje.
 *
 * Funções puras com o Prisma por parâmetro (sem provider Nest — ver CLAUDE.md:
 * ciclo de DI).
 */
import { isLabTenant } from './lab-tenants';

/**
 * Chaves da GlobalSetting que valem para TODA conta, laboratório incluído.
 *  - chaves: nome exato (maiúsculas/minúsculas contam);
 *  - prefixos: toda chave que começa assim.
 *
 * Ficam de fora (o laboratório NÃO lê): a conta Asaas da clínica dona
 * (asaas_api_key, asaas_sandbox, ASAAS_GLOBAL_OWNER_TENANT, ASAAS_BASE_URL),
 * ClickSign, Google Drive (GDRIVE_*), GA4, o chip padrão (EVOLUTION_INSTANCE_NAME),
 * o liga/desliga e o intervalo da IA das clínicas (WHATSAPP_AI_ENABLED,
 * AI_ENABLED_*, AI_COOLDOWN_SECONDS), horários, textos e modelos de mensagem.
 */
export const GLOBAIS_DA_PLATAFORMA = {
  chaves: [
    // IA: créditos/chaves e modelos
    'OPENAI_API_KEY',
    'OPENAI_ADMIN_KEY',
    'ANTHROPIC_API_KEY',
    'OPENAI_DEFAULT_MODEL',
    'AI_ROUTER_ENABLED',
    'AI_ROUTER_MODEL',
    'AI_ROUTER_PROVIDER',
    'MEMORY_EXTRACTION_MODEL',
    'MEMORY_ORG_MODEL',
    'DJEN_AI_MODEL',
    'SMILE_DESIGN_PROVIDER',
    'SMILE_DESIGN_MODEL',
    'SMILE_DESIGN_QUALITY',
    // Servidor Evolution (o chip de envio é da conta, não daqui)
    'EVOLUTION_API_URL',
    'EVOLUTION_GLOBAL_APIKEY',
    'WEBHOOK_URL',
    'EVOLUTION_BASE_URL',
    'EVOLUTION_API_KEY',
    // Segredo do endpoint de webhook do Asaas da plataforma
    'asaas_webhook_token',
    // Vigias e marcas de operação (só pausam ou registram)
    'AVATAR_AUTOBACKFILL_OFF',
    'AI_FINANCEIRO_SEND_OFF',
    'REATIVACAO_LEADS_OFF',
    'SKILLS_PURPOSE_BACKFILLED_v2',
  ],
  prefixos: ['SMTP_', 'VAPID_', 'DISK_SENTINEL_'],
} as const;

const CHAVES = new Set<string>(GLOBAIS_DA_PLATAFORMA.chaves);

/** A chave da GlobalSetting é da plataforma (vale para toda conta)? */
export function eGlobalDaPlataforma(key: unknown): boolean {
  if (typeof key !== 'string' || key === '') return false;
  if (CHAVES.has(key)) return true;
  return GLOBAIS_DA_PLATAFORMA.prefixos.some((p) => key.startsWith(p) && key.length > p.length);
}

/**
 * A conta pode usar o valor GLOBAL desta chave? Clínica: sempre (como hoje).
 * Laboratório: só se a chave for da plataforma.
 */
export function globalValeParaConta(ehLaboratorio: boolean, key: unknown): boolean {
  if (!ehLaboratorio) return true;
  return eGlobalDaPlataforma(key);
}

/**
 * Versão com a conta: pergunta se ela é laboratório (cache de 60 s de
 * getLabTenantIds) só quando a resposta depende disso. Sem conta (null, '',
 * não-texto) ou chave da plataforma: true, sem consultar nada. Nunca rejeita;
 * se a lista de laboratórios não puder ser lida, vale o último conjunto
 * conhecido (vazio = clínica, o comportamento de hoje).
 */
export async function podeLerGlobal(
  prisma: Parameters<typeof isLabTenant>[0],
  tenantId: unknown,
  key: unknown,
  avisar?: (msg: string) => void,
): Promise<boolean> {
  if (typeof tenantId !== 'string' || tenantId === '') return true;
  if (eGlobalDaPlataforma(key)) return true;
  return globalValeParaConta(await isLabTenant(prisma, tenantId, avisar), key);
}
