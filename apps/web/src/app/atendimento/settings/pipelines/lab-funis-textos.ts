/**
 * Paridade do laboratório — textos do LABORATÓRIO na tela de funis comerciais
 * (/atendimento/settings/pipelines). O laboratório monta os funis do zero (os modelos
 * prontos são da clínica e a tela não os oferece lá); o funil de captação de dentistas
 * já nasce com a conta.
 *
 * Só texto. A clínica não usa nada daqui: a tela escolhe pelo tipo de negócio da
 * sessão (`lab ? LAB_FUNIS.x : 'texto de hoje da clínica'`). Este arquivo só tem consts
 * LAB_*: fica sob as travas de scripts/ci/check-pick-literals.mjs e nenhum texto
 * fora delas pode entrar aqui.
 */
export const LAB_FUNIS = Object.freeze({
  titulo: 'Funis comerciais',
  descricao:
    'Crie funis para acompanhar os dentistas e consultórios que podem passar a mandar trabalhos e configure as etapas de cada um.',
  vazioDescricao:
    'Crie seu primeiro funil para organizar os contatos pelas etapas da captação de dentistas e consultórios.',
  contagem: (etapas: number, contatos: number) => `${etapas} etapas · ${contatos} contatos`,

  // Alerta de contatos parados
  paradosTitulo: 'Alerta de contatos parados',
  paradosAntes: 'Exibir alerta no funil quando um contato ficar sem mensagem por pelo menos',

  // Etapa
  etapaDescricao: 'Descrição da etapa: quando mover o contato para esta etapa?',

  // Novo funil
  nomeExemplo: 'Ex: Captação de dentistas, Consultórios parceiros',
  descricaoRotulo: 'Descrição',
  descricaoExemplo: 'Para que serve este funil? Ex: "Dentistas que pediram a tabela de preços"',

  emojis: Object.freeze(['👋', '🔍', '📅', '🚗', '📄', '📋', '💬', '✨', '✅', '❌', '🎯', '🦷', '🛠️', '💰', '📱', '🏆']),
});
