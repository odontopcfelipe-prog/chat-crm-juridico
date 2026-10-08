/**
 * Prompts usados pelo sistema de memoria.
 *
 * A fonte agora e o pacote compartilhado (packages/shared/src/memory-prompts.ts),
 * reescrito para CLINICA ODONTOLOGICA (antes era escritorio de advocacia). Este
 * arquivo so reexporta com os mesmos nomes para nao quebrar os imports dos
 * processors.
 */

export {
  BATCH_EXTRACTION_PROMPT,
  PROFILE_CONSOLIDATION_PROMPT,
  RETROACTIVE_ORG_PROMPT,
  ORG_PROFILE_CONSOLIDATION_PROMPT,
  ORG_PROFILE_INCREMENTAL_PROMPT,
} from '@crm/shared';
