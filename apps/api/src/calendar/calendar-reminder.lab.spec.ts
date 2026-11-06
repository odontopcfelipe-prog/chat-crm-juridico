/**
 * F7 do laboratório — lembretes de 48 h e de 24 h da coleta, da prova e da entrega
 * (fila calendar-reminders), passando pelo process() do CalendarReminderWorker.
 *
 *  - COLETA, PROVA e ENTREGA da conta de laboratório, WhatsApp 2880/1440: claim
 *    atômico, envio pelo chip de Atendimento da conta com o texto do laboratório,
 *    Message arquivada e conversation.update só com last_message_at;
 *  - 60 e 15 min, e-mail, tipos que não são do laboratório, evento legado sem conta e
 *    contato de outra conta: sem claim e sem envio (como antes da F7);
 *  - REMINDER_CONFIG da conta desligado ou sem a antecedência: nada;
 *  - sem chip de Atendimento ou sem telefone: FAILED com o motivo do laboratório e
 *    aviso à equipe com "Cliente";
 *  - clínica com OUTRA conta laboratório: o mesmo rastro de antes.
 *
 * Banco simulado: grava cada operação (menos a leitura da lista de laboratórios) e
 * responde pelo mapa de respostas.
 */
import { Logger } from '@nestjs/common';
import { LAB_AGENDA_TEXTOS, __limparCacheLabTenants, lembreteClinicoIdFor } from '@crm/shared';
import { CalendarReminderWorker } from './calendar-reminder.worker';
import { limparCacheAnexos } from '../disparo-anexos/disparo-anexos-envio';

// ─── Dados de exemplo (repositório público: nada real) ───────────────────────
const CLINICA = 'tenant-clinica';
const LAB = 'tenant-lab';
const OUTRO_LAB = 'tenant-lab-2';
const AGORA = new Date('2026-10-21T15:00:00.000Z');
const TEL_CLIENTE = '5582900000021';
const TEL_PACIENTE_CLINICA = '5582900000001';
const ENDERECO = 'Rua Exemplo, 100, Centro, Maceió/AL';
const CADASTRO = {
  name: 'Dra. Ana Souza',
  lead_id: 'lead-1',
  address: 'Rua Exemplo',
  address_number: '100',
  address_complement: null,
  neighborhood: 'Centro',
  city: 'Maceió',
  state: 'AL',
};
const CONFIG_DO_LAB = JSON.stringify({
  enabled: true,
  default_antecedencias: [
    { minutes_before: 2880, channel: 'WHATSAPP' },
    { minutes_before: 1440, channel: 'WHATSAPP' },
  ],
});
const CHIPS_DO_LAB = [
  { name: 'chip-financeiro-lab', purpose: 'FINANCEIRO' },
  { name: 'chip-atendimento-lab', purpose: 'CLINICA' },
];

