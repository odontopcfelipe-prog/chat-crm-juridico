/**
 * F6 do laboratório — textos do LABORATÓRIO da aba Orçamento da ficha do cliente
 * (LabOrcamentoTab), do seletor de serviços e elementos (AddQuoteItemModal), da tabela
 * de serviços do orçamento (QuotePanel), do resumo ao lado dos elementos, dos anexos
 * (QuoteAttachments) e das versões (QuoteVersions).
 *
 * Só texto. A clínica não usa nada daqui: cada componente escolhe pelo tipo de negócio
 * da sessão (`lab ? LAB_X.y : 'texto de hoje da clínica'`), e a aba Orçamento só existe
 * no laboratório. Este arquivo só tem consts LAB_*: fica sob as travas de
 * scripts/ci/check-pick-literals.mjs, e nenhum texto fora delas pode entrar aqui.
 *
 * "Elemento" é o dente do trabalho, na numeração FDI. Serviço sem elemento é serviço
 * por arcada e vai com a quantidade.
 */

/** Aba Orçamento da ficha do cliente (LabOrcamentoTab). */
export const LAB_ORCAMENTO = Object.freeze({
  titulo: 'Orçamentos de trabalho',
  subtitulo: 'Monte os serviços e os elementos de cada trabalho. Para enviar, aprovar e cobrar, use a aba Propostas.',
  subtituloSemPropostas: 'Monte os serviços e os elementos de cada trabalho.',
  novo: 'Novo orçamento de trabalho',
  criando: 'Criando...',
  carregando: 'Carregando orçamentos...',
  vazioTitulo: 'Nenhum orçamento de trabalho em aberto',
  vazioTexto: 'Os rascunhos e os orçamentos enviados ao cliente aparecem aqui.',
  vazioMontar: 'Use "Novo orçamento de trabalho" para montar os serviços e os elementos.',
  semNome: 'Orçamento de trabalho',
  status: Object.freeze({ DRAFT: 'Rascunho', SENT: 'Enviado' }),
  servicos: (n: number) => `${n} ${n === 1 ? 'serviço' : 'serviços'}`,
  criadoEm: (data: string) => `Criado em ${data}`,
  criadoPor: (nome: string) => `por ${nome}`,
  validoAte: (data: string) => `Válido até ${data}`,
  total: 'Total',
  abrir: 'Ver serviços',
  recolher: 'Recolher',
  carregandoServicos: 'Carregando serviços...',
  semServicos: 'Nenhum serviço neste orçamento ainda.',
  somenteLeitura: 'Este orçamento já foi enviado ao cliente. Para mudar, use "Revisar (nova versão)": o enviado é encerrado e abre um rascunho com os mesmos serviços.',
  revisar: 'Revisar (nova versão)',
  confirmarRevisar: 'Revisar este orçamento? O enviado é encerrado e abre um rascunho novo com os mesmos serviços, para ajustar e enviar de novo.',
  revisado: 'Rascunho novo aberto com os mesmos serviços',
  tabela: Object.freeze({
    elemento: 'Elemento',
    servico: 'Serviço',
    qtd: 'Qtd',
    valor: 'Valor',
    porArcada: 'por arcada',
    semNomeDoServico: '—',
  }),
  editar: 'Editar serviços e elementos',
  usarModelo: 'Usar modelo',
  verPdf: 'Ver PDF',
  gerandoPdf: 'Gerando PDF...',
  apagar: 'Apagar rascunho',
  confirmarApagar: (nome: string) => `Apagar o rascunho "${nome}"? Ele sai da lista de orçamentos do cliente.`,
  apagado: 'Rascunho apagado',
  irPropostas: 'Enviar, aprovar e cobrar na aba Propostas',
  modelos: Object.freeze({
    titulo: 'Usar modelo',
    dica: 'Os serviços do modelo entram no fim do orçamento, sem elemento. Depois, marque os elementos em "Editar serviços e elementos".',
    carregando: 'Carregando modelos...',
    vazio: 'Nenhum modelo ativo. Os modelos ficam em Configurações › Modelos de orçamento.',
    servicos: (n: number) => `${n} ${n === 1 ? 'serviço' : 'serviços'}`,
    aplicar: 'Aplicar',
    aplicado: (nome: string) => `Modelo "${nome}" aplicado`,
    fechar: 'Fechar',
  }),
  erros: Object.freeze({
    carregar: 'Não foi possível carregar os orçamentos de trabalho',
    criar: 'Não foi possível criar o orçamento de trabalho',
    detalhe: 'Não foi possível carregar o orçamento',
    apagar: 'Não foi possível apagar o rascunho',
    modelos: 'Não foi possível carregar os modelos',
    aplicar: 'Não foi possível aplicar o modelo',
    pdf: 'Não foi possível gerar o PDF',
    sessao: 'Sessão expirada — faça login novamente',
    revisar: 'Não foi possível revisar o orçamento',
  }),
});

