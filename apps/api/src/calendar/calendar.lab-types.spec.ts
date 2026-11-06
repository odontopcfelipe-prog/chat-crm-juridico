/**
 * F7 do laboratório — tipos da agenda por conta (CalendarService e CalendarController).
 *
 *  - Laboratório: coleta, prova e entrega gravam com os lembretes de 48 h e 24 h pelo
 *    WhatsApp (mais o PUSH da equipe) e avisam o cliente pelo módulo do laboratório;
 *    nenhum automatismo de paciente (auditoria de consulta, última visita, promoção a
 *    paciente, lista de espera, aviso de audiência) os enxerga. Tipo de clínica segue
 *    recusado com VERTICAL_DENIED. Coleta, prova e entrega exigem cliente.
 *  - Clínica: coleta, prova e entrega recebem o mesmo 400 de tipo inválido de antes,
 *    no serviço e pela rota (com o ValidationPipe real, corpo idêntico).
 *
 * Dados de exemplo (repositório público: nada real).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { BadRequestException, HttpException, Logger, ValidationPipe } from '@nestjs/common';
import { LAB_AGENDA_TEXTOS, __limparCacheLabTenants } from '@crm/shared';
import { CODIGO_VERTICAL_NEGADA } from '../common/lab-gate.util';
import { CalendarController } from './calendar.controller';
import { CreateEventDto, MSG_TIPO_DTO, UpdateEventDto } from './dto/calendar.dto';
import * as aviso from './aviso-agenda-laboratorio';

const CLINICA = 'tenant-clinica';
const LAB = 'tenant-lab';
const AGORA = new Date('2026-10-21T15:00:00.000Z'); // 12:00 em Maceió
const INICIO = '2026-10-28T14:00:00.000Z';
const TIPOS_DA_CLINICA_RECUSADOS = ['CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA', 'AUDIENCIA', 'PERICIA', 'PRAZO'];
const TIPOS_DO_LAB = ['COLETA', 'PROVA', 'ENTREGA'];
const USE = 'CONSULTA, PROCEDIMENTO, RETORNO, ORTODONTIA, BLOQUEIO, TAREFA, OUTRO, AUDIENCIA, PERICIA, PRAZO';

// ─── Carregador do CalendarService (o import dinâmico do @crm/shared vira require) ─
const RAIZ_SRC = path.resolve(__dirname, '..');
const OPCOES_TS = (() => {
  const raizApi = path.resolve(RAIZ_SRC, '..');
  const lido = ts.readConfigFile(path.join(raizApi, 'tsconfig.json'), ts.sys.readFile);
  const { options } = ts.convertCompilerOptionsFromJson(lido.config.compilerOptions, raizApi);
  return {
    ...options,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    resolvePackageJsonExports: undefined,
    sourceMap: false,
    inlineSourceMap: false,
    declaration: false,
    incremental: false,
  };
})();
function carregarFonte(relativo: string): any {
  const arquivo = path.join(RAIZ_SRC, relativo);
  const { outputText } = ts.transpileModule(fs.readFileSync(arquivo, 'utf8'), { fileName: arquivo, compilerOptions: OPCOES_TS });
  const modulo = { exports: {} as any };
  const requerer = (id: string) => require(id.startsWith('.') ? path.resolve(path.dirname(arquivo), id) : id);
  new Function('exports', 'require', 'module', '__filename', '__dirname', outputText)(
    modulo.exports, requerer, modulo, arquivo, path.dirname(arquivo),
  );
  return modulo.exports;
}
const { CalendarService } = carregarFonte('calendar/calendar.service.ts');

beforeAll(() => {
  for (const nivel of ['log', 'warn', 'debug', 'error', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
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
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  for (const nivel of ['log', 'warn', 'debug', 'error', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
  }
});

// ─── Banco de teste (grava cada operação; a lista de laboratórios fica fora) ────
type Respostas = Record<string, (args: any) => any>;
function banco(labs: string[], respostas: Respostas = {}) {
  __limparCacheLabTenants();
  const ops: Array<[string, any]> = [];
  const modelos: Record<string, any> = {};
  const prisma: any = new Proxy({}, {
    get(_a, modelo: string | symbol) {
      if (typeof modelo !== 'string' || modelo === 'then') return undefined;
      if (modelo === 'tenantBusinessProfile') return { findMany: async () => labs.map((tenant_id) => ({ tenant_id })) };
      if (modelo === '$transaction') return async (cb: any) => (typeof cb === 'function' ? cb(prisma) : Promise.all(cb));
      modelos[modelo] ??= new Proxy({}, {
        get(_m, metodo: string | symbol) {
          if (typeof metodo !== 'string' || metodo === 'then') return undefined;
          return async (args: any) => {
            const op = `${modelo}.${metodo}`;
            // A leitura de contaDoLabPodeEnviar fica fora do rastro: conta ativa, sem congelamento.
            if (op === 'tenant.findUnique' && args?.select?.status) return { status: (respostas as any)['conta.status']?.(args) ?? 'ACTIVE' };
            if (op === 'globalSetting.findMany' && args?.where?.key?.in?.includes('LAB_FREEZE')) return [];
            ops.push([op, args]);
            if (respostas[op]) return respostas[op](args);
            if (metodo === 'findMany') return [];
            if (metodo === 'count') return 0;
            if (metodo === 'updateMany' || metodo === 'deleteMany' || metodo === 'createMany') return { count: 1 };
            if (metodo === 'create') return { id: `novo-${modelo}`, ...(args?.data ?? {}) };
            return null;
          };
        },
      });
      return modelos[modelo];
    },
  });
  const de = (op: string) => ops.filter(([o]) => o === op).map(([, a]) => a);
  const escritas = () => ops.filter(([o]) => !/\.(findUnique|findFirst|findMany|count)$/.test(o));
  return { prisma, ops, de, escritas };
}
const esperar = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};
async function erro(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('era para lançar e não lançou');
}
const codigo = (e: any) => e?.getResponse?.()?.code;

const LEMBRETES = [
  { minutes_before: 2880, channel: 'WHATSAPP' },
  { minutes_before: 1440, channel: 'WHATSAPP' },
  { minutes_before: 60, channel: 'WHATSAPP' },
  { minutes_before: 15, channel: 'WHATSAPP' },
  { minutes_before: 1440, channel: 'EMAIL' },
  { minutes_before: 30, channel: 'PUSH' },
];

function montar(labs: string[], respostas: Respostas = {}) {
  let criados: any[] = [];
  const b = banco(labs, {
    'globalSetting.findUnique': () => null,
    'calendarEvent.create': ({ data }) => ({
      id: 'evento-1',
      ...data,
      reminders: (data.reminders?.create ?? []).map((r: any, i: number) => ({ id: `lembrete-${i + 1}`, event_id: 'evento-1', ...r })),
      assigned_user: data.assigned_user_id ? { id: data.assigned_user_id, name: 'Bruno Exemplo' } : null,
      lead: data.lead_id ? { id: data.lead_id, name: 'Dra. Ana Exemplo', phone: '5582900000003', is_client: false } : null,
    }),
    'eventReminder.createMany': ({ data }) => {
      criados = data;
      return { count: data.length };
    },
    'eventReminder.findMany': () => criados.map((r, i) => ({ id: `novo-${i + 1}`, ...r })),
    ...respostas,
  });
  const fila = { add: jest.fn(async (..._a: any[]) => ({ id: 'job' })), getJob: jest.fn(async (_id: string) => null) };
  const waitlist = { notifySlotOpened: jest.fn(async () => ({ notified: 0 })) };
  const moduleRef = { get: jest.fn(() => undefined) };
  const whatsapp = { sendText: jest.fn(async () => ({ key: { id: 'wamid' } })) };
  const email = { dispatch: jest.fn(async () => true) };
  const svc = new CalendarService(b.prisma, { emitCalendarUpdate: jest.fn() }, fila, waitlist, whatsapp, email, moduleRef);
  const clinicos: any[] = [];
  jest.spyOn(svc, 'sendAppointmentEventWhatsapp').mockImplementation(async (...a: any[]) => {
    clinicos.push(['whatsapp', ...a.slice(1)]);
    return { sent: true };
  });
  jest.spyOn(svc, 'sendAppointmentEventEmail').mockImplementation(async (...a: any[]) => {
    clinicos.push(['email', ...a.slice(1)]);
  });
  const avisos: any[] = [];
  jest.spyOn(aviso, 'avisarAgendaDoLaboratorio').mockImplementation(async (_deps: any, a: any) => {
    avisos.push([a.kind, a.tenantId, a.patientId ?? null, a.leadId ?? null, a.event?.id]);
    return { sent: true };
  });
  return { svc, fila, waitlist, moduleRef, clinicos, avisos, ...b };
}
const evento = (t: string | undefined, extra: Record<string, any> = {}) => ({
  type: 'COLETA', title: 'Coleta exemplo', start_at: INICIO, end_at: '2026-10-28T14:30:00.000Z', lead_id: 'lead-1',
  assigned_user_id: 'equipe-1', created_by_id: 'recepcao-1', tenant_id: t, actor_roles: ['OPERADOR'], reminders: LEMBRETES, ...extra,
});

describe('Agenda do laboratório — criar', () => {
  it.each(TIPOS_DA_CLINICA_RECUSADOS)('%s no laboratório: 403 VERTICAL_DENIED e nada é gravado', async (tipo) => {
    const m = montar([LAB]);
    const e = await erro(m.svc.create(evento(LAB, { type: tipo })));
    expect(codigo(e)).toBe(CODIGO_VERTICAL_NEGADA);
    expect(m.escritas()).toEqual([]);
    expect(m.avisos).toEqual([]);
  });

  it.each(TIPOS_DO_LAB)('%s no laboratório: grava com PUSH + WhatsApp 48 h/24 h e avisa o cliente pelo módulo do laboratório', async (tipo) => {
    const m = montar([LAB]);
    await m.svc.create(evento(LAB, { type: tipo }));
    await esperar();
    const criado = m.de('calendarEvent.create');
    expect(criado).toHaveLength(1);
    expect(criado[0].data.type).toBe(tipo);
    expect(criado[0].data.reminders.create).toEqual([
      { minutes_before: 2880, channel: 'WHATSAPP' },
      { minutes_before: 1440, channel: 'WHATSAPP' },
      { minutes_before: 30, channel: 'PUSH' },
    ]);
    // Os 2 lembretes de WhatsApp vão para a fila; nenhum aviso de audiência.
    expect(m.fila.add.mock.calls.map((c: any[]) => [c[0], c[1].reminderId, c[1].channel])).toEqual([
      ['send-reminder', 'lembrete-1', 'WHATSAPP'],
      ['send-reminder', 'lembrete-2', 'WHATSAPP'],
    ]);
    expect(m.avisos).toEqual([['created', LAB, null, 'lead-1', 'evento-1']]);
    expect(m.clinicos).toEqual([]);
    expect(m.de('auditLog.create')).toEqual([]);
    expect(m.de('patient.update')).toEqual([]);
    expect(m.de('patient.updateMany')).toEqual([]);
    expect(m.moduleRef.get).not.toHaveBeenCalled();
  });

  it('coleta já nascendo Concluída ou Confirmada: sem auditoria de consulta, última visita nem promoção', async () => {
    for (const status of ['CONCLUIDO', 'CONFIRMADO', 'COMPARECEU']) {
      const m = montar([LAB], {
        'calendarEvent.findUnique': () => ({ lead_id: 'lead-1', patient_id: 'pac-1', tenant_id: LAB, type: 'COLETA', status }),
      });
      await m.svc.create(evento(LAB, { status, actor_roles: ['ADMIN'], patient_id: 'pac-1' }));
      await esperar();
      expect(m.de('auditLog.create')).toEqual([]);
      expect(m.de('patient.update')).toEqual([]);
      expect(m.moduleRef.get).not.toHaveBeenCalled();
    }
  });

  it('com a confirmação de agendamento desligada na Central: nenhum aviso sai (lido no módulo do laboratório)', async () => {
    const m = montar([LAB], {
      'globalSetting.findUnique': ({ where }) =>
        where.key === `APPOINTMENT_CONFIRMATION_ENABLED_${LAB}` ? { value: 'false' } : null,
    });
    (aviso.avisarAgendaDoLaboratorio as jest.Mock).mockRestore();
    const whatsapp = (m.svc as any).whatsapp;
    const email = (m.svc as any).emailAutomation;
    await m.svc.create(evento(LAB, { patient_id: 'pac-1' }));
    await esperar();
    expect(m.de('globalSetting.findUnique').map((a: any) => a.where.key)).toContain(`APPOINTMENT_CONFIRMATION_ENABLED_${LAB}`);
    expect(whatsapp.sendText).not.toHaveBeenCalled();
    expect(email.dispatch).not.toHaveBeenCalled();
    expect(m.clinicos).toEqual([]);
  });

  it('coleta, prova ou entrega sem cliente: 400 com o texto do laboratório e nada é gravado', async () => {
    for (const tipo of TIPOS_DO_LAB) {
      const m = montar([LAB]);
      const e = await erro(m.svc.create(evento(LAB, { type: tipo, lead_id: undefined, patient_id: undefined })));
      expect(e).toBeInstanceOf(BadRequestException);
      expect(e.message).toBe(LAB_AGENDA_TEXTOS.clienteObrigatorio);
      expect(m.escritas()).toEqual([]);
    }
  });

  it('OUTRO, TAREFA e BLOQUEIO no laboratório: como antes (só o PUSH da equipe, sem aviso)', async () => {
    for (const tipo of ['OUTRO', 'TAREFA', 'BLOQUEIO']) {
      const m = montar([LAB]);
      await m.svc.create(evento(LAB, { type: tipo }));
      await esperar();
      expect(m.de('calendarEvent.create')[0].data.reminders.create).toEqual([{ minutes_before: 30, channel: 'PUSH' }]);
      expect(m.fila.add).not.toHaveBeenCalled();
      expect(m.avisos).toEqual([]);
    }
  });
});

describe('Agenda do laboratório — status (updateStatus não muda)', () => {
  const antes = (status = 'AGENDADO') => ({
    'calendarEvent.findUnique': (a: any) =>
      a.include
        ? { id: 'evento-1', type: 'COLETA', status, start_at: new Date(INICIO), tenant_id: LAB, patient_id: 'pac-1', lead_id: 'lead-1', assigned_user_id: 'equipe-1', assigned_user: { id: 'equipe-1', name: 'Bruno Exemplo' } }
        : { status: 'AGENDADO', validated_at: null, type: 'COLETA', tenant_id: LAB, start_at: new Date(INICIO), patient_id: 'pac-1', lead_id: 'lead-1', assigned_user_id: 'equipe-1' },
    'eventReminder.findMany': () => [{ id: 'lembrete-1' }, { id: 'lembrete-2' }],
  });

  it('Desmarcado e Adiado: sem lista de espera nem auditoria', async () => {
    for (const status of ['CANCELADO', 'ADIADO']) {
      const m = montar([LAB], antes(status));
      await m.svc.updateStatus('evento-1', status, { userId: 'u1', roles: ['OPERADOR'], tenantId: LAB });
      await esperar();
      expect(m.waitlist.notifySlotOpened).not.toHaveBeenCalled();
      expect(m.de('auditLog.create')).toEqual([]);
    }
  });

  it('Feito (CONCLUIDO): cancela os lembretes; sem última visita, ficha, dentista responsável nem promoção', async () => {
    const m = montar([LAB], antes('CONCLUIDO'));
    await m.svc.updateStatus('evento-1', 'CONCLUIDO', { userId: 'u1', roles: ['OPERADOR'], tenantId: LAB });
    await esperar();
    expect(m.fila.getJob.mock.calls.map((c: any[]) => c[0])).toEqual(['reminder-lembrete-1', 'reminder-lembrete-2']);
    expect(m.de('patient.update')).toEqual([]);
    expect(m.de('patient.updateMany')).toEqual([]);
    expect(m.moduleRef.get).not.toHaveBeenCalled();
    expect(m.de('auditLog.create')).toEqual([]);
  });
});

describe('Agenda do laboratório — remarcar', () => {
  const antes = (t: string, tipo = 'COLETA', lembretes: any[] = []) => ({
    'calendarEvent.findUnique': () => ({
      type: tipo, start_at: new Date(INICIO), location: null, lead_id: 'lead-1', status: 'AGENDADO',
      assigned_user_id: 'equipe-1', tenant_id: t, validated_at: null, validated_by_user_id: null,
    }),
    'calendarEvent.update': ({ where, data }: any) => ({
      id: where.id, type: data.type ?? tipo, status: 'AGENDADO', start_at: data.start_at ?? new Date(INICIO), lead_id: 'lead-1',
      patient_id: 'pac-1', tenant_id: t, assigned_user_id: 'equipe-1', assigned_user: { id: 'equipe-1', name: 'Bruno Exemplo' },
      lead: { id: 'lead-1', name: 'Dra. Ana Exemplo', phone: '5582900000003', is_client: true }, reminders: lembretes,
    }),
  });
  const remarcar = {
    start_at: '2026-10-29T14:00:00.000Z',
    reminders: [
      { minutes_before: 2880, channel: 'WHATSAPP' },
      { minutes_before: 1440, channel: 'WHATSAPP' },
      { minutes_before: 60, channel: 'WHATSAPP' },
      { minutes_before: 1440, channel: 'EMAIL' },
      { minutes_before: 30, channel: 'PUSH' },
    ],
  };

  it('coleta remarcada: só 48 h/24 h WhatsApp e o PUSH ficam, os 2 são re-enfileirados e o cliente é avisado', async () => {
    const m = montar([LAB], antes(LAB));
    await m.svc.update('evento-1', remarcar);
    await esperar();
    expect(m.de('eventReminder.createMany')).toEqual([{
      data: [
        { event_id: 'evento-1', minutes_before: 2880, channel: 'WHATSAPP' },
        { event_id: 'evento-1', minutes_before: 1440, channel: 'WHATSAPP' },
        { event_id: 'evento-1', minutes_before: 30, channel: 'PUSH' },
      ],
    }]);
    expect(m.fila.add.mock.calls.map((c: any[]) => c[1].reminderId)).toEqual(['novo-1', 'novo-2']);
    expect(m.avisos).toEqual([['rescheduled', LAB, 'pac-1', 'lead-1', 'evento-1']]);
    expect(m.clinicos).toEqual([]);
  });

  it('coleta com a data igual (só outros campos): sem aviso de remarcação', async () => {
    const m = montar([LAB], antes(LAB));
    await m.svc.update('evento-1', { title: 'Coleta — trazer moldeira' });
    await esperar();
    expect(m.avisos).toEqual([]);
    expect(m.fila.add).not.toHaveBeenCalled();
  });

  it('remarcar só a data (lembretes antigos ficam): os de 48 h/24 h são re-enfileirados', async () => {
    const m = montar([LAB], antes(LAB, 'COLETA', [{ id: 'antigo-1', minutes_before: 1440, channel: 'WHATSAPP' }]));
    await m.svc.update('evento-1', { start_at: '2026-10-29T14:00:00.000Z' });
    await esperar();
    expect(m.fila.add.mock.calls.map((c: any[]) => c[1].reminderId)).toEqual(['antigo-1']);
    expect(m.avisos).toEqual([['rescheduled', LAB, 'pac-1', 'lead-1', 'evento-1']]);
  });

  it('OUTRO remarcado no laboratório: como antes (só PUSH, nada re-enfileirado, sem aviso)', async () => {
    const m = montar([LAB], antes(LAB, 'OUTRO'));
    await m.svc.update('evento-1', remarcar);
    await esperar();
    expect(m.de('eventReminder.createMany')).toEqual([{ data: [{ event_id: 'evento-1', minutes_before: 30, channel: 'PUSH' }] }]);
    expect(m.fila.add).not.toHaveBeenCalled();
    expect(m.avisos).toEqual([]);
  });

  it('trocar OUTRO para coleta no laboratório: troca; tirar o cliente da coleta: 400 com o texto do laboratório', async () => {
    const troca = montar([LAB], antes(LAB, 'OUTRO'));
    await troca.svc.update('evento-1', { type: 'COLETA' });
    expect(troca.de('calendarEvent.update')).toHaveLength(1);

    const semCliente = montar([LAB], antes(LAB));
    const e = await erro(semCliente.svc.update('evento-1', { lead_id: null, patient_id: null }));
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.message).toBe(LAB_AGENDA_TEXTOS.clienteObrigatorio);
    expect(semCliente.de('calendarEvent.update')).toEqual([]);

    // Troca de contato para um cadastro de cliente: segue.
    const comPaciente = montar([LAB], antes(LAB));
    await comPaciente.svc.update('evento-1', { lead_id: null, patient_id: 'pac-2' });
    expect(comPaciente.de('calendarEvent.update')).toHaveLength(1);
  });
});

describe('Clínica com coleta, prova ou entrega — o mesmo 400 de antes', () => {
  it.each([[[]], [[LAB]]] as Array<[string[]]>)('serviço, create (laboratórios: %j): 400 "Tipo invalido" e nenhum efeito', async (labs) => {
    for (const tipo of TIPOS_DO_LAB) {
      const m = montar(labs);
      const e = await erro(m.svc.create(evento(CLINICA, { type: tipo })));
      expect(e).toBeInstanceOf(BadRequestException);
      expect(e.message).toBe(`Tipo invalido: ${tipo}. Use: ${USE}`);
      expect(m.ops).toEqual([]);
      expect(m.fila.add).not.toHaveBeenCalled();
      expect(m.avisos).toEqual([]);
    }
  });

  it.each([[[]], [[LAB]]] as Array<[string[]]>)('serviço, update (laboratórios: %j): 400 "Tipo invalido" e nada é gravado', async (labs) => {
    const m = montar(labs, {
      'calendarEvent.findUnique': () => ({ type: 'CONSULTA', start_at: new Date(INICIO), lead_id: 'lead-1', status: 'AGENDADO', tenant_id: CLINICA, validated_at: null }),
    });
    const e = await erro(m.svc.update('evento-1', { type: 'COLETA' }));
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.message).toBe('Tipo invalido: COLETA');
    expect(m.escritas()).toEqual([]);
  });

  it('tipo que não existe continua com o 400 de antes, sem leitura', async () => {
    const m = montar([LAB]);
    const e = await erro(m.svc.create(evento(CLINICA, { type: 'AVALIACAO' })));
    expect(e.message).toBe(`Tipo invalido: AVALIACAO. Use: ${USE}`);
    expect(m.ops).toEqual([]);
  });
});

describe('Pela rota (ValidationPipe real + CalendarController)', () => {
  const pipe = () => new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  const corpo = (type: string) => ({ type, title: 'Exemplo', start_at: INICIO, lead_id: 'lead-1' });
  const CORPO_400 = { message: [MSG_TIPO_DTO], error: 'Bad Request', statusCode: 400 };
  const CLINICA_USER = { id: 'u1', tenant_id: CLINICA, roles: ['ADMIN'] };
  const LAB_USER = { id: 'u2', tenant_id: LAB, roles: ['ADMIN'], bt: 'LABORATORIO' };

  function rota() {
    const svc: any = {
      exigirIdsDaConta: jest.fn(async () => undefined),
      create: jest.fn(async (d: any) => ({ id: 'novo', ...d })),
      checkOwnership: jest.fn(async () => true),
      update: jest.fn(async () => ({ id: 'evento-1' })),
      updateRecurrenceAll: jest.fn(async () => ({ id: 'evento-1' })),
    };
    return { svc, controller: new CalendarController(svc) };
  }
  async function resposta(fn: () => Promise<unknown>): Promise<unknown> {
    try {
      await fn();
      return 'passou';
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      return (e as HttpException).getResponse();
    }
  }

  it('clínica com COLETA, PROVA, ENTREGA ou "XYZ" no criar: o mesmo corpo de 400, e o serviço nem é chamado', async () => {
    for (const tipo of [...TIPOS_DO_LAB, 'XYZ']) {
      const { svc, controller } = rota();
      const r = await resposta(async () => {
        const dto = await pipe().transform(corpo(tipo), { type: 'body', metatype: CreateEventDto });
        await controller.create(dto, { user: CLINICA_USER });
      });
      expect([tipo, r]).toEqual([tipo, CORPO_400]);
      expect(svc.exigirIdsDaConta).not.toHaveBeenCalled();
      expect(svc.create).not.toHaveBeenCalled();
    }
  });

  it('clínica trocando para COLETA ou "XYZ" no editar: o mesmo corpo de 400, antes de checar o evento', async () => {
    for (const tipo of ['COLETA', 'XYZ']) {
      const { svc, controller } = rota();
      const r = await resposta(async () => {
        const dto = await pipe().transform({ type: tipo }, { type: 'body', metatype: UpdateEventDto });
        await controller.update('evento-1', dto, undefined, { user: CLINICA_USER });
      });
      expect([tipo, r]).toEqual([tipo, CORPO_400]);
      expect(svc.checkOwnership).not.toHaveBeenCalled();
      expect(svc.update).not.toHaveBeenCalled();
    }
  });

  it('laboratório com COLETA: passa pela rota até o serviço (a conta decide lá)', async () => {
    const { svc, controller } = rota();
    const dto = await pipe().transform(corpo('COLETA'), { type: 'body', metatype: CreateEventDto });
    await controller.create(dto, { user: LAB_USER });
    expect(svc.create).toHaveBeenCalledTimes(1);
    expect(svc.create.mock.calls[0][0]).toMatchObject({ type: 'COLETA', tenant_id: LAB });
    const upd = await pipe().transform({ type: 'ENTREGA' }, { type: 'body', metatype: UpdateEventDto });
    await controller.update('evento-1', upd, undefined, { user: LAB_USER });
    expect(svc.update).toHaveBeenCalledTimes(1);
  });

  it('clínica com tipo de clínica: segue como antes', async () => {
    const { svc, controller } = rota();
    const dto = await pipe().transform(corpo('CONSULTA'), { type: 'body', metatype: CreateEventDto });
    await controller.create(dto, { user: CLINICA_USER });
    expect(svc.create).toHaveBeenCalledTimes(1);
    const upd = await pipe().transform({ title: 'x' }, { type: 'body', metatype: UpdateEventDto });
    await controller.update('evento-1', upd, undefined, { user: CLINICA_USER });
    expect(svc.update).toHaveBeenCalledTimes(1);
  });
});
