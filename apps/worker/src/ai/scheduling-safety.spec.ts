import {
  alternativeCandidates,
  analyzeBookingClaims,
  assessBookingClaim,
  buildBookingFixText,
  buildConfirmChoiceText,
  buildHonestPreferenceText,
  buildRefusalOfferText,
  buildRequestedUnavailableText,
  buildSlotTakenText,
  claimsBooked,
  compactDayTimes,
  existingAppointmentFilter,
  extractOfferedSlots,
  extractSlotMentions,
  findBookingClaims,
  formatSlotLabel,
  hasRecentAiTeamNote,
  isAiTeamNote,
  isExistingAppointmentSlot,
  isPastNaive,
  isPureAcceptance,
  isSlotSpecificRefusal,
  isStrictYes,
  isValidConfirmSlot,
  lastOutTurnText,
  maceioTodayStr,
  mentionsExistingAppointment,
  modelEmittedNoAction,
  normalizeDateValue,
  normalizeSchedulingAction,
  normalizeTime,
  patientAcceptedSlot,
  pickAlternativeSlots,
  pickSuggestedSlots,
  recoverSlotFromText,
  reminderDelayMs,
  resolvePatientChoice,
  stripBookingClaimText,
  stripCancellationClaims,
  withoutRefused,
  type FreeSlotDay,
} from './scheduling-safety';

/** Instante REAL a partir da hora de Maceió (UTC-3). */
const maceio = (iso: string) => new Date(`${iso}-03:00`).getTime();
/** Data naive (hora de Maceió gravada como UTC — igual à agenda). */
const naive = (iso: string) => new Date(`${iso}Z`);

// Segunda 12/10/2026, 15:00 em Maceió.
const NOW = maceio('2026-10-12T15:00:00');
const TODAY = '2026-10-12';

// Agenda livre (Orçamentista): ter 13/10, qua 14/10, qui 15/10, ter 20/10.
const FREE: FreeSlotDay[] = [
  { date: '2026-10-13', times: ['08:00', '08:30', '09:00', '09:30', '10:00', '13:00', '14:00', '15:00'] },
  { date: '2026-10-14', times: ['08:00', '09:00', '14:00'] },
  { date: '2026-10-15', times: ['10:00', '11:00'] },
  { date: '2026-10-20', times: ['09:00'] },
];

/**
 * MODO CONSERVADOR (portão final da 13a): a heurística marcaria, mas não é o caso
 * estreito — vira "Pra eu deixar certinho na agenda, me confirma: pode ser <slot>?".
 */
const asksToConfirm = (slot: { date: string; time: string }) => ({
  kind: 'correct',
  why: expect.stringContaining('modo conservador'),
  propose: [slot],
  ambiguous: false,
  requested: null,
  offer: false,
});

describe('fuso naive (Maceió)', () => {
  it('hoje em Maceió vira o dia certo à noite (21h ainda é o mesmo dia)', () => {
    expect(maceioTodayStr(NOW)).toBe(TODAY);
    expect(maceioTodayStr(maceio('2026-10-12T22:30:00'))).toBe(TODAY);
    expect(maceioTodayStr(maceio('2026-10-13T00:10:00'))).toBe('2026-10-13');
  });

  it('"já passou" compara no mesmo referencial (não recusa 3h antes da hora)', () => {
    const now = maceio('2026-10-13T06:30:00'); // 09:30Z real
    expect(isPastNaive(naive('2026-10-13T08:00:00'), now)).toBe(false); // falta 1h30
    expect(isPastNaive(naive('2026-10-13T06:00:00'), now)).toBe(true);
  });

  it('delay do lembrete = instante REAL (naive + 3h) − antecedência − agora (igual à API)', () => {
    const start = naive('2026-10-13T09:00:00'); // 09:00 em Maceió = 12:00Z
    const now = maceio('2026-10-13T07:00:00'); // 2h antes
    expect(reminderDelayMs(start, 60, now)).toBe(60 * 60_000); // 1h antes = daqui 1h
    expect(reminderDelayMs(start, 15, now)).toBe(105 * 60_000);
    expect(reminderDelayMs(start, 1440, now)).toBeLessThan(0); // 1 dia antes já passou
  });
});

describe('normalizeTime / normalizeDateValue', () => {
  it.each([
    ['09:00', '09:00'],
    ['9:00', '09:00'],
    ['09:00:00', '09:00'],
    ['8h', '08:00'],
    ['8h30', '08:30'],
    ['14hs', '14:00'],
    ['às 9', '09:00'],
    ['9 horas', '09:00'],
    [9, '09:00'],
  ])('hora %p → %p', (raw, out) => {
    expect(normalizeTime(raw)).toBe(out);
  });

  it.each([['25:00'], ['9:75'], ['manhã'], [''], [null]])('hora inválida %p → undefined', (raw) => {
    expect(normalizeTime(raw)).toBeUndefined();
  });

  it('ISO sem fuso separa a hora (com Z/offset: ver "item 8")', () => {
    expect(normalizeDateValue('2026-10-14T09:30:00', TODAY)).toEqual({ date: '2026-10-14', time: '09:30' });
    expect(normalizeDateValue('2026-10-14 09:30', TODAY)).toEqual({ date: '2026-10-14', time: '09:30' });
    expect(normalizeDateValue('2026-10-14', TODAY)).toEqual({ date: '2026-10-14', time: undefined });
  });

  it('DD/MM sem ano = próxima ocorrência a partir de hoje (Maceió)', () => {
    expect(normalizeDateValue('14/10', TODAY).date).toBe('2026-10-14');
    expect(normalizeDateValue('12/10', TODAY).date).toBe('2026-10-12'); // hoje
    expect(normalizeDateValue('09/10', TODAY).date).toBe('2026-10-09'); // já passou: fica no ano (a guarda recusa), nunca vira o ano
    expect(normalizeDateValue('05/01', TODAY).date).toBe('2026-01-05');
    expect(normalizeDateValue('05/01', '2026-12-20').date).toBe('2027-01-05'); // virada dez → jan
  });

  it('DD/MM/AAAA e DD/MM/AA; data inexistente vira undefined', () => {
    expect(normalizeDateValue('14/10/2026', TODAY).date).toBe('2026-10-14');
    expect(normalizeDateValue('14/10/26', TODAY).date).toBe('2026-10-14');
    expect(normalizeDateValue('31/02', TODAY).date).toBeUndefined();
  });
});

describe('normalizeSchedulingAction', () => {
  const full = { action: 'confirm_slot', date: '2026-10-14', time: '09:00' };

  it('formato do contrato passa igual', () => {
    expect(normalizeSchedulingAction({ reply: 'x', scheduling_action: full }, NOW)).toEqual(full);
  });

  it('aceita a ação dentro de updates', () => {
    expect(normalizeSchedulingAction({ reply: 'x', updates: { name: 'Ana', scheduling_action: full } }, NOW)).toEqual(full);
  });

  it('aceita {action,date,time} solto no topo (sem o wrapper)', () => {
    expect(normalizeSchedulingAction({ reply: 'x', ...full }, NOW)).toEqual(full);
  });

  it('grafia variante da ação', () => {
    for (const a of ['CONFIRM_SLOT', 'confirm-slot', 'Confirm Slot']) {
      expect(normalizeSchedulingAction({ scheduling_action: { ...full, action: a } }, NOW)).toEqual(full);
    }
    expect(normalizeSchedulingAction({ scheduling_action: { action: 'CANCEL-APPOINTMENT' } }, NOW)).toEqual({
      action: 'cancel_appointment',
    });
  });

  it('data ISO com hora, DD/MM e hora "8h30"', () => {
    expect(
      normalizeSchedulingAction({ scheduling_action: { action: 'confirm_slot', date: '2026-10-14T08:30:00' } }, NOW),
    ).toEqual({ action: 'confirm_slot', date: '2026-10-14', time: '08:30' });
    expect(
      normalizeSchedulingAction({ scheduling_action: { action: 'confirm_slot', date: '14/10', time: '8h30' } }, NOW),
    ).toEqual({ action: 'confirm_slot', date: '2026-10-14', time: '08:30' });
    expect(
      normalizeSchedulingAction({ scheduling_action: { action: 'confirm_slot', data: '14/10/2026', hora: '9:00:00' } }, NOW),
    ).toEqual({ action: 'confirm_slot', date: '2026-10-14', time: '09:00' });
  });

  it('JSON em string e string solta', () => {
    expect(normalizeSchedulingAction({ scheduling_action: JSON.stringify(full) }, NOW)).toEqual(full);
    expect(normalizeSchedulingAction({ scheduling_action: 'confirm_appointment' }, NOW)).toEqual({
      action: 'confirm_appointment',
    });
  });

  it('prefere o confirm_slot completo quando há mais de um candidato', () => {
    expect(
      normalizeSchedulingAction({ scheduling_action: { action: 'confirm_slot' }, updates: { scheduling_action: full } }, NOW),
    ).toEqual(full);
  });

  it('null / ação desconhecida / sem ação → null', () => {
    expect(normalizeSchedulingAction({ reply: 'x', scheduling_action: null }, NOW)).toBeNull();
    expect(normalizeSchedulingAction({ reply: 'x', scheduling_action: { action: 'none' } }, NOW)).toBeNull();
    expect(normalizeSchedulingAction({ reply: 'x' }, NOW)).toBeNull();
    expect(normalizeSchedulingAction(null, NOW)).toBeNull();
  });

  it('isValidConfirmSlot exige data e hora completas', () => {
    expect(isValidConfirmSlot(full)).toBe(true);
    expect(isValidConfirmSlot({ action: 'confirm_slot', date: '2026-10-14' })).toBe(false);
    expect(isValidConfirmSlot({ action: 'confirm_slot', date: '14/10', time: '09:00' })).toBe(false);
    expect(isValidConfirmSlot(null)).toBe(false);
  });
});

describe('afirmação de marcação (findBookingClaims)', () => {
  it.each([
    'Perfeito, deixei agendado dia 14/10 às 9h. Te mando a confirmação e te lembro um dia antes.',
    'Prontinho! Sua avaliação ficou marcada pra terça às 9h',
    'Agendei sua avaliação para terça, 14/10, às 9h.',
    'Agendamento confirmado ✅',
    'Já está agendado, Sr. Felipe!',
    'Sua consulta com a Dra. Suellen está confirmada pra terça às 9h, tudo bem?',
    'Perfeito, deixei agendado pra terça às 9h, combinado?',
    'Agendado pra terça às 9h!',
    'Perfeito, agendado! Terça (13/10) às 9h.',
    'Prontinho! Sua avaliação está agendada para amanhã (terça), às 8h. Te lembro um dia antes 😊',
    'Pronto! Já reservei terça às 9h pra você.',
    'Perfeito, vou deixar agendado terça às 9h.',
    'Não se preocupe, deixei agendado terça às 9h.',
  ])('afirma: %p', (txt) => {
    expect(claimsBooked(txt)).toBe(true);
  });

  it.each([
    'Quer que eu deixe agendado?',
    'Posso deixar agendado terça às 9h?',
    'Posso deixar agendado terça às 9h, tudo bem?',
    'Vamos deixar terça às 17h que já fica certo?',
    'Fica agendado terça às 9h então?',
    'Ainda não está agendado.',
    'Não consegui agendar ainda.',
    'Assim que você confirmar, deixo agendado.',
    'Se preferir, deixo marcado pra terça.',
    'Deixo agendado se você quiser.',
    'Tenho terça às 9h ou quarta às 10h. Qual fica melhor?',
    'Deixa eu confirmar esse horário certinho e já te retorno, tá?',
    'A avaliação é sem compromisso.',
  ])('NÃO afirma: %p', (txt) => {
    expect(claimsBooked(txt)).toBe(false);
  });

  it('os textos de correção da própria rede de segurança não são afirmação', () => {
    const slots = [
      { date: '2026-10-13', time: '09:00' },
      { date: '2026-10-14', time: '14:00' },
    ];
    expect(claimsBooked(buildHonestPreferenceText(slots[0]))).toBe(false);
    expect(claimsBooked(buildHonestPreferenceText())).toBe(false);
    expect(claimsBooked(buildSlotTakenText(slots))).toBe(false);
    expect(claimsBooked(buildConfirmChoiceText(slots, false))).toBe(false);
    expect(claimsBooked(buildConfirmChoiceText(slots, true))).toBe(false);
  });

  it('devolve só a(s) frase(s) da afirmação', () => {
    expect(findBookingClaims('Que bom! Deixei agendado terça às 9h. Qualquer dúvida me chama.')).toEqual([
      'deixei agendado terca as 9h',
    ]);
  });

  it.each([
    // descritivo (fluxo de venda) — "fica + particípio" não é fato
    'A avaliação custa apenas R$ 150 e fica marcada com a Dra. Suellen, que avalia seu sorriso.',
    'Na consulta de avaliação, que fica agendada com a Dra. Suellen, ela faz fotos e o plano.',
    'A manutenção do aparelho fica agendada uma vez por mês.',
    'O horário fica reservado por 24h depois que você confirmar.',
    'O horário está reservado por 24h.',
    'A avaliação fica marcada com a Dra. Suellen, que atende terça às 9h.',
    // pagamento não é consulta (chip Financeiro)
    'Combinado! Fica agendado o pagamento pra sexta então 😊',
    'Seu boleto foi agendado para o dia 15/10.',
    'O pagamento ficou agendado pra sexta.',
  ])('NÃO afirma (descrição/pagamento): %p', (txt) => {
    expect(claimsBooked(txt)).toBe(false);
  });

  it('pagamento em OUTRA oração não esconde a afirmação', () => {
    expect(claimsBooked('Deixei agendado terça às 9h, e o pagamento é na clínica.')).toBe(true);
  });

  it('fato x intenção x pergunta', () => {
    expect(analyzeBookingClaims('Perfeito, deixei agendado terça às 9h.')).toMatchObject({
      firm: true,
      asksConfirmation: false,
      hasQuestion: false,
    });
    // pergunta em OUTRA frase: não é pergunta da afirmação, mas a resposta pergunta (proposta)
    expect(analyzeBookingClaims('Vou deixar agendado pra terça às 9h. Pode ser?')).toMatchObject({
      firm: false,
      asksConfirmation: false,
      hasQuestion: true,
    });
    expect(analyzeBookingClaims('Deixei reservado terça às 8h pra você, é só confirmar!')).toMatchObject({
      firm: true,
      asksConfirmation: true,
    });
    expect(analyzeBookingClaims('Já deixo reservado terça às 8h pra você 😊\nPode ser?').firm).toBe(false);
    // "fica + particípio" só com dia + hora logo depois, e como intenção
    expect(analyzeBookingClaims('Fica agendado então quinta às 11h 😊')).toMatchObject({ firm: false, asksConfirmation: false });
    expect(analyzeBookingClaims('Então fica marcado quinta (15/10) às 9h. Combinado?')).toMatchObject({
      firm: false,
      asksConfirmation: false,
      hasQuestion: true,
    });
  });
});

describe('extractSlotMentions', () => {
  it('data, dia da semana e hora em vários formatos', () => {
    const m = extractSlotMentions('Deixei agendado terça-feira, 14/10, às 9h30', TODAY);
    expect([...m.dates]).toEqual(['2026-10-14']);
    expect([...m.weekdays]).toEqual([2]);
    expect([...m.times]).toEqual(['09:30']);
  });

  it('amanhã / depois de amanhã / "dia 15" / "2 da tarde"', () => {
    expect([...extractSlotMentions('amanhã às 8h', TODAY).dates]).toEqual(['2026-10-13']);
    expect([...extractSlotMentions('depois de amanhã às 8h', TODAY).dates]).toEqual(['2026-10-14']);
    expect([...extractSlotMentions('dia 15 às 10:00', TODAY).dates]).toEqual(['2026-10-15']);
    expect(extractSlotMentions('quinta às 2 da tarde', TODAY).times.has('14:00')).toBe(true);
  });

  it('"terça que vem" / "próxima terça" / "semana que vem" marcam a data como relativa', () => {
    for (const t of ['terça que vem às 9h', 'próxima terça às 9h', 'terça-feira que vem', 'semana que vem às 9h', 'terça da outra semana']) {
      expect(extractSlotMentions(t, TODAY).relativeQualifier).toBe(true);
    }
    expect(extractSlotMentions('terça às 9h', TODAY).relativeQualifier).toBe(false);
    expect(extractSlotMentions('O que vem na avaliação?', TODAY).relativeQualifier).toBe(false);
    expect(extractSlotMentions('terça (20/10) às 9h', TODAY).explicitDate).toBe(true);
  });
});

describe('extractOfferedSlots (nossa proposta)', () => {
  it('pareia cada hora com a data explícita dela (sem produto cartesiano)', () => {
    expect(extractOfferedSlots('Tenho terça (13/10) às 8h ou quarta (14/10) às 14h, qual fica melhor?', TODAY)).toEqual([
      { date: '2026-10-13', time: '08:00' },
      { date: '2026-10-14', time: '14:00' },
    ]);
    expect(extractOfferedSlots('Pra eu deixar certinho na agenda, me confirma: pode ser quinta (15/10) às 11h?', TODAY)).toEqual([
      { date: '2026-10-15', time: '11:00' },
    ]);
  });

  it('dia da semana / "amanhã" sem DD/MM não contam (a oferta pode ser de outro dia)', () => {
    expect(extractOfferedSlots('Consigo terça às 9h ou amanhã às 8h, pode ser?', TODAY)).toEqual([]);
  });
});