beforeAll(() => {
  for (const m of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  }
});
beforeEach(() => {
  __limparCacheLabTenants();
  jest.useFakeTimers({
    now: AGORA,
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
});
afterEach(() => jest.useRealTimers());

type Op = [string, any];
type Respostas = Record<string, (args: any) => any>;

function banco(labs: string[], respostas: Respostas = {}) {
  __limparCacheLabTenants();
  const ops: Op[] = [];
  const perfis = jest.fn(async () => labs.map((tenant_id) => ({ tenant_id })));
  const modelos: Record<string, any> = {};
  const prisma: any = new Proxy(
    {},
    {
      get(_a, modelo: string | symbol) {
        if (typeof modelo !== 'string' || modelo === 'then') return undefined;
        if (modelo === 'tenantBusinessProfile') return { findMany: perfis };
        modelos[modelo] ??= new Proxy(
          {},
          {
            get(_m, metodo: string | symbol) {
              if (typeof metodo !== 'string' || metodo === 'then') return undefined;
              return async (args: any) => {
                const op = `${modelo}.${metodo}`;
                // A leitura de contaDoLabPodeEnviar fica fora do rastro: conta ativa, sem congelamento.
                if (op === 'tenant.findUnique' && args?.select?.status) return { status: (respostas as any)['conta.status']?.(args) ?? 'ACTIVE' };
                if (op === 'globalSetting.findMany' && args?.where?.key?.in?.includes('LAB_FREEZE')) return [];
                ops.push([op, args]);
                const r = respostas[op];
                if (r) return r(args);
                if (metodo === 'findMany') return [];
                if (metodo === 'updateMany') return { count: 1 };
                if (metodo === 'create') return { id: `novo-${modelo}`, ...(args?.data ?? {}) };
                if (metodo === 'update') return { id: args?.where?.id ?? `upd-${modelo}` };
                return null;
              };
            },
          },
        );
        return modelos[modelo];
      },
    },
  );
  const de = (op: string) => ops.filter(([o]) => o === op).map(([, a]) => a);
  return { prisma, ops, de };
}

const eventoDoLab = (over: Record<string, any> = {}) => ({
  id: 'ev-1',
  type: 'COLETA',
  status: 'AGENDADO',
  tenant_id: LAB,
  title: 'Coleta',
  start_at: new Date('2026-10-23T14:30:00.000Z'),
  location: null,
  lead_id: 'lead-1',
  patient_id: 'pac-1',
  assigned_user_id: 'u-1',
  assigned_user: { id: 'u-1', name: 'Expedição Exemplo', phone: null },
  lead: { id: 'lead-1', name: 'Dra. Ana Souza', phone: TEL_CLIENTE, is_client: true, tenant_id: LAB },
  patient: { id: 'pac-1', name: 'Dra. Ana Souza', phone: TEL_CLIENTE, tenant_id: LAB },
  reminders: [{ minutes_before: 2880 }, { minutes_before: 1440 }],
  ...over,
});

const eventoDaClinica = () => ({
  id: 'ev-1',
  type: 'CONSULTA',
  status: 'AGENDADO',
  tenant_id: CLINICA,
  title: 'Avaliação',
  start_at: new Date('2026-10-22T14:30:00.000Z'),
  location: null,
  lead_id: 'lead-9',
  patient_id: null,
  assigned_user: { id: 'u-9', name: 'Dra. Bia Exemplo', phone: null },
  lead: { id: 'lead-9', name: 'Maria Exemplo', phone: TEL_PACIENTE_CLINICA, tenant_id: CLINICA },
  patient: null,
  reminders: [{ minutes_before: 1440 }],
});

interface Opcoes {
  labs?: string[];
  min?: number;
  config?: string | null;
  chips?: { name: string; purpose: string }[];
  cadastro?: any;
  status?: string;
}

function montar(ev: any, o: Opcoes = {}) {
  const min = o.min ?? 2880;
  for (const t of [CLINICA, LAB]) limparCacheAnexos(t, lembreteClinicoIdFor(min));
  const b = banco(o.labs ?? [LAB], {
    'eventReminder.findUnique': () => ({ id: 'r1', sent_at: null, minutes_before: min }),
    'calendarEvent.findUnique': () => ev,
    'globalSetting.findUnique': ({ where }) => {
      if (where.key === `REMINDER_CONFIG_${LAB}`) {
        const v = o.config === undefined ? CONFIG_DO_LAB : o.config;
        return v === null ? null : { value: v };
      }
      return null;
    },
    'patient.findUnique': () => (o.cadastro === undefined ? CADASTRO : o.cadastro),
    'tenant.findUnique': ({ where }) => (where.id === LAB ? { name: 'Laboratório Exemplo' } : null),
    'instance.findMany': ({ where }) =>
      where.tenant_id === LAB ? (o.chips ?? CHIPS_DO_LAB) : [{ name: `chip-${where.tenant_id}`, purpose: 'CLINICA' }],
    'conversation.findFirst': ({ select }) => (select?.instance_name && !select?.id ? null : { id: 'conv-1', instance_name: null }),
    'user.findMany': () => [{ id: 'adm-1' }],
    'conta.status': () => o.status,
  });
  const whatsapp = {
    sendText: jest.fn(async (tel: string, ..._resto: any[]) => ({ key: { id: `wamid-${tel}` }, data: { key: { id: `wamid-${tel}` } } })),
  };
  const settings = { getAiConfig: jest.fn(async () => { throw new Error('sem IA no teste'); }) };
  const worker = new CalendarReminderWorker(b.prisma, whatsapp as any, settings as any);
  const email = jest.spyOn(worker as any, 'sendEmailReminder').mockImplementation(async () => true);
  return { worker, whatsapp, email, ...b };
}
const job = (channel: 'WHATSAPP' | 'EMAIL' = 'WHATSAPP') =>
  ({ name: 'send-reminder', id: 'j1', data: { reminderId: 'r1', eventId: 'ev-1', channel } }) as any;
const SEM_CLAIM = ['eventReminder.findUnique', 'calendarEvent.findUnique'];

const TEXTO_48H_COLETA =
  'Oi Ana! Lembrete do laboratório: *23/10* às *14:30* passamos no consultório para a coleta do seu trabalho.\n' +
  `📍 ${ENDERECO}\n\n` +
  'Se precisar mudar, é só responder aqui.';
const TEXTO_24H_PROVA =
  'Oi Ana! Lembrete do laboratório: amanhã, *23/10* às *14:30*, passamos no consultório para a prova do seu trabalho.\n' +
  `📍 ${ENDERECO}`;

describe('Lembretes do laboratório — conta suspensa ou congelada', () => {
  it('não envia e não reivindica; a mesma fila volta a enviar quando a conta volta', async () => {
    const m = montar(eventoDoLab(), { min: 2880, status: 'SUSPENDED' });
    await m.worker.process(job());
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
    expect(m.de('eventReminder.updateMany')).toEqual([]);
    expect(m.de('eventReminder.update')).toEqual([]);

    const ativa = montar(eventoDoLab(), { min: 2880, status: 'TRIAL' });
    await ativa.worker.process(job());
    expect(ativa.whatsapp.sendText).toHaveBeenCalledTimes(1);
  });
});

describe('Lembretes do laboratório (fila calendar-reminders) — coleta, prova e entrega', () => {
  it.each([
    ['COLETA', 2880],
    ['PROVA', 2880],
    ['ENTREGA', 2880],
    ['COLETA', 1440],
    ['PROVA', 1440],
    ['ENTREGA', 1440],
  ])('%s, WhatsApp %i min: claim, envio pelo chip de Atendimento e enviado', async (tipo, min) => {
    const m = montar(eventoDoLab({ type: tipo }), { min });
    await m.worker.process(job());
    expect(m.de('eventReminder.updateMany')).toEqual([{ where: { id: 'r1', sent_at: null }, data: { sent_at: AGORA } }]);
    expect(m.whatsapp.sendText).toHaveBeenCalledTimes(1);
    const [tel, texto, chip, citado, conta] = m.whatsapp.sendText.mock.calls[0];
    expect([tel, chip, citado, conta]).toEqual([TEL_CLIENTE, 'chip-atendimento-lab', undefined, LAB]);
    const frase = String(tipo).toLowerCase();
    expect(texto).toContain(`para a ${frase} do seu trabalho`);
    expect(texto.startsWith('Oi Ana! Lembrete do laboratório:')).toBe(true);
    expect(texto).toContain(`📍 ${ENDERECO}`);
    expect(texto).not.toMatch(/Dra\.|consulta|paciente/i);
    expect(m.de('eventReminder.update').at(-1)).toEqual({
      where: { id: 'r1' },
      data: { sent_at: AGORA, last_error: null, external_message_id: `wamid-${TEL_CLIENTE}` },
    });
  });

  it('48 h e 24 h: o texto exato de cada lembrete (nome sem "Dra.", tipo minúsculo, DD/MM, endereço do cliente)', async () => {
    const a = montar(eventoDoLab({ type: 'COLETA' }), { min: 2880 });
    await a.worker.process(job());
    expect(a.whatsapp.sendText.mock.calls[0][1]).toBe(TEXTO_48H_COLETA);
    const b = montar(eventoDoLab({ type: 'PROVA' }), { min: 1440 });
    await b.worker.process(job());
    expect(b.whatsapp.sendText.mock.calls[0][1]).toBe(TEXTO_24H_PROVA);
  });

  it('arquiva a mensagem na conversa do contato, fora do Financeiro, e grava só last_message_at (sem IA)', async () => {
    const m = montar(eventoDoLab(), { min: 2880 });
    await m.worker.process(job());
    const busca = m.de('conversation.findFirst').find((a: any) => a.where?.lead_id);
    expect(busca.where).toEqual({ lead_id: 'lead-1', status: { not: 'ENCERRADO' }, NOT: { inbox: { purpose: 'FINANCEIRO' } } });
    expect(m.de('message.create')).toEqual([
      {
        data: {
          conversation_id: 'conv-1',
          direction: 'out',
          type: 'text',
          text: TEXTO_48H_COLETA,
          external_message_id: `wamid-${TEL_CLIENTE}`,
          status: 'enviado',
        },
      },
    ]);
    expect(m.de('conversation.update')).toEqual([{ where: { id: 'conv-1' }, data: { last_message_at: AGORA } }]);
    expect(m.de('dispatchLog.create')).toEqual([]);
  });

  it('o endereço digitado no evento vale antes do cadastro; sem nenhum endereço a linha some', async () => {
    const a = montar(eventoDoLab({ location: 'Consultório Exemplo, sala 2' }), { min: 1440 });
    await a.worker.process(job());
    expect(a.whatsapp.sendText.mock.calls[0][1]).toContain('📍 Consultório Exemplo, sala 2');
    const b = montar(eventoDoLab(), { min: 1440, cadastro: { ...CADASTRO, address: null, address_number: null, neighborhood: null, city: null, state: null } });
    await b.worker.process(job());
    expect(b.whatsapp.sendText.mock.calls[0][1]).not.toContain('📍');
  });

  it('contato em captação (is_client=false) recebe igual, pelo chip de Atendimento', async () => {
    const ev = eventoDoLab({ lead: { id: 'lead-1', name: 'Dra. Ana Souza', phone: TEL_CLIENTE, is_client: false, tenant_id: LAB } });
    const m = montar(ev, { min: 2880, chips: [{ name: 'chip-comercial-lab', purpose: 'COMERCIAL' }, ...CHIPS_DO_LAB] });
    await m.worker.process(job());
    expect(m.whatsapp.sendText.mock.calls.map((c: any[]) => c[2])).toEqual(['chip-atendimento-lab']);
    const chaves = m.de('globalSetting.findUnique').map((a: any) => a.where.key);
    expect(chaves.every((k: string) => k === `REMINDER_CONFIG_${LAB}`)).toBe(true);
  });

  it('texto da conta: o do laboratório vale; vazio ou com palavra de clínica volta ao padrão', async () => {
    const proprio = JSON.stringify({ enabled: true, templates: { consulta_confirmacao: 'Oi {nome}, a {tipo} é dia {data}.' } });
    const a = montar(eventoDoLab(), { min: 2880, config: proprio });
    await a.worker.process(job());
    expect(a.whatsapp.sendText.mock.calls[0][1]).toBe('Oi Ana, a coleta é dia 23/10.');

    const deClinica = JSON.stringify({ enabled: true, templates: { consulta_24h: 'Lembrete da sua consulta amanhã, {nome}.' } });
    const b = montar(eventoDoLab({ type: 'PROVA' }), { min: 1440, config: deClinica });
    await b.worker.process(job());
    expect(b.whatsapp.sendText.mock.calls[0][1]).toBe(TEXTO_24H_PROVA);

    const vazio = JSON.stringify({ enabled: true, templates: { consulta_confirmacao: '   ' } });
    const c = montar(eventoDoLab(), { min: 2880, config: vazio });
    await c.worker.process(job());
    expect(c.whatsapp.sendText.mock.calls[0][1]).toBe(TEXTO_48H_COLETA);

    const semLinha = montar(eventoDoLab(), { min: 2880, config: null });
    await semLinha.worker.process(job());
    expect(semLinha.whatsapp.sendText.mock.calls[0][1]).toBe(TEXTO_48H_COLETA);
  });

  it.each([60, 15])('%i min: sem claim e sem envio', async (min) => {
    const m = montar(eventoDoLab(), { min });
    await m.worker.process(job());
    expect(m.ops.map(([o]) => o)).toEqual(SEM_CLAIM);
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('e-mail: sem claim e sem envio', async () => {
    const m = montar(eventoDoLab(), { min: 2880 });
    await m.worker.process(job('EMAIL'));
    expect(m.ops.map(([o]) => o)).toEqual(SEM_CLAIM);
    expect(m.email).not.toHaveBeenCalled();
  });

  it.each(['OUTRO', 'TAREFA', 'CONSULTA'])('%s do laboratório: como antes (sem claim, sem envio)', async (tipo) => {
    const m = montar(eventoDoLab({ type: tipo }), { min: 2880 });
    await m.worker.process(job());
    expect(m.ops.map(([o]) => o)).toEqual(SEM_CLAIM);
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
  });

  it.each([
    ['evento legado sem conta, contato do laboratório', eventoDoLab({ tenant_id: null })],
    ['contato de outra conta', eventoDoLab({ lead: { id: 'lead-1', name: 'X', phone: TEL_CLIENTE, tenant_id: OUTRO_LAB } })],
    ['cadastro de outra conta', eventoDoLab({ patient: { id: 'pac-1', name: 'X', phone: TEL_CLIENTE, tenant_id: CLINICA } })],
  ])('%s: sem claim e sem envio', async (_n, ev) => {
    const m = montar(ev, { labs: [LAB, OUTRO_LAB], min: 2880 });
    await m.worker.process(job());
    expect(m.ops.map(([o]) => o)).toEqual(SEM_CLAIM);
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('REMINDER_CONFIG da conta desligado: nada (sem claim)', async () => {
    const m = montar(eventoDoLab(), { min: 1440, config: JSON.stringify({ enabled: false }) });
    await m.worker.process(job());
    expect(m.de('eventReminder.updateMany')).toEqual([]);
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('lista da Central sem a de 48 h: a de 48 h não sai; a de 24 h sai', async () => {
    const so24 = JSON.stringify({ enabled: true, default_antecedencias: [{ minutes_before: 1440, channel: 'WHATSAPP' }] });
    const a = montar(eventoDoLab(), { min: 2880, config: so24 });
    await a.worker.process(job());
    expect(a.de('eventReminder.updateMany')).toEqual([]);
    expect(a.whatsapp.sendText).not.toHaveBeenCalled();
    const b = montar(eventoDoLab(), { min: 1440, config: so24 });
    await b.worker.process(job());
    expect(b.whatsapp.sendText).toHaveBeenCalledTimes(1);
  });

  it('cancelado ou feito: marca sent_at sem enviar, como na clínica', async () => {
    const m = montar(eventoDoLab({ status: 'CONCLUIDO' }), { min: 2880 });
    await m.worker.process(job());
    expect(m.de('eventReminder.update')).toEqual([{ where: { id: 'r1' }, data: { sent_at: AGORA } }]);
    expect(m.de('eventReminder.updateMany')).toEqual([]);
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('só chip Financeiro: FAILED com o motivo do laboratório e aviso à equipe com "Cliente"', async () => {
    const ev = eventoDoLab({
      lead: { id: 'lead-1', name: null, phone: TEL_CLIENTE, is_client: true, tenant_id: LAB },
      patient: null,
      patient_id: null,
    });
    const m = montar(ev, { min: 1440, chips: [{ name: 'chip-financeiro-lab', purpose: 'FINANCEIRO' }] });
    await m.worker.process(job());
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
    expect(m.de('eventReminder.update').at(-1)).toEqual({
      where: { id: 'r1' },
      data: { sent_at: null, last_error: LAB_AGENDA_TEXTOS.semChip },
    });
    const avisos = m.de('notification.create').map((a: any) => a.data.body);
    expect(avisos.length).toBeGreaterThan(0);
    for (const corpo of avisos) expect(corpo).toBe(`Cliente — Coleta. Motivo: ${LAB_AGENDA_TEXTOS.semChip}`);
  });

  it('sem telefone: FAILED com o motivo do laboratório', async () => {
    const ev = eventoDoLab({
      lead: { id: 'lead-1', name: 'Dra. Ana Souza', phone: null, tenant_id: LAB },
      patient: { id: 'pac-1', name: 'Dra. Ana Souza', phone: null, tenant_id: LAB },
    });
    const m = montar(ev, { min: 2880 });
    await m.worker.process(job());
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
    expect(m.de('eventReminder.update').at(-1)).toEqual({
      where: { id: 'r1' },
      data: { sent_at: null, last_error: LAB_AGENDA_TEXTOS.semTelefone },
    });
  });

  it('o envio recusado pela Evolution vira FAILED (claim devolvido)', async () => {
    const m = montar(eventoDoLab(), { min: 2880 });
    m.whatsapp.sendText.mockImplementation(async () => ({ statusCode: 400, error: 'recusado' }) as any);
    await m.worker.process(job());
    const ultimo = m.de('eventReminder.update').at(-1);
    expect(ultimo.data.sent_at).toBeNull();
    expect(String(ultimo.data.last_error)).toContain('chip-atendimento-lab');
    expect(m.de('message.create')).toEqual([]);
  });

  it('clínica com OUTRA conta laboratório: o mesmo rastro e o mesmo envio de antes', async () => {
    const antes = montar(eventoDaClinica(), { labs: [], min: 1440 });
    await antes.worker.process(job());
    const depois = montar(eventoDaClinica(), { labs: [LAB], min: 1440 });
    await depois.worker.process(job());
    expect(depois.ops).toEqual(antes.ops);
    expect(depois.whatsapp.sendText.mock.calls).toEqual(antes.whatsapp.sendText.mock.calls);
    expect(depois.whatsapp.sendText).toHaveBeenCalledTimes(1);
  });
});
