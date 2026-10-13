import { Logger } from '@nestjs/common';
import { BookAppointmentHandler } from './book-appointment';

/** Instante REAL a partir da hora de Maceió (UTC-3). */
const maceio = (iso: string) => new Date(`${iso}-03:00`).getTime();

function fakePrisma() {
  const created: any[] = [];
  const prisma: any = {
    conversation: {
      findUnique: jest.fn(async () => ({ assigned_dentist_id: 'dentist-1', assigned_user_id: null, tenant_id: 't1' })),
    },
    globalSetting: {
      findUnique: jest.fn(async ({ where }: any) => (where.key === 'AI_AUTOBOOK_ENABLED_t1' ? { value: 'true' } : null)),
    },
    calendarEvent: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: any) => {
        const ev = {
          id: 'evt-new',
          ...data,
          reminders: (data.reminders?.create || []).map((r: any, i: number) => ({ id: `rem-${i}`, ...r })),
          assigned_user: { id: 'dentist-1', name: 'Dra. Teste', phone: null },
          lead: { id: 'lead-1', name: 'Ana', phone: null },
        };
        created.push(ev);
        return ev;
      }),
    },
    holiday: { findFirst: jest.fn(async () => null) },
    $queryRaw: jest.fn(async () => []),
    scheduleBlock: { findFirst: jest.fn(async () => null) },
    userSchedule: {
      findMany: jest.fn(async () => [{ start_time: '08:00', end_time: '12:00' }, { start_time: '13:00', end_time: '18:00' }]),
    },
    patient: { findUnique: jest.fn(async () => null) },
  };
  return { prisma, created };
}

describe('BookAppointmentHandler — fuso e remarcação', () => {
  let nowSpy: jest.SpyInstance;
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => nowSpy?.mockRestore());

  it('NÃO recusa como "já passou" um horário de hoje que ainda vai acontecer (antes recusava 3h antes)', async () => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(maceio('2026-10-13T06:30:00')); // 09:30Z real
    const { prisma } = fakePrisma();
    const res = await new BookAppointmentHandler().execute(
      { date: '2026-10-13', time: '08:00' },
      { prisma, conversationId: 'c1', leadId: 'lead-1', skipPatientNotify: true } as any,
    );
    expect(res.success).toBe(true);
  });

  it('recusa como "já passou" um horário que já passou em Maceió', async () => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(maceio('2026-10-13T09:10:00'));
    const { prisma } = fakePrisma();
    const res = await new BookAppointmentHandler().execute(
      { date: '2026-10-13', time: '09:00' },
      { prisma, conversationId: 'c1', leadId: 'lead-1', skipPatientNotify: true } as any,
    );
    expect(res).toEqual({ success: false, error: 'Data/hora já passou. Ofereça outro horário.' });
  });

  it('lembretes: cria e enfileira no instante REAL (naive + 3h), igual à API', async () => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(maceio('2026-10-12T15:00:00')); // seg 15h
    const { prisma, created } = fakePrisma();
    const queue = { add: jest.fn(async () => undefined) };
    const res = await new BookAppointmentHandler().execute(
      { date: '2026-10-13', time: '09:00' }, // ter 9h = 18h depois
      { prisma, conversationId: 'c1', leadId: 'lead-1', reminderQueue: queue, skipPatientNotify: true } as any,
    );
    expect(res.success).toBe(true);
    // 1 dia antes (seg 9h) já passou → só 1h e 15min antes.
    expect(created[0].reminders.map((r: any) => r.minutes_before)).toEqual([60, 15]);
    const delays = queue.add.mock.calls.map((c: any[]) => c[2].delay);
    expect(delays).toEqual([17 * 3_600_000, 17.75 * 3_600_000]);
  });

  it('remarcação: consultas antigas da conversa (ignoreEventIds) ficam fora do conflito e do dedup', async () => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(maceio('2026-10-12T15:00:00'));
    const { prisma } = fakePrisma();
    await new BookAppointmentHandler().execute(
      { date: '2026-10-13', time: '09:30' },
      { prisma, conversationId: 'c1', leadId: 'lead-1', skipPatientNotify: true, ignoreEventIds: ['old-1'] } as any,
    );
    const wheres = prisma.calendarEvent.findFirst.mock.calls.map((c: any[]) => c[0].where);
    expect(wheres.length).toBe(2); // conflito + dedup
    for (const w of wheres) expect(w.id).toEqual({ notIn: ['old-1'] });
  });

  it('sem ignoreEventIds a checagem de conflito não filtra id (comportamento antigo)', async () => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(maceio('2026-10-12T15:00:00'));
    const { prisma } = fakePrisma();
    await new BookAppointmentHandler().execute(
      { date: '2026-10-13', time: '09:30' },
      { prisma, conversationId: 'c1', leadId: 'lead-1', skipPatientNotify: true } as any,
    );
    expect(prisma.calendarEvent.findFirst.mock.calls[0][0].where.id).toBeUndefined();
  });
});
