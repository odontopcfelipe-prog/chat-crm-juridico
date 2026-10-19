import {
  computeDay,
  computeMonth,
  DEFAULT_WEEKLY,
  fmtMin,
  maceioHhmm,
  maceioLocalToInstant,
  maceioYmd,
  monthRange,
  normalizeWeekly,
} from './ponto-calc';

// Batida no horário LOCAL de Maceió (+ segundos opcionais).
const at = (ymd: string, hhmm: string, ss = 0) =>
  new Date(maceioLocalToInstant(ymd, hhmm).getTime() + ss * 1000);

// 2026-10-19 é segunda-feira.
const SEG = '2026-10-19';
const base = {
  weekly: DEFAULT_WEEKLY,
  holiday: null as string | null,
  todayYmd: '2026-10-30',
  now: at('2026-10-30', '10:00'),
  startYmd: '2026-10-01',
};

describe('fuso de Maceió', () => {
  it('converte hora local em instante real (UTC-3)', () => {
    expect(maceioLocalToInstant(SEG, '08:00').toISOString()).toBe('2026-10-19T11:00:00.000Z');
  });

  it('batida às 23:30 local fica no dia local, não no dia UTC', () => {
    const p = new Date('2026-10-20T02:30:00.000Z');
    expect(maceioYmd(p)).toBe(SEG);
    expect(maceioHhmm(p)).toBe('23:30');
  });

  it('janela do mês começa às 03:00 UTC do dia 1', () => {
    const r = monthRange('2026-02');
    expect(r.days).toHaveLength(28);
    expect(r.startUtc.toISOString()).toBe('2026-02-01T03:00:00.000Z');
    expect(r.endUtc.toISOString()).toBe('2026-03-01T03:00:00.000Z');
  });
});

describe('computeDay', () => {
  it('dia normal com almoço: 8h, intervalo 1h, saldo zero', () => {
    const d = computeDay({
      ...base,
      date: SEG,
      punches: [at(SEG, '13:00'), at(SEG, '08:00'), at(SEG, '17:00'), at(SEG, '12:00')],
    });
    expect(d.status).toBe('OK');
    expect(d.pairs).toEqual([
      { in: '08:00', out: '12:00', minutes: 240 },
      { in: '13:00', out: '17:00', minutes: 240 },
    ]);
    expect(d.worked_min).toBe(480);
    expect(d.interval_min).toBe(60);
    expect(d.expected_min).toBe(480);
    expect(d.balance_min).toBe(0);
    expect(d.alerts).toEqual([]);
  });

  it('conta minutos cheios: 08:00:59 → 12:00:00 dá 4h00', () => {
    const d = computeDay({
      ...base,
      date: SEG,
      punches: [at(SEG, '08:00', 59), at(SEG, '12:00'), at(SEG, '13:00'), at(SEG, '17:00', 30)],
    });
    expect(d.pairs.map((p) => p.minutes)).toEqual([240, 240]);
    expect(d.worked_min).toBe(480);
  });

  it('tolerância CLT: até 10 min no dia não conta', () => {
    const d = computeDay({
      ...base,
      date: SEG,
      punches: [at(SEG, '08:05'), at(SEG, '12:00'), at(SEG, '13:00'), at(SEG, '17:03')],
    });
    expect(d.worked_min).toBe(478);
    expect(d.balance_min).toBe(0);
  });

  it('passou de 10 min: conta a diferença inteira', () => {
    const d = computeDay({
      ...base,
      date: SEG,
      punches: [at(SEG, '07:50'), at(SEG, '12:00'), at(SEG, '13:00'), at(SEG, '17:05')],
    });
    expect(d.worked_min).toBe(495);
    expect(d.balance_min).toBe(15);
  });

  it('saiu mais cedo: saldo negativo', () => {
    const d = computeDay({
      ...base,
      date: SEG,
      punches: [at(SEG, '08:00'), at(SEG, '12:00'), at(SEG, '13:00'), at(SEG, '16:00')],
    });
    expect(d.balance_min).toBe(-60);
  });

  it('batida ímpar em dia passado = INCOMPLETO, sem saldo', () => {
    const d = computeDay({
      ...base,
      date: SEG,
      punches: [at(SEG, '08:00'), at(SEG, '12:00'), at(SEG, '13:00')],
    });
    expect(d.status).toBe('INCOMPLETO');
    expect(d.balance_min).toBeNull();
    expect(d.worked_min).toBe(240);
    expect(d.pairs[1]).toEqual({ in: '13:00', out: null, minutes: 0 });
  });

  it('hoje com entrada aberta conta até agora e não fecha saldo', () => {
    const d = computeDay({
      ...base,
      date: SEG,
      todayYmd: SEG,
      now: at(SEG, '10:30', 40),
      punches: [at(SEG, '08:00')],
    });
    expect(d.status).toBe('HOJE');
    expect(d.worked_min).toBe(150);
    expect(d.balance_min).toBeNull();
  });

  it('dia útil sem batida após o início = FALTA', () => {
    const d = computeDay({ ...base, date: SEG, punches: [] });
    expect(d.status).toBe('FALTA');
    expect(d.balance_min).toBe(-480);
  });

  it('antes do 1º registro não é falta', () => {
    const d = computeDay({ ...base, date: SEG, punches: [], startYmd: '2026-10-25' });
    expect(d.status).toBe('SEM_REGISTRO');
    expect(d.balance_min).toBeNull();
  });

  it('domingo sem batida = FOLGA; sábado tem jornada de 4h', () => {
    expect(computeDay({ ...base, date: '2026-10-18', punches: [] }).status).toBe('FOLGA');
    expect(computeDay({ ...base, date: '2026-10-17', punches: [] }).balance_min).toBe(-240);
  });

  it('feriado: jornada zero e o trabalhado vira saldo positivo', () => {
    const vazio = computeDay({ ...base, date: SEG, holiday: 'Feriado X', punches: [] });
    expect(vazio.status).toBe('FERIADO');
    expect(vazio.balance_min).toBe(0);

    const trabalhou = computeDay({
      ...base,
      date: SEG,
      holiday: 'Feriado X',
      punches: [at(SEG, '08:00'), at(SEG, '12:00')],
    });
    expect(trabalhou.expected_min).toBe(0);
    expect(trabalhou.balance_min).toBe(240);
    expect(trabalhou.alerts).toContain('Trabalho no feriado (Feriado X)');
  });

  it('jornada acima de 6h sem intervalo gera alerta', () => {
    const d = computeDay({ ...base, date: SEG, punches: [at(SEG, '08:00'), at(SEG, '17:00')] });
    expect(d.worked_min).toBe(540);
    expect(d.alerts).toContain('Intervalo menor que 1h (jornada acima de 6h)');
  });

  it('4h04 no sábado não cobra intervalo (tolerância); 4h30 seguidas cobra', () => {
    const SAB = '2026-10-17';
    const curto = computeDay({ ...base, date: SAB, punches: [at(SAB, '08:00'), at(SAB, '12:04')] });
    expect(curto.alerts).toEqual([]);
    const longo = computeDay({ ...base, date: SAB, punches: [at(SAB, '08:00'), at(SAB, '12:30')] });
    expect(longo.alerts).toContain('Intervalo menor que 15 min (jornada acima de 4h)');
  });

  it('mais de 10h no dia gera alerta', () => {
    const d = computeDay({
      ...base,
      date: SEG,
      punches: [at(SEG, '07:00'), at(SEG, '12:00'), at(SEG, '13:00'), at(SEG, '19:00')],
    });
    expect(d.worked_min).toBe(660);
    expect(d.alerts).toContain('Mais de 10h no dia (limite de 2h extras)');
  });
});

