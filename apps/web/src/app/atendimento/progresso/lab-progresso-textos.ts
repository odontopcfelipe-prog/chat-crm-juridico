/**
 * Paridade do laboratório — textos do LABORATÓRIO no Progresso (o quadro do que
 * acontece com cada trabalho depois que o orçamento fecha). Só texto: a clínica não usa
 * nada daqui, quem usa escolhe pelo tipo de negócio da sessão
 * (`lab ? LAB_X.y : 'texto de hoje da clínica'`). Este arquivo só tem consts LAB_*
 * (scripts/ci/check-pick-literals.mjs).
 *
 * As etapas são as mesmas da clínica, calculadas pela agenda de visitas do laboratório
 * (coleta, prova e entrega) e pelos serviços já executados do trabalho.
 */

/** Nome de cada coluna do quadro. */
export const LAB_PROGRESSO_COLUNAS = Object.freeze({
  A_AGENDAR: 'A agendar',
  AGENDADO: 'Agendado',
  EM_TRATAMENTO: 'Em produção',
  STANDBY: 'Stand by',
  CONCLUIDO: 'Concluído',
});

export const LAB_PROGRESSO = Object.freeze({
  subtitulo: 'A jornada de cada trabalho depois que o orçamento fecha — da agenda à conclusão.',
  filtroTitulo: 'Filtrar o quadro por protético',
  todos: 'Todos os protéticos',
  semProtetico: 'Sem protético',
  protetico: 'Protético que está produzindo',
  naoSalvouProtetico: 'Não foi possível salvar o protético',
  kpiAgendar: 'A agendar',
  kpiAgendarSub: 'aguardando a 1ª visita',
  kpiParadosSub: 'em produção sem visita',
  retomar: 'Retomar o trabalho deste cliente?',
  pausar: 'Colocar este cliente em stand by?',
  tituloRetomar: 'Retomar trabalho',
  clienteSemNome: 'Cliente',
  verServicos: 'Ver serviços e orçamentos',
  servicos: 'serviços',
  trabalhoNaoMontado: 'Trabalho ainda não montado',
  orcamentosJuntos: 'orçamentos juntos',
  agendarTitulo: 'Agendar a 1ª visita deste cliente',
  visita: 'Visita',
  visitaMarcada: 'Visita marcada',
  proximaVisita: 'Próxima visita',
  semProximaVisita: 'Sem próxima visita',
  marcarProxima: 'Marcar a próxima visita deste trabalho',
  finalizado: 'Trabalho finalizado',
});

/** Janela "serviços do trabalho" (aberta pelo livro do cartão). */
export const LAB_PROGRESSO_SERVICOS = Object.freeze({
  titulo: 'Serviços',
  vazio: 'Nenhum serviço no trabalho.',
  orcamentos: 'Orçamentos',
  orcamento: 'Orçamento',
  nenhumFeito: 'Nenhum serviço feito ainda.',
});
