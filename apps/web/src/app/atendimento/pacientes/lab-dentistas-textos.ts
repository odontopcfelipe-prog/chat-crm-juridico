/**
 * F5 do laboratório — textos do LABORATÓRIO da lista de clientes ("Dentistas"), do
 * cadastro (Novo cliente e Editar), da ficha e do histórico. F8: a ficha do cliente
 * (CRO, razão social ou clínica onde atende, dentistas que pedem trabalhos, contato e
 * entrega), o aviso de telefone de outro cliente e o "Inativo" de 90 dias sem orçamento.
 *
 * Só texto. A clínica não usa nada daqui: a lista, a ficha e o histórico escolhem pelo
 * tipo de negócio da sessão (`lab ? LAB_X.y : 'texto de hoje da clínica'`), e o cadastro
 * do laboratório (LabClienteModal) só existe no laboratório. Este arquivo só tem consts
 * LAB_*: fica sob as travas de scripts/ci/check-pick-literals.mjs, e nenhum texto fora
 * delas pode entrar aqui.
 *
 * Menus e títulos dizem "Dentistas"; as frases dizem "cliente" (o cliente do laboratório
 * pode ser um dentista ou uma clínica).
 */
import type { TipoCliente } from '@crm/shared';

/** Cadastro do cliente (LabClienteModal). */
export const LAB_CADASTRO = Object.freeze({
  tituloNovo: 'Novo cliente',
  tituloEditar: 'Editar dados do cliente',
  fechar: 'Fechar',
  identificacao: 'Identificação',
  tipo: 'Tipo',
  tipos: Object.freeze<Record<TipoCliente, string>>({ DENTISTA: 'Dentista', CLINICA: 'Clínica' }),
  tipoDica: 'Dentista: CPF (opcional) e CRO (obrigatório). Clínica: CNPJ (obrigatório) e CRO (opcional).',
  nome: 'Nome',
  nomeExemplo: Object.freeze<Record<TipoCliente, string>>({ DENTISTA: 'Ex.: Dra. Ana Souza', CLINICA: 'Ex.: Clínica Sorriso' }),
  whatsapp: 'WhatsApp',
  ddiDica: 'Código do país (DDI). 55 = Brasil',
  telefoneExemplo: '(82) 99999-9999',
  cpf: 'CPF',
  cnpj: 'CNPJ',
  opcional: 'opcional',
  cpfExemplo: '000.000.000-00',
  cnpjExemplo: '00.000.000/0000-00',
  cnpjDica: 'Aceita letras nas 12 primeiras posições (CNPJ alfanumérico).',
  // F8 — ficha do cliente (CRO, razão social ou clínica onde atende)
  cro: 'CRO',
  croUf: 'UF do CRO',
  croExemplo: 'Ex.: 12345',
  croDica: 'Só os números da inscrição no CRO.',
  razaoSocial: 'Razão social',
  razaoSocialExemplo: 'Ex.: Sorriso Odontologia Ltda.',
  clinicaOndeAtende: 'Clínica onde atende',
  clinicaOndeAtendeExemplo: 'Ex.: Clínica Sorriso',
  /** Aviso, sem bloquear o salvar, quando o WhatsApp digitado já é de outro cadastro. */
  telefoneDeOutroCliente: (nome: string) =>
    `Este telefone já é de outro cliente: ${nome}. Dá para salvar assim mesmo, mas as conversas do WhatsApp deste número continuam no cadastro de ${nome}.`,
  semNome: 'sem nome',
  email: 'E-mail',
  endereco: 'Endereço',
  cep: 'CEP',
  buscandoCep: '(buscando...)',
  cepExemplo: '00000-000',
  logradouro: 'Logradouro',
  numero: 'Número',
  complemento: 'Complemento',
  bairro: 'Bairro',
  cidadeUf: 'Cidade / UF',
  cidade: 'Cidade',
  uf: 'UF',
  // F8 — dentistas que pedem trabalhos (só clínica)
  dentistas: 'Dentistas que pedem trabalhos',
  dentistasDica: 'Quem manda trabalhos em nome deste cliente. O orçamento e a cobrança saem no nome do cadastro.',
  dentistaExemplo: 'Ex.: Dr. Carlos Lima',
  adicionarDentista: 'Adicionar',
  removerDentista: (nome: string) => `Remover ${nome}`,
  semDentistas: 'Nenhum dentista na lista.',
  dentistasLimite: (n: number) => `No máximo ${n} nomes.`,
  // F8 — contato e entrega
  contatoEntrega: 'Contato e entrega',
  contatoNome: 'Pessoa de contato',
  contatoNomeExemplo: 'Ex.: Maria, da recepção',
  contatoTelefone: 'Telefone do contato',
  contatoTelefoneInvalido: 'Telefone inválido (DDD + número)',
  entrega: 'Observações de entrega',
  entregaExemplo: 'Ex.: entregar na recepção, de segunda a sexta, das 8h às 12h',
  // F8 — carga e gravação da ficha do cliente (feita depois do cadastro, como a foto)
  perfilCarregando: 'Carregando CRO, contato e entrega...',
  perfilNaoCarregou: 'Não deu para carregar CRO, contato e entrega agora. Os outros dados podem ser salvos; esses ficam como estão.',
  perfilFalhouNovo: (motivo: string) => `Cliente cadastrado, mas CRO, contato e entrega não foram salvos: ${motivo}`,
  perfilFalhouNovoPadrao: 'complete pelo Editar da ficha do cliente',
  perfilFalhouEditar: (motivo: string) => `Dados salvos, mas CRO, contato e entrega não foram salvos: ${motivo}`,
  perfilFalhouEditarPadrao: 'tente salvar de novo',
  observacoes: 'Observações',
  observacoesExemplo: 'Ex.: prefere contato pela manhã, etc.',
  foto: 'Foto do cliente',
  fotoSelecionada: 'Foto selecionada',
  fotoDica: 'Opcional · JPG, PNG ou WebP · máx 2 MB',
  escolherFoto: 'Escolher foto',
  trocarFoto: 'Trocar foto',
  removerFoto: 'Remover',
  fotoSoImagem: 'Apenas imagens (JPG, PNG, WebP)',
  fotoMaxima: 'Máximo 2 MB',
  cancelar: 'Cancelar',
  cadastrar: 'Cadastrar',
  salvar: 'Salvar',
  /** Nome de cada campo nos avisos de "Preencha" e "Corrija". */
  campos: Object.freeze({
    nome: 'Nome',
    whatsapp: 'WhatsApp',
    cnpj: 'CNPJ',
    documento: 'CPF/CNPJ',
    cep: 'CEP',
    email: 'E-mail',
    cro: 'CRO',
    croUf: 'UF do CRO',
    contatoTelefone: 'Telefone do contato',
  }),
  preencha: (campos: string) => `Preencha: ${campos}.`,
  corrija: (campos: string) => `Corrija: ${campos}.`,
  emailInvalido: 'E-mail inválido',
  cadastrado: 'Cliente cadastrado',
  fotoFalhou: (motivo: string) => `Cliente cadastrado, mas a foto falhou: ${motivo}`,
  fotoFalhouPadrao: 'tente reenviar pela ficha do cliente',
  erroCadastrar: 'Erro ao cadastrar cliente',
  atualizado: 'Dados atualizados',
  erroSalvar: 'Erro ao salvar',
  /** Telefone trocado ao editar e o contato do WhatsApp foi junto. Chave = o que a API devolve. */
  whatsappFoiJunto: Object.freeze({
    atualizado: 'O WhatsApp do cliente passou para o telefone novo.',
    unido: 'O WhatsApp do cliente passou para o telefone novo.',
  }),
  /** Telefone trocado ao editar e o contato do WhatsApp ficou no número antigo (com o motivo). */
  whatsappFicou: Object.freeze({
    numero_de_outro_paciente: 'O WhatsApp continua no número antigo: o telefone novo já é o contato de outro cliente.',
    revisar: 'O WhatsApp continua no número antigo: já existe outro contato com o telefone novo, com histórico. Avise o administrador.',
    erro: 'Dados salvos, mas o WhatsApp do cliente não passou para o telefone novo agora. Salve de novo em instantes.',
  }),
});

