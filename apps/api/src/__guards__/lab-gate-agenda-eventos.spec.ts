/**
 * F7 do laboratório — agenda por EVENTO na API: aviso de agendamento, lembretes, tipos
 * da agenda, aviso manual, reenvio e backfill de lembretes. Os casos vieram de
 * lab-gate-eventos.spec.ts (F2 parte 2c e parte 4) sem mudança; a F7 soma os casos de
 * coleta, prova e entrega (tipos só do laboratório) no fim.
 *
 * Laboratório: OUTRO, TAREFA, BLOQUEIO e o tipo de clínica seguem como antes (só o
 * lembrete PUSH da equipe, sem aviso; consulta recusada com VERTICAL_DENIED). Coleta,
 * prova e entrega gravam os lembretes de 48 h e 24 h pelo WhatsApp, re-enfileiram na
 * remarcação e avisam o cliente pelo módulo do laboratório (nunca pelo aviso da clínica).
 *
 * Cada freio tem três casos: (a) sem laboratório cadastrado (o caso de produção hoje)
 * = mesmas chamadas e argumentos de antes; (b) clínica com OUTRA conta laboratório =
 * igual ao (a); (c) laboratório = o ramo do laboratório.
 *
 * O banco de teste grava cada operação (menos a leitura da lista de laboratórios, a única
 * coisa nova para a clínica) e responde aos where só no que importa aqui: a conta da
 * linha contra `tenant_id: null | { notIn } | { in }`, como o Postgres.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { BadRequestException, Logger } from '@nestjs/common';
import { LAB_AGENDA_TEXTOS, __limparCacheLabTenants } from '@crm/shared';
import { CODIGO_VERTICAL_NEGADA } from '../common/lab-gate.util';
import { invalidateAllSettings } from '../tenants/tenant-settings.helper';
import * as aviso from '../calendar/aviso-agenda-laboratorio';

// ─── Dados de exemplo (repositório público: nada real) ───────────────────────
const CLINICA = 'tenant-clinica';
const OUTRA_CLINICA = 'tenant-clinica-2';
const LAB = 'tenant-lab';
const AGORA = new Date('2026-10-21T15:00:00.000Z'); // quarta, 12:00 em Maceió
const TEL: Record<string, string> = {
  [CLINICA]: '5582900000001',
  [OUTRA_CLINICA]: '5582900000002',
  [LAB]: '5582900000003',
};
const OR_SEM_LAB = { OR: [{ tenant_id: null }, { tenant_id: { notIn: [LAB] } }] };

// ─── Carregador do CalendarService (o import dinâmico do @crm/shared vira require) ─
// Mesmo carregador do retrato mensagens-paciente e da parte 2b: o jest deste projeto
// não executa `await import('@crm/shared')`; o resto é o código de produção.
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
  const { outputText } = ts.transpileModule(fs.readFileSync(arquivo, 'utf8'), {
    fileName: arquivo,
    compilerOptions: OPCOES_TS,
  });
  const modulo = { exports: {} as any };
  const requerer = (id: string) => require(id.startsWith('.') ? path.resolve(path.dirname(arquivo), id) : id);
  new Function('exports', 'require', 'module', '__filename', '__dirname', outputText)(
    modulo.exports, requerer, modulo, arquivo, path.dirname(arquivo),
  );
  return modulo.exports;
}
const { CalendarService } = carregarFonte('calendar/calendar.service.ts');

// ─── Logs (o [LAB-GATE] e os avisos de falha são conferidos) ─────────────────
let logs: { nivel: string; msg: string }[] = [];
beforeAll(() => {
  for (const nivel of ['log', 'warn', 'debug', 'error', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, nivel).mockImplementation((msg: any) => {
      logs.push({ nivel, msg: String(msg) });
    });
  }
});
beforeEach(() => {
  logs = [];
  __limparCacheLabTenants();
  invalidateAllSettings();
  // Só o relógio é simulado; promessas e timers seguem reais.
  jest.useFakeTimers({
    now: AGORA,
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
});
afterEach(() => jest.useRealTimers());
const registrou = (nivel: string, trecho: string) => logs.some((l) => l.nivel === nivel && l.msg.includes(trecho));

// ─── Banco de teste ─────────────────────────────────────────────────────────────

type Op = [string, any];
type Respostas = Record<string, (args: any) => any>;

/**
 * Grava `modelo.metodo(args)` em `ops` e responde pelo mapa (padrão: findMany=[],
 * count=0, updateMany=1, create = os dados com id, o resto null). A leitura da lista
 * de laboratórios (TenantBusinessProfile) não entra no rastro.
 */
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
        if (modelo === '$transaction') return async (cb: any) => (typeof cb === 'function' ? cb(prisma) : Promise.all(cb));
        if (modelo.startsWith('$')) {
          return async (...args: any[]) => {
            ops.push([modelo, args.slice(1)]);
            return respostas[modelo] ? respostas[modelo](args) : modelo === '$queryRaw' ? [] : 0;
          };
        }
        modelos[modelo] ??= new Proxy(
          {},
          {
            get(_m, metodo: string | symbol) {
              if (typeof metodo !== 'string' || metodo === 'then') return undefined;
              return async (args: any) => {
                const op = `${modelo}.${metodo}`;
                ops.push([op, args]);
                const r = respostas[op];
                if (r) return r(args);
                if (metodo === 'findMany' || metodo === 'groupBy') return [];
                if (metodo === 'count') return 0;
                if (metodo === 'updateMany' || metodo === 'deleteMany' || metodo === 'createMany') return { count: 1 };
                if (metodo === 'create') return { id: `novo-${modelo}`, ...(args?.data ?? {}) };
                if (metodo === 'update' || metodo === 'upsert') return { id: args?.where?.id ?? `upd-${modelo}` };
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
  const nomes = () => ops.map(([o]) => o);
  return { prisma, ops, de, nomes, perfis };
}

/** Avalia o where na linha, só pela conta (da linha e do contato/paciente dela). */
function casa(where: any, linha: any): boolean {
  if (!where || typeof where !== 'object') return true;
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === 'AND') return (Array.isArray(v) ? v : [v]).every((w) => casa(w, linha));
    if (k === 'OR') return (v as any[]).some((w) => casa(w, linha));
    if (k === 'NOT') return !casa(v, linha);
    if (k === 'tenant_id') {
      const t = linha?.tenant_id ?? null;
      if (v === null) return t === null;
      if (typeof v === 'string') return t === v;
      if (v && 'notIn' in v) return t !== null && !v.notIn.includes(t); // NOT IN exclui NULL
      if (v && 'in' in v) return t !== null && v.in.includes(t);
      if (v && 'not' in v && v.not === null) return t !== null;
      return true;
    }
    if (k === 'lead' || k === 'patient') return casa(v, linha?.[k]);
    return true; // o resto do where não importa aqui
  });
}

