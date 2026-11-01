/**
 * F6 do laboratório — textos do orçamento de trabalho no servidor: o PDF
 * (quote-pdf-laboratorio.ts), a legenda do envio pelo WhatsApp
 * (orcamento-whatsapp-laboratorio.ts) e a recusa do elemento fora da numeração FDI
 * (quotes.service.ts). Só o ramo do laboratório importa daqui; a clínica não lê
 * este arquivo.
 *
 * Regras deste arquivo (scripts/ci/check-pick-literals.mjs):
 *   - só as consts LAB_: qualquer string fora delas conta como texto de clínica num
 *     arquivo novo e reprova a trava 1;
 *   - nenhum termo da lista PROIBIDOS do script (trava 2);
 *   - valores em reais e datas chegam já formatados (quem formata é quem desenha).
 */

export const LAB_ORCAMENTO_PDF = Object.freeze({
  // ── cabeçalho da conta
  nomePadraoDaConta: 'Laboratório',
  subtitulo: 'Laboratório de prótese dentária',
  cnpjDaConta: (doc: string) => `CNPJ: ${doc}`,
  // ── título e número
  tituloDoc: (numero: string, cliente: string) => `Orçamento de trabalho nº ${numero} — ${cliente}`,
  titulo: 'ORÇAMENTO DE TRABALHO',
  numero: (numero: string) => `Nº ${numero}`,
  // ── dados do orçamento
  dadosDoOrcamento: 'DADOS DO ORÇAMENTO',
  emitidoEValidade: (emitido: string, validade: string) => `Emitido em: ${emitido}    |    Válido até: ${validade}`,
  semPrazo: 'Sem prazo definido',
  atendidoPor: (nome: string) => `Atendido por: ${nome}`,
  // ── cliente
  cliente: 'CLIENTE',
  nome: (nome: string) => `Nome: ${nome}`,
  cpfCnpj: 'CPF/CNPJ',
  cpfCnpjLinha: (doc: string) => `CPF/CNPJ: ${doc}`,
  telefone: (tel: string) => `Telefone: ${tel}`,
  email: (email: string) => `E-mail: ${email}`,
  endereco: (end: string) => `Endereço: ${end}`,
  // ── tabela de serviços
  servicos: 'SERVIÇOS',
  colServico: 'Serviço',
  colElemento: 'Elemento',
  colQtd: 'Qtd',
  colUnitario: 'Unitário',
  colTotal: 'Total',
  servicoSemNome: 'Serviço',
  semElemento: '-',
  obs: (nota: string) => `  obs: ${nota}`,
  // ── totais e condições
  subtotal: 'Subtotal:',
  desconto: (pct: string) => `Desconto${pct ? ` (${pct}%)` : ''}:`,
  descontoValor: (valor: string) => `- ${valor}`,
  total: 'TOTAL:',
  condicoes: 'CONDIÇÕES DE PAGAMENTO',
  propostaApresentada: 'PROPOSTA DE PAGAMENTO APRESENTADA',
  observacoes: 'OBSERVAÇÕES',
  anexos: 'ANEXOS DESTE ORÇAMENTO',
  anexo: (arquivo: string, categoria: string) => `• ${arquivo}${categoria ? ` [${categoria}]` : ''}`,
  anexosNota: 'Os arquivos podem ser solicitados ao laboratório.',
  // ── assinatura e rodapé
  assinatura: 'Assinatura do cliente',
  ciente: (comValores: boolean) =>
    `Ao assinar, declaro estar ciente dos serviços${comValores ? ', valores e condições' : ''} descritos neste documento.`,
  rodape: (numero: string, emitido: string, validade: string) =>
    `Orçamento nº ${numero} · Emitido em ${emitido} · Válido até ${validade}`,
  // ── nome do arquivo sem valores (servicos-<id>.pdf)
  arquivoSemValores: 'servicos',
  // ── caixa da proposta de pagamento (mesmos números da clínica, sem os nomes dela)
  oferta: Object.freeze({
    pixHeadline: (valor: string) => `PIX ou dinheiro à vista · ${valor}`,
    pixDesconto: (pct: string, desconto: string) => `Desconto de ${pct}% (${desconto}) aplicado pra pagamento imediato.`,
    valorOriginal: (total: string) => `Valor original: ${total}.`,
    boletoAvistaHeadline: (valor: string) => `Boleto à vista · ${valor}`,
    boletoAvistaDesconto: (pct: string, desconto: string) => `Desconto de ${pct}% (${desconto}) pra pagamento imediato em boleto.`,
    boletoAvistaSemDesconto: 'Pagamento imediato em boleto.',
    entradaAvista: (valor: string) => `Entrada: ${valor} (à vista)`,
    cartaoParcelas: (n: number, parcela: string, comJuros: boolean) =>
      `${n}x de ${parcela} no cartão${comJuros ? ' (juros de 3,59% a.m.)' : ' sem juros'}`,
    cartaoTotalParcelado: (total: string, juros: string | null) =>
      `Total parcelado: ${total}${juros ? ` (juros somam ${juros})` : ''}`,
    valorFinal: (valor: string, comEntrada: boolean) => `Valor final: ${valor}${comEntrada ? ' (entrada + parcelas)' : ''}`,
    cartaoHeadline: (n: number, parcela: string) => `Cartão de crédito ${n}x · ${parcela}/mês`,
    entrada: (valor: string) => `Entrada: ${valor}`,
    boletoParcelas: (n: number, parcela: string) => `${n}x de ${parcela} no boleto (1,5% a.m.)`,
    boletoTotalParcelas: (total: string, juros: string) => `Total das parcelas: ${total} (juros somam ${juros})`,
    boletoHeadline: (n: number, parcela: string) => `Boleto · ${n}x de ${parcela}/mês`,
  }),
});

export const LAB_ORCAMENTO_WHATSAPP = Object.freeze({
  saudacao: (nome: string) => `Oi, ${nome}! 👋`,
  saudacaoSemNome: 'Olá! 👋',
  pronto: (numero: string, laboratorio: string | null) =>
    `Seu orçamento nº ${numero}${laboratorio ? ` no laboratório *${laboratorio}*` : ''} está pronto:`,
  servicos: (n: number) => `📋 ${n} serviço(s)`,
  total: (valor: string) => `💰 Total: ${valor}`,
  desconto: (valor: string) => `🎁 Desconto: ${valor}`,
  validade: (data: string) => `📅 Válido até ${data}`,
  anexos: (n: number) => `📎 ${n} anexo(s) (fotos e arquivos do caso)`,
  fecho: '\nSegue o PDF com os detalhes. Qualquer dúvida, é só responder por aqui. 😊',
  statusNaoReenvia: (status: string) =>
    `Orçamento está ${status} — não pode ser reenviado. Crie um novo orçamento se precisar.`,
  semPdf: 'Não foi possível gerar o PDF do orçamento — tente enviar de novo.',
  falhaEnvio: (motivo: string) => `Falha ao enviar WhatsApp: ${motivo}. O orçamento não foi marcado como enviado.`,
  erroDesconhecido: 'erro desconhecido',
  // nota da versão gravada no histórico do orçamento
  versaoEnviada: 'Enviado via WhatsApp',
});

export const LAB_ORCAMENTO_ITENS = Object.freeze({
  elementoInvalido:
    'Elemento inválido: use a numeração FDI (11 a 48 ou 51 a 85) ou deixe vazio para serviço por arcada.',
});
