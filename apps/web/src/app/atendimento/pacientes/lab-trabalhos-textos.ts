/**
 * F6 do laboratório — textos do LABORATÓRIO da ficha do cliente: nomes das abas que
 * mudam (Orçamento e Trabalhos) e a aba Trabalhos (TratamentoTab), onde o protético
 * conclui cada serviço aprovado.
 *
 * Só texto. A clínica não usa nada daqui: a ficha e a aba escolhem pelo tipo de negócio
 * da sessão (`lab ? LAB_X.y : 'texto de hoje da clínica'`). Este arquivo só tem consts
 * LAB_*: fica sob as travas de scripts/ci/check-pick-literals.mjs, e nenhum texto fora
 * delas pode entrar aqui.
 *
 * Regra das palavras: serviço (no lugar do item clínico), elemento (no lugar do dente),
 * trabalho (no lugar do plano) e protético (no lugar do dentista que executa).
 */

/** Nome das abas da ficha que mudam no laboratório (chave = id da aba). */
export const LAB_ABAS_DA_FICHA = Object.freeze({
  orcamento: 'Orçamento',
  treatment: 'Trabalhos',
});

/** Aba Trabalhos (TratamentoTab) e a dica do PDF sem valores (FinanceiroTab). */
export const LAB_TRABALHOS = Object.freeze({
  erroCarregar: 'Erro ao carregar os trabalhos',
  carregando: 'Carregando os trabalhos…',
  aguardandoFinanceiro: 'Aguardando validação do Financeiro — o trabalho ainda não foi liberado para a produção.',
  rotuloElemento: (servico: string, elemento: string) => `${servico} (elemento ${elemento})`,
  confirmarConcluir: (rotulo: string) =>
    `Marcar "${rotulo}" como serviço concluído?\n\n` +
    `• Registra você como o protético que fez\n` +
    `• Data de conclusão = agora`,
  servicoConcluido: 'Serviço concluído',
  erroConcluir: 'Erro ao concluir o serviço',
  titulo: 'Trabalhos',
  subtitulo: 'Serviços aprovados — o protético responsável conclui cada um quando terminar.',
  esconderConcluidos: 'Esconder concluídos',
  progresso: 'Progresso do trabalho',
  aguardandoValidacaoVazio: 'O trabalho foi aprovado, mas o Financeiro precisa conferir e liberar antes de aparecer aqui.',
  nenhumTrabalho: 'Nenhum trabalho aprovado ainda',
  nenhumTrabalhoDica: 'Quando um orçamento for aprovado pelo cliente, os serviços aparecem aqui.',
  trabalho: 'Trabalho',
  aprovadoEm: 'Aprovado em ',
  bloqueadoTexto: 'O Financeiro precisa conferir e liberar este trabalho para a produção antes de os serviços serem concluídos.',
  colServico: 'Serviço',
  colElemento: 'Elemento',
  colConcluidoPor: 'Concluído por',
  bloqueadoDica: '🔒 Aguardando aprovação do Financeiro — o trabalho precisa ser liberado para a produção antes de concluir os serviços',
  concluirDica: 'Concluir — marca este serviço como feito',
  servicoDe: (protetico: string | undefined) => `Serviço de ${protetico}`,
  soProteticoOuAdmin: 'Só o protético ou o administrador pode concluir',
  concluir: 'Concluir',
  concluido: 'Concluído',
  avisoLeitura: Object.freeze({
    inicio: 'Só o',
    protetico: 'protético',
    meio: 'ou o',
    administrador: 'administrador',
    fim: 'pode concluir os serviços. Sua visão é somente leitura.',
  }),
  /** Selo do serviço (só os que mudam; os outros ficam com o texto de hoje). */
  statusServico: Object.freeze<Record<string, string>>({ DONE: 'Serviço concluído' }),
  /** Selo do trabalho (só os que mudam; os outros ficam com o texto de hoje). */
  statusTrabalho: Object.freeze<Record<string, string>>({
    PENDING_SIGNATURE: 'Aguardando aprovação',
    ACTIVE: 'Em produção',
  }),
  pdfSemValoresDica: 'Baixar o PDF só com a lista de serviços (sem valores)',
});
