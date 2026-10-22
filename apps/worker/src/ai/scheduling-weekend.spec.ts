import {
  mergeFreeDays,
  pickSuggestedSlots,
  prefersWeekend,
  upcomingSaturdays,
  wantsWeekend,
  weekdayOf,
} from './scheduling-safety';

describe('wantsWeekend — paciente pede sábado/fim de semana', () => {
  it.each([
    'Eu só posso final de semana',
    'só posso no fim de semana',
    'Só sábado',
    'só aos sábados',
    'tem sábado?',
    'atende sábado?',
    'pode ser no sábado de manhã?',
    'só consigo nos finais de semana',
    'só no fds',
    'não, só sábado',
    'durante a semana não consigo',
    'dia de semana não dá pra mim',
    'não posso em dia de semana',
    'de segunda a sexta é complicado',
  ])('pede: %p', (t) => expect(wantsWeekend(t)).toBe(true));

  it.each([
    '',
    'pode ser terça',
    'sábado não posso',
    'no sábado não',
    'não posso no sábado',
    'menos sábado',
    'nem no fim de semana',
    'sábado eu trabalho',
    'trabalho de segunda a sábado',
    'trabalho no sábado',
    'fim de semana passado tive dor',
    'no último sábado quebrou o dente',
  ])('NÃO pede: %p', (t) => expect(wantsWeekend(t)).toBe(false));
});

describe('prefersWeekend — olha as 2 últimas mensagens do paciente', () => {
  it('pediu fim de semana na última', () => {
    expect(prefersWeekend(['oi', 'Eu só posso final de semana'])).toBe(true);
  });
  it('pediu fim de semana e depois só "ok"', () => {
    expect(prefersWeekend(['Eu só posso final de semana', 'ok'])).toBe(true);
  });
  it('depois pediu dia de semana: não força sábado', () => {
    expect(prefersWeekend(['Eu só posso final de semana', 'pode ser terça?'])).toBe(false);
  });
  it('depois recusou o sábado: não força sábado', () => {
    expect(prefersWeekend(['só posso fim de semana', 'sábado não dá'])).toBe(false);
  });
  it('pedido antigo (3+ mensagens atrás) não vale mais', () => {
    expect(prefersWeekend(['só posso fim de semana', 'ok', 'quanto custa?'])).toBe(false);
  });
  it('sem pedido', () => {
    expect(prefersWeekend(['quero marcar', null, ''])).toBe(false);
  });
});

describe('upcomingSaturdays', () => {
  it('a partir de uma quinta: o sábado desta semana e os seguintes', () => {
    expect(upcomingSaturdays('2026-10-22', 3)).toEqual(['2026-10-24', '2026-10-31', '2026-11-07']);
  });
  it('a partir de um sábado: ele mesmo entra', () => {
    expect(upcomingSaturdays('2026-10-24', 2)).toEqual(['2026-10-24', '2026-10-31']);
  });
  it('todos são sábado', () => {
    for (const d of upcomingSaturdays('2026-12-28', 6)) expect(weekdayOf(d)).toBe(6);
  });
});

describe('proposta de sábado', () => {
  it('sábado desta semana cheio → o próximo sábado com vaga vem primeiro', () => {
    // 24/10 sem vaga (não entra na lista); 31/10 e 07/11 com vaga.
    const sats = [
      { date: '2026-10-31', times: ['08:00', '09:00', '10:00'] },
      { date: '2026-11-07', times: ['08:30', '11:00'] },
    ];
    const picks = pickSuggestedSlots(sats);
    expect(picks[0]).toEqual({ date: '2026-10-31', time: '08:00' });
    expect(picks.every((s) => weekdayOf(s.date) === 6)).toBe(true);
  });

  it('mergeFreeDays junta os sábados fora da janela sem repetir data', () => {
    const week = [
      { date: '2026-10-26', times: ['09:00'] },
      { date: '2026-10-31', times: ['08:00'] },
    ];
    const sats = [
      { date: '2026-10-31', times: ['08:00'] },
      { date: '2026-11-07', times: ['10:00'] },
    ];
    expect(mergeFreeDays(week, sats).map((d) => d.date)).toEqual(['2026-10-26', '2026-10-31', '2026-11-07']);
  });
});