const tocaLab = (x: unknown) => JSON.stringify(x).includes(LAB);
/** O rastro sem as operações que citam o laboratório. */
const semOLab = (ops: Op[]) => ops.filter((o) => !tocaLab(o));
const esperar = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};
/** O erro que a promessa lançou (falha o teste se não lançar). */
async function erro(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('era para lançar e não lançou');
}
const codigo = (e: any) => e?.getResponse?.()?.code;

// ═════════════════════════════════════════════════════════════════════════════
// Agenda: aviso de agendamento, lembretes, aviso manual, reenvio, backfill
// ═════════════════════════════════════════════════════════════════════════════

describe('Agenda — evento de laboratório: sem aviso ao contato e sem lembrete WhatsApp/e-mail', () => {
  const INICIO = '2026-10-28T14:00:00.000Z';
  const LEMBRETES = [
    { minutes_before: 1440, channel: 'WHATSAPP' },
    { minutes_before: 60, channel: 'WHATSAPP' },
    { minutes_before: 30, channel: 'PUSH' },
  ];
  function montar(labs: string[], respostas: Respostas = {}, leads: Record<string, string> = {}) {
    let criados: any[] = [];
    const b = banco(labs, {
      'patient.findUnique': () => null,
      'globalSetting.findUnique': () => null,
      'lead.findUnique': ({ where }) => ({ tenant_id: leads[where.id] ?? null }),
      'calendarEvent.create': ({ data }) => ({
        id: 'evento-1',
        ...data,
        reminders: (data.reminders?.create ?? []).map((r: any, i: number) => ({ id: `lembrete-${i + 1}`, event_id: 'evento-1', ...r })),
        assigned_user: { id: data.assigned_user_id, name: 'Dra. Ana Exemplo' },
        lead: data.lead_id ? { id: data.lead_id, name: 'Maria Exemplo', phone: TEL[CLINICA], is_client: true } : null,
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
    const svc = new CalendarService(b.prisma, { emitCalendarUpdate: jest.fn() }, fila, waitlist, {} as any, {} as any, { get: () => undefined });
    const avisos: any[] = [];
    jest.spyOn(svc, 'sendAppointmentEventWhatsapp').mockImplementation(async (...a: any[]) => {
      avisos.push(['whatsapp', a[1], a[2], a[3], a[4]]);
      return { sent: true };
    });
    jest.spyOn(svc, 'sendAppointmentEventEmail').mockImplementation(async (...a: any[]) => {
      avisos.push(['email', a[1], a[2], a[3], a[4]]);
    });
    return { svc, fila, avisos, ...b };
  }
  const evento = (t: string | undefined, extra: Record<string, any> = {}) => ({
    type: 'CONSULTA', title: 'Consulta exemplo', start_at: INICIO, end_at: '2026-10-28T14:30:00.000Z', lead_id: 'lead-1',
    assigned_user_id: 'dentista-1', created_by_id: 'recepcao-1', tenant_id: t, actor_roles: ['OPERADOR'], reminders: LEMBRETES, ...extra,
  });
  const lembretesCriados = (m: ReturnType<typeof montar>) => m.de('calendarEvent.create')[0].data.reminders?.create;

  it('criar, clínica sem laboratório: os 3 lembretes, os 2 jobs e o aviso "agendada" (e-mail + WhatsApp), como antes', async () => {
    const m = montar([]);
    await m.svc.create(evento(CLINICA));
    await esperar();
    expect(lembretesCriados(m)).toEqual(LEMBRETES);
    expect(m.fila.add.mock.calls.map((c: any[]) => c[1].reminderId)).toEqual(['lembrete-1', 'lembrete-2']);
    expect(m.avisos).toEqual([
      ['email', undefined, 'lead-1', CLINICA, 'agendamento_criado'],
      ['whatsapp', undefined, 'lead-1', CLINICA, 'created'],
    ]);
  });

  it('criar, clínica com OUTRA conta laboratório: o mesmo rastro, os mesmos jobs e avisos', async () => {
    const antes = montar([]);
    await antes.svc.create(evento(CLINICA));
    await esperar();
    const depois = montar([LAB]);
    await depois.svc.create(evento(CLINICA));
    await esperar();
    expect(depois.ops).toEqual(antes.ops);
    expect(depois.fila.add.mock.calls).toEqual(antes.fila.add.mock.calls);
    expect(depois.avisos).toEqual(antes.avisos);
  });

  it('criar, laboratório: o evento nasce só com o lembrete PUSH da equipe; nenhum job, nenhum aviso', async () => {
    const m = montar([LAB]);
    // F2 parte 4: a agenda do laboratório só aceita tipos sem consulta (OUTRO, TAREFA, BLOQUEIO).
    await m.svc.create(evento(LAB, { type: 'OUTRO' }));
    await esperar();
    expect(m.de('calendarEvent.create')).toHaveLength(1);
    expect(lembretesCriados(m)).toEqual([{ minutes_before: 30, channel: 'PUSH' }]);
    expect(m.fila.add).not.toHaveBeenCalled();
    expect(m.avisos).toEqual([]);
    expect(registrou('log', '[LAB-GATE] lembretes-agenda')).toBe(true);
  });

  const LEADS = { 'lead-lab': LAB, 'lead-clinica': CLINICA };
  it('criar sem conta no evento, contato de laboratório: sem lembrete ao contato', async () => {
    const lab = montar([LAB], {}, LEADS);
    await lab.svc.create(evento(undefined, { lead_id: 'lead-lab', type: 'OUTRO' }));
    expect(lembretesCriados(lab)).toEqual([{ minutes_before: 30, channel: 'PUSH' }]);
    expect(lab.fila.add).not.toHaveBeenCalled();
  });

  const PACIENTES: Record<string, string> = { 'pac-lab': LAB, 'pac-clinica': CLINICA };
  const pacientes = { 'patient.findUnique': ({ where }: any) => ({ tenant_id: PACIENTES[where.id] ?? null }) };

  it('criar sem conta no evento nem contato, paciente do laboratório: sem lembrete ao contato', async () => {
    const lab = montar([LAB], pacientes, LEADS);
    await lab.svc.create(evento(undefined, { lead_id: undefined, patient_id: 'pac-lab', type: 'OUTRO' }));
    expect(lembretesCriados(lab)).toEqual([{ minutes_before: 30, channel: 'PUSH' }]);
    expect(lab.fila.add).not.toHaveBeenCalled();
    expect(lab.avisos).toEqual([]);
  });

  it('criar sem conta no evento nem contato, paciente de clínica com OUTRA conta laboratório: os lembretes de antes', async () => {
    const clinica = montar([LAB], pacientes, LEADS);
    await clinica.svc.create(evento(undefined, { lead_id: undefined, patient_id: 'pac-clinica' }));
    expect(lembretesCriados(clinica)).toEqual(LEMBRETES);
  });

  it('criar sem conta no evento, contato de clínica com OUTRA conta laboratório: os lembretes de antes', async () => {
    const clinica = montar([LAB], {}, LEADS);
    await clinica.svc.create(evento(undefined, { lead_id: 'lead-clinica' }));
    expect(lembretesCriados(clinica)).toEqual(LEMBRETES);
    expect(clinica.fila.add).toHaveBeenCalledTimes(2);
  });

  const antes = (t: string) => ({
    'calendarEvent.findUnique': () => ({
      type: 'CONSULTA', start_at: new Date(INICIO), location: null, lead_id: 'lead-1', status: 'AGENDADO',
      assigned_user_id: 'dentista-1', tenant_id: t, validated_at: null, validated_by_user_id: null,
    }),
    'calendarEvent.update': ({ where, data }: any) => ({
      id: where.id, type: 'CONSULTA', status: 'AGENDADO', start_at: data.start_at ?? new Date(INICIO), lead_id: 'lead-1',
      patient_id: null, tenant_id: t, assigned_user_id: 'dentista-1', assigned_user: { id: 'dentista-1', name: 'Dra. Ana Exemplo' },
      lead: { id: 'lead-1', name: 'Maria Exemplo', phone: TEL[CLINICA], is_client: true }, reminders: [],
    }),
  });
  const remarcar = { start_at: '2026-10-29T14:00:00.000Z', reminders: [{ minutes_before: 1440, channel: 'WHATSAPP' }, { minutes_before: 30, channel: 'PUSH' }] };

  it('remarcar, clínica sem laboratório: troca os lembretes, re-enfileira e avisa "remarcada", como antes', async () => {
    const m = montar([], antes(CLINICA));
    await m.svc.update('evento-1', remarcar);
    await esperar();
    expect(m.de('eventReminder.createMany')).toEqual([{
      data: [
        { event_id: 'evento-1', minutes_before: 1440, channel: 'WHATSAPP' },
        { event_id: 'evento-1', minutes_before: 30, channel: 'PUSH' },
      ],
    }]);
    expect(m.fila.add.mock.calls.map((c: any[]) => c[1].reminderId)).toEqual(['novo-1']);
    expect(m.avisos).toEqual([
      ['whatsapp', null, 'lead-1', CLINICA, 'rescheduled'],
      ['email', null, 'lead-1', CLINICA, 'agendamento_remarcado'],
    ]);
  });

  it('remarcar, clínica com OUTRA conta laboratório: o mesmo rastro, jobs e avisos', async () => {
    const a = montar([], antes(CLINICA));
    await a.svc.update('evento-1', remarcar);
    await esperar();
    const d = montar([LAB], antes(CLINICA));
    await d.svc.update('evento-1', remarcar);
    await esperar();
    expect(d.ops).toEqual(a.ops);
    expect(d.fila.add.mock.calls).toEqual(a.fila.add.mock.calls);
    expect(d.avisos).toEqual(a.avisos);
  });

  it('remarcar, laboratório: só o lembrete PUSH, nada re-enfileirado, sem aviso', async () => {
    const m = montar([LAB], antes(LAB));
    await m.svc.update('evento-1', remarcar);
    await esperar();
    expect(m.de('eventReminder.createMany')).toEqual([{ data: [{ event_id: 'evento-1', minutes_before: 30, channel: 'PUSH' }] }]);
    expect(m.fila.add).not.toHaveBeenCalled();
    expect(m.avisos).toEqual([]);
  });

  // Lembrete SEM canal: no criar o padrão gravado é PUSH (da equipe, fica); no remarcar
  // o padrão gravado é WHATSAPP (ao contato, sai no laboratório).
  it('criar, laboratório, lembrete sem canal: vale o padrão do criar (PUSH) e fica', async () => {
    const m = montar([LAB]);
    await m.svc.create(evento(LAB, { type: 'OUTRO', reminders: [{ minutes_before: 45 }, { minutes_before: 1440, channel: 'WHATSAPP' }] }));
    await esperar();
    expect(lembretesCriados(m)).toEqual([{ minutes_before: 45, channel: 'PUSH' }]);
    expect(m.fila.add).not.toHaveBeenCalled();
  });

  it('remarcar, laboratório, lembrete sem canal: vale o padrão do remarcar (WHATSAPP) e sai', async () => {
    const m = montar([LAB], antes(LAB));
    await m.svc.update('evento-1', { start_at: '2026-10-29T14:00:00.000Z', reminders: [{ minutes_before: 45 }, { minutes_before: 30, channel: 'PUSH' }] });
    await esperar();
    expect(m.de('eventReminder.createMany')).toEqual([{ data: [{ event_id: 'evento-1', minutes_before: 30, channel: 'PUSH' }] }]);
    expect(m.fila.add).not.toHaveBeenCalled();
  });

  const lembreteAntigo = { id: 'antigo-1', minutes_before: 1440, channel: 'WHATSAPP' };
  const comAntigo = (t: string) => ({
    ...antes(t),
    'calendarEvent.update': (a: any) => ({ ...antes(t)['calendarEvent.update'](a), reminders: [lembreteAntigo] }),
  });

  it('remarcar só a data (lembretes antigos ficam), clínica com OUTRA conta laboratório: re-enfileira, como antes', async () => {
    const clinica = montar([LAB], comAntigo(CLINICA));
    await clinica.svc.update('evento-1', { start_at: '2026-10-29T14:00:00.000Z' });
    expect(clinica.fila.add.mock.calls.map((c: any[]) => c[1].reminderId)).toEqual(['antigo-1']);
  });

  it('remarcar só a data (lembretes antigos ficam), laboratório: nada re-enfileirado', async () => {
    const lab = montar([LAB], comAntigo(LAB));
    await lab.svc.update('evento-1', { start_at: '2026-10-29T14:00:00.000Z' });
    expect(lab.fila.add).not.toHaveBeenCalled();
  });

  // ── F2 parte 4: a agenda do laboratório não tem consulta/procedimento/retorno ──
  it('criar CONSULTA, laboratório (pela conta ou pelo contato): recusa com VERTICAL_DENIED e nada é gravado', async () => {
    for (const [t, extra] of [[LAB, {}], [undefined, { lead_id: 'lead-lab' }]] as Array<[string | undefined, any]>) {
      const m = montar([LAB], {}, LEADS);
      const e = await erro(m.svc.create(evento(t, extra)));
      expect(codigo(e)).toBe(CODIGO_VERTICAL_NEGADA);
      expect(m.de('calendarEvent.create')).toEqual([]);
    }
    expect(logs.some((l) => l.msg.includes('[LAB-GATE] agenda-tipo'))).toBe(true);
  });

  it.each(['TAREFA', 'OUTRO', 'BLOQUEIO'])('criar %s, laboratório: cria', async (tipo) => {
    const m = montar([LAB]);
    await m.svc.create(evento(LAB, { type: tipo, reminders: [] }));
    expect(m.de('calendarEvent.create')).toHaveLength(1);
  });

  it('criar CONSULTA, clínica com OUTRA conta laboratório: cria como antes', async () => {
    const m = montar([LAB]);
    await m.svc.create(evento(CLINICA));
    expect(m.de('calendarEvent.create')).toHaveLength(1);
  });

  it('trocar para CONSULTA: laboratório recusa; para OUTRO, troca; na clínica troca como antes', async () => {
    const lab = montar([LAB], antes(LAB));
    expect(codigo(await erro(lab.svc.update('evento-1', { type: 'CONSULTA' })))).toBe(CODIGO_VERTICAL_NEGADA);
    expect(lab.de('calendarEvent.update')).toEqual([]);
    const labOutro = montar([LAB], antes(LAB));
    await labOutro.svc.update('evento-1', { type: 'OUTRO' });
    expect(labOutro.de('calendarEvent.update')).toHaveLength(1);
    const clinicaSem = montar([], antes(CLINICA));
    await clinicaSem.svc.update('evento-1', { type: 'PROCEDIMENTO' });
    const clinica = montar([LAB], antes(CLINICA));
    await clinica.svc.update('evento-1', { type: 'PROCEDIMENTO' });
    expect(clinica.ops).toEqual(clinicaSem.ops);
    expect(clinica.de('calendarEvent.update')).toHaveLength(1);
  });

  const notificar = (t: string) => ({
    'calendarEvent.findUnique': (a: any) =>
      a.select
        ? { id: 'evento-1', type: 'CONSULTA', status: 'AGENDADO', title: 'Consulta', lead: { phone: TEL[CLINICA] }, patient: null }
        : { id: 'evento-1', type: 'CONSULTA', start_at: new Date(INICIO), tenant_id: t, lead_id: 'lead-1', patient_id: null, assigned_user: null, lead: { id: 'lead-1' } },
  });

  it('"Notificar" manual, clínica sem laboratório e com OUTRA conta laboratório: manda igual', async () => {
    const a = montar([], notificar(CLINICA));
    expect(await a.svc.notifyEvent('evento-1')).toEqual({ queued: true, message: 'WhatsApp enviado ao paciente ✅' });
    expect(a.avisos).toEqual([['whatsapp', null, 'lead-1', CLINICA, 'created']]);
    const d = montar([LAB], notificar(CLINICA));
    await d.svc.notifyEvent('evento-1');
    expect(d.ops).toEqual(a.ops);
    expect(d.avisos).toEqual(a.avisos);
  });

  it('"Notificar" manual, laboratório: recusa (VERTICAL_DENIED), nada sai', async () => {
    const m = montar([LAB], notificar(LAB));
    expect(codigo(await erro(m.svc.notifyEvent('evento-1')))).toBe(CODIGO_VERTICAL_NEGADA);
    expect(m.avisos).toEqual([]);
  });

  const EV: Record<string, any> = { id: 'evento-1', status: 'AGENDADO', start_at: new Date(INICIO), lead_id: 'lead-1', patient_id: null };
  const reenviar = (t: string) => ({
    'eventReminder.findFirst': ({ include }: any) => ({
      id: 'lembrete-1',
      channel: 'WHATSAPP',
      event: Object.fromEntries(Object.keys(include.event.select).map((k) => [k, { ...EV, tenant_id: t }[k]])),
    }),
  });

  it('reenviar lembrete, clínica sem laboratório: a mesma consulta, zera e re-enfileira, como antes', async () => {
    const m = montar([], reenviar(CLINICA));
    expect(await m.svc.resendReminder('lembrete-1', CLINICA)).toEqual({ success: true, reminder_id: 'lembrete-1' });
    expect(m.de('eventReminder.findFirst')).toEqual([{
      where: { id: 'lembrete-1', event: { OR: [{ tenant_id: CLINICA }, { tenant_id: null }] } },
      include: { event: { select: { id: true, status: true, start_at: true } } },
    }]);
    expect(m.de('eventReminder.update')).toEqual([{ where: { id: 'lembrete-1' }, data: { sent_at: null, last_error: null } }]);
    expect(m.fila.add).toHaveBeenCalledTimes(1);
  });

  it('reenviar lembrete, clínica com OUTRA conta laboratório: lê a conta do evento e re-enfileira igual', async () => {
    const a = montar([], reenviar(CLINICA));
    await a.svc.resendReminder('lembrete-1', CLINICA);
    const d = montar([LAB], reenviar(CLINICA));
    await d.svc.resendReminder('lembrete-1', CLINICA);
    expect(d.de('eventReminder.findFirst')[0].include.event.select).toEqual({
      id: true, status: true, start_at: true, tenant_id: true, lead_id: true, patient_id: true,
    });
    expect(d.ops.filter(([o]) => o !== 'eventReminder.findFirst')).toEqual(a.ops.filter(([o]) => o !== 'eventReminder.findFirst'));
    expect(d.fila.add.mock.calls).toEqual(a.fila.add.mock.calls);
  });

  it('reenviar lembrete, laboratório: recusa (VERTICAL_DENIED), nada zera nem enfileira', async () => {
    const m = montar([LAB], reenviar(LAB));
    expect(codigo(await erro(m.svc.resendReminder('lembrete-1', LAB)))).toBe(CODIGO_VERTICAL_NEGADA);
    expect(m.de('eventReminder.update')).toEqual([]);
    expect(m.fila.add).not.toHaveBeenCalled();
  });

  const EVENTOS = [
    { id: 'ev-clinica', tenant_id: CLINICA, start_at: new Date(INICIO), reminders: [] },
    { id: 'ev-lab', tenant_id: LAB, start_at: new Date(INICIO), reminders: [] },
    { id: 'ev-legado', tenant_id: null, start_at: new Date(INICIO), reminders: [] },
  ];
  const backfill = {
    'calendarEvent.findMany': ({ where }: any) => EVENTOS.filter((e) => casa(where, e)),
    'eventReminder.create': ({ data }: any) => ({ id: `lem-${data.event_id}-${data.minutes_before}` }),
  };
  const eventosComLembrete = (m: ReturnType<typeof montar>) => [...new Set(m.de('eventReminder.create').map((a: any) => a.data.event_id))];

  it('backfill de lembretes, ADMIN da clínica sem laboratório e com OUTRA conta laboratório: o mesmo rastro', async () => {
    const a = montar([], backfill);
    const r = await a.svc.backfillReminders({ tenant_id: CLINICA });
    expect(r).toEqual({ events_scanned: 2, reminders_created: 6, jobs_enqueued: 6, dry_run: false });
    expect(eventosComLembrete(a)).toEqual(['ev-clinica', 'ev-legado']);
    const d = montar([LAB], backfill);
    await d.svc.backfillReminders({ tenant_id: CLINICA });
    // Com laboratório cadastrado, a busca também traz a conta do contato/paciente
    // (para o evento legado sem conta); o resto do rastro é o mesmo.
    const semInclude = (ops: any[]) =>
      ops.map(([o, args]: any[]) => (o === 'calendarEvent.findMany' ? [o, { ...args, include: undefined }] : [o, args]));
    expect(semInclude(d.ops)).toEqual(semInclude(a.ops));
    expect(a.de('calendarEvent.findMany')[0].include).toEqual({ reminders: { select: { minutes_before: true } } });
    expect(d.de('calendarEvent.findMany')[0].include).toEqual({
      reminders: { select: { minutes_before: true } },
      lead: { select: { tenant_id: true } },
      patient: { select: { tenant_id: true } },
    });
  });

  it('backfill de lembretes, evento legado sem conta: o de contato/paciente do laboratório fica sem lembrete (ADMIN da clínica e SUPER_ADMIN)', async () => {
    const LEGADOS = [
      { id: 'ev-legado-clinica', tenant_id: null, start_at: new Date(INICIO), reminders: [], lead: { tenant_id: CLINICA }, patient: null },
      { id: 'ev-legado-lead-lab', tenant_id: null, start_at: new Date(INICIO), reminders: [], lead: { tenant_id: LAB }, patient: null },
      { id: 'ev-legado-pac-lab', tenant_id: null, start_at: new Date(INICIO), reminders: [], lead: null, patient: { tenant_id: LAB } },
    ];
    const fx = {
      'calendarEvent.findMany': ({ where }: any) => LEGADOS.filter((e) => casa(where, e)),
      'eventReminder.create': ({ data }: any) => ({ id: `lem-${data.event_id}-${data.minutes_before}` }),
    };
    for (const opcoes of [{ tenant_id: CLINICA }, {}]) {
      const m = montar([LAB], fx);
      await m.svc.backfillReminders(opcoes);
      expect(eventosComLembrete(m)).toEqual(['ev-legado-clinica']);
    }
  });

  it('backfill de lembretes, ADMIN do laboratório: nada lido nem criado (nem nos legados sem conta)', async () => {
    const m = montar([LAB], backfill);
    expect(await m.svc.backfillReminders({ tenant_id: LAB })).toEqual({ events_scanned: 0, reminders_created: 0, jobs_enqueued: 0, dry_run: false });
    expect(m.ops).toEqual([]);
    expect(m.fila.add).not.toHaveBeenCalled();
  });

  it('backfill de lembretes, SUPER_ADMIN sem laboratório cadastrado: todas as contas, como antes', async () => {
    const a = montar([], backfill);
    await a.svc.backfillReminders({});
    expect(eventosComLembrete(a)).toEqual(['ev-clinica', 'ev-lab', 'ev-legado']);
  });

  it('backfill de lembretes, SUPER_ADMIN com laboratório: fora ele (null-safe)', async () => {
    const d = montar([LAB], backfill);
    await d.svc.backfillReminders({});
    expect(eventosComLembrete(d)).toEqual(['ev-clinica', 'ev-legado']);
    expect(d.de('calendarEvent.findMany')[0].where.AND[1]).toEqual(OR_SEM_LAB);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// F7 — coleta, prova e entrega (tipos só do laboratório)
// ═════════════════════════════════════════════════════════════════════════════

describe('Agenda — coleta, prova e entrega: lembretes de 48 h e 24 h e aviso do laboratório', () => {
  const INICIO = '2026-10-28T14:00:00.000Z';
  const LEMBRETES = [
    { minutes_before: 2880, channel: 'WHATSAPP' },
    { minutes_before: 1440, channel: 'WHATSAPP' },
    { minutes_before: 60, channel: 'WHATSAPP' },
    { minutes_before: 1440, channel: 'EMAIL' },
    { minutes_before: 30, channel: 'PUSH' },
  ];
  function montar(labs: string[], respostas: Respostas = {}) {
    let criados: any[] = [];
    const b = banco(labs, {
      'patient.findUnique': () => null,
      'globalSetting.findUnique': () => null,
      'lead.findUnique': () => ({ tenant_id: null }),
      'calendarEvent.create': ({ data }) => ({
        id: 'evento-1',
        ...data,
        reminders: (data.reminders?.create ?? []).map((r: any, i: number) => ({ id: `lembrete-${i + 1}`, event_id: 'evento-1', ...r })),
        assigned_user: { id: data.assigned_user_id, name: 'Bruno Exemplo' },
        lead: data.lead_id ? { id: data.lead_id, name: 'Dra. Ana Exemplo', phone: TEL[LAB], is_client: false } : null,
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
    const svc = new CalendarService(b.prisma, { emitCalendarUpdate: jest.fn() }, fila, waitlist, {} as any, {} as any, { get: () => undefined });
    const avisos: any[] = [];
    jest.spyOn(svc, 'sendAppointmentEventWhatsapp').mockImplementation(async (...a: any[]) => {
      avisos.push(['whatsapp', a[1], a[2], a[3], a[4]]);
      return { sent: true };
    });
    jest.spyOn(svc, 'sendAppointmentEventEmail').mockImplementation(async (...a: any[]) => {
      avisos.push(['email', a[1], a[2], a[3], a[4]]);
    });
    jest.spyOn(aviso, 'avisarAgendaDoLaboratorio').mockImplementation(async (_d: any, a: any) => {
      avisos.push(['laboratorio', a.patientId ?? null, a.leadId ?? null, a.tenantId, a.kind]);
      return { sent: true };
    });
    return { svc, fila, avisos, ...b };
  }
  afterEach(() => (aviso.avisarAgendaDoLaboratorio as jest.Mock).mockRestore?.());
  const evento = (t: string | undefined, extra: Record<string, any> = {}) => ({
    type: 'COLETA', title: 'Coleta exemplo', start_at: INICIO, end_at: '2026-10-28T14:30:00.000Z', lead_id: 'lead-1',
    assigned_user_id: 'equipe-1', created_by_id: 'recepcao-1', tenant_id: t, actor_roles: ['OPERADOR'], reminders: LEMBRETES, ...extra,
  });
  const lembretesCriados = (m: ReturnType<typeof montar>) => m.de('calendarEvent.create')[0].data.reminders?.create;

  it.each(['COLETA', 'PROVA', 'ENTREGA'])('criar %s, laboratório: PUSH + WhatsApp 48 h/24 h, os 2 jobs e o aviso do laboratório', async (tipo) => {
    const m = montar([LAB]);
    await m.svc.create(evento(LAB, { type: tipo }));
    await esperar();
    expect(lembretesCriados(m)).toEqual([
      { minutes_before: 2880, channel: 'WHATSAPP' },
      { minutes_before: 1440, channel: 'WHATSAPP' },
      { minutes_before: 30, channel: 'PUSH' },
    ]);
    expect(m.fila.add.mock.calls.map((c: any[]) => c[1].reminderId)).toEqual(['lembrete-1', 'lembrete-2']);
    expect(m.avisos).toEqual([['laboratorio', null, 'lead-1', LAB, 'created']]);
    expect(registrou('log', '[LAB-AGENDA] lembretes')).toBe(true);
  });

  it('criar coleta, clínica (com e sem laboratório cadastrado): o mesmo 400 de antes, o mesmo rastro, nada gravado', async () => {
    const a = montar([]);
    const ea = await erro(a.svc.create(evento(CLINICA)));
    const d = montar([LAB]);
    const ed = await erro(d.svc.create(evento(CLINICA)));
    for (const e of [ea, ed]) {
      expect(e).toBeInstanceOf(BadRequestException);
      expect(e.message).toBe(
        'Tipo invalido: COLETA. Use: CONSULTA, PROCEDIMENTO, RETORNO, ORTODONTIA, BLOQUEIO, TAREFA, OUTRO, AUDIENCIA, PERICIA, PRAZO',
      );
    }
    expect(d.ops).toEqual(a.ops);
    expect(a.ops).toEqual([]);
    expect([...a.avisos, ...d.avisos]).toEqual([]);
  });

  it('criar coleta sem conta no evento, contato de laboratório: só o lembrete da equipe e sem aviso (o aviso é da conta)', async () => {
    const m = montar([LAB], { 'lead.findUnique': () => ({ tenant_id: LAB }) });
    await m.svc.create(evento(undefined));
    await esperar();
    expect(lembretesCriados(m)).toEqual([{ minutes_before: 30, channel: 'PUSH' }]);
    expect(m.fila.add).not.toHaveBeenCalled();
    expect(m.avisos).toEqual([]);
  });

  it('criar coleta sem cliente: 400 com o texto do laboratório e nada é gravado', async () => {
    const m = montar([LAB]);
    const e = await erro(m.svc.create(evento(LAB, { lead_id: undefined })));
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.message).toBe(LAB_AGENDA_TEXTOS.clienteObrigatorio);
    expect(m.de('calendarEvent.create')).toEqual([]);
  });

  it('criar CONSULTA, laboratório: continua recusada com VERTICAL_DENIED', async () => {
    const m = montar([LAB]);
    expect(codigo(await erro(m.svc.create(evento(LAB, { type: 'CONSULTA' }))))).toBe(CODIGO_VERTICAL_NEGADA);
    expect(m.de('calendarEvent.create')).toEqual([]);
  });

  const antes = (t: string, tipo = 'COLETA') => ({
    'calendarEvent.findUnique': () => ({
      type: tipo, start_at: new Date(INICIO), location: null, lead_id: 'lead-1', status: 'AGENDADO',
      assigned_user_id: 'equipe-1', tenant_id: t, validated_at: null, validated_by_user_id: null,
    }),
    'calendarEvent.update': ({ where, data }: any) => ({
      id: where.id, type: data.type ?? tipo, status: 'AGENDADO', start_at: data.start_at ?? new Date(INICIO), lead_id: 'lead-1',
      patient_id: null, tenant_id: t, assigned_user_id: 'equipe-1', assigned_user: { id: 'equipe-1', name: 'Bruno Exemplo' },
      lead: { id: 'lead-1', name: 'Dra. Ana Exemplo', phone: TEL[LAB], is_client: true }, reminders: [],
    }),
  });
  const remarcar = { start_at: '2026-10-29T14:00:00.000Z', reminders: LEMBRETES };

  it('remarcar coleta, laboratório: 48 h/24 h WhatsApp e o PUSH ficam, os 2 re-enfileirados e o aviso de remarcação do laboratório', async () => {
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
    expect(m.avisos).toEqual([['laboratorio', null, 'lead-1', LAB, 'rescheduled']]);
  });

  it('trocar para coleta, clínica (com e sem laboratório cadastrado): o 400 de antes e o mesmo rastro', async () => {
    const a = montar([], antes(CLINICA, 'CONSULTA'));
    const ea = await erro(a.svc.update('evento-1', { type: 'COLETA' }));
    const d = montar([LAB], antes(CLINICA, 'CONSULTA'));
    const ed = await erro(d.svc.update('evento-1', { type: 'COLETA' }));
    for (const e of [ea, ed]) expect(e.message).toBe('Tipo invalido: COLETA');
    expect(d.ops).toEqual(a.ops);
    expect(a.de('calendarEvent.update')).toEqual([]);
  });

  it('trocar OUTRO para coleta, laboratório: troca', async () => {
    const m = montar([LAB], antes(LAB, 'OUTRO'));
    await m.svc.update('evento-1', { type: 'COLETA' });
    expect(m.de('calendarEvent.update')).toHaveLength(1);
  });
});