describe('recoverSlotFromText', () => {
  it('1 candidato (DD/MM + hora) → match', () => {
    expect(recoverSlotFromText('Perfeito, deixei agendado dia 14/10 às 9h!', FREE, TODAY)).toEqual({
      status: 'match',
      date: '2026-10-14',
      time: '09:00',
    });
  });

  it('dia da semana + hora com 1 candidato → match', () => {
    expect(recoverSlotFromText('Deixei agendado quinta às 11h.', FREE, TODAY)).toEqual({
      status: 'match',
      date: '2026-10-15',
      time: '11:00',
    });
  });

  it('"amanhã às 8h" → o primeiro dia da lista', () => {
    expect(recoverSlotFromText('Prontinho, ficou marcado amanhã às 8h.', FREE, TODAY)).toEqual({
      status: 'match',
      date: '2026-10-13',
      time: '08:00',
    });
  });

  it('2 candidatos (duas terças com 9h livres) → ambíguo, nunca chuta', () => {
    const r = recoverSlotFromText('Deixei agendado terça às 9h.', FREE, TODAY);
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') {
      expect(r.candidates).toEqual([
        { date: '2026-10-13', time: '09:00' },
        { date: '2026-10-20', time: '09:00' },
      ]);
    }
  });

  it('0 candidatos (horário não está livre) → none', () => {
    expect(recoverSlotFromText('Deixei agendado quarta às 10h.', FREE, TODAY)).toEqual({
      status: 'none',
      reason: 'nao_livre',
    });
  });

  it('sem dia/hora no texto e sem contexto → none', () => {
    expect(recoverSlotFromText('Perfeito, deixei agendado!', FREE, TODAY)).toEqual({
      status: 'none',
      reason: 'sem_dia_ou_hora',
    });
  });

  it('sem dia/hora no texto → completa com a mensagem do paciente', () => {
    expect(
      recoverSlotFromText('Perfeito, deixei agendado!', FREE, TODAY, { contextText: 'pode ser quarta às 14h' }),
    ).toEqual({ status: 'match', date: '2026-10-14', time: '14:00' });
  });

  it('dia citado que contradiz a data ("terça" + "amanhã" numa quarta) não casa', () => {
    const wedToday = '2026-10-13'; // terça → amanhã é quarta 14/10
    expect(recoverSlotFromText('Deixei agendado terça amanhã às 9h.', FREE, wedToday).status).toBe('none');
  });

  it('usa a frase da afirmação antes do resto (ignora outra oferta na mesma resposta)', () => {
    const reply = 'Deixei agendado quinta às 11h. Se precisar, também tenho terça às 9h.';
    const claims = findBookingClaims(reply);
    expect(recoverSlotFromText(reply, FREE, TODAY, { claimText: claims.join('. ') })).toEqual({
      status: 'match',
      date: '2026-10-15',
      time: '11:00',
    });
  });

  it('afirmação sem horário + horário na frase seguinte → usa a resposta inteira', () => {
    const reply = 'Perfeito, agendado! Terça (13/10) às 9h com a Dra. Suellen.';
    expect(recoverSlotFromText(reply, FREE, TODAY, { claimText: findBookingClaims(reply).join('. ') })).toEqual({
      status: 'match',
      date: '2026-10-13',
      time: '09:00',
    });
  });

  it('hint de confirm_slot incompleto (só data) + hora do texto', () => {
    expect(
      recoverSlotFromText('Agendei às 14h!', FREE, TODAY, { hint: { date: '2026-10-14' } }),
    ).toEqual({ status: 'match', date: '2026-10-14', time: '14:00' });
  });

  it('"terça que vem" sem data NÃO casa com a terça mais próxima (nem pela mensagem do paciente)', () => {
    const solo: FreeSlotDay[] = [{ date: '2026-10-13', times: ['09:00'] }]; // só amanhã (13/10) livre
    expect(recoverSlotFromText('Perfeito, deixei agendado pra terça que vem às 9h!', solo, TODAY)).toEqual({
      status: 'none',
      reason: 'dia_relativo',
    });
    expect(
      recoverSlotFromText('Perfeito, deixei agendado!', solo, TODAY, { contextText: 'pode ser terça que vem às 9h' }),
    ).toEqual({ status: 'none', reason: 'dia_relativo' });
    // com a data explícita, casa
    expect(recoverSlotFromText('Deixei agendado terça que vem (20/10) às 9h!', FREE, TODAY)).toEqual({
      status: 'match',
      date: '2026-10-20',
      time: '09:00',
    });
  });
});

describe('o paciente aceitou o horário?', () => {
  const tue9 = { date: '2026-10-13', time: '09:00' };
  it.each(['pode ser terça às 9h', 'terça 9h', 'pode ser às 9h', 'sim', 'Pode ser!', 'ok', 'fechado 👍', '👍'])(
    'aceita: %p',
    (txt) => {
      expect(patientAcceptedSlot(txt, tue9, TODAY)).toBe(true);
    },
  );
  it.each([
    'tem terça às 9h?',
    'pode ser terça às 9h?',
    'terça às 9h não consigo, tem quarta às 10h?',
    'pode ser quarta às 14h',
    'pode ser de tarde',
    'ok, mas antes quero saber o valor',
    'vou pensar',
    'pode ser terça que vem às 9h',
    '',
  ])('NÃO aceita: %p', (txt) => {
    expect(patientAcceptedSlot(txt, tue9, TODAY)).toBe(false);
  });
  it('"de acordo" puro não pode ter dia/hora/turno próprio', () => {
    expect(isPureAcceptance('pode ser', TODAY)).toBe(true);
    expect(isPureAcceptance('pode ser às 9h', TODAY)).toBe(false);
    expect(isPureAcceptance('pode ser de manhã', TODAY)).toBe(false);
    expect(isPureAcceptance('Boa tarde! Pode ser sim', TODAY)).toBe(true);
  });
});

describe('assessBookingClaim (decisão da rede 13a)', () => {
  const base = { freeDays: FREE, todayStr: TODAY };

  it('modo conservador: horário completo que o paciente citou, SEM a nossa proposta → pede confirmação (não marca)', () => {
    expect(
      assessBookingClaim({ ...base, reply: 'Perfeito, deixei agendado quinta às 11h. Te lembro um dia antes.', patientText: 'pode ser quinta às 11h' }),
    ).toMatchObject(asksToConfirm({ date: '2026-10-15', time: '11:00' }));
  });

  it('MARCA: "Perfeito, agendado!" depois do "pode ser" à NOSSA proposta de um horário', () => {
    expect(
      assessBookingClaim({
        ...base,
        reply: 'Perfeito, agendado! 😊',
        patientText: 'pode ser',
        lastOutText: 'Consigo quinta (15/10) às 11h com a Dra. Suellen, pode ser?',
      }),
    ).toEqual({ kind: 'book', slot: { date: '2026-10-15', time: '11:00' } });
  });

  it('"sim" a uma proposta de 2 horários → pergunta qual (os 2 oferecidos), não marca', () => {
    const d = assessBookingClaim({
      ...base,
      reply: 'Perfeito, agendado! 😊',
      patientText: 'sim',
      lastOutText: 'Tenho terça (13/10) às 8h ou quarta (14/10) às 14h, qual fica melhor?',
    });
    expect(d).toMatchObject({
      kind: 'correct',
      ambiguous: true,
      propose: [
        { date: '2026-10-13', time: '08:00' },
        { date: '2026-10-14', time: '14:00' },
      ],
    });
  });

  describe('consulta que JÁ existe (nunca marca nem cancela)', () => {
    const existing = [naive('2026-10-20T09:00:00')]; // ter 20/10 9h
    it.each([
      ['Isso mesmo, está agendado! 😊', 'Minha avaliação é terça que vem às 9h, certo?'],
      ['Sua avaliação está agendada sim, terça que vem às 9h', 'Minha avaliação é terça que vem às 9h, certo?'],
      ['Sua consulta já está agendada para a próxima terça às 9h, quer remarcar?', 'oi'],
    ])('%p → não mexe', (reply, patientText) => {
      expect(assessBookingClaim({ ...base, reply, patientText, existingStarts: existing })).toEqual({ kind: 'existing' });
    });

    it('afirmação de OUTRO horário com consulta futura → não marca (equipe resolve)', () => {
      expect(
        assessBookingClaim({ ...base, reply: 'Deixei agendado quarta às 14h!', patientText: 'pode ser quarta 14h', existingStarts: existing }),
      ).toMatchObject({ kind: 'correct', hasExisting: true, propose: [{ date: '2026-10-14', time: '14:00' }] });
    });
  });

  it.each([
    'Vou deixar agendado pra terça às 9h. Pode ser?',
    'Já deixo reservado terça às 8h pra você 😊\nPode ser?',
    'Deixo reservado pra você quinta às 10h. Me confirma?',
    'Vou deixar agendado quinta às 10h. Tudo bem?',
    'Então fica marcado quinta (15/10) às 10h. Combinado?',
  ])('proposta com pergunta → não marca nem mexe: %p', (reply) => {
    expect(assessBookingClaim({ ...base, reply, patientText: 'oi, tem horário essa semana?' })).toEqual({ kind: 'offer' });
  });

  it('afirmação + "é só confirmar" → não marca; pede confirmação do horário', () => {
    expect(
      assessBookingClaim({ ...base, reply: 'Deixei reservado terça às 8h pra você, é só confirmar!', patientText: 'oi' }),
    ).toMatchObject({ kind: 'correct', propose: [{ date: '2026-10-13', time: '08:00' }] });
    // pedido de confirmação mesmo com o paciente tendo escolhido → não marca (CONFIRM_REQUEST_RE mantido)
    expect(
      assessBookingClaim({ ...base, reply: 'Deixei reservado quinta às 11h pra você, é só me confirmar!', patientText: 'pode ser quinta às 11h' }),
    ).toMatchObject({ kind: 'correct', propose: [{ date: '2026-10-15', time: '11:00' }] });
  });

  it('paciente PERGUNTOU ("tem quinta às 11h?") → não marca; pergunta se pode ser esse', () => {
    expect(
      assessBookingClaim({ ...base, reply: 'Perfeito, deixei agendado!', patientText: 'tem quinta às 11h?' }),
    ).toMatchObject({ kind: 'correct', propose: [{ date: '2026-10-15', time: '11:00' }] });
  });

  it('paciente RECUSOU → não usa a mensagem dele (nem o horário recusado)', () => {
    const solo: FreeSlotDay[] = [{ date: '2026-10-13', times: ['09:00'] }];
    expect(
      assessBookingClaim({ ...base, freeDays: solo, reply: 'Perfeito, deixei agendado!', patientText: 'terça às 9h não consigo, tem quarta às 10h?' }),
    ).toMatchObject({ kind: 'correct', propose: [] });
  });

  it('"terça que vem" sem data → não marca a terça mais próxima', () => {
    const solo: FreeSlotDay[] = [{ date: '2026-10-13', times: ['09:00'] }];
    expect(
      assessBookingClaim({ ...base, freeDays: solo, reply: 'Perfeito, deixei agendado pra terça que vem às 9h!', patientText: 'pode ser terça que vem às 9h' }),
    ).toMatchObject({ kind: 'correct', why: 'dia_relativo', propose: [] });
  });

  it.each(['Perfeito, vou deixar agendado quinta às 11h.', 'Fica agendado então quinta às 11h 😊'])(
    'promessa sem pergunta → não marca; pede confirmação: %p',
    (reply) => {
      expect(assessBookingClaim({ ...base, reply, patientText: 'pode ser quinta às 11h' })).toMatchObject({
        kind: 'correct',
        propose: [{ date: '2026-10-15', time: '11:00' }],
      });
    },
  );

  it('turno pedido ("de tarde") não aceita horário da manhã escolhido pela IA', () => {
    expect(
      assessBookingClaim({ ...base, reply: 'Prontinho, deixei agendado quinta às 11h!', patientText: 'pode ser de tarde' }),
    ).toMatchObject({ kind: 'correct', propose: [] });
  });

  it('descrição de venda / pagamento → nada a corrigir', () => {
    expect(
      assessBookingClaim({ ...base, reply: 'A avaliação custa apenas R$ 150 e fica marcada com a Dra. Suellen.', patientText: 'quanto custa?' }),
    ).toEqual({ kind: 'no_claim' });
    expect(
      assessBookingClaim({ ...base, reply: 'Seu boleto foi agendado para o dia 15/10.', patientText: 'ok' }),
    ).toEqual({ kind: 'no_claim' });
  });

  it('corrigindo, mantém o resto da resposta (o preço que ele perguntou)', () => {
    const d = assessBookingClaim({
      ...base,
      reply: 'A avaliação custa R$ 150 e inclui raio-x. Perfeito, deixei agendado quinta às 11h! Te espero lá.',
      patientText: 'quanto custa? pode ser quinta 11h',
    });
    expect(d).toMatchObject({ kind: 'correct', keepText: 'A avaliação custa R$ 150 e inclui raio-x.' });
  });
});

describe('stripBookingClaimText', () => {
  it('tira a afirmação, o que depende dela e interjeições; mantém o conteúdo', () => {
    expect(
      stripBookingClaimText(
        'Que bom! A avaliação custa R$ 1.500,00 e já inclui o raio-x completo. Deixei agendado terça às 9h com a Dra. Suellen. Qualquer dúvida me chama.',
        TODAY,
      ),
    ).toBe('A avaliação custa R$ 1.500,00 e já inclui o raio-x completo.');
  });

  it('só a afirmação (e o "te lembro") → vazio', () => {
    expect(stripBookingClaimText('Perfeito, Ana! Deixei agendada sua avaliação para terça (13/10) às 9h. Te lembro um dia antes 😊', TODAY)).toBe('');
  });
});

describe('consulta que já existe', () => {
  const existing = [naive('2026-10-16T09:00:00')]; // sexta 16/10 9h

  it('resposta que cita a consulta existente é informativa', () => {
    expect(mentionsExistingAppointment('Sua consulta está marcada pra sexta às 9h.', existing, TODAY)).toBe(true);
    expect(mentionsExistingAppointment('Está agendado sim!', existing, TODAY)).toBe(true);
  });

  it('outro dia/hora não é a consulta existente', () => {
    expect(mentionsExistingAppointment('Deixei agendado quarta às 14h.', existing, TODAY)).toBe(false);
    expect(mentionsExistingAppointment('Deixei agendado quarta às 14h.', [], TODAY)).toBe(false);
  });

  it('isExistingAppointmentSlot compara data e hora naive', () => {
    expect(isExistingAppointmentSlot({ date: '2026-10-16', time: '09:00' }, existing)).toBe(true);
    expect(isExistingAppointmentSlot({ date: '2026-10-16', time: '10:00' }, existing)).toBe(false);
  });
});

describe('curadoria de horários', () => {
  it('PROPOSTA: mais cedo de 2 dias + 1 da TARDE (manhã e tarde aparecem)', () => {
    expect(pickSuggestedSlots(FREE)).toEqual([
      { date: '2026-10-13', time: '08:00' },
      { date: '2026-10-13', time: '13:00' },
      { date: '2026-10-14', time: '08:00' },
    ]);
  });

  it('PROPOSTA sem tarde: completa com o 2º horário do dia mais próximo', () => {
    const morningOnly: FreeSlotDay[] = [
      { date: '2026-10-13', times: ['08:00', '08:30'] },
      { date: '2026-10-14', times: ['09:00'] },
    ];
    expect(pickSuggestedSlots(morningOnly)).toEqual([
      { date: '2026-10-13', time: '08:00' },
      { date: '2026-10-13', time: '08:30' },
      { date: '2026-10-14', time: '09:00' },
    ]);
  });

  it('AGENDA COMPLETA mostra manhã E tarde (até 6 de cada, horas cheias + meias horas)', () => {
    const fullDay = [
      '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00',
      '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00',
    ];
    const txt = compactDayTimes(fullDay);
    expect(txt).toBe('manhã 08:00, 08:30, 09:00, 10:00, 10:30, 11:00 / tarde 13:00, 13:30, 14:00, 15:00, 16:00, 17:00');
    expect(compactDayTimes(['14:00', '15:00'])).toBe('tarde 14:00, 15:00');
  });

  it('alternativas: mais cedo primeiro, dias diferentes, nunca o recusado', () => {
    expect(pickAlternativeSlots(FREE, { date: '2026-10-13', time: '08:00' }, 2)).toEqual([
      { date: '2026-10-13', time: '08:30' },
      { date: '2026-10-14', time: '08:00' },
    ]);
    expect(pickAlternativeSlots([{ date: '2026-10-13', times: ['08:00', '09:00'] }], null, 2)).toEqual([
      { date: '2026-10-13', time: '08:00' },
      { date: '2026-10-13', time: '09:00' },
    ]);
    expect(pickAlternativeSlots([], null, 2)).toEqual([]);
  });

  it('recusa DESTE horário x recusa que vale pra qualquer horário', () => {
    expect(isSlotSpecificRefusal('Horário indisponível — já existe "Consulta — Ana" nesse horário.')).toBe(true);
    expect(isSlotSpecificRefusal('Data/hora já passou. Ofereça outro horário.')).toBe(true);
    expect(isSlotSpecificRefusal('Horario 17:30 fora dos turnos do dentista. Atende: 08:00-12:00')).toBe(true);
    expect(isSlotSpecificRefusal('Data 2026-10-12 é feriado. Ofereça outro dia ao paciente.')).toBe(true);
    expect(isSlotSpecificRefusal('Dentista esta bloqueado nesse periodo (férias).')).toBe(true);
    expect(isSlotSpecificRefusal('Paciente com boleto em atraso — a política da clínica não permite agendar')).toBe(false);
  });
});

describe('textos', () => {
  it('rótulo natural do horário', () => {
    expect(formatSlotLabel('2026-10-13', '09:00')).toBe('terça (13/10) às 9h');
    expect(formatSlotLabel('2026-10-17', '08:30')).toBe('sábado (17/10) às 8h30');
  });

  it('horário recusado → 2 alternativas, sem prometer retorno', () => {
    const t = buildSlotTakenText([
      { date: '2026-10-13', time: '09:00' },
      { date: '2026-10-14', time: '14:00' },
    ]);
    expect(t).toBe(
      'Esse horário não está mais livre na agenda. Tenho terça (13/10) às 9h ou quarta (14/10) às 14h, qual fica melhor pra você?',
    );
    expect(t).not.toMatch(/retorno/i);
  });

  it('nota interna da IA é reconhecida (fica fora do histórico do LLM)', () => {
    expect(isAiTeamNote({ type: 'internal_note', external_message_id: 'note_ai_123' })).toBe(true);
    expect(isAiTeamNote({ type: 'internal_note', external_message_id: 'note_123' })).toBe(false);
    expect(isAiTeamNote({ type: 'text', external_message_id: 'note_ai_123' })).toBe(false);
  });
});

