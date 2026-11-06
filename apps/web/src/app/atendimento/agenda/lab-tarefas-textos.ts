/**
 * Paridade do laboratório — textos do LABORATÓRIO na tela de tarefas (aba Tarefas da
 * Agenda). Hoje só o relatório impresso: a coluna do contato ligado à tarefa.
 *
 * Só texto. A clínica não usa nada daqui: a tela escolhe pelo tipo de negócio da
 * sessão (`lab ? LAB_TAREFAS.x : 'texto de hoje da clínica'`). Este arquivo só tem
 * consts LAB_*: fica sob as travas de scripts/ci/check-pick-literals.mjs e nenhum
 * texto fora delas pode entrar aqui.
 */
export const LAB_TAREFAS = Object.freeze({
  colunaContato: 'Contato',
});
