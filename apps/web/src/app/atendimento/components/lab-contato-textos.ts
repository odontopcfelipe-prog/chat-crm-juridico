/**
 * F5 do laboratório — textos do LABORATÓRIO do contato: o painel do contato
 * (LabClientPanel, que abre pelo nome do contato no chat e em Contatos, com o
 * aviso de exclusão) e o "Localizar" do topo (PatientLocatorModal).
 *
 * Só texto. A clínica não usa nada daqui: quem usa escolhe pelo tipo de negócio
 * da sessão (`lab ? LAB_X.y : 'texto de hoje da clínica'`) ou é um componente
 * que só o laboratório monta. Este arquivo só tem consts LAB_*: fica sob as
 * travas de scripts/ci/check-pick-literals.mjs, e nenhum texto fora delas pode
 * entrar aqui.
 */

/** Painel do contato no laboratório (LabClientPanel). */
export const LAB_CONTATO = Object.freeze({
  tituloContato: 'Painel do contato',
  tituloCliente: 'Painel do cliente',
  fechar: 'Fechar',
  erroAoCarregar: 'Erro ao carregar o contato.',
  // Identidade
  seloCliente: 'Cliente',
  seloContato: 'Contato',
  nomePlaceholder: 'Nome do contato',
  semNome: 'Sem nome',
  editarNome: 'Editar nome',
  emailPlaceholder: 'email@exemplo.com',
  semEmail: 'Sem e-mail',
  editarEmail: 'Editar e-mail',
  salvar: 'Salvar',
  cancelar: 'Cancelar',
  semAtendente: 'Sem atendente',
  desde: (data: string) => `Desde ${data}`,
  erroAoSalvar: 'Não foi possível salvar. Tente novamente.',
  // Notas internas
  notas: 'Notas internas',
  notaPlaceholder: 'Adicionar nota interna… (Ctrl+Enter para enviar)',
  salvarNota: 'Salvar nota',
  semNotas: 'Nenhuma nota ainda',
  excluirNota: 'Excluir nota',
  confirmarExcluirNota: 'Excluir esta nota?',
  erroAoSalvarNota: 'Não foi possível salvar a nota. Tente novamente.',
  erroAoExcluirNota: 'Não foi possível excluir a nota. Tente novamente.',
  // Histórico
  historico: 'Histórico',
  semHistorico: 'Nenhuma atividade registrada ainda',
  iniciadoEm: 'Iniciado em',
  sistema: 'Sistema',
  // Ações do rodapé
  verFicha: 'Ver ficha do cliente',
  tornarCliente: 'Tornar cliente',
  dicaTornarCliente: 'Cadastra o contato em Dentistas e move pra aba Clientes do WhatsApp',
  dicaSemNome: 'Dê um nome ao contato (no lápis ao lado do nome) antes de torná-lo cliente',
  virouCliente: 'Contato cadastrado em Dentistas e movido pra aba Clientes',
  erroAoTornarCliente: 'Não foi possível tornar o contato cliente. Tente novamente.',
  abrirNoChat: 'Abrir no chat',
  erroAoAbrirChat: 'Não foi possível abrir o chat. Confira se o contato tem um telefone válido.',
  // Exclusão (só administrador)
  excluirContato: 'Excluir contato',
  atencao: 'Atenção: ação irreversível',
  avisoExclusao:
    'Serão excluídos o contato, todas as conversas e mensagens, as notas, o histórico e as tarefas. O cadastro em Dentistas continua.',
  confirmarExclusao: 'Confirmar exclusão',
  excluindo: 'Excluindo…',
  erroAoExcluir: 'Erro ao excluir o contato. Tente novamente.',
});

/** "Localizar" do topo no laboratório (PatientLocatorModal). */
export const LAB_LOCALIZADOR = Object.freeze({
  titulo: 'Localizar dentista',
  placeholder: 'Localizar dentista (nome, telefone, CPF/CNPJ)',
  dica: 'Digite o nome, o telefone ou o CPF/CNPJ do cliente.',
  vazio: (busca: string) => `Nenhum cliente para "${busca}"`,
  documento: 'CPF/CNPJ',
});