/**
 * Seletor de serviços e elementos (AddQuoteItemModal), tabela de serviços do orçamento
 * (QuotePanel) e o resumo ao lado dos elementos (`resumo`, que vai para o
 * ResumoProcedimentos do DenteReal).
 */
export const LAB_ORC_ITENS = Object.freeze({
  tituloModal: 'Adicionar serviços ao orçamento de trabalho',
  adicionar: 'Adicionar ao orçamento',
  atualizado: 'Orçamento atualizado',
  nadaPraSalvar: 'Nada pra salvar — adicione ou remova serviços, ou edite o nome',
  selecioneServico: 'Selecione um serviço da cesta primeiro',
  aceitoMudar: 'Pra mudar os serviços, crie uma nova versão na aba Propostas.',
  enviadoMudar: 'O orçamento já foi enviado ao cliente. Pra mudar, use "Revisar (nova versão)" na aba Orçamento.',
  nomeExemplo: 'Ex.: Coroas 11 e 21, protocolo superior (opcional)',
  buscar: 'Buscar serviço pelo nome...',
  semGrupo: 'Sem grupo',
  semGrupoMinusculo: 'sem grupo',
  servico: 'serviço',
  nenhumCadastrado: 'Nenhum serviço cadastrado.',
  cadastrarTabela: 'Cadastrar tabela de serviços',
  nenhumFiltro: 'Nenhum serviço corresponde aos filtros.',
  carregando: 'Carregando serviços...',
  cestaVazia: 'Clique nos serviços da esquerda pra adicionar à cesta.',
  removerElemento: (fdi: string) => `Remover elemento ${fdi}`,
  semElemento: 'clique nos elementos acima ou use a quantidade (por arcada)',
  porElemento: '× (1/elemento)',
  rodapeElemento: ' elemento',
  rodapeServico: ' serviço',
  selecioneElementosPara: 'Selecione os elementos para',
  selecioneElementos: 'Selecione os elementos do trabalho',
  permanentes: 'Permanentes',
  deciduos: 'Decíduos',
  elementoAtivo: (fdi: string, nomes: string) => `Elemento ${fdi}${nomes ? ` — ${nomes}` : ''} · clique pra remover`,
  elementoUsado: (fdi: string, nomes: string) => `Elemento ${fdi} — ${nomes}`,
  elementoAdicionar: (fdi: string) => `Clique pra adicionar o elemento ${fdi}`,
  resumo: Object.freeze({
    titulo: 'Resumo do orçamento',
    vazio: 'Os serviços que você marcar aparecem somados aqui.',
    elemento: 'Elemento',
    elementos: 'Elementos',
    servico: 'serviço',
    servicos: 'serviços',
  }),
  confirmarRemover: 'Remover este serviço do orçamento?',
  botaoServicos: ' serviços',
  comeceTitulo: 'Comece adicionando serviços',
  comeceTexto: 'Use o botão abaixo. Os elementos se marcam em "Editar serviços e elementos".',
  colunaElemento: 'Elemento',
  colunaServico: 'Serviço',
  colunaProtetico: 'Protético',
  nenhumCorresponde: (busca: string) => `Nenhum serviço corresponde a "${busca}"`,
  editarElemento: (grupo: string) => `Clique para editar o elemento · ${grupo}`,
  informarElemento: 'Clique para informar o elemento (ex.: 12, 36). Sem elemento = serviço por arcada.',
  semElementoMarca: '—',
  elementoInvalido: 'Elemento inválido. Use a numeração FDI (11 a 48 ou 51 a 85) ou deixe vazio para serviço por arcada.',
  proteticoTitulo: 'Protético que vai fazer este serviço',
  proteticoAria: 'Protético do serviço',
  semProtetico: 'Sem protético',
});

/** Anexos do orçamento de trabalho (QuoteAttachments). */
export const LAB_ORC_ANEXOS = Object.freeze({
  categorias: Object.freeze(['Foto do caso', 'Print do escaneamento', 'Pedido do dentista', 'Cor / escala', 'Outro']),
  dica: ' Adicione fotos do caso, o print ou o PDF do escaneamento e o pedido do dentista (imagem, PDF ou DOC).',
});

/** Versão guardada do orçamento de trabalho (QuoteVersions). */
export const LAB_ORC_VERSOES = Object.freeze({
  titulo: 'SERVIÇOS',
  servico: 'Serviço',
  elemento: 'Elemento',
});
