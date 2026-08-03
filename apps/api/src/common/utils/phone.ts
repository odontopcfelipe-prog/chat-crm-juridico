/**
 * Normalização canônica de telefone BR (55+DDD+8, sem o 9) — fonte ÚNICA no
 * @crm/shared, pra o WORKER e os scripts usarem a MESMA lógica (nunca paralela).
 * Este arquivo só RE-EXPORTA — os importadores em apps/api seguem intactos.
 */
export {
  normalizeBrazilianPhone,
  denormalizeBrazilianPhone,
  brazilPhoneMatchVariants,
} from '@crm/shared';
