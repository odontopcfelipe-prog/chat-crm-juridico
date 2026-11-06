/**
 * Paridade do laboratório — textos do LABORATÓRIO da tela Indicação Premiada
 * (cashback de indicação entre clientes).
 *
 * Só texto. A clínica não usa nada daqui: a tela escolhe pelo tipo de negócio da sessão
 * (`lab ? LAB_X.y : 'texto de hoje da clínica'`). Este arquivo só tem consts LAB_*:
 * fica sob as travas de scripts/ci/check-pick-literals.mjs.
 */
export const LAB_INDICACAO = Object.freeze({
  confirmarPago: (valor: string, nome: string | null) => `Marcar como PAGO o cashback de ${valor} pra ${nome || 'cliente'}?`,
  intro: (valor: string) =>
    `Programa de cashback: o cliente A indica o cliente B. Quando B fecha um trabalho, A ganha ${valor} pra usar como desconto na próxima parcela ou no próximo trabalho.`,
  aindaNaoFecharam: 'clientes ainda não fecharam',
  vazio: 'Nenhuma indicação registrada ainda. Quando um cliente novo for cadastrado com "indicado por outro cliente" no formulário, aparece aqui.',
  planoFechadoEm: 'Trabalho fechado em',
  validadeLabel: 'Validade (dias após o trabalho fechar)',
  valorDica: 'Valor que o indicador ganha quando o cliente novo fecha um trabalho.',
});
