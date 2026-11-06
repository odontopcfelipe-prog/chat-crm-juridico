/**
 * Paridade clínica → laboratório — textos da COBRANÇA AVULSA do contato (painel do
 * contato no chat): o valor combinado com o cliente, dividido em parcelas, que vira
 * boleto na conta Asaas do próprio laboratório. É o mesmo fluxo dos honorários
 * negociados da clínica (lead-honorarios.service.ts), com outros nomes. Só o ramo do
 * laboratório importa daqui.
 *
 * Só consts LAB_ (scripts/ci/check-pick-literals.mjs): nenhum termo de clínica.
 */

export const LAB_COBRANCA_AVULSA = Object.freeze({
  /** Nome de cada tipo gravado (o tipo gravado não muda: CONTRATUAL, ENTRADA, ACORDO). */
  tipos: Object.freeze<Record<string, string>>({
    CONTRATUAL: 'Cobrança avulsa',
    ENTRADA: 'Entrada',
    ACORDO: 'Acordo',
  }),
  /** Descrição que sai no boleto e no financeiro: "<tipo> - <cliente>[ (Nx)]". */
  descricao: (tipo: string, cliente: string | null | undefined, parcelas?: number): string =>
    `${LAB_COBRANCA_AVULSA.tipos[tipo] ?? tipo} - ${(cliente || '').trim() || 'Cliente'}${parcelas && parcelas > 1 ? ` (${parcelas}x)` : ''}`,
  /** Descrição do boleto de uma parcela: "<tipo> - <cliente> (parcela 2/3)". */
  descricaoDaParcela: (tipo: string, cliente: string | null | undefined, numero: number, total: number): string =>
    `${LAB_COBRANCA_AVULSA.descricao(tipo, cliente)}${total > 1 ? ` (parcela ${numero}/${total})` : ''}`,
  contatoNaoEncontrado: 'Contato não encontrado',
  naoEncontrada: 'Cobrança avulsa não encontrada',
  parcelaNaoEncontrada: 'Parcela não encontrada',
  semParcelaPendente: 'Nenhuma parcela pendente nesta cobrança',
  erroNoAsaas: (detalhe: string) => `Não foi possível gerar o boleto: ${detalhe}`,
  asaasNaoConfirmouCancelamento: 'O Asaas não confirmou o cancelamento do boleto. Nada foi excluído: tente de novo em instantes.',
  soAdminCancelaBoleto: 'Esta parcela tem boleto em aberto. Só o administrador pode cancelar o boleto e excluir.',
  soCaixaDaBaixa: 'Esta parcela tem boleto em aberto. Só o Caixa, o Financeiro ou o administrador pode dar baixa nele.',
  boletoJaPago: 'O boleto desta parcela já foi pago: ela não pode ser excluída.',
  temParcelaPaga: 'Esta cobrança avulsa tem parcela paga: ela não pode ser excluída.',
  motivoExcluirParcela: 'Parcela da cobrança avulsa excluída',
  motivoExcluirCobranca: 'Cobrança avulsa excluída',
  contatoSemDocumento: 'O contato não tem CPF/CNPJ cadastrado. Preencha o documento no painel do contato antes de gerar a cobrança.',
});
