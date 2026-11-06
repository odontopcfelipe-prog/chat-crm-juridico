/**
 * Laboratório — textos da nota fiscal de serviço (NFS-e) no servidor.
 *
 * O laboratório preenche sozinho o código do serviço (CNAE), a alíquota do ISS, o CNPJ
 * e a inscrição municipal: não há valor de reserva. A descrição padrão do serviço é
 * "Serviços de prótese dentária".
 *
 * Regras deste arquivo (scripts/ci/check-pick-literals.mjs): só consts LAB_, sem
 * vocabulário de clínica.
 */
export const LAB_NFSE = Object.freeze({
  descricaoPadrao: 'Serviços de prótese dentária',
  faltaDados:
    'Configuração de NFS-e incompleta. Informe o CNPJ, o código do serviço (CNAE) e a alíquota do ISS nas configurações da nota fiscal antes de emitir.',
  provedorInvalido: 'Provedor de NFS-e inválido.',
  cnpjInvalido: 'CNPJ inválido: informe os 14 números.',
  aliquotaInvalida: 'Alíquota do ISS inválida: informe um número entre 0 e 100.',
  valorLongoDemais: (campo: string) => `O campo ${campo} é longo demais.`,
});
