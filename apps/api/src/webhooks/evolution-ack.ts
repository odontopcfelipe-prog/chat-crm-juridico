/**
 * Tique de entrega do WhatsApp (evento messages.update da Evolution) → status da
 * Message no CRM.
 *
 * Evolution v1: { key: { id }, update: { status: 3 } }  (status numérico)
 * Evolution v2 (prod roda a 2.3.7): { keyId, remoteJid, status: 'DELIVERY_ACK' }
 *   — sem `key` e com o status em TEXTO.
 * Só o formato v1 era lido, então nenhuma mensagem enviada passava de um tique.
 */

export type MessageAckStatus = 'enviado' | 'entregue' | 'lido';

const STATUS_TEXTO: Record<string, number> = {
  ERROR: 0, PENDING: 1, SERVER_ACK: 2, DELIVERY_ACK: 3, READ: 4, PLAYED: 5,
};

/** Id da mensagem (o mesmo do external_message_id) + status do CRM, ou null se o
 *  evento não é um tique que interessa (erro, pendente, sem id…). */
export function parseEvolutionAck(update: any): { id: string; status: MessageAckStatus } | null {
  if (!update) return null;
  const id: string | undefined = update.key?.id || update.keyId || update.id;
  if (!id) return null;
  const raw = update.update?.status ?? update.status;
  const code =
    typeof raw === 'number' ? raw
      : typeof raw === 'string' ? (STATUS_TEXTO[raw.toUpperCase()] ?? -1)
        : -1;
  if (code === 2) return { id, status: 'enviado' };
  if (code === 3) return { id, status: 'entregue' };
  if (code === 4 || code === 5) return { id, status: 'lido' };
  return null;
}

/** Ordem dos tiques. O tique nunca regride (um "entregue" atrasado não apaga o
 *  "lido"); 'erro' fica abaixo de tudo — se o WhatsApp confirmou, a mensagem saiu. */
const RANK: Record<string, number> = { erro: -1, enviando: 0, enviado: 1, entregue: 2, lido: 3 };

export function ackSobe(atual: string | null | undefined, novo: MessageAckStatus): boolean {
  return (RANK[novo] ?? 0) > (RANK[atual ?? ''] ?? 0);
}
