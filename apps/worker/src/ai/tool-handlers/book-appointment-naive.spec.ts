import { BookAppointmentHandler } from './book-appointment';

// Agenda é naive-UTC (hora de Maceió gravada como UTC). "Agora" real fixo:
// 12/10/2026 12:00Z = 09:00 em Maceió.
const NOW = Date.UTC(2026, 9, 12, 12, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

function makePrisma(opts: { blockOnOverdue?: boolean } = {}) {
  const settings: Record<string, string> = { AI_AUTOBOOK_ENABLED_t1: 'true' };
  if (opts.blockOnOverdue) settings.BLOCK_SCHED_ON_OVERDUE_t1 = 'true';
  return {
    conversation: {
      findUnique: jest.fn().mockResolvedValue({ assigned_dentist_id: 'dent-1', assigned_user_id: null, tenant_id: 't1' }),
    },
    globalSetting: {
      findUnique: jest.fn(async ({ where }: any) => (settings[where.key] ? { value: settings[where.key] } : null)),
    },
    holiday: { findFirst: jest.fn().mockResolvedValue(null) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    scheduleBlock: { findFirst: jest.fn().mockResolvedValue(null) },
    userSchedule: {
      findMany: jest.fn().mockResolvedValue([
        { start_time: '08:00', end_time: '18:00', lunch_start: null, lunch_end: null, label: null, sort_order: 0 },
      ]),
    },
    patient: {
      findUnique: jest.fn(async ({ where }: any) =>
        opts.blockOnOverdue ? (where.lead_id ? { id: 'pat-1' } : { lead_id: null }) : null,
      ),
    },
    paymentGatewayCustomer: { findMany: jest.fn().mockResolvedValue([]) },
    paymentGatewayCharge: { count: jest.fn().mockResolvedValue(0) },
    calendarEvent: {
      findFirst: jest.fn().mockResolvedValue(null), // sem conflito, sem dedup
      create: jest.fn(async ({ data }: any) => ({
        id: 'ev-1',
        start_at: data.start_at,
        lead_id: data.lead_id,
        assigned_user_id: data.assigned_user_id,
        reminders: data.reminders.create.map((r: any, i: number) => ({ id: `r${i}`, ...r })),
        assigned_user: { id: 'dent-1', name: 'Dra. Teste', phone: null }, // sem telefone: não notifica
        lead: { id: 'lead-1', name: 'Paciente', phone: null },
      })),
    },
  };
}

function makeContext(prisma: any) {
  return {
    conversationId: 'conv-1',
    leadId: 'lead-1',
    leadPhone: '5582999990000',
    instanceName: null,
    prisma,
    reminderQueue: { add: jest.fn().mockResolvedValue(undefined) },
    skipPatientNotify: true,
  } as any;
}

describe('BookAppointmentHandler — "agora" de Maceió (agenda naive-UTC)', () => {
  beforeEach(() => {
    // Só o relógio é falso; timers/promises seguem reais.
    jest.useFakeTimers({
      now: NOW,
      doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'],
    });
  });
  afterEach(() => jest.useRealTimers());

  it('aceita horário de HOJE nas próximas 3h (antes era recusado como "já passou")', async () => {
    const prisma = makePrisma();
    const ctx = makeContext(prisma);
    const res = await new BookAppointmentHandler().execute({ date: '2026-10-12', time: '11:00' }, ctx);

    expect(res.success).toBe(true);
    expect(prisma.calendarEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.calendarEvent.create.mock.calls[0][0].data.start_at.toISOString()).toBe('2026-10-12T11:00:00.000Z');
  });

  it('recusa horário de hoje que já passou em Maceió', async () => {
    const prisma = makePrisma();
    const res = await new BookAppointmentHandler().execute({ date: '2026-10-12', time: '08:30' }, makeContext(prisma));

    expect(res).toEqual({ success: false, error: 'Data/hora já passou. Ofereça outro horário.' });
    expect(prisma.calendarEvent.create).not.toHaveBeenCalled();
  });

  it('recusa o minuto exato de agora (09:00 em Maceió)', async () => {
    const prisma = makePrisma();
    const res = await new BookAppointmentHandler().execute({ date: '2026-10-12', time: '09:00' }, makeContext(prisma));
    expect(res.success).toBe(false);
  });

  it('lembretes: delay = (naive + 3h) − antecedência − agora, igual à API', async () => {
    const prisma = makePrisma();
    const ctx = makeContext(prisma);
    // Amanhã 14:00 em Maceió = 13/10 17:00Z real → faltam 29h.
    await new BookAppointmentHandler().execute({ date: '2026-10-13', time: '14:00' }, ctx);

    const created = prisma.calendarEvent.create.mock.calls[0][0].data.reminders.create.map((r: any) => r.minutes_before);
    expect(created).toEqual([1440, 60, 15]);

    const delays = Object.fromEntries(
      ctx.reminderQueue.add.mock.calls.map((c: any[]) => [c[1].reminderId, c[2].delay]),
    );
    expect(delays).toEqual({ r0: 5 * HOUR, r1: 28 * HOUR, r2: 29 * HOUR - 15 * MIN });
    expect(ctx.reminderQueue.add.mock.calls.map((c: any[]) => c[2].jobId)).toEqual(['reminder-r0', 'reminder-r1', 'reminder-r2']);
  });

  it('lembretes: pula os de antecedência já vencida ou < 1 min (piso da API)', async () => {
    const prisma = makePrisma();
    const ctx = makeContext(prisma);
    // Hoje 10:00 em Maceió (falta 1h): 1d já venceu; 1h cai exatamente agora (< 1 min) → só o de 15 min.
    await new BookAppointmentHandler().execute({ date: '2026-10-12', time: '10:00' }, ctx);

    const created = prisma.calendarEvent.create.mock.calls[0][0].data.reminders.create.map((r: any) => r.minutes_before);
    expect(created).toEqual([15]);
    expect(ctx.reminderQueue.add).toHaveBeenCalledTimes(1);
    expect(ctx.reminderQueue.add.mock.calls[0][2].delay).toBe(45 * MIN);
  });

  it('bloqueio de devedor: boleto que vence HOJE não conta como atraso (mesma régua da API)', async () => {
    const prisma = makePrisma({ blockOnOverdue: true });
    await new BookAppointmentHandler().execute({ date: '2026-10-13', time: '14:00' }, makeContext(prisma));

    expect(prisma.paymentGatewayCharge.count).toHaveBeenCalledTimes(1);
    const where = prisma.paymentGatewayCharge.count.mock.calls[0][0].where;
    // Corte = meia-noite UTC do dia de hoje em Maceió (due_date é data à meia-noite UTC).
    expect(where.due_date.lt.toISOString()).toBe('2026-10-12T00:00:00.000Z');
  });
});
