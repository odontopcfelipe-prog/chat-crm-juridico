import {
  NO_AUTOMATION_SIGNALS,
  chatTurnPrefix,
  classifyHistorySender,
  historyTextLabel,
  loadAutomationSignals,
  stripHistoryLabels,
  type AutomationSignals,
} from './history-sender';

const T0 = new Date('2026-10-12T13:00:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

describe('classifyHistorySender', () => {
  it('mensagem do paciente é do cliente (mesmo com id/skill estranhos)', () => {
    expect(classifyHistorySender({ direction: 'in', external_message_id: '3EB0ABC' })).toBe('client');
    expect(classifyHistorySender({ direction: 'in', external_message_id: 'sys_ai_1', skill_id: 'sk' })).toBe('client');
  });

  it('resposta da IA com id REAL da Evolution + skill_id é da própria IA (não operador)', () => {
    expect(classifyHistorySender({ direction: 'out', external_message_id: '3EB0C4F1A2B3', skill_id: 'skill-1' })).toBe('assistant');
  });

  it('skill_id vence o sinal de automação (IA respondeu logo depois de um broadcast)', () => {
    const signals: AutomationSignals = { externalIds: new Set(['3EB0X']), sentTimes: [T0.getTime()] };
    expect(
      classifyHistorySender({ direction: 'out', external_message_id: '3EB0X', skill_id: 'skill-1', created_at: T0 }, signals),
    ).toBe('assistant');
  });

  it('id sys_ai_* (ainda não reconciliado, triagem, chat de teste) é da IA', () => {
    expect(classifyHistorySender({ direction: 'out', external_message_id: 'sys_ai_1760000000000_0' })).toBe('assistant');
    expect(classifyHistorySender({ direction: 'out', external_message_id: 'sys_ai_np_1760000000000' })).toBe('assistant');
    expect(classifyHistorySender({ direction: 'out', external_message_id: 'sys_ai_test_3' })).toBe('assistant');
  });

  it('sys_* que não é da IA é disparo automático', () => {
    for (const ext of [
      'sys_followup_ia_1',
      'sys_followup_legacy_1',
      'sys_broadcast_1',
      'sys_reativacao_1',
      'sys_reminder_1',
      'sys_cobranca_1',
      'sys_payment_1',
    ]) {
      expect(classifyHistorySender({ direction: 'out', external_message_id: ext })).toBe('automation');
    }
  });

  it('id real gravado num DispatchLog/LeadDispatch é disparo automático', () => {
    const signals: AutomationSignals = { externalIds: new Set(['3EB0REGUA']), sentTimes: [] };
    expect(classifyHistorySender({ direction: 'out', external_message_id: '3EB0REGUA', created_at: T0 }, signals)).toBe('automation');
  });

  it('saiu junto (±3 min) com um envio automático → automação; fora da janela → operador', () => {
    const signals: AutomationSignals = { externalIds: new Set(), sentTimes: [T0.getTime()] };
    expect(classifyHistorySender({ direction: 'out', external_message_id: '3EB0A', created_at: at(2) }, signals)).toBe('automation');
    expect(classifyHistorySender({ direction: 'out', external_message_id: '3EB0B', created_at: at(-3) }, signals)).toBe('automation');
    expect(classifyHistorySender({ direction: 'out', external_message_id: '3EB0C', created_at: at(10) }, signals)).toBe('operator');
  });

  it('aceita created_at como string (linha crua)', () => {
    const signals: AutomationSignals = { externalIds: new Set(), sentTimes: [T0.getTime()] };
    expect(classifyHistorySender({ direction: 'out', external_message_id: '3EB0A', created_at: at(1).toISOString() }, signals)).toBe('automation');
  });

  it('humano: id real sem skill_id nem sinal de automação, ou otimista out_* do painel', () => {
    expect(classifyHistorySender({ direction: 'out', external_message_id: '3EB0HUMANO', skill_id: null, created_at: T0 })).toBe('operator');
    expect(classifyHistorySender({ direction: 'out', external_message_id: null })).toBe('operator');
    // out_* é o painel antes do eco: humano, mesmo colado num disparo automático.
    const signals: AutomationSignals = { externalIds: new Set(), sentTimes: [T0.getTime()] };
    expect(classifyHistorySender({ direction: 'out', external_message_id: 'out_text_1_ab', created_at: T0 }, signals)).toBe('operator');
  });

  it('sem sinais (padrão) o id real sem skill_id cai em operador (comportamento antigo)', () => {
    expect(classifyHistorySender({ direction: 'out', external_message_id: '3EB0', created_at: T0 }, NO_AUTOMATION_SIGNALS)).toBe('operator');
  });
});

describe('rótulos', () => {
  it('historyTextLabel', () => {
    expect(historyTextLabel('client', 'Sophia')).toBe('Cliente');
    expect(historyTextLabel('assistant', 'Sophia')).toBe('Sophia');
    expect(historyTextLabel('automation', 'Sophia')).toBe('Mensagem automática');
    expect(historyTextLabel('operator', 'Sophia')).toBe('Operador');
  });

  it('chatTurnPrefix: IA sem rótulo; operador e automação rotulados', () => {
    expect(chatTurnPrefix('assistant')).toBe('');
    expect(chatTurnPrefix('client')).toBe('');
    expect(chatTurnPrefix('operator')).toBe('[Operador Humano]: ');
    expect(chatTurnPrefix('automation')).toBe('[Mensagem automática da clínica]: ');
  });

  it('stripHistoryLabels tira rótulo copiado no começo de linha e preserva o resto', () => {
    expect(stripHistoryLabels('[Operador Humano]: Oi, tudo bem?')).toBe('Oi, tudo bem?');
    expect(stripHistoryLabels('Oi!\n[Mensagem automática da clínica]: Temos terça às 14h')).toBe('Oi!\nTemos terça às 14h');
    expect(stripHistoryLabels('Pode ser terça [Operador Humano]: ok')).toBe('Pode ser terça [Operador Humano]: ok');
    expect(stripHistoryLabels('Texto normal')).toBe('Texto normal');
  });
});

describe('loadAutomationSignals', () => {
  const mkPrisma = () => ({
    dispatchLog: { findMany: jest.fn().mockResolvedValue([]) },
    leadDispatch: { findMany: jest.fn().mockResolvedValue([]) },
    followupMessage: { findMany: jest.fn().mockResolvedValue([]) },
    broadcastItem: { findMany: jest.fn().mockResolvedValue([]) },
  });

  it('nada pra conferir (só IA/cliente/sys_/out_) = nenhuma consulta', async () => {
    const prisma = mkPrisma();
    const signals = await loadAutomationSignals(prisma as any, {
      tenantId: 't1',
      lead: { id: 'L1', phone: '5582999990000' },
      messages: [
        { direction: 'in', external_message_id: '3EB0IN', created_at: T0 },
        { direction: 'out', external_message_id: '3EB0IA', skill_id: 'sk', created_at: T0 },
        { direction: 'out', external_message_id: 'sys_broadcast_1', created_at: T0 },
        { direction: 'out', external_message_id: 'out_text_1', created_at: T0 },
      ],
    });
    expect(signals).toBe(NO_AUTOMATION_SIGNALS);
    expect(prisma.dispatchLog.findMany).not.toHaveBeenCalled();
    expect(prisma.leadDispatch.findMany).not.toHaveBeenCalled();
  });

  it('junta ids do DispatchLog + LeadDispatch e horários de FollowupMessage/BroadcastItem', async () => {
    const prisma = mkPrisma();
    prisma.dispatchLog.findMany.mockImplementation(async (args: any) =>
      args.where.external_message_id ? [{ external_message_id: '3EB0LEMBRETE' }] : [{ recipient_phone: '5582999990000', sent_at: at(-30) }],
    );
    prisma.leadDispatch.findMany.mockResolvedValue([{ external_message_ids: ['3EB0REGUA1', '3EB0REGUA2'] }]);
    prisma.followupMessage.findMany.mockResolvedValue([{ lead_id: 'L1', sent_at: at(-60) }]);
    prisma.broadcastItem.findMany.mockResolvedValue([{ lead_id: 'L1', sent_at: at(-120) }]);

    const messages = [
      { direction: 'out', external_message_id: '3EB0LEMBRETE', created_at: at(-200) },
      { direction: 'out', external_message_id: '3EB0REGUA1', created_at: at(-150) },
      { direction: 'out', external_message_id: '3EB0SEQ', created_at: at(-59) },
      { direction: 'out', external_message_id: '3EB0HUMANO', created_at: at(-10) },
      { direction: 'out', external_message_id: '3EB0IA', skill_id: 'sk', created_at: at(-5) },
    ];
    const signals = await loadAutomationSignals(prisma as any, {
      tenantId: 't1',
      lead: { id: 'L1', phone: '5582999990000' },
      messages,
    });

    // Só os ids sem classificação certa vão pra consulta (a da IA não).
    expect(prisma.dispatchLog.findMany.mock.calls[0][0].where.external_message_id.in).toEqual([
      '3EB0LEMBRETE',
      '3EB0REGUA1',
      '3EB0SEQ',
      '3EB0HUMANO',
    ]);
    expect([...signals.externalIds].sort()).toEqual(['3EB0LEMBRETE', '3EB0REGUA1', '3EB0REGUA2']);
    expect(signals.sentTimes).toEqual(expect.arrayContaining([at(-60).getTime(), at(-120).getTime(), at(-30).getTime()]));

    const sender = messages.map((m) => classifyHistorySender(m, signals));
    expect(sender).toEqual(['automation', 'automation', 'automation', 'operator', 'assistant']);
  });

  it('sem clínica: não consulta horários (DispatchLog por tenant), mas confere os ids', async () => {
    const prisma = mkPrisma();
    const signals = await loadAutomationSignals(prisma as any, {
      tenantId: null,
      lead: { id: 'L1', phone: null },
      messages: [{ direction: 'out', external_message_id: '3EB0', created_at: T0 }],
    });
    expect(prisma.dispatchLog.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.followupMessage.findMany).not.toHaveBeenCalled();
    expect(signals.sentTimes).toEqual([]);
  });

  it('erro de banco propaga (quem chama cai no rótulo antigo)', async () => {
    const prisma = mkPrisma();
    prisma.dispatchLog.findMany.mockRejectedValue(new Error('db down'));
    await expect(
      loadAutomationSignals(prisma as any, {
        tenantId: 't1',
        lead: { id: 'L1', phone: '5582999990000' },
        messages: [{ direction: 'out', external_message_id: '3EB0', created_at: T0 }],
      }),
    ).rejects.toThrow('db down');
  });
});
