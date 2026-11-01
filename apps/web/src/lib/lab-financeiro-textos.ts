/**
 * F5 do laboratório — textos do LABORATÓRIO das telas de financeiro: o Financeiro
 * (contas a pagar, entradas e a aba Dentistas), os Boletos, os KPIs dos boletos e a
 * aba Financeiro da ficha do cliente.
 *
 * Só texto. A clínica não usa nada daqui: quem usa escolhe pelo tipo de negócio da
 * sessão (`lab ? LAB_X.y : 'texto de hoje da clínica'`). Este arquivo só tem consts
 * LAB_*: fica sob as travas de scripts/ci/check-pick-literals.mjs, e nenhum texto
 * fora delas pode entrar aqui.
 *
 * Vocabulário: "Dentistas" em títulos, colunas e abas; "cliente" nas frases;
 * "trabalho" no lugar de tratamento ou plano; "protético"; "elemento". O Validar
 * libera o trabalho para a produção.
 */

/** Financeiro (financeiro/contas-a-pagar): cabeçalho, aba de clientes, empresa e categorias. */
export const LAB_FINANCEIRO = Object.freeze({
  abaClientes: 'Dentistas',
  subtituloEmpresaSeparada: 'Empresa separada — não entra no caixa/relatórios do laboratório.',
  subtituloGestor: 'Contas, gastos, entradas e clientes do laboratório.',
  subtituloFinanceiro: 'Entradas, clientes e log do laboratório.',
  empresaPrincipal: '🔬 Laboratório',
  porCliente: 'Por cliente: sem nenhuma cobrança atrasada × com mais de 2 em aberto.',
  exemploParcelada: 'Ex: Compra de forno de cerâmica',
  pagamentoEmpresaSeparada: 'Empresa separada — o pagamento só é registrado (não entra no caixa do laboratório).',
  /** Só para exibir: o valor gravado da categoria não muda. */
  categoria: Object.freeze<Partial<Record<string, string>>>({ PROCEDIMENTO: 'Serviço' }),
});

/** Boletos (BoletosTab): chips, recebimento, CSV, cancelamento e lista. */
export const LAB_BOLETOS = Object.freeze({
  /** Nome do chip por chave (as chaves não mudam). */
  chip: Object.freeze<Partial<Record<string, string>>>({ negativados: 'Inadimplentes' }),
  pixDoLaboratorio: 'PIX do laboratório',
  clientePadrao: 'cliente',
  colunasCsv: Object.freeze([
    'Dentista',
    'Telefone',
    'CPF/CNPJ',
    'Tipo',
    'Valor',
    'Vencimento',
    'Status',
    'Dias em atraso',
    'Pago em',
    'Forma',
    'Protético',
    'Proposta',
    'ID Asaas',
  ]),
  recebidoNoLaboratorio: 'Recebido no laboratório',
  promptCancelar: (nome: string, valor: string) =>
    `CANCELAR a cobrança de ${nome} (${valor})?\n\n` +
    `Apaga o boleto NO ASAAS (o link/QR para de funcionar) e tira da inadimplência,\n` +
    `MAS ela FICA REGISTRADA no cadastro como "Cancelado", com quem/quando/motivo —\n` +
    `para eventual revisão até judicial. O cliente NÃO é avisado.\n\n` +
    `Digite o MOTIVO do cancelamento:`,
  filtroIgnoradoNaBusca: 'Filtro de status ignorado durante a busca por cliente',
  listaCortada: (carregadas: number, total: number) =>
    `lista cortada no limite — os totais por cliente consideram só ${carregadas} de ${total}; use a busca para ver um cliente específico`,
  semInadimplentes: 'Nenhum cliente inadimplente — carteira em dia 🎉',
  colunaCliente: 'Dentista',
  abrirFicha: 'Abrir a ficha financeira do cliente',
  registrarRecebimento: 'Registrar recebimento no laboratório (espécie, PIX ou cartão)',
});

/** KPIs dos boletos (BoletosKpis). */
export const LAB_KPIS_BOLETOS = Object.freeze({
  inadimplentes: 'Dentistas inadimplentes',
  subInadimplentes: (pct: string, total: number) => `${pct} dos ${total} clientes com boleto`,
  subExpectativa: (pct: string) => `${pct} do atraso · pelo histórico de cada cliente e idade da dívida`,
  clientes: 'clientes',
  subVencem: (boletos: number, clientes: number) => `${boletos} boleto(s) · ${clientes} cliente(s)`,
  noLaboratorio: 'No laboratório',
  subCarteira: (boletos: number, clientes: number) => `${boletos} boletos · ${clientes} clientes`,
  situacaoCarteira: 'Dentistas — situação da carteira',
  contaClientes: (v: number) => `${v} cliente${v === 1 ? '' : 's'}`,
  inadimplentesCurto: 'Inadimplentes',
  dosClientes: (pct: string) => `${pct} dos clientes`,
  subExpectativaRealista: (pct: string) => `${pct} do que está em aberto, pelo histórico dos clientes`,
  porPerfil: 'Dentistas por perfil — quanto cada grupo tem em aberto hoje',
  boletosPorMesPerfil: 'Total de boletos por mês (vencimento) — dividido por perfil do cliente',
  secaoBoletosPorMes: 'Boletos por mês × perfil do cliente',
});

