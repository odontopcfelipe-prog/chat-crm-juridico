/**
 * Paridade clínica → laboratório — textos da COBRANÇA AVULSA no painel do contato
 * (LabCobrancaAvulsa, dentro do LabClientPanel): o valor combinado com o cliente,
 * dividido em parcelas, que vira boleto na conta Asaas do próprio laboratório.
 *
 * Só texto. A clínica não usa nada daqui: o painel do contato do laboratório é um
 * componente que só o laboratório monta. Este arquivo só tem consts LAB_*: fica sob as
 * travas de scripts/ci/check-pick-literals.mjs.
 */

export const LAB_COBRANCA_AVULSA = Object.freeze({
  titulo: 'Cobranças avulsas',
  vazio: 'Nenhuma cobrança avulsa',
  nova: 'Nova cobrança avulsa',
  /** Nome de cada tipo gravado (o tipo gravado não muda). */
  tipos: Object.freeze<Record<string, string>>({
    CONTRATUAL: 'Cobrança avulsa',
    ENTRADA: 'Entrada',
    ACORDO: 'Acordo',
  }),
  /** Situação da cobrança (o valor gravado não muda). */
  situacoes: Object.freeze<Record<string, string>>({
    NEGOCIANDO: 'Em negociação',
    ACEITO: 'Aceita',
    RECUSADO: 'Recusada',
    CONVERTIDO: 'Convertida',
  }),
  /** Situação da parcela. */
  parcelas: Object.freeze<Record<string, string>>({
    PAGO: 'PAGO',
    ATRASADO: 'ATRASADO',
    PENDENTE: 'PENDENTE',
  }),
  trocarSituacao: 'Clique para alterar a situação',
  convertidaDica: 'Cobrança já convertida',
  valorTotal: 'Valor total (R$)',
  valorPlaceholder: '500.00',
  parcelasRotulo: 'Parcelas',
  dividirIgual: 'Dividir igual',
  adicionarParcela: '+ parcela',
  removerParcela: 'Tirar parcela',
  vencimento: 'Vencimento',
  valorDaParcela: 'Valor',
  observacoes: 'Observações (opcional)',
  salvar: 'Salvar cobrança',
  salvando: 'Salvando…',
  cancelar: 'Cancelar',
  aoFinal: 'Ao final',
  marcarPago: 'Marcar como pago',
  excluirParcela: 'Excluir parcela',
  excluirCobranca: 'Excluir esta cobrança avulsa',
  confirmarExcluirCobranca: 'Excluir esta cobrança avulsa?',
  confirmarExcluirParcela: 'Excluir esta parcela?',
  confirmarExcluirComBoleto: 'Excluir? O boleto em aberto será cancelado no Asaas.',
  confirmarPagoComBoleto: 'Esta parcela tem boleto em aberto. Registrar o pagamento dá baixa no boleto no Asaas. Continuar?',
  gerarBoleto: (n: number) => (n > 1 ? `Gerar ${n} boletos no Asaas` : 'Gerar boleto no Asaas'),
  gerando: 'Gerando…',
  abrirBoleto: 'Boleto',
  verFatura: 'Fatura',
  boletos: Object.freeze<Record<string, string>>({
    ABERTA: 'Boleto gerado',
    OVERDUE: 'Boleto vencido',
    PAGA: 'Boleto pago',
    ENCERRADA: 'Boleto cancelado',
  }),
  boletosGerados: (n: number) => (n > 1 ? `${n} boletos gerados` : 'Boleto gerado'),
  boletosEmDia: 'Os boletos destas parcelas já estavam gerados',
  geradosEmParte: (n: number, motivo: string) => `${n} boleto(s) gerado(s). O restante não saiu: ${motivo} Gere de novo para completar.`,
  semAsaasProprio: 'O laboratório ainda não tem conta Asaas própria: cadastre a chave em Configurações › Gateway de pagamento para gerar o boleto.',
  salva: 'Cobrança avulsa salva',
  paga: 'Pagamento registrado',
  erroSalvar: 'Erro ao salvar a cobrança avulsa',
  erroAtualizar: 'Erro ao atualizar a situação',
  erroExcluir: 'Erro ao excluir',
  erroPagar: 'Erro ao marcar como pago',
  erroGerar: 'Erro ao gerar a cobrança',
  preenchaParcelas: 'Preencha o valor de todas as parcelas',
  somaDiferente: 'A soma das parcelas precisa fechar com o valor total',
});
