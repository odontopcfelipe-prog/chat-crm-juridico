/**
 * Lógica de roteamento de AVALIAÇÕES pra dentistas com especialidade "Orçamentista".
 *
 * Regra de negócio: TODA avaliação inicial agendada pela IA deve ser atribuída a um
 * dentista que tenha "Orçamentista" no array `specialties`. Esses são os dentistas
 * responsáveis por fazer a primeira consulta (avaliação + orçamento). Após a avaliação,
 * o dentista pode encaminhar pra um especialista da área específica (Implantes,
 * Ortodontia, Porcelana, etc.) — mas a PRIMEIRA consulta é sempre Orçamentista.
 *
 * Esse helper é usado em 2 pontos:
 *  1. `tool-handlers/check-availability.ts` — quando a IA pede slots disponíveis,
 *     garante que está consultando a agenda de um Orçamentista (não do especialista)
 *  2. `ai.processor.ts` no handler de `scheduling_action: confirm_slot` — antes de
 *     criar o CalendarEvent, garante que o dentista atribuído é Orçamentista
 *
 * Estratégia: "lock in" — quando a IA pede availability pela primeira vez, escolhemos
 * o Orçamentista menos ocupado e atualizamos `Conversation.assigned_dentist_id`.
 * Próximas chamadas (incluindo confirm_slot) usam esse mesmo Orçamentista, evitando
 * race condition onde IA mostra slot do dentista A mas evento é criado pro dentista B.
 */

export const ORCAMENTISTA_SPECIALTY = 'Orçamentista';

/**
 * Garante que a conversa tenha um Orçamentista atribuído como `assigned_dentist_id`.
 *
 * Comportamento:
 *  - Se a conversa já tem dentista E ele é Orçamentista → retorna ele (no-op)
 *  - Se tem outro dentista (não-orçamentista) ou null → busca o Orçamentista menos
 *    ocupado, ATUALIZA `Conversation.assigned_dentist_id`, retorna o ID escolhido
 *  - Se não existe NENHUM Orçamentista cadastrado no tenant → retorna null
 *    (caller decide o fallback: não criar evento, escalar humano, etc.)
 *
 * "Menos ocupado" = menor número de Conversation.status='ABERTO' atribuídas.
 */
export async function ensureOrcamentistaAssigned(
  prisma: any,
  conversationId: string,
): Promise<string | null> {
  const convo = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { assigned_dentist_id: true, tenant_id: true },
  });
  if (!convo) return null;

  // Atalho: se já tem dentista, validar se é orçamentista
  if (convo.assigned_dentist_id) {
    const u = await prisma.user.findUnique({
      where: { id: convo.assigned_dentist_id },
      select: { specialties: true },
    });
    if (u?.specialties?.includes(ORCAMENTISTA_SPECIALTY)) {
      return convo.assigned_dentist_id;
    }
    // Senão cai pra busca abaixo (override do dentista atual)
  }

  // Buscar orçamentistas ativos do tenant
  const orcamentistas = await prisma.user.findMany({
    where: {
      specialties: { has: ORCAMENTISTA_SPECIALTY },
      ...(convo.tenant_id ? { tenant_id: convo.tenant_id } : {}),
    },
    select: { id: true },
  });
  if (orcamentistas.length === 0) return null;

  // Escolher o menos ocupado (menor count de conversas ABERTO)
  const counts = await Promise.all(
    orcamentistas.map(async (o: any) => ({
      id: o.id as string,
      count: (await prisma.conversation.count({
        where: { assigned_dentist_id: o.id, status: 'ABERTO' },
      })) as number,
    })),
  );
  counts.sort((a, b) => a.count - b.count);
  const chosenId = counts[0].id;

  // "Lock in": atualiza a conversa pra próximas chamadas (check_availability,
  // confirm_slot) usarem o mesmo Orçamentista — evita race condition.
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { assigned_dentist_id: chosenId },
  });

  return chosenId;
}
