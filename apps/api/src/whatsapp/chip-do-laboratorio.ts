/**
 * F9 do laboratório — um só número de WhatsApp (função Comercial) faz tudo.
 *
 * Na clínica cada função tem o seu chip e a cobrança procura o Financeiro e, sem ele,
 * o de Atendimento (função CLINICA). No laboratório, quando falta o chip da função
 * pedida, a procura continua pelas outras funções nesta ordem — nunca chip de outra
 * conta. Quem usa: WhatsappService.getInstanceForPurpose, só depois de a função pedida
 * não ter chip e de a conta ser de laboratório.
 */
export type FuncaoDoChip = 'COMERCIAL' | 'CLINICA' | 'FINANCEIRO';

const VOLTA: Readonly<Record<FuncaoDoChip, readonly FuncaoDoChip[]>> = Object.freeze({
  FINANCEIRO: Object.freeze(['CLINICA', 'COMERCIAL'] as const),
  CLINICA: Object.freeze(['COMERCIAL'] as const),
  COMERCIAL: Object.freeze([] as const),
});

/** Funções a tentar, em ordem, quando a conta de laboratório não tem chip da função pedida. */
export function voltaDoChipNoLaboratorio(funcao: FuncaoDoChip): readonly FuncaoDoChip[] {
  return VOLTA[funcao] ?? [];
}