/** Lista de clientes (pacientes/page.tsx). */
export const LAB_LISTA = Object.freeze({
  titulo: 'Dentistas',
  tituloProprio: 'Meus dentistas',
  subtitulo: 'Cadastro e ficha dos clientes do laboratório',
  subtituloProprio: 'Clientes com trabalho seu ou que você acompanha como responsável',
  novoCliente: 'Novo cliente',
  erroCarregar: 'Erro ao carregar clientes',
  /** Dicas dos cartões (o "Inativo" do laboratório é sem orçamento há DIAS_SEM_ORCAMENTO_PARA_INATIVO dias). */
  cards: Object.freeze({
    total: 'Todos os clientes cadastrados',
    ativos: (dias: number) => `Com orçamento ou cadastro nos últimos ${dias} dias`,
    inativos: (dias: number) => `Sem orçamento há mais de ${dias} dias`,
    emAndamento: 'Em andamento',
    emAndamentoDica: 'Com trabalho em andamento',
  }),
  busca: 'Buscar por nome, CPF/CNPJ, CRO, clínica, telefone, e-mail ou etiqueta...',
  buscaSemContato: 'Buscar por nome, CPF/CNPJ, CRO, clínica ou etiqueta...',
  /** Dica do filtro de status (title do select). */
  filtroStatusDica: (dias: number) => `Inativo = sem orçamento há mais de ${dias} dias`,
  /** CRO na linha do cliente: "CRO-AL 12345" (sem UF: "CRO 12345"). */
  cro: (uf: string | null, numero: string) => (uf ? `CRO-${uf} ${numero}` : `CRO ${numero}`),
  filtroProtetico: 'Clientes de um protético (trabalhos e vendas dele)',
  todosProteticos: 'Todos os protéticos',
  apenasComTrabalho: 'Apenas com trabalho em andamento',
  vazio: 'Nenhum cliente encontrado.',
  vazioComBusca: 'Ajuste os filtros ou cadastre um novo cliente.',
  vazioSemBusca: 'Cadastre o primeiro cliente para começar.',
  /** Rótulo do documento pelo tipo (sem tipo: o documento tem outro tamanho). */
  documento: Object.freeze<Record<TipoCliente, string>>({ DENTISTA: 'CPF', CLINICA: 'CNPJ' }),
  documentoSemTipo: 'CPF/CNPJ',
  protetico: 'Protético',
  trabalhos: (n: number) => `${n} trabalho(s)`,
  /** Rodapé da paginação: "Mostrando 1–50 de 120 clientes". */
  mostrando: (de: number, ate: number, total: number) => `Mostrando ${de}–${ate} de ${total} clientes`,
  csvCabecalhos: Object.freeze(['Nome', 'CPF/CNPJ', 'Telefone', 'Email', 'Status', 'Protético', 'Tags']),
  csvArquivo: (dia: string) => `dentistas-${dia}.csv`,
});