describe('alternativeCandidates', () => {
  it('ordem de preferência: o mais cedo de cada dia primeiro, depois os demais; sem o recusado', () => {
    expect(alternativeCandidates(FREE, { date: '2026-10-13', time: '08:00' }).slice(0, 5)).toEqual([
      { date: '2026-10-13', time: '08:30' },
      { date: '2026-10-14', time: '08:00' },
      { date: '2026-10-15', time: '10:00' },
      { date: '2026-10-20', time: '09:00' },
      { date: '2026-10-13', time: '09:00' },
    ]);
  });
});

describe('lastOutTurnText', () => {
  const at = (min: number) => new Date(Date.UTC(2026, 9, 12, 18, min));
  it('junta os balões da nossa última fala e pula a rajada do paciente e notas internas', () => {
    const msgs = [
      { direction: 'in', text: 'quanto custa?', created_at: at(0) },
      { direction: 'out', text: 'Consigo terça às 9h pra você.', created_at: at(1) },
      { direction: 'out', text: 'Qual fica melhor?', created_at: at(2) },
      { direction: 'out', type: 'internal_note', text: 'nota', created_at: at(3) },
      { direction: 'in', text: 'ok', created_at: at(4) },
      { direction: 'in', text: '👍', created_at: at(5) },
    ];
    expect(lastOutTurnText(msgs, at(5).getTime())).toBe('Consigo terça às 9h pra você.\n\nQual fica melhor?');
    expect(lastOutTurnText(msgs.slice(0, 1), at(1).getTime())).toBeNull();
  });
});

// ═══ Revisão final da rede 13a — cenários dos revisores ══════════════════════
// Agenda da Dra. Suellen 08–12 / 13–18 (passo de 30 min, consulta de 60 min) e dias
// livres 13, 14, 15, 16 e 19/10 — a simulação dos revisores (hoje = seg 12/10).
const AM = ['08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00'];
const PM = ['13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00'];
const SUELLEN: FreeSlotDay[] = ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19'].map((date) => ({
  date,
  times: [...AM, ...PM],
}));
const net = (i: Partial<Parameters<typeof assessBookingClaim>[0]> & { reply: string }) =>
  assessBookingClaim({ freeDays: SUELLEN, todayStr: TODAY, ...i });
const TUE8 = { date: '2026-10-13', time: '08:00' };
const OFFER3 = '• Terça 13/10 às 08:00\n• Terça 13/10 às 13:00\n• Quarta 14/10 às 08:00\nQual fica melhor?';
const SINGLE_TUE8 = 'Vamos deixar terça, 13/10, às 8h?';

describe('item 1 — aceite só vale pro horário INEQUÍVOCO da nossa proposta', () => {
  it.each(['sim', 'ok', 'pode ser', '👍', 'beleza', 'confirmo'])(
    'MARCA: "%s" à proposta de UM horário com data, e a IA diz esse mesmo',
    (patientText) => {
      expect(net({ reply: 'Perfeito, deixei agendado terça, 13/10, às 8h!', patientText, lastOutText: SINGLE_TUE8 })).toEqual({
        kind: 'book',
        slot: TUE8,
      });
    },
  );

  it.each(['sim', 'beleza'])('(a) "%s" a 3 opções → NÃO marca; pergunta qual entre as 3 oferecidas', (patientText) => {
    expect(net({ reply: 'Perfeito, deixei agendado terça, 13/10, às 8h!', patientText, lastOutText: OFFER3 })).toMatchObject({
      kind: 'correct',
      ambiguous: true,
      propose: [TUE8, { date: '2026-10-13', time: '13:00' }, { date: '2026-10-14', time: '08:00' }],
    });
  });

  it('(b) "sim" a terça 8h e a IA diz quarta 9h → NÃO marca; propõe a terça 8h que ele aceitou', () => {
    expect(net({ reply: 'deixei agendado quarta, 14/10, às 9h!', patientText: 'sim', lastOutText: SINGLE_TUE8 })).toMatchObject({
      kind: 'correct',
      propose: [TUE8],
    });
  });

  it('(c) "quero sim" a "quer que eu veja um horário?" (sem horário proposto) → NÃO marca', () => {
    expect(
      net({
        reply: 'deixei agendado terça 13/10 às 8h',
        patientText: 'quero sim',
        lastOutText: 'Quer que eu veja um horário pra sua avaliação?',
      }).kind,
    ).toBe('correct');
  });

  it('(d) "pode ser às 13h" com terça 13h e quarta 13h oferecidos → NÃO marca; pergunta qual', () => {
    expect(
      net({
        reply: 'Perfeito, deixei agendado quarta (14/10) às 13h!',
        patientText: 'pode ser às 13h',
        lastOutText: 'Tenho terça (13/10) às 13h ou quarta (14/10) às 13h, qual prefere?',
      }),
    ).toMatchObject({
      kind: 'correct',
      ambiguous: true,
      propose: [
        { date: '2026-10-13', time: '13:00' },
        { date: '2026-10-14', time: '13:00' },
      ],
    });
  });

  it('(d) "terça" com terça 8h e terça 13h oferecidos → NÃO marca o que a IA escolheu', () => {
    expect(net({ reply: 'Perfeito, deixei agendado terça às 13h!', patientText: 'terça', lastOutText: OFFER3 })).toMatchObject({
      kind: 'correct',
      ambiguous: true,
      propose: [TUE8, { date: '2026-10-13', time: '13:00' }],
    });
  });

  it('(d) "terça cedinho" = manhã → escolheu terça 8h; a IA disse 13h → NÃO marca, propõe 8h', () => {
    expect(net({ reply: 'Perfeito, deixei agendado terça às 13h!', patientText: 'terça cedinho', lastOutText: OFFER3 })).toMatchObject({
      kind: 'correct',
      propose: [TUE8],
    });
    const choose = (patientText: string) =>
      resolvePatientChoice({ patientText, lastOutText: OFFER3, freeDays: SUELLEN, todayStr: TODAY }).slot;
    expect(choose('terça cedinho')).toEqual(TUE8);
    expect(choose('terça bem cedo')).toEqual(TUE8);
  });

  it('(e) oferta de ontem "amanhã às 8h" (sem data explícita) + "pode ser" → NÃO marca', () => {
    expect(
      net({ reply: 'Perfeito, deixei agendado amanhã às 8h!', patientText: 'pode ser', lastOutText: 'Consigo amanhã às 8h, pode ser?' }).kind,
    ).toBe('correct');
  });

  it('revisor 2 (a): "sim" a quarta 9h e a IA diz terça 8h → NÃO marca; propõe quarta 9h', () => {
    expect(
      net({ reply: 'Perfeito, deixei agendado terça (13/10) às 8h!', patientText: 'sim', lastOutText: 'Tenho quarta (14/10) às 9h, pode ser?' }),
    ).toMatchObject({ kind: 'correct', propose: [{ date: '2026-10-14', time: '09:00' }] });
  });

  it('revisor 2 (b)/(c): "ok"/"sim" a "posso olhar a agenda?" / "te mando o endereço?" → NÃO marca', () => {
    expect(
      net({
        reply: 'Show! Agendei sua avaliação pra quarta (14/10) às 9h.',
        patientText: 'ok',
        lastOutText: 'Tudo isso fica apenas R$ 350.\n\nPosso dar uma olhada na agenda e ver se consigo pra essa semana?',
      }).kind,
    ).toBe('correct');
    expect(
      net({
        reply: 'Deixei agendado terça às 8h. O endereço é Rua X, 123.',
        patientText: 'sim',
        lastOutText: 'Quer que eu te mande o endereço?',
      }).kind,
    ).toBe('correct');
  });

  it('sem proposta: o horário COMPLETO que o paciente citou ("quinta às 8 tá ótimo") → me confirma quinta 8h (modo conservador)', () => {
    const qui8 = { date: '2026-10-15', time: '08:00' };
    expect(net({ reply: 'Perfeito, deixei agendado quinta às 8h!', patientText: 'quinta às 8 tá ótimo' })).toMatchObject(
      asksToConfirm(qui8),
    );
    // "Perfeito, deixei agendado!" sem horário na resposta: propõe o que ele citou
    expect(net({ reply: 'Perfeito, deixei agendado!', patientText: 'quinta às 8 tá ótimo' })).toMatchObject(asksToConfirm(qui8));
  });

  it('citando um dos oferecidos sem ambiguidade ("a de quarta") → me confirma o oferecido (modo conservador)', () => {
    expect(
      net({ reply: 'Perfeito, deixei agendado quarta (14/10) às 8h!', patientText: 'pode ser a de quarta', lastOutText: OFFER3 }),
    ).toMatchObject(asksToConfirm({ date: '2026-10-14', time: '08:00' }));
  });
});

describe('item 2 — asksConfirmation só na frase da afirmação (tags curtas e outras frases não contam)', () => {
  it.each([
    'Prontinho! Deixei agendado terça, 13/10, às 8h com a Dra. Suellen. Te mando um lembrete um dia antes, tá?',
    'Deixei agendado terça, 13/10, às 8h! Posso te ajudar em mais alguma coisa?',
    'Deixei agendado terça, 13/10, às 8h! Quer que eu te mande a localização?',
    'Deixei agendado terça às 8h, ok?',
    'Deixei agendado terça às 8h, certo?',
    'Deixei agendado terça às 8h, tudo bem?',
    'Deixei agendado terça às 8h, combinado?',
    'Deixei agendado terça às 8h, pode ser?',
  ])('"sim" ao horário único oferecido → MARCA: %p', (reply) => {
    expect(net({ reply, patientText: 'sim', lastOutText: SINGLE_TUE8 })).toEqual({ kind: 'book', slot: TUE8 });
  });

  it('nosso próprio "me confirma: pode ser X?" + "sim" → MARCA, mesmo com intenção ("vou deixar agendado")', () => {
    const lastOutText = buildConfirmChoiceText([TUE8], false);
    expect(net({ reply: 'Vou deixar agendado terça às 8h e te lembro um dia antes.', patientText: 'sim', lastOutText })).toEqual({
      kind: 'book',
      slot: TUE8,
    });
    expect(net({ reply: 'Perfeito, vou deixar agendado terça às 8h 😊', patientText: 'pode ser', lastOutText })).toEqual({
      kind: 'book',
      slot: TUE8,
    });
  });

  it('intenção depois de escolher entre VÁRIOS oferecidos → não marca (só com o horário único)', () => {
    expect(net({ reply: 'Vou deixar agendado terça às 8h.', patientText: 'terça às 8h', lastOutText: OFFER3 })).toMatchObject({
      kind: 'correct',
      propose: [TUE8],
    });
  });

  it('pergunta DE VERDADE na frase da afirmação, ou pedido de confirmação → não marca', () => {
    expect(analyzeBookingClaims('Deixei agendado terça às 8h, prefere outro horário?').asksConfirmation).toBe(true);
    expect(net({ reply: 'Deixei agendado terça às 8h, prefere outro horário?', patientText: 'sim', lastOutText: SINGLE_TUE8 }).kind).toBe(
      'correct',
    );
    expect(net({ reply: 'Deixei reservado terça às 8h, é só me confirmar!', patientText: 'sim', lastOutText: SINGLE_TUE8 }).kind).toBe(
      'correct',
    );
  });

  it('tags curtas e pergunta em outra frase não contam', () => {
    for (const r of ['Deixei agendado terça às 8h, tá?', 'Deixei agendado terça às 8h, ok?', 'Deixei agendado terça às 8h. Quer o endereço?']) {
      expect(analyzeBookingClaims(r).asksConfirmation).toBe(false);
    }
  });

  it('paciente: "sim" + pergunta (mesmo de logística) não é "sim" puro → me confirma; pergunta de preço também', () => {
    expect(
      net({ reply: 'Deixei agendado terça às 8h! O endereço é Rua X.', patientText: 'sim! qual o endereço?', lastOutText: SINGLE_TUE8 }),
    ).toMatchObject({ ...asksToConfirm(TUE8), keepText: 'O endereço é Rua X.' });
    expect(net({ reply: 'Deixei agendado terça às 8h!', patientText: 'sim, qual o endereço?', lastOutText: SINGLE_TUE8 })).toMatchObject(
      asksToConfirm(TUE8),
    );
    expect(
      net({
        reply: 'Deixei agendado terça às 8h! A avaliação custa R$ 150.',
        patientText: 'pode ser terça 8h. quanto custa?',
        lastOutText: SINGLE_TUE8,
      }).kind,
    ).toBe('correct');
  });
});

describe('item 3 — recusa só quando o "não" governa o horário', () => {
  const ONE = 'Consigo quinta (15/10) às 15h, pode ser?';
  const QUI15 = { date: '2026-10-15', time: '15:00' };

  it('"quinta às 15h tá ótimo, não tenho compromisso" → não é recusa: me confirma quinta 15h (modo conservador)', () => {
    expect(
      net({
        reply: 'Perfeito, deixei agendado quinta, 15/10, às 15h!',
        patientText: 'quinta às 15h tá ótimo, não tenho compromisso',
        lastOutText: 'Tenho quinta (15/10) às 15h ou sexta (16/10) às 8h, qual prefere?',
      }),
    ).toMatchObject(asksToConfirm(QUI15));
  });

  it('"pode ser sim, não vejo a hora" → não é recusa: me confirma (fora da lista fechada do "sim" puro)', () => {
    expect(
      net({ reply: 'Perfeito, deixei agendado quinta, 15/10, às 15h!', patientText: 'pode ser sim, não vejo a hora', lastOutText: ONE }),
    ).toMatchObject(asksToConfirm(QUI15));
  });

  it.each([
    'não posso',
    'não consigo',
    'não dá',
    'não vou poder',
    'não quero esse horário',
    'prefiro outro',
    'tem outro dia?',
    'posso não',
    'dá não',
    'não, obrigada',
    'quinta não',
  ])('recusa: %p → não escolhe', (patientText) => {
    expect(resolvePatientChoice({ patientText, lastOutText: ONE, freeDays: SUELLEN, todayStr: TODAY }).slot).toBeNull();
  });

  it.each(['sim, não tenho compromisso', 'pode ser sim, não vejo a hora', 'pode ser, não precisa me lembrar'])(
    'NÃO é recusa: %p → escolhe o oferecido',
    (patientText) => {
      expect(resolvePatientChoice({ patientText, lastOutText: ONE, freeDays: SUELLEN, todayStr: TODAY }).slot).toEqual(QUI15);
    },
  );

  it('negação que não é recusa mas deixa dúvida ("não sei se consigo") → não marca, mas propõe o horário dele', () => {
    expect(
      net({
        reply: 'Perfeito, deixei agendado quinta às 15h!',
        patientText: 'pode ser quinta 15h, não sei se consigo chegar',
        lastOutText: ONE,
      }),
    ).toMatchObject({ kind: 'correct', propose: [QUI15] });
  });

  it('paciente cita o horário que bate com o da resposta → propõe ESSE (não o 1º de cada dia)', () => {
    expect(net({ reply: 'Vou deixar agendado quinta às 15h.', patientText: 'quinta às 15h tá ótimo, não tenho compromisso' })).toMatchObject({
      kind: 'correct',
      propose: [QUI15],
    });
  });

  it('recusa + outro pedido ("terça às 9h não consigo, pode ser quarta às 10h") → propõe a quarta 10h', () => {
    expect(
      net({ reply: 'Perfeito, deixei agendado quarta às 10h!', patientText: 'terça às 9h não consigo, pode ser quarta às 10h' }),
    ).toMatchObject({ kind: 'correct', propose: [{ date: '2026-10-14', time: '10:00' }] });
  });

  it('"quero dia 20 às 9h" (fora dos dias livres) → não marca; diz que não deu e oferece 2', () => {
    const d = net({ reply: 'Perfeito, deixei agendado dia 20 às 9h!', patientText: 'quero dia 20 às 9h' });
    expect(d).toMatchObject({ kind: 'correct', propose: [], requested: { date: '2026-10-20', time: '09:00' } });
    const alts = pickAlternativeSlots(SUELLEN, null, 2);
    const txt = buildRequestedUnavailableText({ date: '2026-10-20', time: '09:00' }, alts);
    expect(txt).toBe(
      'Não consegui terça (20/10) às 9h na agenda. Tenho terça (13/10) às 8h ou quarta (14/10) às 8h, qual fica melhor pra você?',
    );
    expect(claimsBooked(txt)).toBe(false);
    // na próxima volta, o horário que não deu não conta como oferecido
    expect(extractOfferedSlots(txt, TODAY)).toEqual([TUE8, { date: '2026-10-14', time: '08:00' }]);
  });
});

