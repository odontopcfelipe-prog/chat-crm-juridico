/**
 * Prompts DEFAULT do resumo da clínica (OrganizationProfile).
 *
 * Fonte única: packages/shared/src/memory-prompts.ts (@crm/shared) — o worker
 * usa EXATAMENTE os mesmos textos (apps/worker/src/memory/memory-prompts.ts
 * reexporta de lá). Não copie o texto aqui: antes era uma cópia manual que ficou
 * com as instruções do escritório de advocacia enquanto o worker mudava.
 *
 * Usado pelo GET /memories/organization/settings para informar ao frontend
 * qual é o texto padrão (pra botão "Restaurar padrão" e exibir quando o admin
 * ainda não personalizou).
 *
 * As instruções de extração (diária/retroativa) e do perfil do paciente não são
 * editáveis pela tela — ficam só no shared.
 */

export {
  ORG_PROFILE_INCREMENTAL_PROMPT as DEFAULT_ORG_PROFILE_INCREMENTAL_PROMPT,
  ORG_PROFILE_CONSOLIDATION_PROMPT as DEFAULT_ORG_PROFILE_REBUILD_PROMPT,
} from '@crm/shared';

export const DEFAULT_ORG_MODEL = 'gpt-4.1';

export const AVAILABLE_ORG_MODELS = [
  { value: 'gpt-4.1', label: 'GPT-4.1 — analítico, recomendado' },
  { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini — balanceado' },
  { value: 'gpt-4o', label: 'GPT-4o — capaz' },
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini — rápido, econômico' },
  { value: 'gpt-5', label: 'GPT-5 — máxima capacidade' },
  { value: 'gpt-5-mini', label: 'GPT-5 Mini — capaz, econômico' },
];
