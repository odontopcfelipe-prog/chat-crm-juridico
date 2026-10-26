/**
 * Resumo diário do dentista: é POR CLÍNICA (DENTIST_DAILY_SUMMARY_<conta>).
 *
 *  - o cron ignora a chave sem conta (legado) e sufixo vazio/'undefined'/'null'
 *    — nunca dispara para os dentistas de todas as contas (WhatsApp nem PUSH);
 *  - "Enviar agora" e salvar exigem conta; sem conta, 400 e nada sai/grava;
 *  - para quem tem a chave da conta nada muda: mesmos dentistas (os da conta),
 *    mesmo chip, mesmo texto, mesma janela do dia.
 */
import { BadRequestException, Logger } from '@nestjs/common';
import { DEFAULT_DENTIST_DAILY_SUMMARY } from '@crm/shared';
import { CalendarService } from '../calendar/calendar.service';
import { CalendarCronService, contaDaChaveResumoDentista } from '../calendar/calendar-cron.service';

const A = 'conta-a';
const B = 'conta-b';
// 10:00 em Maceió (13:00 UTC).
const AGORA = new Date('2026-10-21T13:00:00.000Z');
const DIA = new Date('2026-10-21T00:00:00.000Z');

let avisos: string[] = [];
beforeAll(() => {
  for (const m of ['log', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  }
  jest.spyOn(Logger.prototype, 'warn').mockImplementation((msg: any) => {
    avisos.push(String(msg));
  });
});
beforeEach(() => {
  avisos = [];
  jest.useFakeTimers({ now: AGORA, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
});
afterEach(() => jest.useRealTimers());

const DENTISTAS = [
  { id: 'd-a', name: 'Ana Lima', phone: '(82) 98888-7777', disparos_off: [], tenant_id: A },
  { id: 'd-b', name: 'Bruno Reis', phone: '82977776666', disparos_off: [], tenant_id: B },
];

function montarServico(settings: Record<string, any>) {
  const store = new Map<string, string>(Object.entries(settings).map(([k, v]) => [k, JSON.stringify(v)]));
  const prisma: any = {
    globalSetting: {
      findUnique: jest.fn(async ({ where }: any) => (store.has(where.key) ? { value: store.get(where.key) } : null)),
      upsert: jest.fn(async ({ where, create }: any) => store.set(where.key, create.value)),
    },
    user: {
      findMany: jest.fn(async ({ where }: any) => DENTISTAS.filter((u) => !where.tenant_id || u.tenant_id === where.tenant_id)),
    },
    calendarEvent: {
      findMany: jest.fn(async ({ where }: any) =>
        where.assigned_user_id === 'd-a'
          ? [
              { start_at: new Date('2026-10-21T09:00:00Z'), type: 'CONSULTA', patient: { name: 'Maria Souza' }, lead: null },
              { start_at: new Date('2026-10-21T14:30:00Z'), type: 'ORTODONTIA', patient: null, lead: { name: 'João Lead' } },
            ]
          : [{ start_at: new Date('2026-10-21T11:00:00Z'), type: 'RETORNO', patient: { name: 'Carla' }, lead: null }],
      ),
    },
  };
  const chatGateway: any = { emitCalendarReminder: jest.fn() };
  const whatsapp: any = { sendText: jest.fn(async () => ({ ok: true })) };
  const svc: any = new CalendarService(prisma, chatGateway, {} as any, {} as any, whatsapp, {} as any, {} as any);
  svc.resolveTenantWhatsappInstance = jest.fn(async (t: string) => `chip-clinica-${t}`);
  svc.logDispatch = jest.fn(async () => undefined);
  return { svc, prisma, chatGateway, whatsapp, store };
}

function montarCron(linhas: Array<{ key: string; value: any }>) {
  const prisma: any = {
    globalSetting: {
      findMany: jest.fn(async () => linhas.map((l) => ({ key: l.key, value: JSON.stringify(l.value) }))),
    },
  };
  const calendar: any = { sendDentistDailySummaryNow: jest.fn(async () => ({ total: 0, results: [] })) };
  return { cron: new CalendarCronService(prisma, {} as any, calendar), calendar };
}

const LIGADO_AGORA = { enabled: true, send_at: '10:00', channel: 'WHATSAPP' };
const erro400 = async (p: Promise<any>) => expect(await p.catch((e) => e)).toBeInstanceOf(BadRequestException);

describe('Resumo diário do dentista — só por clínica', () => {
  describe('nenhuma clínica alcança os dentistas de outra', () => {
    it('cron: a chave sem conta e os sufixos inválidos são ignorados (com aviso); a da conta dispara', async () => {
      const { cron, calendar } = montarCron([
        { key: 'DENTIST_DAILY_SUMMARY', value: LIGADO_AGORA },
        { key: `DENTIST_DAILY_SUMMARY_${A}`, value: LIGADO_AGORA },
        { key: `DENTIST_DAILY_SUMMARY_${B}`, value: { ...LIGADO_AGORA, enabled: false } },
        { key: 'DENTIST_DAILY_SUMMARY_undefined', value: LIGADO_AGORA },
        { key: 'DENTIST_DAILY_SUMMARY_null', value: LIGADO_AGORA },
        { key: 'DENTIST_DAILY_SUMMARY_', value: LIGADO_AGORA },
      ]);
      await cron.checkDentistDailySummary();
      expect(calendar.sendDentistDailySummaryNow.mock.calls).toEqual([[A]]);
      expect(avisos.filter((m) => /sem conta ignorada/.test(m))).toHaveLength(4);
    });

    it('cron: só a chave global ligada (WhatsApp ou PUSH): ninguém recebe', async () => {
      for (const channel of ['WHATSAPP', 'PUSH']) {
        const { cron, calendar } = montarCron([{ key: 'DENTIST_DAILY_SUMMARY', value: { ...LIGADO_AGORA, channel } }]);
        await cron.checkDentistDailySummary();
        expect(calendar.sendDentistDailySummaryNow).not.toHaveBeenCalled();
      }
    });

    it('contaDaChaveResumoDentista', () => {
      expect(contaDaChaveResumoDentista(`DENTIST_DAILY_SUMMARY_${A}`)).toBe(A);
      for (const k of ['DENTIST_DAILY_SUMMARY', 'DENTIST_DAILY_SUMMARY_', 'DENTIST_DAILY_SUMMARY_undefined', 'DENTIST_DAILY_SUMMARY_null', 'OUTRA_COISA']) {
        expect(contaDaChaveResumoDentista(k)).toBeNull();
      }
    });

    it.each([undefined, null, ''])('Enviar agora sem conta (%p): 400; nenhum dentista, envio, push ou registro', async (t) => {
      for (const channel of ['WHATSAPP', 'PUSH']) {
        const { svc, prisma, chatGateway, whatsapp } = montarServico({ DENTIST_DAILY_SUMMARY: { ...LIGADO_AGORA, channel } });
        await erro400(svc.sendDentistDailySummaryNow(t as any));
        expect(prisma.user.findMany).not.toHaveBeenCalled();
        expect(whatsapp.sendText).not.toHaveBeenCalled();
        expect(chatGateway.emitCalendarReminder).not.toHaveBeenCalled();
        expect(svc.logDispatch).not.toHaveBeenCalled();
      }
    });

    it('salvar sem conta: 400 e a chave global não é criada nem alterada', async () => {
      const { svc, prisma } = montarServico({});
      await erro400(svc.setDentistDailySummaryConfig(undefined, { enabled: true }));
      expect(prisma.globalSetting.upsert).not.toHaveBeenCalled();
    });

    it('ler sem conta: o padrão, sem ler a chave global', async () => {
      const { svc, prisma } = montarServico({ DENTIST_DAILY_SUMMARY: { ...LIGADO_AGORA, template: 'global' } });
      expect(await svc.getDentistDailySummaryConfig(undefined)).toEqual(DEFAULT_DENTIST_DAILY_SUMMARY);
      expect(prisma.globalSetting.findUnique).not.toHaveBeenCalled();
    });

    it('PUSH da conta A: só os dentistas da A (o filtro de conta está sempre presente)', async () => {
      const { svc, prisma, chatGateway } = montarServico({ [`DENTIST_DAILY_SUMMARY_${A}`]: { ...LIGADO_AGORA, channel: 'PUSH' } });
      const r = await svc.sendDentistDailySummaryNow(A);
      expect(prisma.user.findMany.mock.calls[0][0].where.tenant_id).toBe(A);
      expect(chatGateway.emitCalendarReminder.mock.calls.map((c: any[]) => c[0])).toEqual(['d-a']);
      expect(r.results.map((x: any) => x.user_id)).toEqual(['d-a']);
    });
  });

  describe('para a clínica com a chave dela, nada muda', () => {
    it('Enviar agora (WhatsApp) da A: dentistas da A, chip da A, o mesmo texto de hoje e registro na A', async () => {
      const { svc, prisma, whatsapp } = montarServico({ [`DENTIST_DAILY_SUMMARY_${A}`]: LIGADO_AGORA });
      const r = await svc.sendDentistDailySummaryNow(A);
      expect(r).toEqual({ total: 1, results: [{ user_id: 'd-a', name: 'Ana Lima', sent: true }] });
      expect(svc.resolveTenantWhatsappInstance).toHaveBeenCalledWith(A, 'CLINICA');
      const janela = prisma.calendarEvent.findMany.mock.calls[0][0].where.start_at;
      expect(janela).toEqual({ gte: DIA, lt: new Date(DIA.getTime() + 86400000) });
      expect(whatsapp.sendText.mock.calls).toEqual([
        [
          '82988887777',
          'Bom dia, Ana Lima! 👋\n\n' +
            'Sua agenda hoje (qua., 21/10) tem 2 atendimento(s):\n\n' +
            '- 09:00  Maria Souza (Avaliacao)\n' +
            '- 14:30  João Lead (Ortodontia)\n\n' +
            'Tenha um excelente dia!',
          `chip-clinica-${A}`,
          undefined,
          A,
        ],
      ]);
      expect(svc.logDispatch.mock.calls[0][0]).toMatchObject({ tenantId: A, type: 'resumo_dentista', status: 'SENT' });
    });

    it('salvar na A: grava DENTIST_DAILY_SUMMARY_A com o mesmo merge; ler na A lê só a dela', async () => {
      const { svc, prisma } = montarServico({ [`DENTIST_DAILY_SUMMARY_${A}`]: { send_at: '07:00' }, DENTIST_DAILY_SUMMARY: { template: 'global' } });
      const salvo = await svc.setDentistDailySummaryConfig(A, { enabled: true });
      expect(prisma.globalSetting.upsert.mock.calls[0][0].where.key).toBe(`DENTIST_DAILY_SUMMARY_${A}`);
      expect(salvo).toEqual({ ...DEFAULT_DENTIST_DAILY_SUMMARY, send_at: '07:00', enabled: true });
      const lidas = prisma.globalSetting.findUnique.mock.calls.map((c: any[]) => c[0].where.key);
      expect(lidas).toEqual([`DENTIST_DAILY_SUMMARY_${A}`]);
    });

    it('as validações de antes continuam (hora, canal, tamanho)', async () => {
      const { svc } = montarServico({});
      await erro400(svc.setDentistDailySummaryConfig(A, { send_at: '7h' }));
      await erro400(svc.setDentistDailySummaryConfig(A, { channel: 'SMS' }));
      await erro400(svc.setDentistDailySummaryConfig(A, { template: 'x'.repeat(2001) }));
    });
  });
});
