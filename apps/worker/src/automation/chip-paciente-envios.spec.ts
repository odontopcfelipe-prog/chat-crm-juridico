jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
import axios from 'axios';
import { AppointmentConfirmationDispatcherService } from './appointment-confirmation-dispatcher.service';
import { AppointmentConfirmationSchedulerService } from './appointment-confirmation-scheduler.service';
import { AppointmentOrtoReminderService } from './appointment-orto-reminder.service';
import { PostCareCronService } from '../post-care/post-care-cron.service';
import { MaintenanceRecallCronService } from '../maintenance/maintenance-recall-cron.service';

/**
 * BLINDAGEM — disparos de PACIENTE do worker escolhem o chip pela FUNÇÃO, dentro
 * da clínica (out/2026): CLINICA → COMERCIAL, NUNCA o FINANCEIRO, nunca a linha
 * órfã ('Comercial'/'whatsapp', purpose NULL, que vinham antes de 't00000000-*'
 * por nome), nunca o chip do env (de outra clínica). Falha não vira "enviado".
 */
const TENANT = '00000000-0000-0000-0000-000000000000';
const CHIPS_POR_NOME = [
  { name: 'Comercial', purpose: null },
  { name: 't00000000-1', purpose: 'COMERCIAL' },
  { name: 't00000000-2', purpose: 'CLINICA' },
  { name: 't00000000-3', purpose: 'FINANCEIRO' },
  { name: 'whatsapp', purpose: null },
];
const SO_FINANCEIRO = [{ name: 't00000000-3', purpose: 'FINANCEIRO' }];

const post = (axios as any).post as jest.Mock;
const settings: any = { getEvolutionConfig: jest.fn().mockResolvedValue({ apiUrl: 'https://evo', apiKey: 'k' }) };

function instanceMock(chips: any[]) {
  return {
    findMany: jest.fn().mockImplementation(({ where }: any) =>
      Promise.resolve(where?.tenant_id === TENANT ? chips : [])),
    findFirst: jest.fn().mockRejectedValue(new Error('instance.findFirst não deveria ser chamado')),
  };
}

beforeEach(() => post.mockReset());

describe('Confirmação de agendamento (dispatcher)', () => {
  beforeAll(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-10-14T13:00:00Z')); // 10h em Maceió (horário comercial)
  });
  afterAll(() => jest.useRealTimers());

  function build(chips: any[]) {
    const update = jest.fn().mockResolvedValue({});
    const prisma: any = {
      appointmentConfirmation: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'c1',
          message_text: 'Confirma amanhã?',
          appointment: { id: 'a1', tenant_id: TENANT, type: 'CONSULTA', start_at: new Date(), patient: { id: 'p1', name: 'Maria', phone: '82988887777' } },
        }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update,
      },
      globalSetting: { findUnique: jest.fn().mockResolvedValue(null) },
      instance: instanceMock(chips),
    };
    return { svc: new AppointmentConfirmationDispatcherService(prisma, settings), update, prisma };
  }

  it('sai pelo CLINICA da clínica', async () => {
    post.mockResolvedValue({ data: { key: { id: 'wamid' } } });
    const { svc, update, prisma } = build(CHIPS_POR_NOME);
    await svc.dispatchPending();
    expect(post.mock.calls[0][0]).toBe('https://evo/message/sendText/t00000000-2');
    expect(prisma.instance.findMany.mock.calls[0][0].where).toEqual({ tenant_id: TENANT, type: 'whatsapp' });
    expect(update.mock.calls.at(-1)[0].data.delivery_status).toBe('SENT');
  });

  it('só FINANCEIRO: NÃO sai por ele (antes era o "último recurso") e grava FAILED', async () => {
    const { svc, update } = build(SO_FINANCEIRO);
    await svc.dispatchPending();
    expect(post).not.toHaveBeenCalled();
    expect(update.mock.calls.at(-1)[0].data.delivery_status).toBe('FAILED');
  });

  it('2xx com exists:false → FAILED, não SENT', async () => {
    post.mockResolvedValue({ data: { response: { message: [{ exists: false }] } } });
    const { svc, update } = build(CHIPS_POR_NOME);
    await svc.dispatchPending();
    expect(update.mock.calls.at(-1)[0].data.delivery_status).toBe('FAILED');
  });
});