describe('item 4 — consulta de HOJE (já começou) e recém-atendida contam como existente', () => {
  const tuesday = '2026-10-13';
  const today9 = [naive('2026-10-13T09:00:00')];

  it('filtro: ativas desde o início do dia (naive) + atendidas nas últimas 12h', () => {
    expect(existingAppointmentFilter(maceio('2026-10-13T09:10:00'))).toEqual([
      {
        status: { in: ['AGENDADO', 'CONFIRMADO', 'COMPARECEU', 'EM_ATENDIMENTO'] },
        start_at: { gte: naive('2026-10-13T00:00:00') },
      },
      { status: { in: ['COMPARECEU', 'EM_ATENDIMENTO', 'CONCLUIDO'] }, start_at: { gte: naive('2026-10-12T21:10:00') } },
    ]);
  });

  it('09:10, consulta hoje 9h: "vou me atrasar" → "sua avaliação está marcada pra hoje às 9h" não é mexida', () => {
    expect(
      net({
        todayStr: tuesday,
        reply: 'Sem problemas, Maria! Sua avaliação está marcada para hoje às 9h, pode vir tranquila',
        patientText: 'bom dia, vou me atrasar uns 10 minutinhos',
        existingStarts: today9,
      }),
    ).toEqual({ kind: 'existing' });
  });

  it('"cheguei" → "sua consulta está confirmada, é só avisar na recepção" não é mexida', () => {
    expect(
      net({
        todayStr: tuesday,
        reply: 'Sua consulta está confirmada, é só avisar na recepção',
        patientText: 'cheguei',
        existingStarts: today9,
      }),
    ).toEqual({ kind: 'existing' });
  });

  it('pós-consulta (concluída hoje): "seu retorno ficou marcado com a recepção" não é mexida', () => {
    expect(
      net({ todayStr: tuesday, reply: 'Seu retorno ficou marcado com a recepção 😊', patientText: 'obrigada!', existingStarts: today9 }),
    ).toEqual({ kind: 'existing' });
  });
});

describe('item 5 — "esse horário já está reservado/de outra pessoa" não é afirmação de marcação', () => {
  it.each([
    'Esse horário já está reservado, mas tenho terça às 10h, pode ser?',
    'O horário de 9h já está reservado, mas tenho terça às 10h, pode ser?',
    'Às 9h já está marcado, mas tenho às 10h.',
    'Esse horário já está agendado com outra pessoa. Tenho terça às 10h ou quarta às 9h, qual prefere?',
    'Infelizmente esse horário já foi agendado por outro paciente.',
    'Reservei dois horários pra você: terça (13/10) às 8h ou quarta (14/10) às 9h. Qual prefere?',
    'O horário das 8h está agendado pra outra pessoa, mas tenho às 9h.',
  ])('NÃO afirma: %p', (txt) => {
    expect(claimsBooked(txt)).toBe(false);
  });

  it.each([
    'Às 9h já está marcado pra você!',
    'Seu horário ficou reservado, terça às 9h!',
    'Deixei agendado terça às 9h, mas se precisar remarcar tenho outros horários.',
  ])('continua afirmando: %p', (txt) => {
    expect(claimsBooked(txt)).toBe(true);
  });

  it('pergunta de disponibilidade + "já está reservado, mas tenho…" → nada a corrigir', () => {
    expect(net({ reply: 'O horário de 9h já está reservado, mas tenho terça às 10h, pode ser?', patientText: 'tem terça às 9h?' })).toEqual({
      kind: 'no_claim',
    });
  });
});

describe('item 6 — texto honesto não é proposta; alerta em aberto protege a consulta anterior', () => {
  const sex10 = { date: '2026-10-16', time: '10:00' };

  it('texto honesto SEM pergunta no fim', () => {
    expect(buildHonestPreferenceText(sex10)).toBe(
      'Deixei anotada sua preferência por sexta (16/10) às 10h pra recepção confirmar com você.',
    );
    expect(buildHonestPreferenceText()).toBe('Deixei anotada sua preferência de horário pra recepção confirmar com você.');
    expect(buildHonestPreferenceText(sex10)).not.toContain('?');
  });

  it('o horário do texto honesto não é "oferecido": um "ok" depois dele não marca', () => {
    const lastOutText = buildHonestPreferenceText(sex10);
    expect(extractOfferedSlots(lastOutText, TODAY)).toEqual([]);
    expect(net({ reply: 'Perfeito, deixei agendado sexta (16/10) às 10h!', patientText: 'ok', lastOutText }).kind).toBe('correct');
  });

  it('alerta da IA (note_ai_) nas últimas 12h → em aberto (15b não cancela a consulta anterior)', () => {
    const at = (h: number) => new Date(NOW - h * 3600_000);
    expect(hasRecentAiTeamNote([{ type: 'internal_note', external_message_id: 'note_ai_1', created_at: at(2) }], NOW)).toBe(true);
    expect(hasRecentAiTeamNote([{ type: 'internal_note', external_message_id: 'note_ai_1', created_at: at(13) }], NOW)).toBe(false);
    expect(hasRecentAiTeamNote([{ type: 'internal_note', external_message_id: 'note_1', created_at: at(1) }], NOW)).toBe(false);
    expect(hasRecentAiTeamNote([{ type: 'text', external_message_id: 'note_ai_1', created_at: at(1) }], NOW)).toBe(false);
    expect(hasRecentAiTeamNote(null, NOW)).toBe(false);
  });
});

// A 13a roda também na resposta a lembrete e com confirm_appointment/reschedule_appointment:
// a confirmação da consulta do lembrete (que entra em existingStarts) não pode ser corrigida.
describe('rede 13a na resposta a lembrete', () => {
  const REM = 'Olá Maria! Passando pra lembrar da sua consulta amanhã, terça (13/10) às 8h. Você confirma sua presença?';
  const ex = [new Date('2026-10-13T08:00:00.000Z')];
  const at = (patientText: string, reply: string) =>
    assessBookingClaim({ freeDays: SUELLEN, todayStr: TODAY, reply, patientText, lastOutText: REM, existingStarts: ex });
  it.each([
    'Perfeito, Maria! Sua consulta está confirmada para amanhã às 8h. Te esperamos!',
    'Perfeito, deixei agendado!',
    'Ótimo! Sua consulta de terça (13/10) às 8h está agendada e confirmada.',
    'Prontinho! Agendado pra amanhã às 8h.',
  ])('"sim" + %p → existing (não mexe)', (reply) => {
    expect(at('sim', reply).kind).toBe('existing');
  });
  it('"remarquei pra quinta 10h" sem nada marcado → correct com consulta existente (equipe resolve)', () => {
    expect(at('não vou poder amanhã, pode ser quinta às 10h?', 'Sem problemas! Remarquei pra quinta (15/10) às 10h.')).toMatchObject({
      kind: 'correct',
      hasExisting: true,
    });
  });
});

describe('stripCancellationClaims — "cancelei" mantido pela 13a quando a consulta NÃO vai ser cancelada', () => {
  it('cenário do revisor: consulta da mãe + "pode marcar minha filha" → a frase de cancelamento sai', () => {
    const d = assessBookingClaim({
      freeDays: [{ date: '2026-10-15', times: ['09:00', '10:00'] }],
      todayStr: '2026-10-12',
      reply: 'Claro! Cancelei sua consulta anterior. Deixei agendado quinta (15/10) às 10h pra sua filha.',
      patientText: 'pode marcar minha filha quinta às 10h?',
      lastOutText: 'Oi',
      existingStarts: [new Date('2026-10-13T09:00:00.000Z')],
    });
    expect(d).toMatchObject({ kind: 'correct', hasExisting: true, keepText: 'Cancelei sua consulta anterior.' });
    if (d.kind === 'correct') expect(stripCancellationClaims(d.keepText)).toEqual({ text: '', stripped: true });
  });

  it.each([
    ['Sem problemas! Cancelei sua consulta anterior. A avaliação é gratuita.', 'Sem problemas! A avaliação é gratuita.'],
    ['Sua consulta de quinta foi desmarcada.\n\nQualquer dúvida me chama!', 'Qualquer dúvida me chama!'],
    ['Já tirei da agenda a de terça. Custa R$ 150,00.', 'Custa R$ 150,00.'],
  ])('%p → %p', (text, expected) => {
    expect(stripCancellationClaims(text)).toEqual({ text: expected, stripped: true });
  });

  it('sem frase de cancelamento → intacto', () => {
    expect(stripCancellationClaims('A avaliação é gratuita.')).toEqual({ text: 'A avaliação é gratuita.', stripped: false });
    expect(stripCancellationClaims(null)).toEqual({ text: '', stripped: false });
  });
});

describe('item 7 — confirm_slot incompleto zerado pela 13a não arma o SAFEGUARD v28', () => {
  it('ação zerada pela rede conta como "veio ação" (igual a antes da 13a)', () => {
    expect(modelEmittedNoAction(null, true)).toBe(false);
    expect(modelEmittedNoAction(null, false)).toBe(true);
    expect(modelEmittedNoAction({ action: 'confirm_slot' }, false)).toBe(false);
  });

  it('cenário do revisor: "cancelei a anterior, deixei agendado sexta 10h" com confirm_slot sem hora', () => {
    const action = normalizeSchedulingAction({ reply: 'x', scheduling_action: { action: 'confirm_slot', date: '2026-10-16' } }, NOW);
    expect(action).toEqual({ action: 'confirm_slot', date: '2026-10-16' });
    expect(isValidConfirmSlot(action)).toBe(false);
    const d = net({
      reply: 'Sem problemas! Cancelei sua consulta anterior. Deixei agendado sexta às 10h.',
      patientText: 'não vou poder quinta, pode ser sexta às 10h',
      existingStarts: [naive('2026-10-15T09:00:00')],
      hint: { date: action!.date },
    });
    expect(d).toMatchObject({ kind: 'correct', hasExisting: true, keepText: 'Sem problemas! Cancelei sua consulta anterior.' });
    // o processor zera a ação (actionDroppedBy13a=true) → o v28 NÃO vê "sem ação"
    expect(modelEmittedNoAction(null, !!action?.action)).toBe(false);
  });
});

describe('item 8 — ISO com Z/offset: só a data (a hora é de outro fuso)', () => {
  it.each([
    '2026-10-13T11:00:00.000Z',
    '2026-10-13T11:00:00Z',
    '2026-10-13T08:00:00+00:00',
    '2026-10-13T08:00:00-03:00',
    '2026-10-13T08:00-0300',
  ])('%p → { date } sem time', (raw) => {
    expect(normalizeDateValue(raw, TODAY)).toEqual({ date: '2026-10-13', time: undefined });
  });

  it('confirm_slot só com ISO Z fica INCOMPLETO (não marca 11h no lugar de 8h); com time usa o time', () => {
    expect(
      normalizeSchedulingAction({ scheduling_action: { action: 'confirm_slot', date: '2026-10-13T11:00:00.000Z' } }, NOW),
    ).toEqual({ action: 'confirm_slot', date: '2026-10-13' });
    expect(
      normalizeSchedulingAction(
        { scheduling_action: { action: 'confirm_slot', date: '2026-10-13T11:00:00.000Z', time: '08:00' } },
        NOW,
      ),
    ).toEqual({ action: 'confirm_slot', date: '2026-10-13', time: '08:00' });
  });
});

describe('item 9 — "às 2" na fala de agenda = 14h', () => {
  it.each([
    ['terça às 2', '14:00'],
    ['às 3', '15:00'],
    ['às 1', '13:00'],
    ['às 6', '18:00'],
    ['às 7', '07:00'],
    ['às 10', '10:00'],
    ['às 2 da manhã', '02:00'],
  ])('%p → %p', (txt, time) => {
    expect([...extractSlotMentions(txt, TODAY).times]).toEqual([time]);
  });

  it('"as 2 opções" (artigo) não é hora', () => {
    expect(extractSlotMentions('te mandei as 2 opções', TODAY).times.size).toBe(0);
  });

  it('cenário do revisor: "terça às 2" a "terça (13/10) às 8h ou às 14h" → me confirma 14h (modo conservador)', () => {
    expect(
      net({
        reply: 'Perfeito, deixei agendado terça (13/10) às 14h!',
        patientText: 'terça às 2',
        lastOutText: 'Tenho terça (13/10) às 8h ou às 14h',
      }),
    ).toMatchObject(asksToConfirm({ date: '2026-10-13', time: '14:00' }));
  });
});

describe('item 10 — AGENDA COMPLETA: até 6 por turno, com meias horas', () => {
  it('agenda da Dra. Suellen inteira livre: 15h e 8h30 aparecem', () => {
    const txt = compactDayTimes([...AM, ...PM]);
    expect(txt).toBe('manhã 08:00, 08:30, 09:00, 10:00, 10:30, 11:00 / tarde 13:00, 13:30, 14:00, 15:00, 16:00, 17:00');
    expect(txt).toContain('15:00');
    expect(txt).toContain('08:30');
  });

  it('até 6 → todos; mais de 6 horas cheias → 6 espalhadas', () => {
    expect(compactDayTimes(['08:00', '08:30', '09:00', '09:30', '10:00', '10:30'])).toBe(
      'manhã 08:00, 08:30, 09:00, 09:30, 10:00, 10:30',
    );
    expect(compactDayTimes(['12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'])).toBe(
      'tarde 12:00, 13:00, 14:00, 16:00, 17:00, 18:00',
    );
  });

  it('texto de pedido de escolha aceita 3 opções (a proposta ambígua)', () => {
    expect(
      buildConfirmChoiceText([TUE8, { date: '2026-10-13', time: '13:00' }, { date: '2026-10-14', time: '08:00' }], true),
    ).toBe('Só pra eu deixar certinho na agenda: é terça (13/10) às 8h, terça (13/10) às 13h ou quarta (14/10) às 8h?');
  });
});

// ═══ Simulação final da rede 13a — na dúvida NÃO marca; só reescreve com certeza ═══
describe('item 11 — hora de um dia sem DD/MM nunca fica com a data de OUTRO dia', () => {
  const QUA9 = { date: '2026-10-14', time: '09:00' };
  const QUA10 = { date: '2026-10-14', time: '10:00' };
  const X1 = 'Na terça (13/10) está lotada, mas tenho quarta às 9h. Pode ser?';
  const E1 = 'Tenho terça (13/10) às 8h. Quarta também tenho às 9h.';
  const E2 = 'Terça (13/10) às 8h já foi preenchido. Quarta às 10h, pode ser?';
  const E22 = 'Na terça (13/10) a manhã está lotada. Tenho quarta às 9h';

  it('extractOfferedSlots: a hora contradita pela palavra de dia não vira a data citada', () => {
    expect(extractOfferedSlots(X1, TODAY)).toEqual([]);
    expect(extractOfferedSlots(E2, TODAY)).toEqual([]);
    expect(extractOfferedSlots(E22, TODAY)).toEqual([]);
    expect(extractOfferedSlots(E1, TODAY)).toEqual([TUE8]);
    expect(extractOfferedSlots('Hoje (12/10) não tenho mais horário. Amanhã às 8h, pode ser?', TODAY)).toEqual([]);
    expect(extractOfferedSlots('Quarta às 9h ou terça (13/10) às 8h, qual prefere?', TODAY)).toEqual([TUE8]);
    expect(extractOfferedSlots('Tenho terça (13/10) às 8h ou terça que vem às 9h', TODAY)).toEqual([TUE8]);
  });

  it('extractOfferedSlots: o que estava certo continua pareado', () => {
    expect(extractOfferedSlots('Tenho terça (13/10) às 8h ou às 14h', TODAY)).toEqual([
      TUE8,
      { date: '2026-10-13', time: '14:00' },
    ]);
    expect(extractOfferedSlots('Tenho terça (13/10) às 8h, quarta (14/10) às 9h', TODAY)).toEqual([TUE8, QUA9]);
    expect(extractOfferedSlots('Tenho terça (13/10) às 8h quarta (14/10) às 9h', TODAY)).toEqual([TUE8, QUA9]);
    expect(extractOfferedSlots('Amanhã, dia 13/10, às 8h', TODAY)).toEqual([TUE8]);
    // "amanhã" ancorado pela própria mensagem ("amanhã (13/10)") confirma a data
    expect(extractOfferedSlots('Amanhã (13/10) tenho às 8h ou, também amanhã, às 9h', TODAY)).toEqual([
      TUE8,
      { date: '2026-10-13', time: '09:00' },
    ]);
    expect(extractOfferedSlots(OFFER3, TODAY)).toEqual([
      TUE8,
      { date: '2026-10-13', time: '13:00' },
      { date: '2026-10-14', time: '08:00' },
    ]);
  });

  it('(X1) "sim" + "Perfeito, agendado! Te espero." → NÃO marca terça 9h; pede confirmação da quarta 9h', () => {
    expect(net({ reply: 'Perfeito, agendado! Te espero.', patientText: 'sim', lastOutText: X1 })).toMatchObject({
      kind: 'correct',
      ambiguous: false,
      requested: null,
      propose: [QUA9],
    });
  });

  it('(X1b) a IA cita "quarta às 9h" → pede "pode ser quarta (14/10) às 9h?", nunca terça', () => {
    const d = net({ reply: 'Perfeito, deixei agendado quarta às 9h!', patientText: 'sim', lastOutText: X1 });
    expect(d).toMatchObject({ kind: 'correct', propose: [QUA9] });
    expect(buildConfirmChoiceText([QUA9], false)).toBe('Pra eu deixar certinho na agenda, me confirma: pode ser quarta (14/10) às 9h?');
  });

  it('(E2) "Quarta às 10h" depois de "Terça (13/10) às 8h já foi preenchido" → propõe quarta 10h', () => {
    expect(net({ reply: 'Perfeito, deixei agendado!', patientText: 'sim', lastOutText: E2 })).toMatchObject({
      kind: 'correct',
      propose: [QUA10],
    });
  });

  it('(E1) "pode ser às 9" → a 9h é da quarta: propõe quarta 9h', () => {
    expect(net({ reply: 'Perfeito, agendado!', patientText: 'pode ser às 9', lastOutText: E1 })).toMatchObject({
      kind: 'correct',
      propose: [QUA9],
    });
  });

  it('(X2) "sim" puro a "terça (13/10) às 8h. Quarta às 9h." → pergunta entre as DUAS (a quarta não some)', () => {
    expect(net({ reply: 'Perfeito, agendado!', patientText: 'sim', lastOutText: E1 })).toMatchObject({
      kind: 'correct',
      ambiguous: true,
      propose: [TUE8, QUA9],
    });
  });

  it('(E22) "pode ser" a "terça (13/10) a manhã está lotada. Tenho quarta às 9h" → propõe quarta 9h', () => {
    expect(net({ reply: 'Perfeito, deixei agendado!', patientText: 'pode ser', lastOutText: E22 })).toMatchObject({
      kind: 'correct',
      propose: [QUA9],
    });
  });

  it('o horário COMPLETO que o paciente citou ("pode ser quarta às 9h") é o proposto (me confirma, modo conservador)', () => {
    expect(
      net({ reply: 'Perfeito, deixei agendado quarta às 9h!', patientText: 'pode ser quarta às 9h', lastOutText: X1 }),
    ).toMatchObject(asksToConfirm(QUA9));
  });

  it('oferta "terça (13/10) às 9h ou quarta às 9h" + "pode ser às 9" → pergunta qual', () => {
    expect(
      net({ reply: 'Perfeito, deixei agendado!', patientText: 'pode ser às 9', lastOutText: 'Tenho terça (13/10) às 9h ou quarta às 9h' }),
    ).toMatchObject({ kind: 'correct', ambiguous: true, propose: [{ date: '2026-10-13', time: '09:00' }, QUA9] });
  });

  it('(X3) "Hoje (12/10) não tenho. Amanhã às 8h" + "sim" → não diz "não consegui segunda"; pede terça (13/10) 8h', () => {
    const d = net({
      reply: 'Perfeito, deixei agendado amanhã às 8h!',
      patientText: 'sim',
      lastOutText: 'Hoje (12/10) não tenho mais horário. Amanhã às 8h, pode ser?',
    });
    expect(d).toMatchObject({ kind: 'correct', requested: null, propose: [TUE8] });
    expect(buildConfirmChoiceText([TUE8], false)).toBe('Pra eu deixar certinho na agenda, me confirma: pode ser terça (13/10) às 8h?');
  });

  it('proposta de ONTEM: o "hoje/amanhã" dela vale pelo dia que ela mesma diz ("Hoje (12/10)…")', () => {
    const tue = '2026-10-13';
    // amanhã da mensagem = 13/10 (não 14/10, o amanhã de hoje)
    expect(
      net({
        todayStr: tue,
        reply: 'Perfeito, deixei agendado!',
        patientText: 'sim',
        lastOutText: 'Hoje (12/10) não tenho mais horário. Amanhã às 8h, pode ser?',
      }),
    ).toMatchObject({ kind: 'correct', propose: [TUE8] });
    // "às 8h de amanhã (terça, 13/10)" escrito ontem continua pareado com 13/10
    expect(extractOfferedSlots('Consigo às 8h de amanhã (terça, 13/10), pode ser?', tue)).toEqual([TUE8]);
  });

  it('"amanhã" SOLTO sem a mensagem dizer o dia dela não confirma a data (pode ser de ontem): pede confirmação', () => {
    const offer = 'Tenho terça (13/10) às 8h ou amanhã às 9h';
    expect(extractOfferedSlots(offer, TODAY)).toEqual([TUE8]);
    expect(net({ reply: 'Perfeito, deixei agendado!', patientText: 'às 9', lastOutText: offer })).toMatchObject({
      kind: 'correct',
      propose: [{ date: '2026-10-13', time: '09:00' }],
    });
    // a terça 8h (com data) continua escolhível — e, no modo conservador, vai pra confirmação
    expect(net({ reply: 'Perfeito, deixei agendado!', patientText: 'às 8', lastOutText: offer })).toMatchObject(asksToConfirm(TUE8));
  });

  it('a IA diz "terça às 8h" e há DUAS terças livres às 8h: é a que ele escolheu na proposta com data (sem laço de "me confirma")', () => {
    const twoTuesdays: FreeSlotDay[] = [...SUELLEN, { date: '2026-10-20', times: [...AM, ...PM] }];
    expect(
      net({ freeDays: twoTuesdays, reply: 'Perfeito, deixei agendado terça às 8h!', patientText: 'sim', lastOutText: SINGLE_TUE8 }),
    ).toEqual({ kind: 'book', slot: TUE8 });
    // depois do nosso próprio "me confirma: pode ser terça (13/10) às 8h?" também
    expect(
      net({
        freeDays: twoTuesdays,
        reply: 'Prontinho, agendado para terça às 8h!',
        patientText: 'pode ser',
        lastOutText: buildConfirmChoiceText([TUE8], false),
      }),
    ).toEqual({ kind: 'book', slot: TUE8 });
    // sem escolha inequívoca, continua sem chutar
    expect(net({ freeDays: twoTuesdays, reply: 'Perfeito, deixei agendado terça às 8h!', patientText: 'oi' }).kind).toBe('correct');
  });
});

