/**
 * Fase 0 — regras PURAS de quem pode confirmar (executar) procedimento do plano.
 * Sem DI: o TreatmentPlansService importa direto, sem ciclo.
 */
import { criadoAposCorte } from '../common/fase0-corte';

export const MSG_ITEM_OUTRO_DENTISTA = 'Este procedimento é de outro dentista — só ele ou o administrador pode confirmar.';
export const MSG_SO_DENTISTA = 'Só um dentista ou o administrador pode confirmar procedimento.';
export const MSG_AGUARDANDO_FINANCEIRO = 'Aguardando validação do Financeiro — o tratamento ainda não foi liberado.';
export const MSG_PLANO_CANCELADO = 'Plano de tratamento cancelado — procedimento não pode ser confirmado.';

/**
 * Ator pode confirmar o item? null = pode; string = motivo do 403.
 * ADMIN sempre; quem não é ADMIN tem que ser DENTISTA no banco; item COM dentista só o
 * próprio; item SEM dentista qualquer dentista.
 * Fase 0 — ser "dono" do item não basta: o dentist_id vem do orçamento (cliente) e a
 * recepção/CRC podia se pôr como dentista do item e confirmar o procedimento.
 */
export function motivoNegarAtor(a: {
  isAdmin: boolean;
  actorId: string;
  actorEhDentista: boolean;
  itemDentistId: string | null;
}): string | null {
  if (a.isAdmin) return null;
  if (!a.actorEhDentista) return MSG_SO_DENTISTA;
  if (a.itemDentistId && a.itemDentistId !== a.actorId) return MSG_ITEM_OUTRO_DENTISTA;
  return null;
}

/**
 * O plano deixa confirmar procedimento? null = deixa; string = motivo do 400.
 * Vale pra todos, inclusive ADMIN (ele tem manage_financial e valida num clique).
 * Plano anterior ao corte não é barrado pela validação do Financeiro (nada retroativo).
 */
export function motivoBloqueioPlano(p: {
  status: string;
  created_at: Date | string | null;
  validated_by_financial_at: Date | string | null;
}): string | null {
  if (p.status === 'CANCELLED') return MSG_PLANO_CANCELADO;
  if (criadoAposCorte(p.created_at) && !p.validated_by_financial_at) return MSG_AGUARDANDO_FINANCEIRO;
  return null; // PAUSED continua permitido (como hoje)
}
