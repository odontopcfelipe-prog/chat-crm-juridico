/**
 * Trava de repetição dos MARCOS da régua (1 dia antes, no dia, atraso 1/2/3/15/30d).
 *
 * Regra: cada marco sai UMA vez POR BOLETO. Desde fcbd3e31 (02/ago/2026) a trava era
 * "uma vez por PACIENTE, para sempre": quem recebeu "1 dia antes" na 1ª parcela nunca
 * mais recebia esse aviso nas parcelas seguintes (caso Jose, out/2026: a 2ª parcela
 * só ganhou o aviso de 3 dias, o único que ele nunca tinha recebido).
 *
 * Agora cada envio grava em meta_json.charge_ids os boletos avisados e a trava é
 * boleto + marco. O agrupamento por paciente (1 mensagem com N boletos do mesmo marco)
 * continua no cron — isto só decide QUAIS boletos ainda faltam avisar.
 *
 * Registro ANTIGO (sem charge_ids) não diz qual boleto foi: só trava paciente+marco
 * por LEGACY_DEDUP_DAYS — o bastante pra não repetir o aviso de hoje (o cron roda a
 * cada minuto) nem a repescagem da segunda logo depois do deploy, sem bloquear a
 * parcela do mês seguinte.
 */

/** Registro de envio antigo (sem charge_ids) trava paciente+marco por estes dias. */
export const LEGACY_DEDUP_DAYS = 5;
/** Quanto do histórico olhar: os marcos de um boleto vão de 1 dia antes a 30 dias
 *  depois do vencimento (~32 dias), então 40 dias cobre o ciclo inteiro. */
export const DEDUP_LOOKBACK_DAYS = 40;

export interface AlertLogRow {
  entity_id: string; // patientId
  action: string; // marco (boleto_1d_antes, …)
  created_at: Date | string;
  meta_json: unknown;
}

export interface AlertIndex {
  /** Este boleto já recebeu este marco? */
  jaAvisado(chargeId: string, patientId: string, stage: string): boolean;
}

export function buildAlertIndex(rows: AlertLogRow[], nowMs: number): AlertIndex {
  const porBoleto = new Set<string>();
  const legado = new Set<string>();
  const legacyCutoff = nowMs - LEGACY_DEDUP_DAYS * 86_400_000;
  for (const r of rows) {
    const meta = (r.meta_json || {}) as { charge_ids?: unknown };
    const ids = Array.isArray(meta.charge_ids) ? meta.charge_ids.filter((x): x is string => typeof x === 'string') : [];
    if (ids.length) {
      for (const id of ids) porBoleto.add(`${id}:${r.action}`);
    } else if (new Date(r.created_at).getTime() >= legacyCutoff) {
      legado.add(`${r.entity_id}:${r.action}`);
    }
  }
  return {
    jaAvisado: (chargeId, patientId, stage) =>
      porBoleto.has(`${chargeId}:${stage}`) || legado.has(`${patientId}:${stage}`),
  };
}