describe('item 12 — afirmação + pergunta de logística/cortesia na MESMA frase continua sendo afirmação', () => {
  it.each([
    ['Prontinho, deixei agendado terça às 8h, quer que eu te mande a localização?', 'sim'],
    ['Deixei agendado terça às 8h, posso te ajudar em algo mais?', 'ok'],
    ['Deixei agendado terça às 8h, posso te mandar a localização?', 'sim'],
    ['Sua avaliação ficou marcada para terça às 8h, precisa de mais alguma coisa?', 'ok'],
    ['Perfeito, marquei sua avaliação pra terça às 8h, você já sabe onde fica a clínica?', 'sim'],
    ['Agendado para terça às 8h, combinado?', 'sim'],
    ['Agendado para terça às 8h, tá?', 'ok'],
    ['Deixei agendado terça às 8h, quer que eu te lembre amanhã?', 'sim'],
    ['Deixei agendado terça às 8h e te mando a localização?', 'sim'],
  ])('MARCA terça 8h (aceite da proposta única): %p', (reply, patientText) => {
    expect(analyzeBookingClaims(reply)).toMatchObject({ firm: true, asksConfirmation: false });
    expect(net({ reply, patientText, lastOutText: SINGLE_TUE8 })).toEqual({ kind: 'book', slot: TUE8 });
  });

  it.each([
    'Deixei agendado terça às 8h, prefere outro horário?',
    'Deixei agendado terça às 8h, ou fica melhor às 9h?',
    'Agendado para terça às 8h, consegue?',
    'Deixei agendado terça às 8h, quer mudar pra quarta?',
  ])('pergunta sobre o HORÁRIO na frase → afirmação com dúvida (não marca): %p', (reply) => {
    expect(analyzeBookingClaims(reply)).toMatchObject({ firm: true, asksConfirmation: true });
    expect(net({ reply, patientText: 'sim', lastOutText: SINGLE_TUE8 }).kind).toBe('correct');
  });

  it('a frase inteira como pergunta / oferta continua NÃO sendo afirmação', () => {
    for (const r of ['Deixei agendado terça às 8h?', 'Agendado para terça às 8h?', 'Posso deixar agendado terça às 8h, quer?']) {
      expect(claimsBooked(r)).toBe(false);
    }
  });

  it.each([
    'Deixei agendado terça às 8h, se quiser te mando a localização.',
    'Deixei agendado terça às 8h, caso precise remarcar é só me avisar.',
  ])('condição em OUTRA oração não desfaz o fato → MARCA: %p', (reply) => {
    expect(net({ reply, patientText: 'sim', lastOutText: SINGLE_TUE8 })).toEqual({ kind: 'book', slot: TUE8 });
  });

  it('condição na oração da afirmação (ou na intenção) continua não sendo afirmação', () => {
    for (const r of ['Deixei agendado se você quiser.', 'Deixo agendado terça às 8h, se você preferir.', 'Deixei reservado até você confirmar.']) {
      expect(claimsBooked(r)).toBe(false);
    }
  });
});

describe('item 13 — só o turno ("prefiro de tarde") é preferência: nunca fecha horário', () => {
  const TER13 = { date: '2026-10-13', time: '13:00' };
  const QUA14 = { date: '2026-10-14', time: '14:00' };

  it.each([
    ['prefiro de tarde', 'Claro! Deixei agendado terça às 13h.'], // T6
    ['de tarde', 'Claro! Deixei agendado terça às 13h.'], // E3
    ['prefiro de tarde', 'Perfeito, deixei agendado!'], // E3e — a IA nem disse o horário
  ])('"%s" + %p → NÃO marca; "me confirma: pode ser terça (13/10) às 13h?"', (patientText, reply) => {
    expect(net({ reply, patientText, lastOutText: OFFER3 })).toMatchObject({ kind: 'correct', ambiguous: false, propose: [TER13] });
  });

  it('(E3c) terça 8h / quarta 14h + "prefiro de tarde" + IA quarta 14h → NÃO marca; pede confirmação', () => {
    expect(
      net({
        reply: 'Perfeito, deixei agendado quarta às 14h!',
        patientText: 'prefiro de tarde',
        lastOutText: 'Tenho terça (13/10) às 8h ou quarta (14/10) às 14h, qual fica melhor?',
      }),
    ).toMatchObject({ kind: 'correct', propose: [QUA14] });
  });

  it('(E3b) "a da tarde" aponta UMA opção da proposta → me confirma ela (modo conservador)', () => {
    expect(
      net({ reply: 'Perfeito, deixei agendado terça às 13h!', patientText: 'pode ser a da tarde', lastOutText: OFFER3 }),
    ).toMatchObject(asksToConfirm(TER13));
    expect(net({ reply: 'Perfeito, deixei agendado!', patientText: 'a da tarde', lastOutText: OFFER3 })).toMatchObject(
      asksToConfirm(TER13),
    );
  });

  it('dia + turno ("terça de tarde") reduz a UMA opção → me confirma ela (modo conservador)', () => {
    expect(
      net({ reply: 'Perfeito, deixei agendado terça às 13h!', patientText: 'terça de tarde', lastOutText: OFFER3 }),
    ).toMatchObject(asksToConfirm(TER13));
  });
});

// ═══ Simulação 2 da rede 13a (result.sim2.wrong) — cenários exatos ════════════════
// Mesma agenda dos revisores (SUELLEN, hoje = seg 12/10). OFF3_SIM = a lista da simulação.
const OFF3_SIM =
  'Tenho estes horários pra sua avaliação:\n• Terça 13/10 às 08:00\n• Terça 13/10 às 13:00\n• Quarta 14/10 às 08:00\nQual fica melhor?';
const TWO_OPT = 'Tenho terça (13/10) às 8h ou quarta (14/10) às 14h, qual prefere?';
const QUA8 = { date: '2026-10-14', time: '08:00' };
const QUA13 = { date: '2026-10-14', time: '13:00' };
const QUA14 = { date: '2026-10-14', time: '14:00' };
const TER13 = { date: '2026-10-13', time: '13:00' };
const QUI8 = { date: '2026-10-15', time: '08:00' };
const SEX8 = { date: '2026-10-16', time: '08:00' };

describe('sim2 item 1 — recusa: OFERECE outros horários, nunca os recusados nem o turno recusado', () => {
  const fixOf = (d: ReturnType<typeof net>) => {
    if (d.kind !== 'correct') throw new Error(`esperava correct, veio ${d.kind}`);
    return buildBookingFixText(d, d.propose, true);
  };

  it('(U7) "não posso" à terça 8h, IA "deixei agendado quarta 8h" → oferta: quarta 8h (a da IA) primeiro, sem a terça', () => {
    const d = net({
      reply: 'Sem problemas! Deixei agendado quarta (14/10) às 8h.',
      patientText: 'não posso',
      lastOutText: 'Tenho terça (13/10) às 8h, pode ser?',
    });
    expect(d).toMatchObject({ kind: 'correct', offer: true, ambiguous: false, requested: null, keepText: '', propose: [QUA8, QUI8] });
    const txt = fixOf(d);
    expect(txt).toBe('Sem problemas! Tenho quarta (14/10) às 8h ou quinta (15/10) às 8h, qual fica melhor?');
    expect(txt).not.toMatch(/me confirma|terça \(13\/10\) às 8h/);
    expect(claimsBooked(txt, TODAY)).toBe(false);
    // na próxima volta, é proposta nossa com data (um "sim" pergunta qual; "quinta" escolhe)
    expect(extractOfferedSlots(txt, TODAY)).toEqual([QUA8, QUI8]);
  });

  it('(U7b) "não posso" às 3 opções, IA diz quarta 8h (recusada) → oferta noutros dias, nenhum dos 3', () => {
    const d = net({ reply: 'Sem problemas! Deixei agendado quarta (14/10) às 8h.', patientText: 'não posso', lastOutText: OFF3_SIM });
    expect(d).toMatchObject({ kind: 'correct', offer: true, propose: [QUI8, SEX8] });
    expect(fixOf(d)).toBe('Sem problemas! Tenho quinta (15/10) às 8h ou sexta (16/10) às 8h, qual fica melhor?');
  });

  it('(P23) "não posso de manhã" às 3 opções, IA diz terça 13h → oferta terça 13h (a da IA) + outra TARDE', () => {
    const d = net({ reply: 'Sem problemas! Deixei agendado terça (13/10) às 13h.', patientText: 'não posso de manhã', lastOutText: OFF3_SIM });
    expect(d).toMatchObject({ kind: 'correct', offer: true, propose: [TER13, QUA13] });
    expect(fixOf(d)).toBe('Sem problemas! Tenho terça (13/10) às 13h ou quarta (14/10) às 13h, qual fica melhor?');
  });

  it('fallback do processor (verificação derrubou as propostas): withoutRefused tira o recusado e o turno', () => {
    const p23 = net({ reply: 'Sem problemas! Deixei agendado terça (13/10) às 13h.', patientText: 'não posso de manhã', lastOutText: OFF3_SIM });
    const u7b = net({ reply: 'Sem problemas! Deixei agendado quarta (14/10) às 8h.', patientText: 'não posso', lastOutText: OFF3_SIM });
    if (p23.kind !== 'correct' || u7b.kind !== 'correct') throw new Error('esperava correct');
    const pm = withoutRefused(SUELLEN, p23.refused);
    expect(pm.every((d) => d.times.every((t) => t >= '12:00'))).toBe(true);
    expect(pickAlternativeSlots(pm, null, 2)).toEqual([TER13, QUA13]);
    // recusa genérica: de preferência noutro dia (a terça e a quarta da proposta ficam de fora)
    expect(pickAlternativeSlots(withoutRefused(SUELLEN, u7b.refused), null, 2)).toEqual([QUI8, SEX8]);
    expect(withoutRefused(SUELLEN, null)).toBe(SUELLEN);
  });

  it('"terça às 9h não consigo" → a 10h da IA (não recusada) primeiro; a 9h nunca volta', () => {
    const d = net({
      reply: 'Sem problemas! Deixei agendado terça (13/10) às 10h.',
      patientText: 'terça às 9h não consigo',
      lastOutText: 'Tenho terça (13/10) às 9h, pode ser?',
    });
    expect(d).toMatchObject({ kind: 'correct', offer: true, propose: [{ date: '2026-10-13', time: '10:00' }, QUA8] });
  });

  it('textos: oferta de 1 horário, sem repetir o "Sem problemas!" do texto mantido; sem recusa continua pedindo confirmação', () => {
    expect(buildRefusalOfferText([QUA8])).toBe('Sem problemas! Tenho quarta (14/10) às 8h, pode ser?');
    expect(buildRefusalOfferText([QUA8], false)).toBe('Tenho quarta (14/10) às 8h, pode ser?');
    const d = net({
      reply: 'Sem problemas! A avaliação é gratuita. Deixei agendado quarta (14/10) às 8h.',
      patientText: 'não posso',
      lastOutText: 'Tenho terça (13/10) às 8h, pode ser?',
    });
    if (d.kind !== 'correct') throw new Error('esperava correct');
    expect(d.keepText).toBe('Sem problemas! A avaliação é gratuita.');
    expect(buildBookingFixText(d, d.propose, true)).toBe('Tenho quarta (14/10) às 8h ou quinta (15/10) às 8h, qual fica melhor?');
    // sem recusa: o mesmo de antes
    const amb = { requested: null, ambiguous: true, offer: false };
    expect(buildBookingFixText(amb, [TUE8, QUA8], true)).toBe(buildConfirmChoiceText([TUE8, QUA8], true));
    const req = { requested: { date: '2026-10-20', time: '09:00' }, ambiguous: false, offer: false };
    expect(buildBookingFixText(req, [TUE8, QUA8], false)).toBe(buildRequestedUnavailableText(req.requested, [TUE8, QUA8]));
  });
});

describe('sim2 item 2 — status, data passada, terceiro, prazo distante e outra pessoa NÃO são marcação feita agora', () => {
  it.each([
    [
      'Q1',
      'Oi Maria, sentimos sua falta ontem!',
      'faltei ontem, e agora?',
      'Sem problemas! Sua consulta de ontem foi marcada como falta, mas podemos remarcar. Prefere terça (13/10) às 8h ou quarta (14/10) às 8h?',
    ],
    ['Q2', null, 'quando foi minha última consulta?', 'Sua última consulta foi marcada para 10/09, com a Dra. Suellen.'],
    ['Q3', null, 'e o retorno?', 'O retorno ficou agendado para daqui a 6 meses, a recepção vai te chamar.'],
    ['Q4', null, 'e o raio-x?', 'Seu exame foi agendado pelo laboratório parceiro, eles vão te ligar.'],
  ])('(%s) → no_claim (a resposta sai intacta)', (_id, lastOutText, patientText, reply) => {
    expect(analyzeBookingClaims(reply, TODAY).claims).toEqual([]);
    expect(net({ reply, patientText, lastOutText })).toEqual({ kind: 'no_claim' });
  });

  it.each([
    'Sua avaliação foi marcada como concluída.',
    'Sua consulta está marcada como compareceu.',
    'Sua consulta foi marcada para quinta, 10/09.',
    'Sua avaliação foi agendada pela recepção para terça (13/10) às 8h.',
    'Ficou agendado pela Dra. Suellen.',
    'A recepção vai agendar pra você.',
    'Sua limpeza ficou agendada para o próximo retorno.',
  ])('NÃO afirma: %p', (txt) => {
    expect(claimsBooked(txt, TODAY)).toBe(false);
  });

  it.each([
    'Deixei agendado terça às 9h, como você pediu.',
    'Sua consulta de ontem foi remarcada pra terça às 9h.',
    'Deixei agendado com a Dra. Suellen terça às 9h.',
    'Deixei agendado terça às 9h, e o retorno fica para daqui a 6 meses.',
    'Deixei agendado terça às 9h; sua última consulta foi 10/09.',
    'Deixei agendado dia 14/10 às 9h.',
  ])('continua afirmando: %p', (txt) => {
    expect(claimsBooked(txt, TODAY)).toBe(true);
  });

  it('"agendado pra sua filha": sem horário livre recuperável não reescreve; com horário, pede confirmação e nunca marca', () => {
    expect(net({ reply: 'Prontinho! Agendado pra sua filha.', patientText: 'pode marcar pra minha filha?' })).toEqual({ kind: 'no_claim' });
    expect(
      net({
        reply: 'Prontinho! Agendado pra sua filha terça (13/10) às 8h.',
        patientText: 'sim',
        lastOutText: 'Tenho terça (13/10) às 8h pra sua filha, pode ser?',
      }),
    ).toMatchObject({ kind: 'correct', propose: [TUE8] });
  });
});

