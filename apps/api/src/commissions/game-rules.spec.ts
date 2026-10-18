/**
 * Out/2026 — "Meu jogo" do profissional: pontos pela produção clínica, sem R$.
 */
import {
  levelFor, weeksOfMonth, monthBounds, missionDone, maceioMonthKey, computeMyGame,
  GAME_POINTS, DEFAULT_MISSIONS,
} from './game-rules';

describe('game-rules — níveis', () => {
  it('Bronze < 500 ≤ Prata < 1500 ≤ Ouro < 3000 ≤ Diamante', () => {
    expect(levelFor(0).nivel.nome).toBe('Bronze');
    expect(levelFor(499).nivel.nome).toBe('Bronze');
    expect(levelFor(500).nivel.nome).toBe('Prata');
    expect(levelFor(1240).nivel.nome).toBe('Prata');
    expect(levelFor(1240).proximo).toMatchObject({ nome: 'Ouro', faltam: 260 });
    expect(levelFor(3000).nivel.nome).toBe('Diamante');
    expect(levelFor(3000).proximo).toBeNull();
    expect(levelFor(3000).progressoNivel).toBe(1);
  });
});

describe('game-rules — calendário', () => {
  it('semanas do mês começam na segunda e a segunda cai dentro do mês', () => {
    const ws = weeksOfMonth('2026-10'); // 01/10/2026 é quinta → 1ª segunda = 05/10
    expect(ws[0].start.toISOString().slice(0, 10)).toBe('2026-10-05');
    expect(ws.every((w) => w.start.getUTCDay() === 1)).toBe(true);
    expect(ws[ws.length - 1].start.toISOString().slice(0, 10)).toBe('2026-10-26');
  });

  it('mês de Maceió: consulta (naive) e instantes reais (+3h)', () => {
    const b = monthBounds('2026-10');
    expect(b.naiveStart.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(b.realStart.toISOString()).toBe('2026-10-01T03:00:00.000Z');
    expect(b.realEnd.toISOString()).toBe('2026-11-01T02:59:59.999Z');
  });

  it('mês corrente é o de Maceió (21h do dia 31 ainda é o mês)', () => {
    expect(maceioMonthKey(Date.parse('2026-11-01T01:00:00Z'))).toBe('2026-10');
  });
});

describe('game-rules — missões', () => {
  const [proc, faltas] = DEFAULT_MISSIONS.missions;
  it('procedimentos: vale ao bater o alvo', () => {
    expect(missionDone(proc, { procedimentos: 5, consultas: 6, faltas: 1 }, false)).toBe(true);
    expect(missionDone(proc, { procedimentos: 4, consultas: 6, faltas: 0 }, true)).toBe(false);
  });
  it('zero faltas: só com a semana encerrada e com consulta', () => {
    expect(missionDone(faltas, { procedimentos: 0, consultas: 3, faltas: 0 }, true)).toBe(true);
    expect(missionDone(faltas, { procedimentos: 0, consultas: 3, faltas: 0 }, false)).toBe(false);
    expect(missionDone(faltas, { procedimentos: 0, consultas: 0, faltas: 0 }, true)).toBe(false);
    expect(missionDone(faltas, { procedimentos: 0, consultas: 3, faltas: 1 }, true)).toBe(false);
  });
});

describe('computeMyGame — sem R$', () => {
  const count = (n: number) => jest.fn().mockResolvedValue(n);
  const prisma: any = {
    treatmentPlanItem: { count: count(62), findMany: jest.fn().mockResolvedValue([]) },
    calendarEvent: { count: count(74), findMany: jest.fn().mockResolvedValue([]) },
    quote: { count: jest.fn().mockResolvedValueOnce(18).mockResolvedValueOnce(8).mockResolvedValue(0) },
    goal: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'g1', metric: 'SALES_VALUE', direction: 'ACHIEVE', target_value: 50000, current_value: 36000, notes: null },
        { id: 'g2', metric: 'FIRST_CONSULTATIONS', direction: 'ACHIEVE', target_value: 20, current_value: 12, notes: null },
      ]),
    },
  };

  it('soma os pontos pela produção e nunca devolve valor de produção em R$', async () => {
    const g = await computeMyGame(prisma, 't1', 'u1', '2026-09', { enabled: false, missions: [] }, Date.parse('2026-10-18T15:00:00Z'));
    const expected = 62 * GAME_POINTS.procedimento + 74 * GAME_POINTS.atendimento + 18 * GAME_POINTS.avaliacao + 8 * GAME_POINTS.conversao;
    expect(g.pontos).toBe(expected); // 620 + 370 + 90 + 160 = 1240
    expect(g.nivel.nome).toBe('Prata');
    const prod = g.metas.find((m) => m.id === 'g1')!;
    expect(prod.atual).toBeNull();
    expect(prod.alvo).toBeNull();
    expect(prod.pct).toBeCloseTo(0.72);
    expect(g.metas.find((m) => m.id === 'g2')).toMatchObject({ atual: 12, alvo: 20 });
    expect(JSON.stringify(g)).not.toMatch(/R\$|comiss/i);
  });
});
