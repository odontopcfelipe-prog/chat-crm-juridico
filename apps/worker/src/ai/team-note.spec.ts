import {
  AI_TEAM_NOTE_DEDUP_MS,
  aiTeamNoteExternalId,
  aiTeamNoteKey,
  aiTeamNoteKeyOf,
  hasRecentSameSubjectNote,
} from './team-note';
import { isAiTeamNote } from './scheduling-safety';

const NOW = Date.UTC(2026, 9, 12, 15, 0, 0);
const note = (key: string | null, minutesAgo: number, text = '⚠️ IA: ...') => ({
  type: 'internal_note',
  text,
  external_message_id: key ? aiTeamNoteExternalId(key, NOW - minutesAgo * 60_000) : `note_ai_${NOW - minutesAgo * 60_000}`,
  created_at: new Date(NOW - minutesAgo * 60_000),
});

describe('assunto da nota interna da IA', () => {
  it('chave por horário, tópico ou "agendamento"', () => {
    expect(aiTeamNoteKey({ slot: { date: '2026-10-14', time: '09:00' } })).toBe('slot_2026-10-14_0900');
    expect(aiTeamNoteKey({ topic: 'np_CURRICULO' })).toBe('np_curriculo');
    expect(aiTeamNoteKey({})).toBe('agendamento');
    expect(aiTeamNoteKey({ slot: null, topic: '' })).toBe('agendamento');
  });

  it('o id continua sendo nota da IA (prefixo) e devolve o assunto', () => {
    const id = aiTeamNoteExternalId('slot_2026-10-14_0900', NOW);
    expect(isAiTeamNote({ type: 'internal_note', external_message_id: id })).toBe(true);
    expect(aiTeamNoteKeyOf(id)).toBe('slot_2026-10-14_0900');
    expect(aiTeamNoteKeyOf(`note_ai_${NOW}`)).toBeNull();
    expect(aiTeamNoteKeyOf('sys_ai_1')).toBeNull();
  });
});

describe('hasRecentSameSubjectNote — trava do alerta pra equipe', () => {
  const k9 = aiTeamNoteKey({ slot: { date: '2026-10-14', time: '09:00' } });
  const k10 = aiTeamNoteKey({ slot: { date: '2026-10-14', time: '10:00' } });

  it('mesmo horário há 10 min → pula', () => {
    expect(hasRecentSameSubjectNote([note(k9, 10)], k9, { nowMs: NOW })).toBe(true);
  });

  it('horário DIFERENTE → nota nova', () => {
    expect(hasRecentSameSubjectNote([note(k9, 10)], k10, { nowMs: NOW })).toBe(false);
  });

  it('não-paciente depois de alerta de agenda → nota nova', () => {
    expect(hasRecentSameSubjectNote([note(k9, 5)], 'np_curriculo', { nowMs: NOW })).toBe(false);
  });

  it('fora da janela de 30 min → nota nova', () => {
    expect(hasRecentSameSubjectNote([note(k9, AI_TEAM_NOTE_DEDUP_MS / 60_000 + 1)], k9, { nowMs: NOW })).toBe(false);
  });

  it('nota antiga (sem assunto no id) só conta com legacySame', () => {
    const legacy = note(null, 5, '⚠️ IA: o paciente aceitou terça (14/10) às 9h, mas a consulta NÃO foi criada');
    expect(hasRecentSameSubjectNote([legacy], k9, { nowMs: NOW })).toBe(false);
    expect(
      hasRecentSameSubjectNote([legacy], k9, { nowMs: NOW, legacySame: (t) => t.includes('terça (14/10) às 9h') }),
    ).toBe(true);
    expect(
      hasRecentSameSubjectNote([legacy], k10, { nowMs: NOW, legacySame: (t) => t.includes('terça (14/10) às 10h') }),
    ).toBe(false);
  });

  it('mensagem comum / nota de operador não conta', () => {
    expect(
      hasRecentSameSubjectNote(
        [
          { type: 'text', external_message_id: aiTeamNoteExternalId(k9, NOW), created_at: new Date(NOW) },
          { type: 'internal_note', external_message_id: 'op_1', created_at: new Date(NOW) },
        ],
        k9,
        { nowMs: NOW },
      ),
    ).toBe(false);
  });
});
