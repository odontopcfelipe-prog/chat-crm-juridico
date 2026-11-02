/**
 * F8 do laboratório — ficha do caso de um orçamento de trabalho, com HERANÇA por
 * leitura: o orçamento sem caso próprio usa o do orçamento de origem (aprovação
 * parcial = accepted_from_id; renegociação = renegotiated_from_id), subindo até 3
 * níveis. Nada é copiado: quotes.service e quote-versions.service não mudam.
 *
 * Funções puras (sem provider Nest): recebem o prisma por parâmetro.
 *
 * lerCasoParaPdf é a ÚNICA leitura do caso fora das rotas de fichas: o PDF do
 * laboratório mostra só cor, material e entrega prometida. O select é FECHADO
 * nesses 3 campos, então o paciente do caso, o dentista solicitante, as
 * instruções, o link e o "recebido em" nunca entram no caminho do PDF (que também
 * vai anexado no WhatsApp).
 */

/** Até quantos orçamentos de origem a herança sobe (o laboratório revisa várias vezes o mesmo trabalho). */
export const NIVEIS_DE_HERANCA = 20;

/** O que o PDF do laboratório mostra da ficha do caso. */
export type CasoNoPdf = { shade: string | null; material: string | null; due_date: Date | null };

/** Só o que estas funções usam do prisma (o spec passa um banco simulado). */
export type DbDoCaso = {
  quote: { findFirst(args: any): Promise<any> };
  quoteLabCase: { findFirst(args: any): Promise<any> };
};

/** Orçamento de origem (aprovação parcial antes de renegociação). */
export function origemDoOrcamento(
  q: { accepted_from_id?: string | null; renegotiated_from_id?: string | null } | null | undefined,
): string | null {
  return q?.accepted_from_id || q?.renegotiated_from_id || null;
}

/**
 * Sobe a cadeia de origem procurando um caso. Começa no próprio quoteId (nível 0)
 * e vai até NIVEIS_DE_HERANCA orçamentos acima. Toda leitura filtra a conta: o
 * caso por tenant_id e o orçamento de origem pela conta do paciente (inclusive
 * orçamento apagado: só serve de elo da cadeia).
 * Devolve o caso (com o select pedido) e o quote_id onde ele está, ou null.
 */
export async function acharCasoNaCadeia<T = any>(
  db: DbDoCaso,
  quoteId: string,
  tenantId: string,
  select?: Record<string, true>,
  origemDoPedido?: string | null,
): Promise<{ caso: T; de: string } | null> {
  let id: string | null = quoteId;
  const vistos = new Set<string>();
  for (let nivel = 0; id && nivel <= NIVEIS_DE_HERANCA; nivel++) {
    if (vistos.has(id)) return null;
    vistos.add(id);
    const caso = await db.quoteLabCase.findFirst({
      where: { quote_id: id, tenant_id: tenantId },
      ...(select ? { select } : {}),
    });
    if (caso) return { caso: caso as T, de: id };
    if (nivel === NIVEIS_DE_HERANCA) break;
    if (nivel === 0 && origemDoPedido !== undefined) {
      // Quem chamou já leu o orçamento pedido (com a conta conferida).
      id = origemDoPedido;
      continue;
    }
    const q = await db.quote.findFirst({
      where: { id, patient: { tenant_id: tenantId } },
      select: { accepted_from_id: true, renegotiated_from_id: true },
    });
    id = origemDoOrcamento(q);
  }
  return null;
}

/**
 * Cor, material e entrega prometida do caso do orçamento (próprio ou herdado),
 * para o PDF do laboratório. NUNCA lança: qualquer falha (inclusive banco sem a
 * tabela do caso) devolve null, o PDF sai sem o bloco e `avisar` recebe
 * '[LAB-CASO] pdf ...' (sem nenhum valor do caso).
 */
export async function lerCasoParaPdf(
  db: unknown,
  quoteId: string,
  tenantId: string | null | undefined,
  avisar?: (m: string) => void,
): Promise<CasoNoPdf | null> {
  try {
    if (typeof tenantId !== 'string' || tenantId === '' || !quoteId) return null;
    const achado = await acharCasoNaCadeia<{ shade: string | null; material: string | null; due_date: Date | null }>(
      db as DbDoCaso,
      quoteId,
      tenantId,
      { shade: true, material: true, due_date: true },
    );
    if (!achado) return null;
    return {
      shade: achado.caso.shade ?? null,
      material: achado.caso.material ?? null,
      due_date: achado.caso.due_date ?? null,
    };
  } catch (e) {
    avisar?.(`[LAB-CASO] pdf ${quoteId}: ${(e as Error)?.message ?? 'falha'}`);
    return null;
  }
}
