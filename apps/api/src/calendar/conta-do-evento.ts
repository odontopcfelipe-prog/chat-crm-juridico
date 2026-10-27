/**
 * Conta de um evento da agenda (CalendarEvent), para as checagens "só da própria
 * conta" (lista, conflito de horário, rotas por id, ICS, atendimento ligado à
 * aplicação estética e ao estoque, painel).
 *
 * A conta é a gravada no evento. Evento antigo sem conta gravada pertence à conta
 * de QUEM O CRIOU (created_by): continua aparecendo e editável para essa conta, e
 * só para ela. Criado por usuário sem conta (SUPER_ADMIN), vale a conta do contato
 * e, sem ela, a do paciente do evento. Sem nenhuma dessas, o evento não é de conta
 * nenhuma: só quem entra sem conta (SUPER_ADMIN) o enxerga.
 *
 * Funções puras, sem Prisma nem provider Nest.
 */
import type { Prisma } from '@crm/shared';

/**
 * Filtro de eventos da conta `tenantId`: os gravados nela, os antigos sem conta
 * criados por usuário dela e os sem conta criados por usuário sem conta para
 * contato/paciente dela. Sem conta (SUPER_ADMIN): sem filtro, como hoje.
 * Devolve `{ OR: [...] }` — quem já usa `OR` no mesmo nível põe isto num `AND`.
 */
export function eventosDaConta(tenantId: string | null | undefined): Prisma.CalendarEventWhereInput {
  if (!tenantId) return {};
  return {
    OR: [
      { tenant_id: tenantId },
      { tenant_id: null, created_by: { tenant_id: tenantId } },
      { tenant_id: null, created_by: { tenant_id: null }, lead: { tenant_id: tenantId } },
      { tenant_id: null, created_by: { tenant_id: null }, lead_id: null, patient: { tenant_id: tenantId } },
      { tenant_id: null, created_by: { tenant_id: null }, lead: { tenant_id: null }, patient: { tenant_id: tenantId } },
    ],
  };
}

/** Campos que `contaDoEvento` precisa no select/include do evento. */
export const SELECT_CONTA_DO_EVENTO = {
  tenant_id: true,
  created_by: { select: { tenant_id: true } },
  lead: { select: { tenant_id: true } },
  patient: { select: { tenant_id: true } },
} as const;

type EventoComConta = {
  tenant_id?: string | null;
  created_by?: { tenant_id?: string | null } | null;
  lead?: { tenant_id?: string | null } | null;
  patient?: { tenant_id?: string | null } | null;
};

/**
 * Conta do evento: a gravada nele; sem ela, a de quem o criou; criador sem conta,
 * a do contato e depois a do paciente.
 */
export function contaDoEvento(evento: EventoComConta): string | null {
  if (evento.tenant_id) return evento.tenant_id;
  if (evento.created_by?.tenant_id) return evento.created_by.tenant_id;
  return evento.lead?.tenant_id ?? evento.patient?.tenant_id ?? null;
}

/**
 * O evento é da conta `tenantId`? Sem conta no contexto (SUPER_ADMIN): sempre sim,
 * como hoje.
 */
export function eventoDaConta(evento: EventoComConta, tenantId: string | null | undefined): boolean {
  if (!tenantId) return true;
  return contaDoEvento(evento) === tenantId;
}