describe('sim2 item 3 — keepText mantém a resposta à pergunta dele, mesmo curta', () => {
  it('(R0.7) "quanto custa a avaliação?" → mantém "A avaliação é gratuita."', () => {
    expect(
      net({
        reply: 'A avaliação é gratuita. Deixei agendado terça, 13/10, às 8h para você.',
        patientText: 'quanto custa a avaliação?',
        lastOutText: 'Posso ver um horário pra você?',
      }),
    ).toMatchObject({ kind: 'correct', keepText: 'A avaliação é gratuita.' });
  });

  it('(R0.1-custa) "pode ser terça 8h. quanto custa?" → continua sem marcar (preço condiciona), mas mantém o preço', () => {
    expect(
      net({
        reply: 'Perfeito, deixei agendado terça, 13/10, às 8h! A avaliação é gratuita.',
        patientText: 'pode ser terça 8h. quanto custa?',
        lastOutText: SINGLE_TUE8,
      }),
    ).toMatchObject({ kind: 'correct', propose: [TUE8], keepText: 'A avaliação é gratuita.' });
  });

  it('(Q11) "que horas vocês abrem?" → mantém "Abrimos às 8h e fechamos às 18h."', () => {
    expect(
      net({ reply: 'Abrimos às 8h e fechamos às 18h. Deixei agendado terça (13/10) às 8h pra você!', patientText: 'que horas vocês abrem?' }),
    ).toMatchObject({ kind: 'correct', propose: [TUE8], keepText: 'Abrimos às 8h e fechamos às 18h.' });
  });

  it('(R1.0c) "quer o endereço?" "sim" → mantém o endereço', () => {
    expect(
      net({
        reply: 'Deixei agendado terça às 8h. O endereço é Rua das Flores, 123, Centro.',
        patientText: 'sim',
        lastOutText: 'Quer que eu te mande o endereço?',
      }),
    ).toMatchObject({ kind: 'correct', keepText: 'O endereço é Rua das Flores, 123, Centro.' });
  });

  it.each([
    ['Sim, aceitamos cartão. Deixei agendado terça às 9h.', 'Sim, aceitamos cartão.'],
    ['Certo, aceitamos cartão. Deixei agendado terça às 9h.', 'Certo, aceitamos cartão.'],
    ['Bom dia! O valor é R$ 150. Deixei agendado terça às 9h.', 'Bom dia! O valor é R$ 150.'],
    ['Atendemos de segunda a sexta, das 8h às 18h. Deixei agendado terça às 9h.', 'Atendemos de segunda a sexta, das 8h às 18h.'],
    ['Perfeito, Ana! A avaliação é gratuita. Deixei agendado terça às 9h.', 'A avaliação é gratuita.'],
    ['Ótima escolha! A avaliação é gratuita. Deixei agendado terça às 9h.', 'A avaliação é gratuita.'],
    // sem conteúdo: interjeição, acolhimento, vocativo, dia/hora repetidos e "te mando a localização" caem
    ['Combinado então! Deixei agendado terça às 9h.', ''],
    ['Sem problemas, Maria! Deixei agendado terça às 9h.', ''],
    ['Prontinho, Maria Clara! Deixei agendado terça às 9h.', ''],
    ['Deixei agendado terça às 9h. Terça (13/10) às 9h com a Dra. Suellen.', ''],
    ['Deixei agendado terça às 9h. Te mando a localização.', ''],
  ])('%p → %p', (reply, kept) => {
    expect(stripBookingClaimText(reply, TODAY)).toBe(kept);
  });
});

describe('sim2 item 4 — remarcação falsa', () => {
  const existing20 = [naive('2026-10-20T09:00:00')];
  const R2 = { lastOutText: 'Oi! Sua consulta é dia 20/10 às 9h.', patientText: 'Não vou poder dia 20, pode ser terça 13/10 às 9h?' };
  const TER9 = { date: '2026-10-13', time: '09:00' };

  it.each(['Perfeito, deixei agendado! Te espero.', 'Prontinho, remarquei!'])(
    '(R2.1 / R2.1b) consulta 20/10 + pediu terça 9h + %p → correct honesto (hasExisting), não "existing"',
    (reply) => {
      const d = net({ ...R2, reply, existingStarts: existing20 });
      expect(d).toMatchObject({ kind: 'correct', hasExisting: true, propose: [TER9], keepText: '' });
      // processor: hasExisting → sem autobook → texto honesto + alerta pra equipe
      expect(buildHonestPreferenceText(TER9)).toBe(
        'Deixei anotada sua preferência por terça (13/10) às 9h pra recepção confirmar com você.',
      );
    },
  );

  it('(Q5) "Seu horário foi remarcado para quinta (15/10) às 9h" sem consulta → pede confirmação (não sai intacto)', () => {
    const reply = 'Claro! Seu horário foi remarcado para quinta (15/10) às 9h.';
    expect(analyzeBookingClaims(reply, TODAY)).toMatchObject({ firm: true, reschedule: true });
    expect(net({ reply, patientText: 'pode remarcar pra quinta às 9h?' })).toMatchObject({
      kind: 'correct',
      propose: [{ date: '2026-10-15', time: '09:00' }],
      keepText: '',
    });
  });

  it.each(['Remarquei sua consulta.', 'Ficou remarcado para quinta às 9h.', 'Reagendei pra você!', 'Sua avaliação foi reagendada para sexta.'])(
    'afirma remarcação: %p',
    (txt) => {
      expect(analyzeBookingClaims(txt, TODAY)).toMatchObject({ firm: true, reschedule: true });
    },
  );

  it('"desmarquei" e "se precisar ser remarcado" não são afirmação de remarcação', () => {
    expect(claimsBooked('Tudo bem, desmarquei sua consulta de quinta.', TODAY)).toBe(false);
    expect(claimsBooked('Se precisar ser remarcado é só avisar.', TODAY)).toBe(false);
    expect(analyzeBookingClaims('Deixei agendado terça às 9h, mas se precisar ser remarcado é só avisar.', TODAY)).toMatchObject({
      firm: true,
      reschedule: false,
    });
  });

  it('remarcação nunca vira agendamento, mesmo com aceite inequívoco', () => {
    expect(
      net({ reply: 'Prontinho, remarquei pra terça (13/10) às 8h!', patientText: 'sim', lastOutText: SINGLE_TUE8 }),
    ).toMatchObject({ kind: 'correct', propose: [TUE8] });
  });

  it('remarcação que cita a consulta que JÁ existe, ou resposta sem dia/hora a quem não pediu outro → existing', () => {
    expect(
      net({ reply: 'Prontinho, remarquei pra terça (20/10) às 9h!', patientText: 'pode remarcar?', existingStarts: existing20 }),
    ).toEqual({ kind: 'existing' });
    expect(
      net({ reply: 'Sim! Sua consulta está agendada.', patientText: 'vocês abrem sábado às 9h?', existingStarts: existing20 }),
    ).toEqual({ kind: 'existing' });
    expect(net({ reply: 'Está agendado sim!', patientText: 'minha consulta tá confirmada?', existingStarts: existing20 })).toEqual({
      kind: 'existing',
    });
  });
});

describe('sim2 item 5 — ordinal depois da nossa lista = aceite daquele item', () => {
  const choose = (patientText: string, lastOutText: string) =>
    resolvePatientChoice({ patientText, lastOutText, freeDays: SUELLEN, todayStr: TODAY });
  const WITH_MONDAY = 'Tenho segunda (19/10) às 8h ou terça (13/10) às 9h, qual prefere?';

  it('(U8) "o primeiro" a terça 8h / quarta 14h, IA diz terça 8h → me confirma terça 8h (modo conservador)', () => {
    expect(net({ reply: 'Perfeito, deixei agendado terça (13/10) às 8h!', patientText: 'o primeiro', lastOutText: TWO_OPT })).toMatchObject(
      asksToConfirm(TUE8),
    );
  });

  it('"a segunda opção" e a IA diz OUTRO horário → não marca; propõe o item escolhido', () => {
    expect(
      net({ reply: 'Perfeito, deixei agendado terça (13/10) às 8h!', patientText: 'pode ser a segunda opção', lastOutText: TWO_OPT }),
    ).toMatchObject({ kind: 'correct', propose: [QUA14] });
  });

  it.each([
    ['o primeiro', TWO_OPT, TUE8],
    ['a primeira opção', TWO_OPT, TUE8],
    ['a segunda', TWO_OPT, QUA14],
    ['a segunda opção', TWO_OPT, QUA14],
    ['opção 2', TWO_OPT, QUA14],
    ['a 2ª', TWO_OPT, QUA14],
    ['a segunda', OFF3_SIM, TER13], // depois de lista NÃO é segunda-feira
    ['o último', OFF3_SIM, QUA8],
    ['o de terça', TWO_OPT, TUE8], // só uma terça na proposta
    ['a quarta', OFF3_SIM, QUA8], // "a quarta" é o dia (só uma quarta)
    ['pode ser a segunda opção', WITH_MONDAY, { date: '2026-10-13', time: '09:00' }],
  ])('%p → %p', (patientText, lastOutText, slot) => {
    expect(choose(patientText, lastOutText).slot).toEqual(slot);
  });

  it('"a segunda" com uma segunda-feira na lista é ambíguo → não escolhe; "segunda" sem artigo é o dia', () => {
    expect(choose('a segunda', WITH_MONDAY)).toMatchObject({
      slot: null,
      candidates: [
        { date: '2026-10-13', time: '09:00' },
        { date: '2026-10-19', time: '08:00' },
      ],
    });
    expect(choose('segunda', WITH_MONDAY).slot).toEqual({ date: '2026-10-19', time: '08:00' });
  });

  it.each([
    ['é minha primeira vez', TWO_OPT],
    ['o primeiro horário que tiver', TWO_OPT],
    ['o terceiro', TWO_OPT],
    ['o de terça', OFF3_SIM], // OFF3 tem DUAS terças
  ])('não aponta item inequívoco: %p', (patientText, lastOutText) => {
    expect(choose(patientText, lastOutText).slot).toBeNull();
  });
});

describe('sim2 item 6 — recusa uma opção e escolhe outra na outra oração', () => {
  it('(P21) "terça não, quarta sim" às 3 opções (só uma quarta), IA diz quarta 8h → me confirma quarta 8h (modo conservador)', () => {
    expect(
      net({ reply: 'Perfeito, deixei agendado quarta (14/10) às 8h!', patientText: 'terça não, quarta sim', lastOutText: OFF3_SIM }),
    ).toMatchObject(asksToConfirm(QUA8));
  });

  it('(P22) "não posso terça, pode ser quarta às 8h" → me confirma quarta 8h (modo conservador)', () => {
    expect(
      net({
        reply: 'Perfeito, deixei agendado quarta (14/10) às 8h!',
        patientText: 'não posso terça, pode ser quarta às 8h',
        lastOutText: OFF3_SIM,
      }),
    ).toMatchObject(asksToConfirm(QUA8));
  });

  it('"não, quarta" a terça 8h / quarta 14h → o "não" é da terça: me confirma quarta 14h (modo conservador)', () => {
    expect(net({ reply: 'Perfeito, deixei agendado quarta (14/10) às 14h!', patientText: 'não, quarta', lastOutText: TWO_OPT })).toMatchObject(
      asksToConfirm(QUA14),
    );
  });

  it('ressalva, a IA dizendo o recusado, ou sem proposta com data → não marca', () => {
    expect(
      net({ reply: 'Perfeito, deixei agendado quarta (14/10) às 8h!', patientText: 'terça não, quarta talvez', lastOutText: OFF3_SIM }).kind,
    ).toBe('correct');
    expect(
      net({ reply: 'Perfeito, deixei agendado terça (13/10) às 8h!', patientText: 'terça não, quarta sim', lastOutText: OFF3_SIM }),
    ).toMatchObject({ kind: 'correct', propose: [QUA8] });
    expect(net({ reply: 'Perfeito, deixei agendado quarta às 8h!', patientText: 'terça não, quarta às 8h sim' }).kind).toBe('correct');
  });
});

// ═══ Simulação 3 da rede 13a — cenários exatos (C*, N*, B*) ═══════════════════════
const ONE_SIM = 'Tenho terça (13/10) às 8h, pode ser?';
const TER9 = { date: '2026-10-13', time: '09:00' };
const TER10 = { date: '2026-10-13', time: '10:00' };
const QUA9S = { date: '2026-10-14', time: '09:00' };
const QUI9 = { date: '2026-10-15', time: '09:00' };
/** Réplica do processor: alternativas = propose (ou 2 livres sem o recusado) + texto mantido. */
const fixFor = (d: ReturnType<typeof net>) => {
  if (d.kind !== 'correct') throw new Error(`esperava correct, veio ${d.kind}`);
  const fromClaim = d.propose.length > 0;
  const alts = fromClaim ? d.propose : pickAlternativeSlots(withoutRefused(SUELLEN, d.refused), null, 2);
  const fix = buildBookingFixText(d, alts, fromClaim);
  return d.keepText ? `${d.keepText}\n\n${fix}` : fix;
};

describe('sim3 item 1 — ordinal só vale como escolha da lista (nunca "1º de novembro", "3º ano", "o segundo dente")', () => {
  const choose = (patientText: string, lastOutText = TWO_OPT) =>
    resolvePatientChoice({ patientText, lastOutText, freeDays: SUELLEN, todayStr: TODAY });

  it('(C1) "consigo só a partir de 1º de novembro" → NÃO marca; "Não consegui horário a partir de…"', () => {
    const d = net({
      reply: 'Tudo bem! Deixei agendado terça (13/10) às 8h.',
      patientText: 'consigo só a partir de 1º de novembro',
      lastOutText: TWO_OPT,
    });
    expect(d).toMatchObject({ kind: 'correct', requested: { date: '2026-11-01', onwards: true }, keepText: '' });
    expect(fixFor(d)).toBe(
      'Não consegui horário a partir de domingo (01/11). Tenho terça (13/10) às 8h ou quarta (14/10) às 8h, qual fica melhor pra você?',
    );
  });

  it.each([
    ['C7', OFF3_SIM, 'minha filha tá no 3º ano', 'Que bom! Deixei agendado quarta (14/10) às 8h.'],
    ['C10', TWO_OPT, 'o segundo dente de baixo tá doendo', 'Entendi! Deixei agendado quarta (14/10) às 14h.'],
    ['C5', TWO_OPT, 'tô no 1º semestre da faculdade, de manhã tenho aula', 'Entendi! Deixei agendado quarta (14/10) às 14h.'],
    ['C11', OFF3_SIM, 'moro no 2º andar, tem elevador?', 'Tem sim! Deixei agendado terça (13/10) às 13h.'],
    ['C4', TWO_OPT, 'recebo dia 5, pode ser depois do 2º sábado?', 'Pode sim! Deixei agendado quarta (14/10) às 14h.'],
  ])('(%s) %p → NÃO marca', (_id, lastOutText, patientText, reply) => {
    expect(net({ reply, patientText, lastOutText }).kind).toBe('correct');
  });

  it('(C3 / B5.h) pediu uma DATA fora da agenda → "Não consegui horário no domingo (01/11)", sem o "Pode sim!"', () => {
    for (const patientText of ['pode ser no 1º de novembro?', 'pode ser dia 1º?']) {
      const d = net({ reply: 'Pode sim! Deixei agendado terça (13/10) às 8h.', patientText, lastOutText: TWO_OPT });
      expect(d).toMatchObject({ kind: 'correct', requested: { date: '2026-11-01' }, keepText: '' });
      expect(fixFor(d)).toBe(
        'Não consegui horário no domingo (01/11). Tenho terça (13/10) às 8h ou quarta (14/10) às 8h, qual fica melhor pra você?',
      );
    }
  });

  it('(C4) o "Pode sim!" a uma pergunta de horário cai; (C11) o "Tem sim!" do elevador fica, e a proposta é a da resposta', () => {
    expect(
      net({
        reply: 'Pode sim! Deixei agendado quarta (14/10) às 14h.',
        patientText: 'recebo dia 5, pode ser depois do 2º sábado?',
        lastOutText: TWO_OPT,
      }),
    ).toMatchObject({ kind: 'correct', keepText: '', requested: null });
    expect(
      net({ reply: 'Tem sim! Deixei agendado terça (13/10) às 13h.', patientText: 'moro no 2º andar, tem elevador?', lastOutText: OFF3_SIM }),
    ).toMatchObject({ kind: 'correct', keepText: 'Tem sim!', propose: [TER13] });
  });

  it('(C5) "de manhã tenho aula" recusa a manhã: a oferta é só à tarde', () => {
    const d = net({
      reply: 'Entendi! Deixei agendado quarta (14/10) às 14h.',
      patientText: 'tô no 1º semestre da faculdade, de manhã tenho aula',
      lastOutText: TWO_OPT,
    });
    expect(d).toMatchObject({ kind: 'correct', offer: true, propose: [QUA14, TER13] });
  });

  it.each([
    ['o primeiro mesmo', TUE8],
    ['o primeiro, por favor', TUE8],
    ['quero o 1º', TUE8],
    ['1º', TUE8],
    ['2ª opção', QUA14],
    ['pode ser a 2ª', QUA14],
    ['o segundo pra mim', QUA14],
    ['pode ser no primeiro horário', TUE8],
    ['o 2º não, o 1º sim', TUE8],
    ['o segundo não, o primeiro sim', TUE8],
  ])('continua escolha da lista: %p', (patientText, slot) => {
    expect(choose(patientText).slot).toEqual(slot);
  });

  it.each([
    'o segundo dente de baixo tá doendo',
    'minha filha tá no 3º ano',
    'moro no 2º andar',
    'tô no 1º semestre',
    'dia 1º',
    'pode ser no 1º',
    'o primeiro dia que tiver',
    'depois do 2º sábado',
  ])('NÃO é escolha da lista: %p', (patientText) => {
    const c = choose(patientText);
    expect(c.slot).toBeNull();
    expect(c.candidates).toEqual([]);
  });

  it('datas por extenso são data ("1º de novembro", "13 de outubro"); "dia 5 de janeiro" não vira o dia 5 do mês que vem', () => {
    expect([...extractSlotMentions('consigo só a partir de 1º de novembro', TODAY).dates]).toEqual(['2026-11-01']);
    const m = extractSlotMentions('pode ser 13 de outubro às 8h', TODAY);
    expect([...m.dates]).toEqual(['2026-10-13']);
    expect([...m.times]).toEqual(['08:00']);
    expect(m.explicitDate).toBe(true);
    expect([...extractSlotMentions('dia 5 de janeiro', '2026-12-20').dates]).toEqual(['2027-01-05']);
    expect(extractOfferedSlots('Tenho terça, 13 de outubro, às 8h. Pode ser?', TODAY)).toEqual([TUE8]);
    // "daqui a 1 mês" / "dura 1 hora" não são hora; "a 2ª" não é 2h
    expect([...extractSlotMentions('daqui a 1 mês, dia 12/11 às 9h', TODAY).times]).toEqual(['09:00']);
    expect(extractSlotMentions('a avaliação dura 1 hora', TODAY).times.size).toBe(0);
    expect(extractSlotMentions('pode ser a 2ª', TODAY).times.size).toBe(0);
  });

  it('"de acordo" puro não tem prazo, data nem ordinal', () => {
    expect(isPureAcceptance('consigo só a partir de 1º de novembro', TODAY)).toBe(false);
    expect(isPureAcceptance('pode ser, mês que vem', TODAY)).toBe(false);
    expect(isPureAcceptance('sim, pode marcar', TODAY)).toBe(true);
    expect(isPureAcceptance('pode ser sim, obrigada!', TODAY)).toBe(true);
  });
});

