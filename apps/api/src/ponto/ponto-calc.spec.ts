import {
  computeDay,
  computeMonth,
  easterSunday,
  expectedOf,
  fmtMin,
  holidaysForMonth,
  maceioHhmm,
  maceioLocalToInstant,
  maceioYmd,
  marksOf,
  monthRange,
  nationalHolidays,
  normalizeDaySchedule,
  normalizeWeek,
  scheduleOn,
  type DaySchedule,
  type ScheduleVersion,
} from './ponto-calc';

// Batida no horário LOCAL de Maceió (+ segundos opcionais).
const at = (ymd: string, hhmm: string, ss = 0) =>
  new Date(maceioLocalToInstant(ymd, hhmm).getTime() + ss * 1000);

// Seg–sex 08:00–12:00 / 13:00–17:00 (8h) + sábado 08:00–12:00 (4h) = 44h.
const S8: DaySchedule = { in: '08:00', break_start: '12:00', break_end: '13:00', out: '17:00' };
const SAB: DaySchedule = { in: '08:00', break_start: null, break_end: null, out: '12:00' };
const WEEK = [null, S8, S8, S8, S8, S8, SAB];
const VERSIONS: ScheduleVersion[] = [{ valid_from: '2026-01-01', days: WEEK }];

// 2026-10-19 é segunda-feira.
const SEG = '2026-10-19';
const base = {
  schedule: S8 as DaySchedule | null,
  holiday: null as string | null,
  todayYmd: '2026-10-30',
  now: at('2026-10-30', '10:00'),
  startYmd: '2026-10-01' as string | null,
  endYmd: null as string | null,
};
const day = (date: string, punches: string[], extra: Partial<typeof base> = {}) =>
  computeDay({ ...base, ...extra, date, punches: punches.map((h) => at(date, h)) });

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

describe('horário do funcionário', () => {
  it('previsto = entrada→saída menos o intervalo', () => {
    expect(expectedOf(S8)).toBe(480);
    expect(expectedOf(SAB)).toBe(240);
    expect(expectedOf(null)).toBe(0);
    expect(marksOf(S8)).toEqual([480, 720, 780, 1020]);
    expect(marksOf(SAB)).toEqual([480, 720]);
  });

  it('valida o dia', () => {
    expect(normalizeDaySchedule({ in: '', out: '' })).toEqual({ ok: true, value: null });
    expect(normalizeDaySchedule({ in: '08:00', out: '07:00' }).ok).toBe(false);
    expect(normalizeDaySchedule({ in: '08:00', out: '17:00', break_start: '12:00' }).ok).toBe(false);
    expect(normalizeDaySchedule({ in: '08:00', out: '17:00', break_start: '18:00', break_end: '19:00' }).ok).toBe(false);
    expect(normalizeDaySchedule({ in: '8:00', out: '17:00' }).ok).toBe(false);
    expect(normalizeDaySchedule({ in: '08:00', break_start: '12:00', break_end: '13:00', out: '17:00' })).toEqual({ ok: true, value: S8 });
    expect(normalizeWeek([null, S8]).ok).toBe(false);
    expect(normalizeWeek(WEEK)).toEqual({ ok: true, value: WEEK });
  });

  it('usa a versão vigente no dia (mudar o horário não reescreve o passado)', () => {
    const SEIS: DaySchedule = { in: '08:00', break_start: null, break_end: null, out: '14:00' };
    const v: ScheduleVersion[] = [
      { valid_from: '2026-01-01', days: WEEK },
      { valid_from: '2026-10-15', days: [null, SEIS, SEIS, SEIS, SEIS, SEIS, null] },
    ];
    expect(scheduleOn(v, '2026-10-14')).toEqual(S8);
    expect(scheduleOn(v, '2026-10-15')).toEqual(SEIS);
    // antes da 1ª vigência (início puxado pra trás) usa a 1ª versão — senão virava folga
    expect(scheduleOn(v, '2025-12-31')).toEqual(S8); // quarta
    expect(scheduleOn([], '2026-10-14')).toBeNull();
  });
});

