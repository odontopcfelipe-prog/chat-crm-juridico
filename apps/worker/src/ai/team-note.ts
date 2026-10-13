import { AI_TEAM_NOTE_PREFIX, isAiTeamNote, type SlotRef } from './scheduling-safety';

/**
 * Assunto das notas internas que a IA grava pra equipe (alerta de agendamento e de
 * não-paciente) — helpers PUROS. O assunto vai no external_message_id da nota
 * (`note_ai_<ms>_<assunto>`; isAiTeamNote continua valendo pelo prefixo), e a trava
 * anti-repetição só pula o alerta quando a nota recente é do MESMO assunto: outro
 * horário (ou não-paciente depois de um alerta de agenda) gera nota nova.
 */

/** Janela da trava anti-repetição do alerta pra equipe. */
export const AI_TEAM_NOTE_DEDUP_MS = 30 * 60_000;

/** Assunto: o horário ("slot_2026-10-14_0900"), um tópico ("np_curriculo") ou "agendamento". */
export function aiTeamNoteKey(subject: { slot?: SlotRef | null; topic?: string | null }): string {
  if (subject.slot?.date && subject.slot?.time) {
    return `slot_${subject.slot.date}_${subject.slot.time.replace(':', '')}`;
  }
  const topic = String(subject.topic || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return topic || 'agendamento';
}

/** external_message_id da nota com o assunto. */
export function aiTeamNoteExternalId(key: string, nowMs: number = Date.now()): string {
  return `${AI_TEAM_NOTE_PREFIX}${nowMs}_${key}`;
}

/** Assunto gravado na nota; null = nota antiga (só `note_ai_<ms>`). */
export function aiTeamNoteKeyOf(externalId: string | null | undefined): string | null {
  const id = String(externalId || '');
  if (!id.startsWith(AI_TEAM_NOTE_PREFIX)) return null;
  const m = id.slice(AI_TEAM_NOTE_PREFIX.length).match(/^\d+_(.+)$/);
  return m ? m[1] : null;
}

/**
 * Já há nota da IA do MESMO assunto na janela? Nota antiga (sem assunto no id) conta
 * como mesma só se `legacySame(texto)` disser (ex.: o texto cita o mesmo horário).
 */
export function hasRecentSameSubjectNote(
  messages: { type?: string | null; external_message_id?: string | null; text?: string | null; created_at: any }[] | null | undefined,
  key: string,
  opts: { nowMs?: number; windowMs?: number; legacySame?: (text: string) => boolean } = {},
): boolean {
  const nowMs = opts.nowMs ?? Date.now();
  const windowMs = opts.windowMs ?? AI_TEAM_NOTE_DEDUP_MS;
  return (messages || []).some((m) => {
    if (!isAiTeamNote(m) || nowMs - new Date(m.created_at).getTime() >= windowMs) return false;
    const k = aiTeamNoteKeyOf(m.external_message_id);
    if (k) return k === key;
    return !!opts.legacySame && opts.legacySame(String(m.text || ''));
  });
}