/** Aba Financeiro da ficha do cliente (FinanceiroTab). */
export const LAB_FICHA_FINANCEIRO = Object.freeze({
  resumo: 'Resumo do cliente',
  trabalho: 'trabalho',
  trabalhos: 'trabalhos',
  promptCancelar: (valor: string) =>
    `CANCELAR esta cobrança (${valor})?\n\n` +
    `Apaga o boleto NO ASAAS (o link/QR para de funcionar) e tira da inadimplência,\n` +
    `MAS ela FICA REGISTRADA no cadastro como "Cancelado", com quem/quando/motivo —\n` +
    `para eventual revisão até judicial. O cliente NÃO é avisado.\n\n` +
    `Digite o MOTIVO do cancelamento:`,
  motivoCancelar: 'Cliente cancelou o trabalho',
  /** Sem "liberar a comissão": no laboratório o servidor não libera comissão. */
  confirmarRecebido: (valor: string, metodo: string) =>
    `Marcar como RECEBIDO (${valor})?\n\n` +
    `Use só se o cliente JÁ pagou por fora (${metodo}).\n\n` +
    `Isso vai:\n` +
    `• Fechar a cobrança no Asaas (o link/QR para de funcionar)\n` +
    `• Lançar a receita no caixa`,
  trabalhoNaoCarregado: 'Trabalho ainda não carregado — aguarde um instante.',
  eLiberaProducao: ', e libera o trabalho para a produção.',
  trabalhoLiberado: 'Trabalho liberado para a produção.',
  erroValidar: 'Erro ao validar o trabalho',
  confirmarEnvioBoletoMes: 'Enviar o boleto do mês (próximo a vencer) em PDF para o WhatsApp do cliente agora?',
  boletoEnviado: 'Boleto enviado ao cliente.',
  vendaBalcao: 'Venda de balcão',
  trabalhoRotulo: 'Trabalho',
  servicosSolicitados: 'Serviços solicitados',
  validarTitulo: 'Validar a negociação e liberar o trabalho para a produção',
  liberadoTitulo: 'Trabalho liberado pelo Financeiro para a produção',
  enviarBoletoMesTitulo: 'Enviar o boleto do mês (próximo a vencer) em PDF para o WhatsApp do cliente, na hora',
  totalDoTrabalho: 'Total do trabalho: ',
  semCobranca: '⚠ Sem cobrança gerada ainda para este trabalho.',
  darBaixaParcela: 'Cliente pagou por fora? Clique para dar baixa (fecha no Asaas + lança no caixa).',
  carregandoServicos: 'Carregando serviços...',
  nenhumServico: 'Nenhum serviço listado neste trabalho.',
  elemento: 'Elemento ',
  confirmarRecebidoLinha: (valor: string, metodo: string) =>
    `Marcar como RECEBIDO (${valor})?\n\n` +
    `Use só se o cliente JÁ pagou por fora (${metodo}).\n\n` +
    `Isso fecha a cobrança no Asaas (o link/QR para de funcionar) e lança a receita no caixa.`,
  promptCancelarLinha: (valor: string) =>
    `CANCELAR esta cobrança (${valor})?\n\n` +
    `Apaga o boleto NO ASAAS e tira da inadimplência, MAS ela FICA REGISTRADA no\n` +
    `cadastro como "Cancelado" (quem/quando/motivo) — para revisão até judicial.\n` +
    `O cliente NÃO é avisado.\n\n` +
    `Digite o MOTIVO do cancelamento:`,
  darBaixaLinha: 'Cliente pagou por fora? Dar baixa (marca pago + fecha no Asaas + lança no caixa)',
  tituloTrabalhos: 'Trabalhos',
  nenhumTrabalho: 'Nenhum trabalho ainda. Quando um trabalho for vendido, ele aparece aqui.',
  nenhumTrabalhoAtivo: 'Nenhum trabalho ativo. Todos os trabalhos deste cliente estão quitados.',
  nenhumTrabalhoQuitado: 'Nenhum trabalho quitado ainda.',
  boletoEnviadoWhatsapp: 'Boleto enviado ao cliente pelo WhatsApp.',
  elementoNaLista: ' · Elemento ',
  enviarBoletoWhatsappTitulo: 'Enviar este boleto para o WhatsApp do cliente (chip Financeiro)',
});