describe('feriados nacionais', () => {
  it('Páscoa e Sexta-feira Santa', () => {
    expect(easterSunday(2025)).toBe('2025-04-20');
    expect(easterSunday(2026)).toBe('2026-04-05');
    expect(easterSunday(2027)).toBe('2027-03-28');
    expect(nationalHolidays(2026).get('2026-04-03')).toBe('Sexta-feira Santa');
  });

  it('inclui 20/11 (desde 2024) e não inclui carnaval', () => {
    const h = nationalHolidays(2026);
    expect(h.get('2026-11-20')).toBe('Dia da Consciência Negra');
    expect(h.get('2026-10-12')).toBe('Nossa Senhora Aparecida');
    expect(h.size).toBe(10);
  });

  it('feriado da clínica soma aos nacionais', () => {
    const m = holidaysForMonth('2026-08', new Map([['2026-08-27', 'N. Sra. dos Prazeres']]));
    expect([...m.keys()]).toEqual(['2026-08-27']);
  });
});

describe('computeDay', () => {
  it('dia exato: 8h, intervalo 1h, saldo zero', () => {
    const d = day(SEG, ['13:00', '08:00', '17:00', '12:00']);
    expect(d.status).toBe('OK');
    expect(d.pairs).toEqual([
      { in: '08:00', out: '12:00', minutes: 240 },
      { in: '13:00', out: '17:00', minutes: 240 },
    ]);
    expect(d.worked_min).toBe(480);
    expect(d.interval_min).toBe(60);
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
  });

  it('tolerância: cada batida até 5 min e soma até 10 → dia fecha em zero', () => {
    const d = day(SEG, ['08:04', '12:00', '13:03', '17:02']); // 4+0+3+2 = 9
    expect(d.worked_min).toBe(475);
    expect(d.tolerance_applied).toBe(true);
    expect(d.balance_min).toBe(0);
  });

  it('uma batida passou de 5 min → conta a diferença inteira (Súmula 366)', () => {
    const d = day(SEG, ['08:06', '12:00', '13:00', '17:00']);
    expect(d.tolerance_applied).toBe(false);
    expect(d.balance_min).toBe(-6);
    expect(d.debit_min).toBe(6);
  });

  it('cada uma até 5 min mas a soma passou de 10 → conta inteira', () => {
    const d = day(SEG, ['07:55', '12:04', '12:58', '17:00']); // 5+4+2+0 = 11
    expect(d.worked_min).toBe(491);
    expect(d.balance_min).toBe(11);
    expect(d.extra_min).toBe(11);
  });

  it('não bateu o intervalo: conta o que bateu e avisa', () => {
    const d = day(SEG, ['08:00', '17:00']);
    expect(d.worked_min).toBe(540);
    expect(d.balance_min).toBe(60);
    expect(d.alerts).toContain('Intervalo não registrado (faltam as batidas do intervalo)');
  });

  it('batida ímpar em dia passado = INCOMPLETO, sem saldo', () => {
    const d = day(SEG, ['08:00', '12:00', '13:00']);
    expect(d.status).toBe('INCOMPLETO');
    expect(d.balance_min).toBeNull();
    expect(d.pairs[1]).toEqual({ in: '13:00', out: null, minutes: 0 });
  });

  it('hoje com entrada aberta conta até agora e não fecha saldo', () => {
    const d = computeDay({ ...base, date: SEG, todayYmd: SEG, now: at(SEG, '10:30', 40), punches: [at(SEG, '08:00')] });
    expect(d.status).toBe('HOJE');
    expect(d.worked_min).toBe(150);
    expect(d.balance_min).toBeNull();
  });

  it('dia de trabalho sem batida = FALTA com as horas do dia', () => {
    const d = day(SEG, []);
    expect(d.status).toBe('FALTA');
    expect(d.balance_min).toBe(-480);
    expect(d.absence_min).toBe(480);
  });

  it('fora do período na equipe não conta (antes de entrar / depois de sair)', () => {
    expect(day(SEG, [], { startYmd: '2026-10-20' }).status).toBe('FORA_DO_PERIODO');
    const depois = day(SEG, ['08:00', '12:00'], { endYmd: '2026-10-18' });
    expect(depois.status).toBe('FORA_DO_PERIODO');
    expect(depois.balance_min).toBeNull();
    expect(depois.alerts).toContain('Batida fora do período na equipe do ponto (não conta)');
    expect(day(SEG, [], { startYmd: null }).status).toBe('FORA_DO_PERIODO');
  });

  it('domingo sem horário: folga; se trabalhar vira extra de domingo/feriado', () => {
    const DOM = '2026-10-18';
    expect(day(DOM, [], { schedule: null }).status).toBe('FOLGA');
    const d = day(DOM, ['08:00', '12:00'], { schedule: null });
    expect(d.balance_min).toBe(240);
    expect(d.extra_dsr_min).toBe(240);
    expect(d.extra_min).toBe(0);
  });

  it('sábado de folga trabalhado = extra normal (não é domingo)', () => {
    const d = day('2026-10-17', ['08:00', '12:00'], { schedule: null });
    expect(d.extra_min).toBe(240);
    expect(d.extra_dsr_min).toBe(0);
  });

  it('feriado: previsto zero; trabalhado vira extra de domingo/feriado', () => {
    expect(day(SEG, [], { holiday: 'X' }).status).toBe('FERIADO');
    const d = day(SEG, ['08:00', '12:00'], { holiday: 'X' });
    expect(d.expected_min).toBe(0);
    expect(d.extra_dsr_min).toBe(240);
    expect(d.alerts).toContain('Trabalho no feriado (X)');
  });

  it('jornada acima de 6h sem intervalo (dia sem intervalo previsto) gera alerta', () => {
    const NOVE: DaySchedule = { in: '08:00', break_start: null, break_end: null, out: '17:00' };
    const d = day(SEG, ['08:00', '17:00'], { schedule: NOVE });
    expect(d.balance_min).toBe(0);
    expect(d.alerts).toContain('Intervalo menor que 1h (jornada acima de 6h)');
  });

  it('4h04 no sábado não cobra intervalo; mais de 10h no dia avisa', () => {
    expect(day('2026-10-17', ['08:00', '12:04'], { schedule: SAB }).alerts).toEqual([]);
    expect(day(SEG, ['07:00', '12:00', '13:00', '19:00']).alerts).toContain('Mais de 10h no dia (limite de 2h extras)');
  });
});

