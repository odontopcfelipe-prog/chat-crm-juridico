/**
 * Paridade do laboratório — textos do LABORATÓRIO no quadro do funil comercial
 * (/atendimento/crm). Quem é "lead" na clínica é "contato" aqui (dentista ou
 * consultório que ainda não manda trabalhos); depois de fechar vira cliente.
 *
 * Só texto. A clínica não usa nada daqui: a tela escolhe pelo tipo de negócio da
 * sessão (`lab ? LAB_CRM.x : 'texto de hoje da clínica'`). Este arquivo só tem consts
 * LAB_*: fica sob as travas de scripts/ci/check-pick-literals.mjs e nenhum texto
 * fora delas pode entrar aqui.
 */

export const LAB_CRM = Object.freeze({
  // Cabeçalho e seletor de funil
  titulo: 'Funil comercial',
  geralContatos: 'Geral — Contatos (Comercial)',
  geralClientes: 'Geral — Clientes (dentistas)',
  contatos: (n: number) => `${n} contato${n !== 1 ? 's' : ''}`,
  clientes: (n: number) => `${n} cliente${n !== 1 ? 's' : ''}`,
  contatoSingular: 'contato',
  perdidosTitulo: 'Contatos marcados como perdidos (coluna Perdidos) — fora do total',
  buscar: 'Buscar contato…',
  ordenarScore: '⭐ Score do contato',
  exportar: 'Exportar contatos para CSV',
  erroExportar: 'Erro ao exportar contatos.',

  // Carregamento e erros
  carregando: 'Carregando contatos…',
  erroCarregar: 'Erro ao carregar contatos.',
  erroCarregarToast: 'Não foi possível carregar os contatos. Tente novamente.',
  erroMover: 'Erro ao mover contato. Tente novamente.',
  erroMoverVarios: 'Erro ao mover alguns contatos. A lista foi atualizada.',

  // Colunas do funil geral (as etapas de cada funil vêm da própria conta)
  colunasGerais: Object.freeze({
    novo: 'Novo contato',
    conversa: 'Em conversa',
    convite: 'Convite para visita',
    agendado: 'Visita agendada',
    orcamento: 'Orçamento / tabela',
    fechamento: 'Em fechamento',
    ganho: 'Cliente ativo',
    perdido: 'Perdido',
  }),
  virouCliente: 'Virou cliente',
  etapaAutomatica: 'Essa etapa é automática (orçamento criado / virou cliente).',

  // Colunas e cartões
  vazioColuna: 'Nenhum contato aqui',
  vazioPerdidos: 'Nenhum contato perdido',
  paradosTitulo: (n: number) => `${n} contato(s) parado(s) há mais de 5 dias`,
  selecionados: (n: number) => `${n} contato${n !== 1 ? 's' : ''} selecionado${n !== 1 ? 's' : ''}`,
  movidos: (n: number, etapa: string) => `${n} contato(s) movido(s) para ${etapa}.`,

  // Alerta de contatos parados
  parados: (n: number) => `${n} contato${n !== 1 ? 's' : ''}`,

  // Lista
  listaColunaContato: 'Contato',
  listaVazia: 'Nenhum contato encontrado com os filtros aplicados.',

  // Painel do contato
  historico: 'Histórico do contato',
  etapaSemNome: 'Etapa anterior',
  etapasLegado: Object.freeze<Record<string, string>>({
    INICIAL: 'Novo contato',
    NOVO: 'Novo contato',
    NEW: 'Novo contato',
    QUALIFICANDO: 'Em conversa',
    QUALIFICADO: 'Qualificado',
    QUALIFIED: 'Qualificado',
    CONTATADO: 'Em conversa',
    CONTACTED: 'Em conversa',
    EM_ATENDIMENTO: 'Em atendimento',
    AGUARDANDO_FORM: 'Aguardando formulário',
    REUNIAO_AGENDADA: 'Visita agendada',
    AGUARDANDO_DOCS: 'Aguardando documentos',
    AGUARDANDO_PROC: 'Aguardando contrato',
    PROPOSTA: 'Orçamento',
    PROPOSAL: 'Orçamento',
    FINALIZADO: 'Cliente ativo',
    GANHO: 'Cliente ativo',
    WON: 'Cliente ativo',
    PERDIDO: 'Perdido',
    LOST: 'Perdido',
  }),

  // Sem funil configurado na conta
  semFunilTitulo: 'Nenhum funil configurado',
  semFunilTexto: 'Crie o funil comercial do laboratório para organizar seus contatos em etapas.',
  semFunilLink: 'Configurar funis',

  // Zonas de soltar
  zonaFecharTitulo: 'Arraste aqui → Cliente ativo',
  zonaFecharSoltar: 'Soltar para fechar como cliente',
  zonaFecharSub: 'Contato virou cliente ✅',

  // Confirmar cliente ativo
  fecharTitulo: 'Fechar como cliente?',
  fecharAntes: 'Deseja marcar ',
  fecharMeio: ' como ',
  fecharDestaque: 'Cliente ativo',
  fecharDepois: '? Essa etapa indica que o contato passou a mandar trabalhos para o laboratório.',

  // Motivo de perda
  perdaAntes: 'Por que o contato ',
  perdaDepois: ' foi perdido?',
  motivosPerda: Object.freeze([
    'Sem interesse',
    'Preço acima do esperado',
    'Já trabalha com outro laboratório',
    'Não respondeu',
    'Poucos trabalhos no mês',
  ]),
});