describe('sim3 item 2 — "próxima manutenção", "daqui a N meses" e data passada COM dia + hora continuam afirmação', () => {
  it('(N2.1) ortodontia: "Deixei agendada sua próxima manutenção para quinta (15/10) às 9h" → MARCA', () => {
    expect(
      net({
        reply: 'Prontinho! Deixei agendada sua próxima manutenção para quinta (15/10) às 9h.',
        patientText: 'pode',
        lastOutText: 'Sua próxima manutenção pode ser quinta (15/10) às 9h?',
      }),
    ).toEqual({ kind: 'book', slot: QUI9 });
  });

  it.each([
    'Perfeito! Seu próximo retorno ficou agendado para terça (13/10) às 8h.',
    'Perfeito! Deixei agendada sua próxima limpeza para terça (13/10) às 8h.',
  ])('(N2.2 / B2.w) %p após "sim" → MARCA', (reply) => {
    expect(net({ reply, patientText: 'sim', lastOutText: ONE_SIM })).toEqual({ kind: 'book', slot: TUE8 });
  });

  it('(N2.5) "…para daqui a 1 mês, dia 12/11 às 9h" (fora da agenda) → "Não consegui quinta (12/11) às 9h…"', () => {
    const d = net({
      reply: 'Prontinho! Deixei sua manutenção agendada para daqui a 1 mês, dia 12/11 às 9h.',
      patientText: 'quero, daqui a um mês no mesmo horário',
      lastOutText: 'Quer deixar a próxima manutenção marcada?',
    });
    expect(d).toMatchObject({ kind: 'correct', requested: { date: '2026-11-12', time: '09:00' }, keepText: '' });
    expect(fixFor(d)).toMatch(/^Não consegui quinta \(12\/11\) às 9h na agenda\. Tenho /);
  });

  it('(N2.7) em outubro, "deixei agendado para 05/01 às 9h" (data passada, 1ª pessoa) → correct, nunca no_claim', () => {
    const d = net({
      reply: 'Perfeito, deixei agendado para 05/01 às 9h!',
      patientText: 'pode ser 05/01 às 9h',
      lastOutText: 'Qual dia fica melhor?',
    });
    expect(d).toMatchObject({ kind: 'correct', requested: { date: '2026-01-05', time: '09:00' } });
    expect(fixFor(d)).toMatch(/^Não consegui segunda \(05\/01\) às 9h na agenda\./);
  });

  it.each([
    'Sua consulta foi marcada para 10/09 às 9h.',
    'O retorno ficou agendado para daqui a 6 meses, a recepção vai te chamar.',
    'Seu retorno ficou agendado para daqui a 6 meses, em abril.',
    'Deixei marcado seu retorno pra daqui a 6 meses, a recepção te chama perto da data.',
    'Sua última consulta foi em 10 de setembro.',
  ])('sem dia + hora (ou passado descritivo) continua NÃO afirmando: %p', (txt) => {
    expect(findBookingClaims(txt, TODAY)).toEqual([]);
  });
});

describe('sim3 item 3 — "pelo convênio/plano" é pagamento; "pela recepção/equipe/Dra." logo depois do "sim" é afirmação nossa', () => {
  it.each([
    ['N2.4', 'sim', 'Perfeito! Agendei sua avaliação pelo plano para terça (13/10) às 8h.'],
    ['N2.11', 'sim', 'Prontinho! Sua avaliação foi agendada pela recepção para terça (13/10) às 8h.'],
    ['N2.12', 'sim', 'Agendado para terça (13/10) às 8h pela nossa equipe!'],
    ['N2.6', 'sim', 'Perfeito! Sua avaliação foi agendada pela Dra. Suellen para terça (13/10) às 8h.'],
  ])('(%s) %p + %p → MARCA terça 8h', (_id, patientText, reply) => {
    expect(net({ reply, patientText, lastOutText: ONE_SIM })).toEqual({ kind: 'book', slot: TUE8 });
  });

  it('(N2.3) "sim, pelo convênio" não é "sim" puro → me confirma terça 8h (modo conservador)', () => {
    const d = net({ reply: 'Pode sim! Deixei agendado terça (13/10) às 8h pelo seu convênio.', patientText: 'sim, pelo convênio', lastOutText: ONE_SIM });
    expect(d).toMatchObject(asksToConfirm(TUE8));
  });

  it('(Q10) "a moça marcou pra mim?" → "foi agendada pela recepção…" sai intacta', () => {
    const reply = 'Sim! Sua avaliação foi agendada pela recepção para terça (13/10) às 8h.';
    expect(net({ reply, patientText: 'a moça marcou pra mim?' })).toEqual({ kind: 'no_claim' });
    expect(['no_claim', 'existing']).toContain(
      net({ reply, patientText: 'a moça marcou pra mim?', existingStarts: [naive('2026-10-13T08:00:00')] }).kind,
    );
    // o filtro de ENTRADA da rede deixa passar (quem decide é o assessBookingClaim); claimsBooked não
    expect(findBookingClaims(reply, TODAY)).toHaveLength(1);
    expect(claimsBooked(reply, TODAY)).toBe(false);
  });

  it('terceiro de fora (laboratório) nunca é afirmação, nem depois do "sim"', () => {
    expect(
      net({ reply: 'Seu exame foi agendado pelo laboratório parceiro para terça às 9h.', patientText: 'sim', lastOutText: ONE_SIM }),
    ).toEqual({ kind: 'no_claim' });
  });
});

describe('sim3 item 4 — recusa sem "não" ("muito cedo", "complica", "fica difícil") nunca marca o horário recusado', () => {
  it.each([
    ['C13', '8h é muito cedo pra mim', [TER9, QUA9S]],
    ['C15', 'terça às 8 complica pra mim', [QUA8, QUI8]],
    ['C16', 'às 8h fica difícil', [TER9, QUA9S]],
  ])('(%s) %p → oferta sem a terça 8h (nem 8h30)', (_id, patientText, propose) => {
    expect(net({ reply: 'Perfeito, deixei agendado terça (13/10) às 8h!', patientText, lastOutText: ONE_SIM })).toMatchObject({
      kind: 'correct',
      offer: true,
      propose,
    });
    expect(resolvePatientChoice({ patientText, lastOutText: ONE_SIM, freeDays: SUELLEN, todayStr: TODAY })).toMatchObject({
      slot: null,
      fromSingleOffer: false,
    });
  });

  it.each(['8h não é muito cedo pra mim', 'sim, não complica', 'pode ser, 8h não tem problema'])(
    'NÃO é recusa: %p → escolhe a terça 8h',
    (patientText) => {
      expect(resolvePatientChoice({ patientText, lastOutText: ONE_SIM, freeDays: SUELLEN, todayStr: TODAY }).slot).toEqual(TUE8);
    },
  );
});

describe('sim3 item 5 — keepText não mantém frase que pressupõe a marcação', () => {
  it.each([
    ['N3.1', 'Perfeito, deixei agendado terça às 8h! Já está tudo certo, é só comparecer.'],
    ['N3.2', 'Deixei agendado terça às 8h. Agora é só chegar 10 minutinhos antes.'],
    ['N3.4', 'Deixei agendado terça às 8h. Já está na agenda da Dra. Suellen.'],
    ['N3.6', 'Deixei agendado terça às 8h. Está tudo certinho pra você!'],
    ['N3.8', 'Deixei agendado terça às 8h! Pode ficar tranquila que tá tudo certo.'],
  ])('(%s) %p → keepText vazio', (_id, reply) => {
    const d = net({ reply, patientText: 'quero', lastOutText: 'Quer agendar sua avaliação?' });
    expect(d).toMatchObject({ kind: 'correct', keepText: '', propose: [TUE8] });
    expect(fixFor(d)).toBe('Pra eu deixar certinho na agenda, me confirma: pode ser terça (13/10) às 8h?');
  });
});

describe('sim3 item 6 — "não posso" sobre OUTRA coisa (pagar, atrasar) não é recusa do horário', () => {
  it('(N1.13) "sim, mas não posso pagar agora" → pede confirmação da terça 8h (a ressalva impede marcar), nunca oferta', () => {
    const d = net({
      reply: 'Perfeito, deixei agendado terça (13/10) às 8h! A avaliação é gratuita.',
      patientText: 'sim, mas não posso pagar agora',
      lastOutText: ONE_SIM,
    });
    expect(d).toMatchObject({ kind: 'correct', offer: false, refused: null, propose: [TUE8], keepText: 'A avaliação é gratuita.' });
    expect(fixFor(d)).toBe('A avaliação é gratuita.\n\nPra eu deixar certinho na agenda, me confirma: pode ser terça (13/10) às 8h?');
  });

  it('(N1.18) "sim, só não posso atrasar porque trabalho às 10" → me confirma terça 8h (a hora do motivo não é escolha)', () => {
    expect(
      net({
        reply: 'Perfeito, deixei agendado terça (13/10) às 8h!',
        patientText: 'sim, só não posso atrasar porque trabalho às 10',
        lastOutText: ONE_SIM,
      }),
    ).toMatchObject(asksToConfirm(TUE8));
  });

  it('o motivo ("porque…") é contexto: "quarta, porque terça trabalho" escolhe a quarta; "pois é, pode ser" é aceite', () => {
    expect(
      resolvePatientChoice({ patientText: 'quarta, porque terça trabalho', lastOutText: TWO_OPT, freeDays: SUELLEN, todayStr: TODAY }).slot,
    ).toEqual(QUA14);
    expect(resolvePatientChoice({ patientText: 'pois é, pode ser', lastOutText: ONE_SIM, freeDays: SUELLEN, todayStr: TODAY }).slot).toEqual(
      TUE8,
    );
  });

  it.each(['não posso ir', 'não consigo vir', 'não vou poder', 'nenhum dos dois'])('continua recusa: %p', (patientText) => {
    expect(resolvePatientChoice({ patientText, lastOutText: ONE_SIM, freeDays: SUELLEN, todayStr: TODAY }).slot).toBeNull();
    expect(net({ reply: 'Perfeito, deixei agendado terça (13/10) às 8h!', patientText, lastOutText: ONE_SIM })).toMatchObject({
      kind: 'correct',
      offer: true,
    });
  });
});

describe('sim3 item 7 — o horário recusado nunca volta como proposta', () => {
  it.each([
    ['C12', OFF3_SIM, 'terça às 8h não', 'Perfeito, deixei agendado terça (13/10) às 8h!', [TER13, QUA8]],
    ['B6.o', OFF3_SIM, 'terça às 8h não', 'Sem problemas! Deixei agendado terça (13/10) às 13h.', [TER13, QUA8]],
    ['C14', ONE_SIM, 'terça 8h nem pensar', 'Perfeito, deixei agendado terça (13/10) às 8h!', [QUA8, QUI8]],
    ['C17', OFF3_SIM, 'às 8 não', 'Sem problemas! Deixei agendado terça (13/10) às 13h.', [TER13, QUA9S]],
    ['B1.u', ONE_SIM, '8h é muito cedo pra mim', 'Sem problemas! Deixei agendado terça (13/10) às 10h.', [TER10, QUA9S]],
    ['C18', ONE_SIM, 'não posso, só sábado', 'Sem problemas! Deixei agendado quarta (14/10) às 8h.', [QUA8, QUI8]],
  ])('(%s) %p → oferta sem o recusado', (_id, lastOutText, patientText, reply, propose) => {
    const d = net({ reply, patientText, lastOutText });
    expect(d).toMatchObject({ kind: 'correct', offer: true, propose });
    const txt = fixFor(d);
    expect(txt).toMatch(/^Sem problemas! Tenho /);
    expect(txt).not.toMatch(/me confirma/);
    if (d.kind !== 'correct' || !d.refused) throw new Error('esperava recusa');
    // fallback do processor (verificação derrubou as propostas): nunca o recusado
    const fallback = pickAlternativeSlots(withoutRefused(SUELLEN, d.refused), null, 3);
    expect(fallback.some((s) => d.refused!.slots.some((r) => r.date === s.date && r.time === s.time))).toBe(false);
    expect(fallback.some((s) => d.refused!.times.includes(s.time))).toBe(false);
  });

  it('(C18) "não posso, só sábado": o "não" recusa a terça 8h (sábado nem está na proposta)', () => {
    const d = net({ reply: 'Sem problemas! Deixei agendado quarta (14/10) às 8h.', patientText: 'não posso, só sábado', lastOutText: ONE_SIM });
    if (d.kind !== 'correct') throw new Error('esperava correct');
    expect(d.refused?.slots).toEqual([TUE8]);
    expect(withoutRefused(SUELLEN, d.refused).some((x) => x.date === '2026-10-13')).toBe(false);
  });
});

describe('sim3 item 8 — texto honesto depois de recusa não fala em "preferência"', () => {
  const NO_PREF = 'Sem problemas! Vou pedir pra recepção te chamar com outras opções de horário.';

  it('(N1.8) proposta única + "não posso", autobook desligado', () => {
    const d = net({ reply: 'Sem problemas! Deixei agendado quarta (14/10) às 8h.', patientText: 'não posso', lastOutText: ONE_SIM });
    if (d.kind !== 'correct') throw new Error('esperava correct');
    expect(d.offer).toBe(true);
    expect(buildHonestPreferenceText(d.propose.length === 1 ? d.propose[0] : null, d)).toBe(NO_PREF);
    // nem por um horário que NÓS sugerimos
    expect(buildHonestPreferenceText(d.propose[0], d)).toBe(NO_PREF);
  });

  it.each([
    ['N1.12', 'não vou poder', 'Sem problemas! Deixei agendado sexta (16/10) às 9h.'],
    ['N4.4', 'não vou conseguir ir quinta', 'Sem problemas! Remarquei pra sexta (16/10) às 9h.'],
  ])('(%s) tem consulta qui 9h + %p', (_id, patientText, reply) => {
    const d = net({
      reply,
      patientText,
      lastOutText: 'Lembrando: sua consulta é quinta (15/10) às 9h.',
      existingStarts: [naive('2026-10-15T09:00:00')],
    });
    expect(d).toMatchObject({ kind: 'correct', hasExisting: true, offer: true, keepText: '' });
    if (d.kind !== 'correct') return;
    const txt = buildHonestPreferenceText(d.propose.length === 1 ? d.propose[0] : null, d);
    expect(txt).toBe(NO_PREF);
    expect(txt).not.toMatch(/prefer/);
    expect(claimsBooked(txt, TODAY)).toBe(false);
  });

  it('sem recusa, o texto de antes; acolhimento já no texto mantido não se repete', () => {
    expect(buildHonestPreferenceText(TER9)).toBe('Deixei anotada sua preferência por terça (13/10) às 9h pra recepção confirmar com você.');
    expect(buildHonestPreferenceText(TER9, { offer: false, refused: null })).toBe(buildHonestPreferenceText(TER9));
    expect(buildHonestPreferenceText(null, { offer: true, keepText: 'Sem problemas! A avaliação é gratuita.' })).toBe(
      'Vou pedir pra recepção te chamar com outras opções de horário.',
    );
  });
});