describe('computeMonth', () => {
  it('soma só os dias fechados; falta, extra e hoje separados', () => {
    const r = computeMonth({
      ym: '2026-10',
      punches: [
        at('2026-10-19', '08:00'), at('2026-10-19', '12:00'), at('2026-10-19', '13:00'), at('2026-10-19', '17:00'),
        // 20/10 sem batida → falta
        at('2026-10-21', '08:00'), at('2026-10-21', '12:00'), at('2026-10-21', '13:00'), at('2026-10-21', '18:30'),
        at('2026-10-22', '08:00'), // hoje, ainda trabalhando
      ],
      versions: VERSIONS,
      holidays: new Map(),
      todayYmd: '2026-10-22',
      now: at('2026-10-22', '10:30'),
      startYmd: '2026-10-19',
    });
    expect(r.days).toHaveLength(31);
    expect(r.days[0].status).toBe('FORA_DO_PERIODO');
    expect(r.days[18].status).toBe('OK');
    expect(r.days[19].status).toBe('FALTA');
    expect(r.days[20].extra_min).toBe(90);
    expect(r.days[21].status).toBe('HOJE');
    expect(r.days[22].status).toBe('FUTURO');
    expect(r.totals).toEqual({
      worked_min: 1050,
      expected_min: 1440,
      balance_min: -390,
      extra_min: 90,
      extra_dsr_min: 0,
      debit_min: 0,
      absence_min: 480,
      tolerance_min: 0,
      absences: 1,
      days_worked: 2,
      incomplete: 0,
      today_worked_min: 150,
    });
  });

  it('feriado nacional entra sozinho e sábado conta 4h de falta', () => {
    const r = computeMonth({
      ym: '2026-10',
      punches: [],
      versions: VERSIONS,
      holidays: new Map(),
      todayYmd: '2026-10-13',
      now: at('2026-10-13', '09:00'),
      startYmd: '2026-10-01',
    });
    expect(r.days[11]).toMatchObject({ status: 'FERIADO', holiday: 'Nossa Senhora Aparecida', balance_min: 0 });
    expect(r.days[3].status).toBe('FOLGA'); // domingo 04/10
    // faltas: 01,02,05–09 (8h) + sábados 03 e 10 (4h)
    expect(r.totals.absences).toBe(9);
    expect(r.totals.absence_min).toBe(7 * 480 + 2 * 240);
  });

  it('saldo do mês = extras + extras dom/feriado − atrasos − faltas', () => {
    const punches = [
      ...['08:00', '12:00', '13:00', '17:40'].map((h) => at('2026-10-05', h)), // +40
      ...['08:30', '12:00', '13:00', '17:00'].map((h) => at('2026-10-06', h)), // −30
      ...['08:00', '12:00'].map((h) => at('2026-10-11', h)),                   // domingo +240
    ];
    const r = computeMonth({
      ym: '2026-10', punches, versions: VERSIONS, holidays: new Map(),
      todayYmd: '2026-10-08', now: at('2026-10-08', '07:00'), startYmd: '2026-10-05',
    });
    const t = r.totals;
    expect(t.extra_min).toBe(40);
    expect(t.debit_min).toBe(30);
    expect(t.absence_min).toBe(480); // 07/10
    expect(t.extra_dsr_min).toBe(0); // o domingo 11/10 ainda não chegou (hoje é 08/10)
    expect(t.balance_min).toBe(t.extra_min + t.extra_dsr_min - t.debit_min - t.absence_min);
  });

  it('troca de horário no meio do mês: cada dia usa o horário da época', () => {
    const SEIS: DaySchedule = { in: '08:00', break_start: null, break_end: null, out: '14:00' };
    const r = computeMonth({
      ym: '2026-10',
      punches: [],
      versions: [...VERSIONS, { valid_from: '2026-10-15', days: [null, SEIS, SEIS, SEIS, SEIS, SEIS, null] }],
      holidays: new Map(),
      todayYmd: '2026-10-17',
      now: at('2026-10-17', '07:00'),
      startYmd: '2026-10-14',
    });
    expect(r.days[13].absence_min).toBe(480); // qua 14/10
    expect(r.days[14].absence_min).toBe(360); // qui 15/10
    expect(r.days[15].absence_min).toBe(360); // sex 16/10
  });

  it('alerta descanso entre jornadas menor que 11h (inclusive vindo do mês anterior)', () => {
    const r = computeMonth({
      ym: '2026-11',
      punches: [at('2026-10-31', '14:00'), at('2026-10-31', '23:00'), at('2026-11-02', '08:00'), at('2026-11-02', '12:00')],
      versions: VERSIONS,
      holidays: new Map(),
      todayYmd: '2026-11-10',
      now: at('2026-11-10', '09:00'),
      startYmd: '2026-10-01',
    });
    expect(r.days[1].alerts.some((a) => a.startsWith('Descanso entre jornadas'))).toBe(false); // 33h de descanso
    const r2 = computeMonth({
      ym: '2026-11',
      punches: [at('2026-10-31', '14:00'), at('2026-10-31', '23:00'), at('2026-11-01', '08:00'), at('2026-11-01', '12:00')],
      versions: VERSIONS,
      holidays: new Map(),
      todayYmd: '2026-11-10',
      now: at('2026-11-10', '09:00'),
      startYmd: '2026-10-01',
    });
    expect(r2.days[0].alerts).toContain('Descanso entre jornadas de 9h00 (mínimo 11h)');
  });
});