describe('computeMonth', () => {
  it('soma só os dias fechados e separa o dia de hoje', () => {
    const r = computeMonth({
      ym: '2026-10',
      punches: [
        at('2026-10-19', '08:00'), at('2026-10-19', '12:00'), at('2026-10-19', '13:00'), at('2026-10-19', '17:00'),
        // 20/10 sem batida → falta
        at('2026-10-21', '08:00'), // hoje, ainda trabalhando
      ],
      weekly: DEFAULT_WEEKLY,
      holidays: new Map(),
      todayYmd: '2026-10-21',
      now: at('2026-10-21', '10:30'),
      startYmd: '2026-10-19',
    });
    expect(r.days).toHaveLength(31);
    expect(r.days[0].status).toBe('SEM_REGISTRO');
    expect(r.days[18].status).toBe('OK');
    expect(r.days[19].status).toBe('FALTA');
    expect(r.days[20].status).toBe('HOJE');
    expect(r.days[21].status).toBe('FUTURO');
    expect(r.totals).toEqual({
      worked_min: 480,
      expected_min: 960,
      balance_min: -480,
      extra_min: 0,
      debit_min: 480,
      days_worked: 1,
      absences: 1,
      incomplete: 0,
      today_worked_min: 150,
    });
  });

  it('alerta descanso entre jornadas menor que 11h (inclusive vindo do mês anterior)', () => {
    const r = computeMonth({
      ym: '2026-11',
      punches: [
        at('2026-10-31', '14:00'), at('2026-10-31', '23:00'),
        at('2026-11-01', '08:00'), at('2026-11-01', '12:00'),
      ],
      weekly: DEFAULT_WEEKLY,
      holidays: new Map(),
      todayYmd: '2026-11-10',
      now: at('2026-11-10', '09:00'),
      startYmd: '2026-10-31',
    });
    expect(r.days[0].alerts).toContain('Descanso entre jornadas de 9h00 (mínimo 11h)');
  });
});

describe('utilitários', () => {
  it('fmtMin', () => {
    expect(fmtMin(485)).toBe('8h05');
    expect(fmtMin(-70)).toBe('-1h10');
    expect(fmtMin(0)).toBe('0h00');
  });

  it('normalizeWeekly aceita 7 valores de 0 a 1440', () => {
    expect(normalizeWeekly([0, 480, 480, 480, 480, 480, 240])).toEqual(DEFAULT_WEEKLY);
    expect(normalizeWeekly([1, 2, 3])).toBeNull();
    expect(normalizeWeekly([0, 480, 480, 480, 480, 480, 2000])).toBeNull();
  });
});