// ═══ MODO CONSERVADOR — portão final da rede 13a ════════════════════════════════
// Decisão do produto: 'book' SÓ no caso estreito — a nossa última fala ofereceu UM
// horário com DD/MM + hora, o paciente mandou um "sim" puro da lista fechada, a IA diz
// esse horário (ou nenhum), sem consulta e sem remarcação. O resto que a heurística
// marcaria vira "me confirma: pode ser <o horário certo>?" (cenários das simulações r13–r15).
describe('modo conservador — o caso estreito MARCA', () => {
  it.each([
    'sim', 'Sim!', 'SIM', 's', 'ss', 'simmm', 'siiim', 'sim sim', 'pode ser', 'Pode', 'pode marcar', 'ok', 'okay',
    'beleza', 'blz', 'fechado', 'combinado', 'confirmo', 'confirmado', 'perfeito', 'ótimo', 'isso', 'isso mesmo',
    'uhum', 'aham', 'tá', 'ta bom', 'tá bom', '👍', '👍🏻', '👌', '✅', 'pode sim', 'sim, pode', 'Sim, pode ser!',
    'Pode ser sim 😊', 'sim, obrigada', 'Sim senhora', 'Bom dia! Pode ser',
  ])('"sim" puro %p à proposta ÚNICA com data → MARCA', (patientText) => {
    expect(net({ reply: 'Perfeito, deixei agendado! Te lembro um dia antes.', patientText, lastOutText: ONE_SIM })).toEqual({
      kind: 'book',
      slot: TUE8,
    });
  });

  it.each([
    'Perfeito, deixei agendado terça (13/10) às 8h!',
    'Prontinho! Deixei agendado terça 13/10 às 8h. Te mando lembrete, tá?',
    'Agendado pra terça às 8h!',
    'Perfeito, deixei agendado amanhã às 8h!',
    'Vou deixar agendado terça às 8h e te lembro um dia antes.',
  ])('a resposta cita o MESMO horário (ou nenhum) → MARCA: %p', (reply) => {
    expect(net({ reply, patientText: 'sim', lastOutText: ONE_SIM })).toEqual({ kind: 'book', slot: TUE8 });
  });

  it.each([
    'Tenho terça (13/10) às 8h, pode ser?',
    'Tenho terça (13/10) às 8h. Pode ser?',
    'Vamos deixar terça, 13/10, às 8h?',
    'Terça 13/10 às 08:00, pode ser?',
    'Tenho terça (13/10) às 8h, pode ser, Maria?',
    'Tenho terça (13/10) às 8h com a Dra. Suellen. Fica bom pra você?',
    'Tenho terça (13/10) às 8h. Quer agendar sua avaliação?',
    'Oi Maria, tudo bem? Abriu uma vaga terça (13/10) às 8h com a Dra. Pode ser?',
  ])('a nossa proposta %p + "sim" → MARCA', (lastOutText) => {
    expect(net({ reply: 'Perfeito, deixei agendado!', patientText: 'sim', lastOutText })).toEqual({ kind: 'book', slot: TUE8 });
  });

  it('fecha o laço: o "sim" ao nosso "me confirma: pode ser X?" (com o texto mantido antes) MARCA X', () => {
    const lastOutText = `A avaliação é gratuita.\n\n${buildConfirmChoiceText([QUA8], false)}`;
    expect(net({ reply: 'Perfeito, deixei agendado quarta (14/10) às 8h!', patientText: 'pode ser', lastOutText })).toEqual({
      kind: 'book',
      slot: QUA8,
    });
  });

  it('"uhum", "tá", "ss"… (lista fechada, que a heurística não lia como aceite) MARCAM em vez de inventar opções', () => {
    for (const patientText of ['uhum', 'aham', 'tá', 'ss', 'simmm', 'siiim', 's']) {
      expect(net({ reply: 'Perfeito, deixei agendado! Te lembro um dia antes.', patientText, lastOutText: SINGLE_TUE8 })).toEqual({
        kind: 'book',
        slot: TUE8,
      });
    }
  });
});

describe('modo conservador — o que a heurística marcava agora PEDE CONFIRMAÇÃO do horário certo', () => {
  const OFFER_814 = 'Tenho terça (13/10) às 8h ou às 14h. Qual prefere?';
  const TER14 = { date: '2026-10-13', time: '14:00' };
  const QUI15 = { date: '2026-10-15', time: '15:00' };
  const SEG8 = { date: '2026-10-19', time: '08:00' };
  const ENCAIXE =
    'Consegui um encaixe! Posso te encaixar:\n• Terça-feira 13/10 às 08:00\n• Terça-feira 13/10 às 13:00\n• Quarta-feira 14/10 às 08:00\nQual fica melhor pra você?';
  it.each([
    // ordinais
    ['o primeiro', TWO_OPT, 'Perfeito, deixei agendado terça (13/10) às 8h!', TUE8],
    ['o 1º', TWO_OPT, 'Perfeito, deixei agendado terça (13/10) às 8h!', TUE8],
    ['a segunda opção', TWO_OPT, 'Perfeito, deixei agendado quarta, 14/10, às 14h!', QUA14],
    ['prefiro o segundo horário', TWO_OPT, 'Perfeito, deixei agendado quarta (14/10) às 14h!', QUA14],
    ['2ª opção', OFF3_SIM, 'Perfeito, deixei agendado terça (13/10) às 13h!', TER13],
    ['o segundo', OFF3_SIM, 'Perfeito, deixei agendado!', TER13],
    ['a terceira', OFF3_SIM, 'Perfeito, deixei agendado quarta (14/10) às 8h!', QUA8],
    ['o primeiro horário', ENCAIXE, 'Perfeito, deixei agendado terça às 8h!', TUE8],
    // dia/hora/turno citados
    ['quinta às 8 tá ótimo', ENCAIXE, 'Perfeito, deixei agendado quinta, 15/10, às 8h!', QUI8],
    ['quinta às 15h tá ótimo, não tenho compromisso', null, 'Perfeito, deixei agendado quinta, 15/10, às 15h!', QUI15],
    ['a da tarde', ENCAIXE, 'Perfeito, deixei agendado terça às 13h!', TER13],
    ['terça cedinho', 'Tenho:\n• terça (13/10) às 8h\n• terça (13/10) às 13h\nQual prefere?', 'Perfeito, deixei agendado terça às 8h!', TUE8],
    ['às 2', OFFER_814, 'Perfeito, deixei agendado terça às 14h!', TER14],
    ['quarta', TWO_OPT, 'Perfeito, deixei agendado quarta às 14h!', QUA14],
    ['segunda às 8h', TWO_OPT, 'Perfeito, deixei agendado segunda (19/10) às 8h!', SEG8],
    ['quero terça às 8h', null, 'Agendado para terça às 8h! Te lembro um dia antes.', TUE8],
    // recusa numa oração + escolha noutra
    ['terça não, quarta sim', TWO_OPT, 'Perfeito, deixei agendado quarta às 14h!', QUA14],
    ['não, a de quarta', OFF3_SIM, 'Perfeito, deixei agendado quarta (14/10) às 8h!', QUA8],
    ['Não. Quarta.', TWO_OPT, 'Perfeito, deixei agendado quarta (14/10) às 14h!', QUA14],
    ['na terça às 8h não consigo, mas quarta às 14h tá ótimo', TWO_OPT, 'Perfeito, deixei agendado quarta (14/10) às 14h!', QUA14],
    // aceite com pergunta / ressalva / fora da lista fechada
    ['sim! qual o endereço?', SINGLE_TUE8, 'Perfeito, deixei agendado terça 13/10 às 8h! O endereço é Rua X, 123, Centro.', TUE8],
    ['sim, pelo convênio', ONE_SIM, 'Pode sim! Deixei agendado terça (13/10) às 8h pelo seu convênio.', TUE8],
    ['pode ser sim, não vejo a hora', SINGLE_TUE8, 'Perfeito, deixei agendado terça 13/10 às 8h!', TUE8],
    ['sim! não vou faltar', ONE_SIM, 'Perfeito, deixei agendado terça (13/10) às 8h!', TUE8],
    ['claro', SINGLE_TUE8, 'Perfeito, deixei agendado! Te lembro um dia antes.', TUE8],
    ['Com certeza!', SINGLE_TUE8, 'Perfeito, deixei agendado! Te lembro um dia antes.', TUE8],
    // a nossa fala não é UM horário com DD/MM (e nada mais)
    ['sim', 'Tenho terça, 13 de outubro, às 8h. Pode ser?', 'Perfeito, deixei agendado terça (13/10) às 8h!', TUE8],
    [
      'sim',
      'A terça (13/10) às 9h já está ocupada. Tenho terça (13/10) às 10h, pode ser?',
      'Perfeito, deixei agendado terça (13/10) às 10h!',
      { date: '2026-10-13', time: '10:00' },
    ],
    ['sim', 'Não consegui terça (13/10) às 9h. Tenho quarta (14/10) às 10h, pode ser?', 'Perfeito, deixei agendado!', { date: '2026-10-14', time: '10:00' }],
    // intenção depois de um aceite que não é o caso estreito
    ['pode ser sim, não vejo a hora', SINGLE_TUE8, 'Vou deixar agendado terça às 8h e te lembro um dia antes.', TUE8],
  ])('%p (nossa: %p) → me confirma, NUNCA marca', (patientText, lastOutText, reply, slot) => {
    const d = net({ reply, patientText, lastOutText });
    expect(d.kind).not.toBe('book');
    expect(d).toMatchObject(asksToConfirm(slot));
    if (d.kind === 'correct') expect(buildBookingFixText(d, [slot], true)).toBe(buildConfirmChoiceText([slot], false));
  });

  it('o texto final: o resto da resposta + "Pra eu deixar certinho na agenda, me confirma: pode ser <dia (DD/MM) às HHh>?"', () => {
    const d = net({
      reply: 'Perfeito, deixei agendado quarta (14/10) às 8h! A avaliação é gratuita.',
      patientText: 'terça não, quarta sim',
      lastOutText: OFF3_SIM,
    });
    expect(fixFor(d)).toBe('A avaliação é gratuita.\n\nPra eu deixar certinho na agenda, me confirma: pode ser quarta (14/10) às 8h?');
    // e a 2ª rodada: o "sim" a esse texto MARCA
    expect(net({ reply: 'Prontinho, agendado!', patientText: 'sim', lastOutText: fixFor(d) })).toEqual({ kind: 'book', slot: QUA8 });
  });

  it('virada da meia-noite ("pode ser amanhã às 9h"): não marca — a confirmação mostra a data (DD/MM)', () => {
    const at = (todayStr: string) =>
      net({
        todayStr,
        reply: 'Perfeito, deixei agendado amanhã às 9h!',
        patientText: 'pode ser amanhã às 9h',
        lastOutText: 'Qual dia fica melhor pra você?',
      });
    expect(at('2026-10-12')).toMatchObject(asksToConfirm({ date: '2026-10-13', time: '09:00' }));
    expect(at('2026-10-13')).toMatchObject(asksToConfirm({ date: '2026-10-14', time: '09:00' }));
  });
});

describe('modo conservador — o caso estreito exige TUDO', () => {
  const R = 'Perfeito, deixei agendado terça (13/10) às 8h!';
  it.each([
    ['pergunta outra coisa', 'Tenho terça (13/10) às 8h. Você já fez avaliação com a gente?'],
    ['pergunta outra coisa na mesma frase', 'Tenho terça (13/10) às 8h, tem convênio?'],
    ['"ou" na pergunta', 'Tenho terça (13/10) às 8h, pode ser ou prefere outro dia?'],
    ['outra data citada', 'Sua consulta de 20/10 foi cancelada. Tenho terça (13/10) às 8h, pode ser?'],
    ['outra hora citada', 'Não tenho às 9h, mas tenho terça (13/10) às 8h, pode ser?'],
    ['sem DD/MM', 'Tenho terça às 8h, pode ser?'],
    ['sem pergunta nenhuma', 'Tenho terça (13/10) às 8h livre na agenda.'],
    ['só a saudação perguntando, ANTES da oferta', 'Oi Maria, tudo bem? Abriu uma vaga terça (13/10) às 8h com a Dra.'],
    ['"me avisa" mesmo com pergunta da lista', 'Tenho terça (13/10) às 8h. Fala com seu marido e me avisa, combinado?'],
  ])('a nossa fala com %s → "sim" NÃO marca (me confirma terça 8h)', (_why, lastOutText) => {
    const d = net({ reply: R, patientText: 'sim', lastOutText });
    expect(d.kind).toBe('correct');
    if (d.kind === 'correct') expect(d.propose).toEqual([TUE8]);
  });

  // Revisão final: "ok"/"beleza" de CIÊNCIA ou "sim" à saudação não é aceite do horário.
  it.each([
    ['Tenho terça (13/10) às 8h. Fala com seu marido e me avisa.', 'beleza', 'Prontinho, deixei agendado terça (13/10) às 8h!'],
    ['Tenho terça (13/10) às 8h. Me avisa se der certo pra você.', 'ok', 'Perfeito, deixei agendado!'],
    ['Oi Maria, tudo bem? Abriu uma vaga terça (13/10) às 8h com a Dra.', 'sim', 'Perfeito, deixei agendado!'],
    [
      'a Dra. só tem vaga terça (13/10) às 8h. Vou ver com ela outros dias e te aviso.',
      'ok',
      'Prontinho, agendado pra terça!',
    ],
    ['Tenho terça (13/10) às 8h. Pensa com calma, tá?', 'ok', 'Perfeito, deixei agendado!'],
  ])('nossa %p + %p → NÃO marca', (lastOutText, patientText, reply) => {
    const d = net({ reply, patientText, lastOutText });
    expect(d.kind).not.toBe('book');
    if (d.kind === 'correct') expect(d.propose).toEqual([TUE8]);
  });

  it('a resposta ou o confirm_slot incompleto apontam OUTRO horário → não marca', () => {
    expect(net({ reply: 'Perfeito, deixei agendado! Te espero quarta às 9h.', patientText: 'sim', lastOutText: ONE_SIM }).kind).toBe('correct');
    expect(net({ reply: 'Perfeito, deixei agendado terça que vem às 8h!', patientText: 'sim', lastOutText: ONE_SIM }).kind).toBe('correct');
    expect(net({ reply: 'Perfeito, deixei agendado!', patientText: 'sim', lastOutText: ONE_SIM, hint: { date: '2026-10-14' } }).kind).toBe(
      'correct',
    );
  });

  it('consulta futura ou remarcação → nunca marca', () => {
    expect(net({ reply: R, patientText: 'sim', lastOutText: ONE_SIM, existingStarts: [naive('2026-10-15T09:00:00')] }).kind).toBe('correct');
    expect(net({ reply: 'Prontinho, remarquei pra terça (13/10) às 8h!', patientText: 'sim', lastOutText: ONE_SIM })).toMatchObject({
      kind: 'correct',
      propose: [TUE8],
    });
  });

  it('horário que não está livre, pergunta de verdade na afirmação ou outra pessoa → nunca marca', () => {
    const busy = SUELLEN.map((d) => (d.date === TUE8.date ? { ...d, times: d.times.filter((t) => t !== '08:00') } : d));
    expect(net({ freeDays: busy, reply: R, patientText: 'sim', lastOutText: ONE_SIM }).kind).not.toBe('book');
    expect(net({ reply: 'Deixei agendado terça (13/10) às 8h, prefere outro horário?', patientText: 'sim', lastOutText: ONE_SIM }).kind).toBe(
      'correct',
    );
    expect(
      net({
        reply: 'Prontinho! Agendado pra sua filha terça (13/10) às 8h.',
        patientText: 'sim',
        lastOutText: 'Tenho terça (13/10) às 8h pra sua filha, pode ser?',
      }).kind,
    ).not.toBe('book');
  });

  it.each([
    ['C1', TWO_OPT, 'consigo só a partir de 1º de novembro', 'Tudo bem! Deixei agendado terça (13/10) às 8h.'],
    ['C7', OFF3_SIM, 'minha filha tá no 3º ano', 'Que bom! Deixei agendado quarta (14/10) às 8h.'],
    ['C10', TWO_OPT, 'o segundo dente de baixo tá doendo', 'Entendi! Deixei agendado quarta (14/10) às 14h.'],
    ['C13', ONE_SIM, '8h é muito cedo pra mim', 'Perfeito, deixei agendado terça (13/10) às 8h!'],
    ['C12', OFF3_SIM, 'terça às 8h não', 'Perfeito, deixei agendado terça (13/10) às 8h!'],
    ['R1.1a', OFF3_SIM, 'sim', 'Perfeito, deixei agendado terça, 13/10, às 8h!'],
  ])('(%s) regressões das rodadas anteriores continuam sem marcar: %p + %p', (_id, lastOutText, patientText, reply) => {
    expect(net({ reply, patientText, lastOutText }).kind).toBe('correct');
  });
});

describe('isStrictYes — "sim" puro, lista fechada', () => {
  it.each([
    'sim', 'S', 'ss', 'Simmm', 'pode marcar', 'pode agendar', 'tá bom', 'isso mesmo', 'uhum', 'aham', '👍', '✅',
    'Ok obrigada', 'sim senhora', 'Boa tarde, pode ser sim',
  ])('é: %p', (t) => expect(isStrictYes(t)).toBe(true));
  it.each([
    '', 'não', 'nao', 'sim?', 'pode ser?', 'obrigada', '😊', 'sim, mas de tarde', 'sim às 8', 'pode ser terça', 'quero',
    'quero sim', 'claro', 'certo', 'show', 'vlw', 'n', 'o primeiro', 'minha filha tá no 3º ano', 'sim nem precisa',
    'sim, sim, sim, pode, ok, beleza', 'pode ser, não tenho preferência', 'sim, pelo convênio', 'ok mas só depois das 10',
  ])('NÃO é: %p', (t) => expect(isStrictYes(t)).toBe(false));
});
