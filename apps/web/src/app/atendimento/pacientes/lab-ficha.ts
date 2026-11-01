/**
 * F5 do laboratório — abas da ficha do cliente no laboratório.
 *
 * Não é texto (por isso sem o prefixo reservado aos textos de laboratório): são os ids
 * das abas da ficha que o laboratório vai ter. Cada uma só abre quando a tela dela
 * estiver pronta para ele:
 *   - Visão geral e Histórico: já abrem;
 *   - Financeiro: junto com as telas do financeiro do laboratório, isto é, quando as
 *     rotas do financeiro estiverem na lista de rotas do laboratório (ALLOWED_LAB_ROUTES);
 *   - Propostas: fica fechada até a F6.
 */
import { labAllowsRoute } from '@crm/shared';

export const ABAS_DA_FICHA_NO_LAB = ['overview', 'proposals', 'financial', 'timeline'] as const;

/** Abas da ficha que o laboratório pode abrir agora (na ordem da ficha). */
export function abasProntasNoLab(): string[] {
  const financeiroAberto = labAllowsRoute('/atendimento/financeiro/boletos');
  return ABAS_DA_FICHA_NO_LAB.filter((aba) => aba !== 'proposals' && (aba !== 'financial' || financeiroAberto));
}
