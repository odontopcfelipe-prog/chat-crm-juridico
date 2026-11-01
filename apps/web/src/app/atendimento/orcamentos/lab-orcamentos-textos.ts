/**
 * F6 do laboratório — textos do painel de orçamentos (/atendimento/orcamentos) na
 * conta de laboratório: "Orçamentos de trabalho" e "Propostas".
 *
 * Só texto. A clínica não usa nada daqui: o painel escolhe pelo tipo de negócio da
 * sessão (`lab ? LAB_PAINEL_ORCAMENTOS.x : 'texto de hoje da clínica'`). Este
 * arquivo só tem a const LAB_PAINEL_ORCAMENTOS: fica sob as travas de
 * scripts/ci/check-pick-literals.mjs, e nenhum texto fora dela pode entrar aqui.
 */
export const LAB_PAINEL_ORCAMENTOS = Object.freeze({
  /** Título da visão sem ?status (a visão Propostas mantém o título "Propostas"). */
  titulo: 'Orçamentos de trabalho',
  subtitulo: 'Acompanhe os orçamentos de trabalho: rascunhos, aceitos e taxa de conversão.',
  propostasAprovadas: 'Propostas aprovadas — quem fechou, por ordem. Clique na ficha pra acompanhar o trabalho.',
  vendasAprovadas: 'Vendas rápidas aprovadas — quem fechou, por ordem. Clique na ficha pra acompanhar o trabalho.',
  propostasAFazer:
    'Propostas a fazer — rascunhos a montar e enviados aguardando a decisão do cliente. Clique no cliente pra aprovar.',
  vendasAFazer:
    'Vendas rápidas a fazer — rascunhos a montar e enviados aguardando a decisão do cliente. Clique no cliente pra aprovar.',
  /** Cartão do funil (quantos clientes têm orçamento). */
  clientesComOrcamento: 'Clientes com orçamento',
  clientesUnicos: 'clientes únicos com orçamento',
  aprovadasSemValor: 'aceita + trabalho ativado',
  /** Confirmação do "Enviar" pelo WhatsApp (o servidor anexa o PDF do orçamento). */
  confirmarEnvio: (valor: string, cliente: string) =>
    `Enviar o orçamento de trabalho de ${valor} pra ${cliente} pelo WhatsApp? O PDF vai anexado.`,
  oCliente: 'o cliente',
  buscar: 'Buscar por cliente, telefone ou CPF/CNPJ...',
  /** Filtro por quem montou o orçamento. */
  semResponsavel: 'Sem responsável',
  ninguem: 'Ninguém (sem orçamentos)',
  todosResponsaveis: (n: number) => `Todos os responsáveis (${n})`,
  limparResponsavel: 'Limpar filtro de responsável',
  /** Colunas das tabelas. */
  colunaNumero: 'Nº',
  colunaProtetico: 'Protético',
  colunaCliente: 'Cliente',
  /** Botões e dicas que levam à ficha do cliente. */
  abrirOrcamento: 'Abrir o orçamento de trabalho do cliente',
  verOrcamento: 'Ver orçamento',
  abrirFicha: 'Abrir a ficha do cliente',
  abrirNegociacao: 'Abrir a negociação (aba Propostas do cliente)',
});
