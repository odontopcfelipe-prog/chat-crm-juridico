/**
 * F2 parte 4 do laboratório — tipos de evento que a agenda do laboratório aceita.
 * Os outros (consulta, procedimento, retorno, ortodontia, audiência, perícia,
 * prazo) são de clínica: a agenda recusa no laboratório e a vigia diária conta
 * se aparecer algum. Negação por padrão: tipo novo de agenda fica fora até
 * entrar aqui.
 */
export const TIPOS_DE_AGENDA_DO_LABORATORIO: readonly string[] = ['TAREFA', 'OUTRO', 'BLOQUEIO'];

export function tipoDeAgendaDoLaboratorio(tipo: unknown): boolean {
  return typeof tipo === 'string' && TIPOS_DE_AGENDA_DO_LABORATORIO.includes(tipo);
}
