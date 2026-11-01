/**
 * F2 parte 4 e F7 do laboratório — tipos de evento que a agenda do laboratório aceita
 * (a lista mora em @crm/shared, agenda-laboratorio.ts): tarefa, outro, bloqueio e
 * os tipos só do laboratório (coleta, prova e entrega). Os outros (consulta,
 * procedimento, retorno, ortodontia, audiência, perícia, prazo) são de clínica: a
 * agenda recusa no laboratório e a vigia diária conta se aparecer algum. Negação por
 * padrão: tipo novo de agenda fica fora até entrar na lista.
 */
import { BadRequestException } from '@nestjs/common';
import { TIPOS_DE_AGENDA_DO_LABORATORIO, tipoSoDoLaboratorio } from '@crm/shared';
import { MSG_TIPO_DTO } from '../calendar/dto/calendar.dto';

export { TIPOS_DE_AGENDA_DO_LABORATORIO };

export function tipoDeAgendaDoLaboratorio(tipo: unknown): boolean {
  return typeof tipo === 'string' && TIPOS_DE_AGENDA_DO_LABORATORIO.includes(tipo);
}

/**
 * Coleta, prova ou entrega pedida por uma conta de CLÍNICA: o mesmo 400 que a
 * validação do corpo dava antes desses tipos existirem (mesmo corpo de resposta).
 * Conta de laboratório e tipo de clínica passam (quem decide é o serviço).
 */
export function exigirTipoDaConta(lab: boolean, tipo: unknown): void {
  if (tipoSoDoLaboratorio(tipo) && !lab) throw new BadRequestException([MSG_TIPO_DTO]);
}
