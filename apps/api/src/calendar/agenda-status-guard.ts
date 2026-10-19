/**
 * Fase 0 — regras puras de status da agenda (antifraude). Sem DI: o CalendarService
 * só importa as funções, então não mexe no construtor nem cria ciclo entre módulos.
 *
 * A agenda guarda o horário de Maceió "naive" em campo UTC (14:00 local = 14:00Z),
 * então "agora" para comparar com start_at é Date.now() - 3h.
 * ADMIN aqui é ADMIN ou SUPER_ADMIN (o chamador resolve com isAdminRole).
 */

export const AGENDA_TZ_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Fase 0 — "agora" no relógio naive da agenda. Nome próprio para não sombrear os MACEIO_OFFSET_MS locais. */
export function agoraMaceioNaive(nowMs = Date.now()): Date {
  return new Date(nowMs - AGENDA_TZ_OFFSET_MS);
}

/** Fase 0 — consulta só nasce já Atendido/Faltou/Desmarcou pelas mãos do ADMIN (visita retroativa). */
export const STATUS_INICIAIS_SO_ADMIN = ['CONCLUIDO', 'NO_SHOW', 'CANCELADO'] as const;

/** Fase 0 — depois que o dentista valida, só o ADMIN derruba a consulta para um destes. */
export const STATUS_TRAVADOS_POS_VALIDACAO = ['NO_SHOW', 'CANCELADO', 'ADIADO'] as const;

export const MSG_CRIAR_SO_ADMIN =
  'Só o administrador pode lançar um atendimento já como Atendido, Faltou ou Desmarcou. Crie como Agendado ou Chegou e mude o status depois.';

export const MSG_VALIDADA_SO_ADMIN =
  'Atendimento já validado pelo dentista — só o administrador pode marcar como Faltou, Desmarcou ou Adiado.';

/** Fase 0 — virar TAREFA tirava a consulta validada da trava e do rastro de status. */
export const MSG_TIPO_VALIDADA_SO_ADMIN =
  'Atendimento já validado pelo dentista — só o administrador pode mudar o tipo.';

/** Fase 0 — tipos que são atendimento do paciente (mesma lista do CalendarService.isClinicalEvent). */
export const TIPOS_CLINICOS = ['CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA'] as const;

/** Fase 0 — true = criar o evento clínico com este status é só para ADMIN. */
export function statusInicialBloqueado(a: { clinico: boolean; status?: string | null; isAdmin: boolean }): boolean {
  return a.clinico && !!a.status && (STATUS_INICIAIS_SO_ADMIN as readonly string[]).includes(a.status) && !a.isAdmin;
}

/** Fase 0 — true = a mudança para `para` é travada para quem não é ADMIN (vale para consulta validada ou que pode virar). */
export function mudancaTravada(a: { para: string; isAdmin: boolean }): boolean {
  return !a.isAdmin && (STATUS_TRAVADOS_POS_VALIDACAO as readonly string[]).includes(a.para);
}
