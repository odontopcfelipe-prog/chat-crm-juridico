import * as fs from 'fs';
import * as path from 'path';
import { AiProcessor } from './ai.processor';
import {
  MACEIO_OFFSET_MS,
  REMINDER_MIN_DELAY_MS,
  isPastNaive,
  maceioNowNaive,
  maceioTodayStr,
  reminderDelayMs,
} from './scheduling-safety';

// Agenda é naive-UTC (hora de Maceió gravada como UTC). "Agora" real fixo:
// 12/10/2026 12:00Z = 09:00 em Maceió.
const NOW = Date.UTC(2026, 9, 12, 12, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const naive = (iso: string) => new Date(`${iso}Z`);

describe('scheduling-safety — "agora" de Maceió', () => {
  it('maceioNowNaive = agora real − 3h', () => {
    expect(MACEIO_OFFSET_MS).toBe(3 * HOUR);
    expect(maceioNowNaive(NOW).toISOString()).toBe('2026-10-12T09:00:00.000Z');
  });

  it('maceioTodayStr: às 22h em Maceió o UTC já virou o dia, mas "hoje" continua o dia local', () => {
    const lateNight = Date.UTC(2026, 9, 13, 1, 0); // 13/10 01:00Z = 12/10 22:00 em Maceió
    expect(maceioTodayStr(lateNight)).toBe('2026-10-12');
    expect(maceioTodayStr(NOW)).toBe('2026-10-12');
  });

  it('isPastNaive compara no referencial da agenda (consulta das próximas 3h é FUTURA)', () => {
    expect(isPastNaive(naive('2026-10-12T11:00:00'), NOW)).toBe(false); // < agora real, mas futura em Maceió
    expect(isPastNaive(naive('2026-10-12T09:01:00'), NOW)).toBe(false);
    expect(isPastNaive(naive('2026-10-12T09:00:00'), NOW)).toBe(true); // o próprio minuto já conta como passado
    expect(isPastNaive(naive('2026-10-12T08:30:00'), NOW)).toBe(true);
  });

  it('reminderDelayMs = a mesma conta da API (calendar.service.enqueueReminders)', () => {
    const start = naive('2026-10-13T14:00:00'); // 13/10 17:00Z real
    const api = (startAt: Date, minutesBefore: number) =>
      startAt.getTime() + 3 * 60 * 60 * 1000 - minutesBefore * 60 * 1000 - NOW;
    for (const m of [1440, 60, 15]) expect(reminderDelayMs(start, m, NOW)).toBe(api(start, m));
    expect(reminderDelayMs(start, 1440, NOW)).toBe(5 * HOUR);
    expect(REMINDER_MIN_DELAY_MS).toBe(60_000);
  });
});

describe('AiProcessor.createCalendarEvent — lembretes no fuso da agenda', () => {
  beforeEach(() => {
    jest.useFakeTimers({
      now: NOW,
      doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'],
    });
  });
  afterEach(() => jest.useRealTimers());

  function makeProcessor() {
    const reminderQueue = { add: jest.fn().mockResolvedValue(undefined) };
    const prisma = {
      calendarEvent: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(async ({ data }: any) => ({
          id: 'ev-1',
          start_at: data.start_at,
          reminders: data.reminders.create.map((r: any, i: number) => ({ id: `r${i}`, ...r })),
        })),
      },
    };
    // Sem o construtor (DI do Nest): só o que o método usa.
    const proc: any = Object.create(AiProcessor.prototype);
    proc.prisma = prisma;
    proc.reminderQueue = reminderQueue;
    proc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    return { proc, prisma, reminderQueue };
  }

  it('TAREFA de amanhã no mesmo horário: lembrete de 1h sai 23h depois; o de 1d (= agora) é pulado', async () => {
    const { proc, reminderQueue } = makeProcessor();
    await proc.createCalendarEvent({
      type: 'TAREFA',
      title: 'Cobrar documentos do lead — Fulano',
      start_at: new Date(maceioNowNaive().getTime() + 24 * HOUR), // como o stage-move cria
      assigned_user_id: 'dent-1',
      lead_id: 'lead-1',
      conversation_id: 'conv-1',
      created_by_id: 'dent-1',
    });

    expect(reminderQueue.add).toHaveBeenCalledTimes(1);
    const [name, payload, opts] = reminderQueue.add.mock.calls[0];
    expect(name).toBe('send-reminder');
    expect(payload).toEqual({ reminderId: 'r0', eventId: 'ev-1', channel: 'WHATSAPP' }); // minutes_before 60
    expect(opts).toMatchObject({ delay: 23 * HOUR, jobId: 'reminder-r0', attempts: 1 });
  });

  it('evento de HOJE daqui a 2h (Maceió): o de 1h sai em 1h (antes era descartado como passado)', async () => {
    const { proc, reminderQueue } = makeProcessor();
    await proc.createCalendarEvent({
      type: 'TAREFA',
      title: 'Tarefa',
      start_at: naive('2026-10-12T11:00:00'),
      assigned_user_id: 'dent-1',
      lead_id: 'lead-1',
      created_by_id: 'dent-1',
    });

    expect(reminderQueue.add).toHaveBeenCalledTimes(1);
    expect(reminderQueue.add.mock.calls[0][2].delay).toBe(1 * HOUR);
  });
});

describe('guarda: código da IA não compara a agenda com o UTC real', () => {
  function tsFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return tsFiles(p);
      return e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') ? [p] : [];
    });
  }

  it('nenhum start_at filtrado/criado com new Date() ou Date.now() crus em src/ai/**', () => {
    const offenders: string[] = [];
    const bad = [
      /start_at:\s*\{[^}]*\b(?:gte?|lte?):\s*new Date\(\s*\)/, // start_at: { gte: new Date() }
      /start_at:\s*new Date\(\s*Date\.now\(\)/, // start_at: new Date(Date.now() + …)
    ];
    for (const file of tsFiles(__dirname)) {
      fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (bad.some((re) => re.test(line))) offenders.push(`${path.relative(__dirname, file)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
