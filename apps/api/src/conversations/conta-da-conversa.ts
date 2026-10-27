/**
 * Conta de uma conversa, para as checagens "só da própria conta" do chat (guarda
 * das rotas :id, mensagens, notas internas, recarregar mídia).
 *
 * A conta é a gravada na conversa. Conversa sem conta gravada (nasce assim por um
 * instante no webhook e na cobrança) usa a do contato (lead). Sem conta nas duas,
 * a conversa não é de conta nenhuma: só quem entra sem conta (SUPER_ADMIN) opera.
 *
 * Funções puras com o Prisma por parâmetro (sem provider Nest — ciclo de DI).
 */
type PrismaConversa = {
  conversation: { findUnique(args: any): Promise<any> };
};

/**
 * Conta efetiva: `tenantGravado` (o tenant_id já lido da conversa) ou, sem ele,
 * a do contato. Só consulta o banco quando a conversa não tem conta gravada.
 */
export async function contaEfetivaDaConversa(
  prisma: PrismaConversa,
  conversationId: string,
  tenantGravado: string | null | undefined,
): Promise<string | null> {
  if (tenantGravado) return tenantGravado;
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { lead: { select: { tenant_id: true } } },
  });
  return conv?.lead?.tenant_id ?? null;
}

/**
 * A conversa existe e NÃO é da conta `tenantId` (é de outra, ou não é de conta
 * nenhuma)? Conversa inexistente → false (segue pro handler, que devolve o 404 de
 * hoje). Conversa da própria conta: uma consulta só, a mesma de antes.
 */
export async function conversaForaDaConta(
  prisma: PrismaConversa,
  conversationId: string,
  tenantId: string,
): Promise<boolean> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { tenant_id: true },
  });
  if (!conv || conv.tenant_id === tenantId) return false;
  if (conv.tenant_id) return true;
  return (await contaEfetivaDaConversa(prisma, conversationId, null)) !== tenantId;
}