/** Ficha do cliente (pacientes/[id]/page.tsx). */
export const LAB_FICHA = Object.freeze({
  erroCarregar: 'Erro ao carregar cliente',
  semContatoWhatsapp: 'Cliente sem contato vinculado ao WhatsApp.',
  semTelefoneFinanceiro: 'Cliente sem telefone — não dá pra abrir o chat do Financeiro.',
  semNumeroFinanceiro: 'Este laboratório não tem número do Financeiro configurado.',
  confirmarArquivar: (nome: string) => `Arquivar o cliente ${nome}? Esta ação preserva todos os dados.`,
  arquivado: 'Cliente arquivado',
  arquivarDica: 'Arquiva o cliente (preserva histórico, reversível)',
  semTelefoneConversar: 'Cliente sem telefone — cadastre antes de conversar.',
  abrirWhatsapp: 'Abrir o WhatsApp deste cliente aqui na ficha',
  falarFinanceiro: 'Abrir a conversa deste cliente no WhatsApp do Financeiro',
  emAtraso: 'Cliente com boleto em atraso — ver Financeiro',
  dadosDoCliente: 'Dados do cliente',
  tipo: 'Tipo',
  documento: 'CPF/CNPJ',
  // F8 — linhas da ficha do cliente (LabPerfilNaFicha)
  cro: 'CRO',
  /** "AL 12345" */
  croValor: (uf: string | null, numero: string | null) => [uf, numero].filter(Boolean).join(' '),
  razaoSocial: 'Razão social',
  clinicaOndeAtende: 'Clínica onde atende',
  dentistas: 'Dentistas que pedem trabalhos',
  contato: 'Contato',
  entrega: 'Entrega',
  perfilNaoCarregou: 'Não deu para carregar CRO, contato e entrega.',
  resumo: 'Resumo do cliente',
  proteticoResponsavel: 'Protético responsável',
  proteticoAtualizado: 'Protético atualizado',
});

/** Histórico do cliente (TimelineTab). */
export const LAB_HISTORICO = Object.freeze({
  /** Filtros que o laboratório mostra (os outros tipos de evento são só da clínica). */
  tipos: Object.freeze({ appointment: 'Agenda', procedure: 'Serviços', payment: 'Pagamentos' }),
  vazio: 'Sem histórico registrado ainda. A agenda, os serviços e os pagamentos deste cliente aparecem aqui.',
});
