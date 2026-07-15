/**
 * FREIO do agendamento AUTOMÁTICO pela IA (Onda — anti "agendando sozinho").
 *
 * Default OFF: a IA só cria evento na agenda (book_appointment / "Avaliação" do
 * Orçamentista) se o tenant tiver LIGADO explicitamente
 * `AI_AUTOBOOK_ENABLED_<tenant>='true'`. Sem isso, a IA conversa normalmente mas
 * NÃO marca ninguém sozinha — o operador/recepção confirma e agenda manualmente.
 *
 * Por que default OFF: os toggles de IA (master + por chip) só filtram no
 * webhook (enqueue); o worker/book_appointment não os reconferia, e crons
 * (after-hours / reativação 24h) religam a IA por conversa. Um gate PRÓPRIO da
 * criação de evento é o único ponto que garante "a IA não marca sozinha".
 *
 * Sem tenant → retorna false (seguro: não agenda).
 */
export async function isAiAutobookEnabled(
  prisma: any,
  tenantId: string | null | undefined,
): Promise<boolean> {
  if (!tenantId) return false;
  try {
    const row = await prisma.globalSetting.findUnique({
      where: { key: `AI_AUTOBOOK_ENABLED_${tenantId}` },
    });
    return (row?.value ?? 'false') === 'true';
  } catch {
    return false;
  }
}
