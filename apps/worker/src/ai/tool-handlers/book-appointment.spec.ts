import { Logger } from '@nestjs/common';
import {
  BookAppointmentHandler,
  aiBookingDescription,
  aiBookingTitle,
  findEvaluationAppointmentTypeId,
} from './book-appointment';

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
    appointmentType: { findFirst: jest.fn(async () => null) },
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

describe('BookAppointmentHandler — título/descrição da consulta marcada pela IA', () => {
  let nowSpy: jest.SpyInstance;
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(maceio('2026-10-12T15:00:00'));
  });
  afterEach(() => nowSpy.mockRestore());

  it('lead sem ficha: título "Avaliação" (sem nome do paciente) + descrição com a assistente e "paciente novo"', async () => {
    const { prisma, created } = fakePrisma();
    const res = await new BookAppointmentHandler().execute(
      { date: '2026-10-13', time: '11:00', title: 'Avaliação' },
      { prisma, conversationId: 'c1', leadId: 'lead-1', skipPatientNotify: true, assistantName: 'Sophia' } as any,
    );
    expect(res.success).toBe(true);
    expect(created[0].title).toBe('Avaliação');
    expect(created[0].description).toBe('Avaliação agendada pela IA (Sophia) pelo WhatsApp — paciente novo');
    expect(created[0].created_by_ai).toBe(true);
    expect(created[0].patient_id).toBeUndefined();
    // Clínica sem tipo "Avaliação" cadastrado → appointment_type_id fica de fora.
    expect(created[0].appointment_type_id).toBeUndefined();
    expect(prisma.appointmentType.findFirst.mock.calls[0][0].where).toEqual({
      tenant_id: 't1',
      active: true,
      name: { contains: 'avalia', mode: 'insensitive' },
    });
  });

  it('sem título (chamada direta da ferramenta) cai em "Avaliação"; paciente com ficha NÃO é "novo"', async () => {
    const { prisma, created } = fakePrisma();
    prisma.patient.findUnique = jest.fn(async () => ({ id: 'pat-1' }));
    await new BookAppointmentHandler().execute(
      { date: '2026-10-13', time: '11:00' },
      { prisma, conversationId: 'c1', leadId: 'lead-1', skipPatientNotify: true } as any,
    );
    expect(created[0].title).toBe('Avaliação');
    expect(created[0].patient_id).toBe('pat-1');
    expect(created[0].description).toBe('Avaliação agendada pela IA pelo WhatsApp');
  });

  it('lead que já é cliente (is_client) sem ficha: NÃO marca "paciente novo"', async () => {
    const { prisma, created } = fakePrisma();
    prisma.lead = { findUnique: jest.fn(async () => ({ is_client: true })) };
    await new BookAppointmentHandler().execute(
      { date: '2026-10-13', time: '11:00', title: 'Avaliação' },
      { prisma, conversationId: 'c1', leadId: 'lead-1', skipPatientNotify: true, assistantName: 'Sophia' } as any,
    );
    expect(created[0].description).toBe('Avaliação agendada pela IA (Sophia) pelo WhatsApp');
  });

  it('clínica com tipo "Avaliação" ativo: o evento já sai com appointment_type_id', async () => {
    const { prisma, created } = fakePrisma();
    prisma.appointmentType.findFirst = jest.fn(async () => ({ id: 'at-aval' }));
    await new BookAppointmentHandler().execute(
      { date: '2026-10-13', time: '11:00', title: 'Avaliação' },
      { prisma, conversationId: 'c1', leadId: 'lead-1', skipPatientNotify: true } as any,
    );
    expect(created[0].appointment_type_id).toBe('at-aval');
  });

  it('outro procedimento pedido pela IA: mantém o título e não procura tipo "Avaliação"', async () => {
    const { prisma, created } = fakePrisma();
    await new BookAppointmentHandler().execute(
      { date: '2026-10-13', time: '11:00', title: 'Profilaxia', description: 'Prefere à tarde' },
      { prisma, conversationId: 'c1', leadId: 'lead-1', skipPatientNotify: true, assistantName: 'Sophia' } as any,
    );
    expect(created[0].title).toBe('Profilaxia');
    expect(created[0].description).toBe('Agendado pela IA (Sophia) pelo WhatsApp — paciente novo\nPrefere à tarde');
    expect(prisma.appointmentType.findFirst).not.toHaveBeenCalled();
  });
});

describe('helpers do agendamento pela IA', () => {
  it('aiBookingTitle: vazio/"Consulta…"/"Avaliação…" → "Avaliação"; tira " — Fulano"', () => {
    expect(aiBookingTitle(undefined)).toBe('Avaliação');
    expect(aiBookingTitle('   ')).toBe('Avaliação');
    expect(aiBookingTitle('  Consulta   de  avaliação ')).toBe('Avaliação');
    expect(aiBookingTitle('Consulta — Felipe Passos')).toBe('Avaliação');
    expect(aiBookingTitle('Avaliação - Felipe')).toBe('Avaliação');
    expect(aiBookingTitle('Profilaxia — Ana')).toBe('Profilaxia');
    expect(aiBookingTitle('Clareamento')).toBe('Clareamento');
  });

  it('aiBookingDescription: sem nome da assistente não deixa "()" vazio', () => {
    expect(aiBookingDescription({ title: 'Avaliação', assistantName: '  ', isNewPatient: false })).toBe(
      'Avaliação agendada pela IA pelo WhatsApp',
    );
    expect(aiBookingDescription({ title: 'Consulta de avaliação', assistantName: 'Sophia', isNewPatient: true })).toBe(
      'Consulta de avaliação agendada pela IA (Sophia) pelo WhatsApp — paciente novo',
    );
  });

  it('findEvaluationAppointmentTypeId: sem tenant não consulta (nunca mistura clínica); erro → null', async () => {
    const prisma: any = { appointmentType: { findFirst: jest.fn(async () => ({ id: 'x' })) } };
    expect(await findEvaluationAppointmentTypeId(prisma, null)).toBeNull();
    expect(prisma.appointmentType.findFirst).not.toHaveBeenCalled();
    prisma.appointmentType.findFirst = jest.fn(async () => {
      throw new Error('db fora');
    });
    expect(await findEvaluationAppointmentTypeId(prisma, 't1')).toBeNull();
  });
});
