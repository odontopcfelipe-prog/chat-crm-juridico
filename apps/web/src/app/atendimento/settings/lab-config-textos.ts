/**
 * F4 do laboratório — rótulos do menu de Configurações na conta de laboratório.
 *
 * Só texto. O layout de Configurações usa estes rótulos quando a conta é de
 * laboratório e cai no rótulo de sempre quando não há entrada aqui (a clínica
 * continua vendo exatamente o menu de hoje).
 */

/** Rótulo do item pelo href. */
export const LAB_CONFIG_POR_ROTA: Readonly<Record<string, string>> = Object.freeze({
  '/atendimento/settings/identidade': 'Identidade do laboratório',
});

/** Título da seção pelo título que a clínica vê. */
export const LAB_CONFIG_POR_SECAO: Readonly<Record<string, string>> = Object.freeze({
  'Clínica': 'Laboratório',
});
