/**
 * Paridade do laboratório — textos do LABORATÓRIO da tela Configurações → Automações
 * de Workflow e do painel "Sequências de mensagens" (LabSequencias).
 *
 * Só texto. A clínica não usa nada daqui: a tela escolhe pelo tipo de negócio da
 * sessão (`lab ? LAB_X.y : 'texto de hoje da clínica'`), e o painel de sequências só
 * existe no laboratório. Este arquivo só tem consts LAB_*: fica sob as travas de
 * scripts/ci/check-pick-literals.mjs.
 *
 * Fora do laboratório ficam o gatilho "Lead mudou de etapa" e a ação "Mover etapa do
 * lead": eles trabalham com as etapas do funil da clínica, que o laboratório não usa.
 */

/** Cabeçalho, lista vazia e mensagens da tela. */
export const LAB_AUTOMACOES = Object.freeze({
  titulo: 'Automações de Workflow',
  subtitulo: 'Regras automáticas acionadas por eventos nos contatos e conversas do laboratório',
  novaAutomacao: 'Nova automação',
  nomeDaRegra: 'Nome da regra',
  nomeExemplo: 'Ex: Avisar o time quando o contato ficar 24h sem resposta',
  quando: 'Quando (gatilho)',
  fazer: 'Fazer (ação)',
  cancelar: 'Cancelar',
  salvar: 'Salvar',
  carregando: 'Carregando...',
  vazioTitulo: 'Nenhuma automação configurada',
  vazioTexto: 'Crie regras para automatizar tarefas repetitivas',
  ativo: 'Ativo',
  pausado: 'Pausado',
  erroCarregar: 'Erro ao carregar automações',
  erroCriar: 'Erro ao criar automação',
  erroAtualizar: 'Erro ao atualizar automação',
  erroRemover: 'Erro ao remover automação',
  criada: 'Automação criada',
});

/** Gatilhos que o laboratório oferece (sem a mudança de etapa do funil da clínica). */
export const LAB_GATILHOS = Object.freeze([
  Object.freeze({ value: 'NEW_LEAD', label: 'Novo contato criado', emoji: '🆕' }),
  Object.freeze({ value: 'NO_RESPONSE_24H', label: 'Sem resposta há 24h', emoji: '⏰' }),
  Object.freeze({ value: 'NO_RESPONSE_48H', label: 'Sem resposta há 48h', emoji: '🔴' }),
  Object.freeze({ value: 'PAYMENT_OVERDUE', label: 'Pagamento vencido', emoji: '💰' }),
]);

/** Ações que o laboratório oferece (sem mover etapa; com iniciar sequência de mensagens). */
export const LAB_ACOES = Object.freeze([
  Object.freeze({ value: 'ADD_TAG', label: 'Adicionar etiqueta', emoji: '🏷️' }),
  Object.freeze({ value: 'SEND_INTERNAL_NOTE', label: 'Criar nota interna', emoji: '📝' }),
  Object.freeze({ value: 'CREATE_TASK', label: 'Criar tarefa automaticamente', emoji: '✅' }),
  Object.freeze({ value: 'ENROLL_FOLLOWUP', label: 'Iniciar sequência de mensagens', emoji: '💬' }),
]);

/** Campo de valor da ação: rótulo, exemplo e ajuda por ação. */
export const LAB_VALOR_ACAO = Object.freeze({
  etiqueta: 'Etiqueta a adicionar',
  nota: 'Texto da nota interna',
  tarefa: 'Título da tarefa a criar',
  sequencia: 'Sequência de mensagens',
  padrao: 'Valor da ação',
  exemploEtiqueta: 'ex: urgente',
  exemploNota: 'ex: Cliente sem resposta há 24h — verificar',
  exemploTarefa: 'ex: Entrar em contato com o cliente',
  tarefaAjuda: 'A tarefa será criada automaticamente com prazo de 48h vinculada ao contato/conversa.',
  escolherSequencia: 'Escolha uma sequência',
  semSequenciaLigada: 'Nenhuma sequência está ligada. Ligue uma na seção "Sequências de mensagens" abaixo para poder escolhê-la aqui.',
  sequenciaAjuda: 'O cliente é inscrito na sequência quando a regra dispara. As mensagens saem pelo WhatsApp do laboratório, com o texto que você escreveu.',
  sequenciaRemovida: 'Sequência não encontrada',
});

/** Painel "Sequências de mensagens" (LabSequencias). */
export const LAB_SEQUENCIAS = Object.freeze({
  titulo: 'Sequências de mensagens',
  subtitulo: 'Série de mensagens enviadas ao cliente em prazos definidos, depois que uma regra de automação o inscreve.',
  avisoTextoFixo: 'As mensagens são texto fixo, escrito por você. A geração de texto por IA ainda não está disponível no laboratório.',
  avisoNascemDesligadas: 'Cada sequência nasce desligada. Ligar uma sequência não envia nada sozinho: o envio só começa quando uma regra de automação "Iniciar sequência de mensagens" inscreve um cliente.',
  variavelNome: 'Use {{nome}} no texto para colocar o primeiro nome do cliente.',
  carregando: 'Carregando sequências...',
  vazioTitulo: 'Nenhuma sequência criada',
  vazioTexto: 'Crie as sequências padrão do laboratório. Elas são criadas desligadas, para você revisar os textos antes de ligar.',
  criarPadrao: 'Criar sequências padrão',
  criando: 'Criando...',
  criadasUma: 'sequência criada',
  criadasVarias: 'sequências criadas',
  nenhumaCriada: 'As sequências padrão já existem.',
  ligada: 'Ligada',
  desligada: 'Desligada',
  ligarTitulo: 'Desligada — clique para ligar',
  desligarTitulo: 'Ligada — clique para desligar',
  inscritos: 'inscritos',
  inscritoUm: 'cliente inscrito',
  inscritosVarios: 'clientes inscritos',
  passos: 'passos',
  passoUm: 'passo',
  passoRotulo: 'Passo',
  mostrarPassos: 'Ver passos',
  esconderPassos: 'Esconder passos',
  semPassos: 'Esta sequência ainda não tem passos.',
  texto: 'Texto da mensagem',
  textoExemplo: 'Ex: Olá, {{nome}}! Passando para saber se o trabalho chegou direitinho.',
  prazo: 'Prazo (horas depois do passo anterior)',
  prazoPrimeiro: 'Prazo (horas depois da inscrição)',
  salvar: 'Salvar passo',
  salvando: 'Salvando...',
  salvo: 'Passo salvo',
  textoVazio: 'Escreva o texto da mensagem antes de salvar.',
  prazoInvalido: 'Informe o prazo em horas (zero ou mais).',
  erroCarregar: 'Erro ao carregar as sequências',
  erroCriar: 'Erro ao criar as sequências padrão',
  erroLigar: 'Erro ao atualizar a sequência',
  erroSalvar: 'Erro ao salvar o passo',
});