describe('auditoria das horas (contabilidade)', () => {
  it('semana completa conferida à mão: feriado, tolerância, extra, atraso, falta, sábado e domingo', () => {
    const W = (ymd: string, hs: string[]) => hs.map((h) => at(ymd, h));
    const r = computeMonth({
      ym: '2026-11',
      punches: [
        ...W('2026-11-02', ['08:00', '12:00']),                   // seg — Finados (feriado nacional) trabalhado: +4h00 dom/fer
        ...W('2026-11-03', ['08:04', '12:00', '13:03', '17:02']), // ter — 4+0+3+2 = 9 min: tolerância; trabalhou 7h55
        ...W('2026-11-04', ['08:00', '12:00', '13:00', '18:30']), // qua — ficou até 18h30: +1h30 extra
        ...W('2026-11-05', ['08:20', '12:00', '13:00', '17:00']), // qui — chegou 08h20: −0h20 atraso
        //                                                           sex — não veio: falta de 8h
        ...W('2026-11-07', ['08:06', '12:00']),                   // sáb — 6 min > 5: conta inteiro, −0h06
        ...W('2026-11-08', ['09:00', '11:00']),                   // dom — sem horário: +2h00 dom/fer
      ],
      versions: VERSIONS,
      holidays: new Map(),
      todayYmd: '2026-11-09',
      now: at('2026-11-09', '07:00'),
      startYmd: '2026-11-02',
    });
    const d = (dd: number) => r.days[dd - 1];
    expect(d(2)).toMatchObject({ status: 'OK', holiday: 'Finados', worked_min: 240, expected_min: 0, extra_dsr_min: 240, balance_min: 240 });
    expect(d(3)).toMatchObject({ worked_min: 475, expected_min: 480, tolerance_applied: true, tolerance_min: -5, balance_min: 0 });
    expect(d(4)).toMatchObject({ worked_min: 570, extra_min: 90, balance_min: 90 });
    expect(d(5)).toMatchObject({ worked_min: 460, debit_min: 20, balance_min: -20 });
    expect(d(6)).toMatchObject({ status: 'FALTA', absence_min: 480, balance_min: -480 });
    expect(d(7)).toMatchObject({ worked_min: 234, expected_min: 240, tolerance_applied: false, debit_min: 6, balance_min: -6 });
    expect(d(8)).toMatchObject({ worked_min: 120, expected_min: 0, extra_dsr_min: 120, balance_min: 120 });
    expect(r.totals).toEqual({
      worked_min: 240 + 475 + 570 + 460 + 234 + 120, // 2099 = 34h59
      expected_min: 480 * 4 + 240,                    // 2160 = 36h00 (feriado e domingo = 0)
      balance_min: 90 + 360 - 26 - 480,               // −56
      extra_min: 90,
      extra_dsr_min: 360,
      debit_min: 26,
      absence_min: 480,
      tolerance_min: -5,
      absences: 1,
      days_worked: 6,
      incomplete: 0,
      today_worked_min: 0,
    });
    // a conta fecha: trabalhado − previsto = saldo + tolerância
    expect(r.totals.worked_min - r.totals.expected_min).toBe(r.totals.balance_min + r.totals.tolerance_min);
  });

  it('3.000 dias sorteados: as contas sempre fecham', () => {
    let seed = 20261022;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const NOVE: DaySchedule = { in: '08:00', break_start: null, break_end: null, out: '17:00' };
    const schedules = [S8, SAB, NOVE, null];
    const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    for (let i = 0; i < 3000; i++) {
      const schedule = schedules[Math.floor(rnd() * schedules.length)];
      const holiday = rnd() < 0.1 ? 'Feriado' : null;
      const marks = marksOf(schedule).length ? marksOf(schedule) : [480, 720, 780, 1020];
      const n = Math.floor(rnd() * 7);
      const mins = new Set<number>();
      for (let k = 0; k < n; k++) {
        const alvo = marks[k % marks.length] + Math.floor(rnd() * 31) - 15;
        mins.add(rnd() < 0.2 ? 360 + Math.floor(rnd() * 840) : alvo);
      }
      const day = computeDay({
        ...base,
        date: SEG,
        schedule,
        holiday,
        punches: [...mins].map((m) => at(SEG, hhmm(m), Math.floor(rnd() * 60))),
      });
      const pairSum = day.pairs.reduce((s, p) => s + p.minutes, 0);
      expect(day.worked_min).toBe(pairSum);
      if (day.balance_min === null) {
        expect(day.status).toBe('INCOMPLETO');
        continue;
      }
      expect(day.balance_min).toBe(day.extra_min + day.extra_dsr_min - day.debit_min - day.absence_min);
      expect(day.worked_min - day.expected_min).toBe(day.balance_min + day.tolerance_min);
      for (const v of [day.extra_min, day.extra_dsr_min, day.debit_min, day.absence_min]) expect(v).toBeGreaterThanOrEqual(0);
      expect(day.extra_min > 0 && day.debit_min > 0).toBe(false);
      expect(Math.abs(day.tolerance_min)).toBeLessThanOrEqual(10);
      if (day.tolerance_min !== 0) expect(day.tolerance_applied).toBe(true);
      if (day.expected_min === 0) expect(day.debit_min + day.absence_min).toBe(0); // folga/feriado nunca vira desconto
    }
  });
});

describe('utilitários', () => {
  it('fmtMin', () => {
    expect(fmtMin(485)).toBe('8h05');
    expect(fmtMin(-70)).toBe('-1h10');
    expect(fmtMin(0)).toBe('0h00');
  });
});
