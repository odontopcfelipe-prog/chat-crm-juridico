/**
 * F5/F6 do laboratório — abas da ficha do cliente no laboratório.
 *
 * Arquivo de ids (sem o prefixo reservado): são os ids das abas da ficha que o
 * laboratório tem, na ordem em que aparecem. Cada uma só abre quando a tela dela
 * estiver pronta para ele:
 *   - Visão geral e Histórico: já abrem;
 *   - Financeiro: junto com as telas do financeiro do laboratório, isto é, quando as
 *     rotas do financeiro estiverem na lista de rotas do laboratório (ALLOWED_LAB_ROUTES);
 *   - Orçamento, Propostas e Trabalhos: abrem junto com o painel de orçamentos
 *     ('/atendimento/orcamentos' na lista de rotas do laboratório, bloco F6a);
 *   - Afiliado: junto com a tela Afiliados ('/atendimento/afiliados' na lista de rotas).
 */
import { labAllowsRoute } from '@crm/shared';

/** Id da aba Orçamento da ficha do laboratório (a tela de montar o orçamento de trabalho). */
export const ABA_ORCAMENTO_DO_LAB = 'orcamento' as const;

export const ABAS_DA_FICHA_NO_LAB = ['overview', ABA_ORCAMENTO_DO_LAB, 'proposals', 'treatment', 'financial', 'affiliate', 'timeline'] as const;

/** Abas que abrem junto com o painel de orçamentos. */
const ABAS_DO_ORCAMENTO: readonly string[] = [ABA_ORCAMENTO_DO_LAB, 'proposals', 'treatment'];

/** Abas da ficha que o laboratório pode abrir agora (na ordem da ficha). */
export function abasProntasNoLab(): string[] {
  const financeiroAberto = labAllowsRoute('/atendimento/financeiro/boletos');
  const orcamentoAberto = labAllowsRoute('/atendimento/orcamentos');
  return ABAS_DA_FICHA_NO_LAB.filter((aba) => {
    if (aba === 'financial') return financeiroAberto;
    if (aba === 'affiliate') return labAllowsRoute('/atendimento/afiliados');
    if (ABAS_DO_ORCAMENTO.includes(aba)) return orcamentoAberto;
    return true;
  });
}

/**
 * Aba da ficha onde o orçamento aparece no laboratório: em aberto (rascunho ou enviado)
 * na aba Orçamento; aceito em Trabalhos; arquivado, recusado ou vencido em Propostas.
 */
export function abaDoOrcamentoNoLab(q: { status: string; archived_at?: string | null }): string {
  if (q.archived_at) return 'proposals';
  if (q.status === 'DRAFT' || q.status === 'SENT') return ABA_ORCAMENTO_DO_LAB;
  if (q.status === 'ACCEPTED') return 'treatment';
  return 'proposals';
}

/** Posição da aba na ficha do laboratório (fora da lista = 999, vai para o fim). */
export function ordemNoLab(id: string): number {
  const i = (ABAS_DA_FICHA_NO_LAB as readonly string[]).indexOf(id);
  return i < 0 ? 999 : i;
}