describe('Scheduler da confirmação de 24h × lembrete de 48h', () => {
  // Emula o banco: o findFirst só acha o lembrete de 48h se ele casar com o where.
  function build(lembrete48h: { sent_at: Date | null; last_error: string | null }) {
    const create = jest.fn().mockResolvedValue({});
    const tx: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      appointmentConfirmation: { findFirst: jest.fn().mockResolvedValue(null), create },
    };
    const prisma: any = {
      calendarEvent: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'ev1', tenant_id: TENANT, type: 'CONSULTA', title: 'Avaliação', start_at: new Date('2026-10-15T14:00:00Z'),
          location: null, assigned_user: { name: 'Dra. X' }, patient: { id: 'p1', name: 'Maria', phone: '82988887777', lead: null },
        }]),
      },
      globalSetting: { findUnique: jest.fn().mockResolvedValue(null) },
      tenant: { findUnique: jest.fn().mockResolvedValue(null) },
      eventReminder: {
        findFirst: jest.fn().mockImplementation(({ where }: any) => {
          const casa =
            (!('sent_at' in where) || where.sent_at === lembrete48h.sent_at) &&
            (!('last_error' in where) || where.last_error === lembrete48h.last_error);
          return Promise.resolve(casa ? { id: 'r48' } : null);
        }),
      },
      appointmentConfirmation: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn().mockImplementation((fn: any) => fn(tx)),
    };
    return { svc: new AppointmentConfirmationSchedulerService(prisma), create };
  }

  it('48h ainda pendente (sem erro) → NÃO cria a de 24h (não duplica)', async () => {
    const { svc, create } = build({ sent_at: null, last_error: null });
    await svc.scheduleConfirmations();
    expect(create).not.toHaveBeenCalled();
  });

  it('48h que FALHOU (sent_at null + last_error) → a confirmação de 24h sai (rede de segurança)', async () => {
    const { svc, create } = build({ sent_at: null, last_error: 'Evolution recusou o envio (chip t00000000-2): 404' });
    await svc.scheduleConfirmations();
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('Lembrete de ortodontia', () => {
  function build(chips: any[]) {
    const dispatchCreate = jest.fn().mockResolvedValue({});
    const prisma: any = {
      calendarEvent: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'ev1', tenant_id: TENANT, start_at: new Date('2026-10-14T15:00:00Z'), location: null,
          assigned_user: { name: 'Dra. X' }, patient: { id: 'p1', name: 'Maria Silva', phone: '82988887777' },
        }]),
      },
      globalSetting: { findUnique: jest.fn().mockResolvedValue({ value: 'true' }) },
      dispatchLog: { findFirst: jest.fn().mockResolvedValue(null), create: dispatchCreate },
      tenant: { findUnique: jest.fn().mockResolvedValue(null) },
      instance: instanceMock(chips),
    };
    return { svc: new AppointmentOrtoReminderService(prisma, settings), dispatchCreate };
  }

  it('sai pelo CLINICA (antes: CLINICA → qualquer instance, inclusive o FINANCEIRO)', async () => {
    post.mockResolvedValue({ data: { key: { id: 'wamid' } } });
    const { svc, dispatchCreate } = build(CHIPS_POR_NOME);
    await svc.sendOrtoReminders();
    expect(post.mock.calls[0][0]).toBe('https://evo/message/sendText/t00000000-2');
    expect(dispatchCreate.mock.calls[0][0].data.status).toBe('SENT');
  });

  it('só FINANCEIRO: não envia', async () => {
    const { svc } = build(SO_FINANCEIRO);
    await svc.sendOrtoReminders();
    expect(post).not.toHaveBeenCalled();
  });
});

describe('Pesquisa pós-atendimento', () => {
  function build(chips: any[]) {
    const prisma: any = { instance: instanceMock(chips) };
    return new PostCareCronService(prisma, settings);
  }

  it('sai pelo CLINICA — não pela órfã "Comercial" (1ª por nome)', async () => {
    post.mockResolvedValue({ data: { key: { id: 'wamid' } } });
    const id = await (build(CHIPS_POR_NOME) as any).sendWhatsApp(TENANT, '82988887777', 'oi');
    expect(id).toBe('wamid');
    expect(post.mock.calls[0][0]).toBe('https://evo/message/sendText/t00000000-2');
  });

  it('só FINANCEIRO / sem clínica / exists:false → erro (vira FAILED na pesquisa)', async () => {
    await expect((build(SO_FINANCEIRO) as any).sendWhatsApp(TENANT, '82988887777', 'oi')).rejects.toThrow(/Financeiro/);
    await expect((build(CHIPS_POR_NOME) as any).sendWhatsApp(null, '82988887777', 'oi')).rejects.toThrow(/sem clínica/);
    expect(post).not.toHaveBeenCalled();
    post.mockResolvedValue({ data: { response: { message: [{ exists: false }] } } });
    await expect((build(CHIPS_POR_NOME) as any).sendWhatsApp(TENANT, '82988887777', 'oi')).rejects.toThrow(/sem WhatsApp/);
  });
});

describe('Recall de manutenção', () => {
  function build(chips: any[], legado: string | null = null) {
    const prisma: any = {
      instance: instanceMock(chips),
      tenantSetting: { findUnique: jest.fn().mockResolvedValue(legado ? { value: legado } : null) },
    };
    return new MaintenanceRecallCronService(prisma, settings) as any;
  }

  it('CLINICA; só FINANCEIRO → null; sem chip → só o override DA clínica, nunca o env', async () => {
    const envAntes = process.env.EVOLUTION_INSTANCE_NAME;
    process.env.EVOLUTION_INSTANCE_NAME = 'chip-do-env-de-outra-clinica';
    try {
      expect(await build(CHIPS_POR_NOME).resolveClinicaInstance(TENANT)).toBe('t00000000-2');
      expect(await build(SO_FINANCEIRO).resolveClinicaInstance(TENANT)).toBeNull();
      expect(await build([], 'legado-da-clinica').resolveClinicaInstance(TENANT)).toBe('legado-da-clinica');
      expect(await build([]).resolveClinicaInstance(TENANT)).toBeNull();
      expect(await build(CHIPS_POR_NOME).resolveClinicaInstance(undefined)).toBeNull();
      // sendWhatsApp sem chip = falha, sem chamar a Evolution.
      expect(await build(SO_FINANCEIRO).sendWhatsApp('82988887777', 'oi', TENANT)).toBe(false);
      expect(post).not.toHaveBeenCalled();
    } finally {
      if (envAntes === undefined) delete process.env.EVOLUTION_INSTANCE_NAME;
      else process.env.EVOLUTION_INSTANCE_NAME = envAntes;
    }
  });
});
