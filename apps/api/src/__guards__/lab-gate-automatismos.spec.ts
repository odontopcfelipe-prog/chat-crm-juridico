/**
 * F2 parte 2b do laboratório — @Cron, @Processor e ganchos de boot da API que mandam
 * mensagem/e-mail com texto de clínica ou criam entidade de clínica. Conta de
 * laboratório não recebe nenhum destes; a clínica segue EXATAMENTE como antes (mesmas
 * consultas, mesmos argumentos, mesma ordem).
 *
 *  - retorno de manutenção (cron da Central de Disparos);
 *  - regras "sem resposta" 24/48 h (ENROLL_FOLLOWUP, tarefa, nota, etapa);
 *  - resumo diário do dentista (cron e sendDentistDailySummaryNow, inclusive a chave
 *    global sem conta);
 *  - aniversário (o laboratório nem marca last_run_date);
 *  - "pacientes sem agendamento" aos ADMs;
 *  - backfill do retorno pós-tratamento (cron das 4 h e boot);
 *  - fila calendar-reminders: lembretes 48/24 h, 1 h e 15 min (WhatsApp e e-mail) e o
 *    aviso de audiência/perícia;
 *  - fila fechamento-jobs (negociação aprovada + boleto da entrada);
 *  - régua por e-mail ("vence amanhã" e "pagamento em atraso");
 *  - apresentação do Financeiro/âncora no fechamento e a entrega automática do carnê D+2.
 *
 * Cada freio tem três casos: (a) sem laboratório cadastrado (o caso de produção hoje)
 * = mesmas chamadas de antes (esses casos passam também contra o código anterior);
 * (b) clínica com OUTRA conta laboratório = igual ao (a); (c) laboratório = nada sai,
 * nada é criado.
 *
 * O banco falso grava cada operação (menos a leitura da lista de laboratórios, que é
 * a única coisa nova para a clínica) e responde aos where só no que importa aqui: a
 * conta da linha (e a do contato dela) contra `tenant_id: null | { notIn } | { in } |
 * { not: null }`, como o Postgres. Sem filtro no where, a linha do laboratório volta.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { BadRequestException, Logger } from '@nestjs/common';
import {
  __limparCacheLabTenants,
  lembreteClinicoIdFor,
  retornoDisparoId,
  retornoToggleKey,
} from '@crm/shared';
import { RetornoDisparosService } from '../agenda-extended/retorno-disparos.service';
import { AutomationsService } from '../automations/automations.service';
import { CalendarCronService } from '../calendar/calendar-cron.service';
import { CalendarReminderWorker } from '../calendar/calendar-reminder.worker';
import { QuotesService } from '../commercial/quotes.service';
import { FechamentoProcessor } from '../commercial/fechamento.processor';
import { TreatmentPlansService } from '../commercial/treatment-plans.service';
import { EmailAutomationService } from '../email-automation/email-automation.service';
import { PaymentGatewayService } from '../payment-gateway/payment-gateway.service';
import { BoletoDeliveryService } from '../payment-gateway/boleto-delivery.service';
import { limparCacheAnexos } from '../disparo-anexos/disparo-anexos-envio';
import { invalidateAllSettings } from '../tenants/tenant-settings.helper';

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
// Mesmo carregador do retrato mensagens-paciente: o jest deste projeto não executa
// `await import('@crm/shared')`; o resto é o código de produção byte a byte.
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

beforeAll(() => {
  for (const m of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  }
});
beforeEach(() => {
  __limparCacheLabTenants();
  // Só o relógio é falso; promessas e timers seguem reais.
  jest.useFakeTimers({
    now: AGORA,
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
});
afterEach(() => jest.useRealTimers());

// ─── Banco falso ─────────────────────────────────────────────────────────────

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
  return { prisma, ops, de, perfis };
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

// ─── retorno de manutenção (cron da Central) ─────────────────────────────────

describe('Retorno de manutenção (cron) — laboratório não dispara', () => {
  const TOQUE = retornoDisparoId('limpeza', 'no_dia');
  // O marca-passo sorteia 3–7 min: fixo aqui para os rastros compararem.
  beforeEach(() => jest.spyOn(Math, 'random').mockReturnValue(0.5));
  afterEach(() => (Math.random as jest.Mock).mockRestore());
  function montar(labs: string[], contas = [CLINICA, LAB, OUTRA_CLINICA]) {
    for (const t of [CLINICA, LAB, OUTRA_CLINICA]) limparCacheAnexos(t, TOQUE);
    const pac = (t: string) => ({ id: `pac-${t}`, name: `Maria ${t}`, phone: TEL[t], status: 'ACTIVE', lead_id: null, lead: null });
    const b = banco(labs, {
      'globalSetting.findMany': () => contas.map((t) => ({ key: retornoToggleKey(TOQUE, t) })),
      'instance.findMany': ({ where }) => [{ name: `chip-${where.tenant_id}`, purpose: 'CLINICA' }],
      'patient.findMany': ({ where }) => [pac(where.tenant_id)],
      'patient.findFirst': ({ where }) => pac(where.tenant_id),
      'tenant.findUnique': ({ where }) => ({ name: `Clínica ${where.id}` }),
      'auditLog.create': ({ data }) => ({ id: `marca-${data.tenant_id}` }),
    });
    const board = {
      getMaintenanceBoard: jest.fn(async (t: string) => ({
        procedures: [],
        recalls: [
          {
            kind: 'procedure',
            family: 'limpeza',
            patient: { id: `pac-${t}`, name: `Maria ${t}` },
            last_date: new Date('2026-04-21T12:00:00.000Z'),
            return_date: new Date('2026-10-21T12:00:00.000Z'),
          },
        ],
      })),
    };
    const whatsapp = { sendText: jest.fn(async (tel: string, ..._resto: any[]) => ({ key: { id: `wamid-${tel}` } })) };
    return { svc: new RetornoDisparosService(b.prisma, board as any, whatsapp as any), board, whatsapp, ...b };
  }
  const efeitos = (m: ReturnType<typeof montar>) => ({
    quadro: m.board.getMaintenanceBoard.mock.calls.map((c) => c[0]),
    envios: m.whatsapp.sendText.mock.calls,
    marcas: m.de('auditLog.create'),
    registros: m.de('dispatchLog.create'),
  });

  it('sem laboratório cadastrado: as três contas disparam, na ordem de antes', async () => {
    const m = montar([]);
    await m.svc.rodar(AGORA);
    const e = efeitos(m);
    expect(e.quadro).toEqual([CLINICA, LAB, OUTRA_CLINICA]);
    expect(e.envios.map((c: any[]) => [c[0], c[2], c[3], c[4]])).toEqual([
      [TEL[CLINICA], `chip-${CLINICA}`, undefined, CLINICA],
      [TEL[LAB], `chip-${LAB}`, undefined, LAB],
      [TEL[OUTRA_CLINICA], `chip-${OUTRA_CLINICA}`, undefined, OUTRA_CLINICA],
    ]);
    expect(e.marcas.map((a: any) => [a.data.tenant_id, a.data.entity_id, a.data.action])).toEqual([
      [CLINICA, `pac-${CLINICA}:limpeza:2026-10-21`, 'no_dia'],
      [LAB, `pac-${LAB}:limpeza:2026-10-21`, 'no_dia'],
      [OUTRA_CLINICA, `pac-${OUTRA_CLINICA}:limpeza:2026-10-21`, 'no_dia'],
    ]);
    expect(e.registros.map((a: any) => [a.data.tenant_id, a.data.type, a.data.status])).toEqual([
      [CLINICA, TOQUE, 'SENT'],
      [LAB, TOQUE, 'SENT'],
      [OUTRA_CLINICA, TOQUE, 'SENT'],
    ]);
  });

  it('clínica com OUTRA conta laboratório: as clínicas disparam igual (mesmo rastro, mesmos argumentos)', async () => {
    const antes = montar([]);
    await antes.svc.rodar(AGORA);
    const depois = montar([LAB]);
    await depois.svc.rodar(AGORA);
    expect(depois.ops).toEqual(semOLab(antes.ops));
    const a = efeitos(antes);
    expect(efeitos(depois)).toEqual({
      quadro: a.quadro.filter((t) => t !== LAB),
      envios: a.envios.filter((c: any[]) => c[4] !== LAB),
      marcas: a.marcas.filter((x: any) => x.data.tenant_id !== LAB),
      registros: a.registros.filter((x: any) => x.data.tenant_id !== LAB),
    });
    expect(depois.whatsapp.sendText).toHaveBeenCalledTimes(2);
  });

  it('laboratório com o toque ligado: nem lê o quadro, nem marca, nem envia', async () => {
    const m = montar([LAB], [LAB]);
    await m.svc.rodar(AGORA);
    expect(m.board.getMaintenanceBoard).not.toHaveBeenCalled();
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
    expect(tocaLab(m.ops)).toBe(false);
  });
});

// ─── regras "sem resposta" 24/48 h ───────────────────────────────────────────

describe('Regras "sem resposta" 24/48 h (cron) — conversa de laboratório fica fora', () => {
  const H = 3_600_000;
  const BASE24 = { status: { not: 'FECHADO' }, last_message_at: { gte: new Date(AGORA.getTime() - 25 * H), lte: new Date(AGORA.getTime() - 24 * H) } };
  const BASE48 = { status: { not: 'FECHADO' }, last_message_at: { gte: new Date(AGORA.getTime() - 49 * H), lte: new Date(AGORA.getTime() - 48 * H) } };
  const conv = (id: string, tenant: string | null, leadTenant: string | null) => ({
    id: `c-${id}`,
    lead_id: `l-${id}`,
    tenant_id: tenant,
    lead: { tenant_id: leadTenant },
  });
  const DA_CLINICA = [conv('clin', CLINICA, CLINICA), conv('legado', null, CLINICA)];
  const DO_LAB = [conv(LAB, LAB, LAB), conv(`legado-${LAB}`, null, LAB)];

  function montar(labs: string[], convs: any[]) {
    const b = banco(labs, {
      'automationRule.findMany': ({ where }) =>
        where.trigger === 'NO_RESPONSE_24H'
          ? [{ id: 'r24', tenant_id: null, action: 'ENROLL_FOLLOWUP', action_value: 'seq-1' }]
          : [{ id: 'r48', tenant_id: null, action: 'CREATE_TASK', action_value: '{"title":"Ligar para o contato"}' }],
      'conversation.findMany': ({ where }) =>
        convs.filter((c) => casa(where, c)).map(({ id, lead_id, tenant_id }) => ({ id, lead_id, tenant_id })),
      'lead.findUnique': ({ where }) => ({ tenant_id: convs.find((c) => c.lead_id === where.id)?.lead.tenant_id ?? null }),
      'conversation.findUnique': ({ where }) => ({ tenant_id: convs.find((c) => c.id === where.id)?.tenant_id ?? null }),
    });
    const followup = { enrollLead: jest.fn(async () => ({})) };
    const moduleRef: any = { get: jest.fn(() => followup) };
    return { svc: new AutomationsService(b.prisma, moduleRef), followup, ...b };
  }
  const efeitos = (m: ReturnType<typeof montar>) => ({
    inscricoes: m.followup.enrollLead.mock.calls,
    tarefas: m.de('task.create'),
  });

  it('sem laboratório cadastrado: mesmo where de antes e age em todas as conversas', async () => {
    const m = montar([], [...DA_CLINICA, ...DO_LAB]);
    await m.svc.checkNoResponse();
    expect(m.de('conversation.findMany')).toEqual([
      { where: BASE24, select: { id: true, lead_id: true, tenant_id: true } },
      { where: BASE48, select: { id: true, lead_id: true, tenant_id: true } },
    ]);
    expect(m.followup.enrollLead.mock.calls).toEqual([
      ['l-clin', 'seq-1'],
      ['l-legado', 'seq-1'],
      [`l-${LAB}`, 'seq-1'],
      [`l-legado-${LAB}`, 'seq-1'],
    ]);
    expect(m.de('task.create').map((a: any) => [a.data.conversation_id, a.data.tenant_id ?? null])).toEqual([
      ['c-clin', CLINICA],
      ['c-legado', CLINICA],
      [`c-${LAB}`, LAB],
      [`c-legado-${LAB}`, LAB],
    ]);
  });

  it('clínica com OUTRA conta laboratório: where de antes + fora o laboratório (null-safe, conversa e contato); efeitos iguais', async () => {
    const antes = montar([], DA_CLINICA);
    await antes.svc.checkNoResponse();
    const depois = montar([LAB], DA_CLINICA);
    await depois.svc.checkNoResponse();
    const lead = { AND: [{}, OR_SEM_LAB] };
    expect(depois.de('conversation.findMany').map((a: any) => a.where)).toEqual([
      { AND: [{ ...BASE24, lead }, OR_SEM_LAB] },
      { AND: [{ ...BASE48, lead }, OR_SEM_LAB] },
    ]);
    expect(efeitos(depois)).toEqual(efeitos(antes));
    expect(depois.followup.enrollLead).toHaveBeenCalledTimes(2);
    expect(depois.ops.filter(([o]) => o !== 'conversation.findMany')).toEqual(
      antes.ops.filter(([o]) => o !== 'conversation.findMany'),
    );
  });

  it('laboratório: nem inscreve em follow-up, nem cria tarefa (inclusive conversa legada de contato do laboratório)', async () => {
    const m = montar([LAB], [...DA_CLINICA, ...DO_LAB]);
    await m.svc.checkNoResponse();
    expect(m.followup.enrollLead.mock.calls).toEqual([
      ['l-clin', 'seq-1'],
      ['l-legado', 'seq-1'],
    ]);
    expect(m.de('task.create').map((a: any) => a.data.conversation_id)).toEqual(['c-clin', 'c-legado']);
    expect(tocaLab(m.ops.filter(([o]) => o !== 'conversation.findMany'))).toBe(false);
  });
});

// ─── resumo diário do dentista ───────────────────────────────────────────────

describe('Resumo diário do dentista (cron) — conta de laboratório não recebe', () => {
  const cfg = JSON.stringify({ enabled: true, send_at: '12:00' });
  function montar(labs: string[]) {
    const b = banco(labs, {
      'globalSetting.findMany': () => [
        { key: `DENTIST_DAILY_SUMMARY_${CLINICA}`, value: cfg },
        { key: `DENTIST_DAILY_SUMMARY_${LAB}`, value: cfg },
        { key: 'DENTIST_DAILY_SUMMARY', value: cfg },
        { key: `DENTIST_DAILY_SUMMARY_${OUTRA_CLINICA}`, value: cfg },
      ],
    });
    const agenda = { sendDentistDailySummaryNow: jest.fn(async () => ({ total: 1, results: [] })) };
    return { svc: new CalendarCronService(b.prisma, {} as any, agenda as any), agenda, ...b };
  }

  // A chave sem conta (legado) é ignorada pelo cron — o resumo é sempre por clínica
  // (resumo-dentista-por-conta.spec). Aqui só o freio de laboratório.
  it('sem laboratório cadastrado: dispara para cada chave de conta ligada, na ordem de antes', async () => {
    const m = montar([]);
    await m.svc.checkDentistDailySummary();
    expect(m.agenda.sendDentistDailySummaryNow.mock.calls).toEqual([[CLINICA], [LAB], [OUTRA_CLINICA]]);
  });

  it('clínica com OUTRA conta laboratório: igual, sem a do laboratório', async () => {
    const m = montar([LAB]);
    await m.svc.checkDentistDailySummary();
    expect(m.agenda.sendDentistDailySummaryNow.mock.calls).toEqual([[CLINICA], [OUTRA_CLINICA]]);
  });

  it('laboratório: o resumo dele não é disparado', async () => {
    const m = montar([LAB]);
    await m.svc.checkDentistDailySummary();
    expect(m.agenda.sendDentistDailySummaryNow.mock.calls.some((c: any[]) => c[0] === LAB)).toBe(false);
  });
});

describe('Resumo diário do dentista (envio: cron e "Enviar agora")', () => {
  const ROLES = [{ roles: { has: 'DENTIST' } }, { roles: { has: 'ADMIN' }, specialties: { isEmpty: false } }];
  const SELECT = { id: true, name: true, phone: true, disparos_off: true };
  const USUARIOS = [
    { id: `u-${CLINICA}`, name: 'Dra. Ana Exemplo', phone: '5582900000011', disparos_off: [], tenant_id: CLINICA },
    { id: `u-${LAB}`, name: 'Dr. Lab Exemplo', phone: '5582900000013', disparos_off: [], tenant_id: LAB },
    { id: 'u-sem-conta', name: 'Dr. Sem Conta', phone: '5582900000019', disparos_off: [], tenant_id: null },
  ];
  function montar(labs: string[]) {
    const b = banco(labs, {
      'globalSetting.findUnique': ({ where }) =>
        where.key.startsWith('DENTIST_DAILY_SUMMARY') ? { value: JSON.stringify({ enabled: true, channel: 'WHATSAPP' }) } : null,
      'user.findMany': ({ where, select }) =>
        USUARIOS.filter((u) => !where.tenant_id || u.tenant_id === where.tenant_id).map((u: any) =>
          Object.fromEntries(Object.keys(select).map((k) => [k, u[k]])),
        ),
      'calendarEvent.findMany': ({ where }) => [
        { start_at: new Date('2026-10-21T14:30:00.000Z'), type: 'CONSULTA', patient: { name: `Paciente de ${where.assigned_user_id}` }, lead: null },
      ],
      'instance.findFirst': ({ where }) => ({ name: `chip-${where.tenant_id}` }),
    });
    const whatsapp = { sendText: jest.fn(async (tel: string, ..._resto: any[]) => ({ key: { id: `wamid-${tel}` } })) };
    const svc = new CalendarService(b.prisma, {} as any, {} as any, {} as any, whatsapp, {} as any, {} as any);
    return { svc, whatsapp, ...b };
  }

  it('clínica, sem laboratório cadastrado: mesma consulta de antes e o dentista recebe', async () => {
    const m = montar([]);
    const r = await m.svc.sendDentistDailySummaryNow(CLINICA);
    expect(m.de('user.findMany')).toEqual([{ where: { tenant_id: CLINICA, OR: ROLES }, select: SELECT }]);
    expect(m.whatsapp.sendText.mock.calls.map((c: any[]) => [c[0], c[2], c[3], c[4]])).toEqual([
      ['5582900000011', `chip-${CLINICA}`, undefined, CLINICA],
    ]);
    expect(m.whatsapp.sendText.mock.calls[0][1]).toContain('Paciente de u-tenant-clinica');
    expect(r.total).toBe(1);
  });

  it('clínica com OUTRA conta laboratório: o mesmo rastro e o mesmo envio', async () => {
    const antes = montar([]);
    await antes.svc.sendDentistDailySummaryNow(CLINICA);
    const depois = montar([LAB]);
    await depois.svc.sendDentistDailySummaryNow(CLINICA);
    expect(depois.ops).toEqual(antes.ops);
    expect(depois.whatsapp.sendText.mock.calls).toEqual(antes.whatsapp.sendText.mock.calls);
  });

  it('laboratório ("Enviar agora" ou cron): nada é lido, nada sai', async () => {
    const m = montar([LAB]);
    expect(await m.svc.sendDentistDailySummaryNow(LAB)).toEqual({ total: 0, results: [] });
    expect(m.ops).toEqual([]);
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('sem conta (chave global antiga): recusado antes de ler qualquer coisa, com ou sem laboratório', async () => {
    for (const labs of [[], [LAB]]) {
      const m = montar(labs);
      const e = await m.svc.sendDentistDailySummaryNow(undefined).catch((x: any) => x);
      expect(e).toBeInstanceOf(BadRequestException);
      expect(m.ops).toEqual([]);
      expect(m.whatsapp.sendText).not.toHaveBeenCalled();
    }
  });
});

// ─── aniversário ─────────────────────────────────────────────────────────────

describe('Aniversário (cron) — laboratório não manda nem marca last_run_date', () => {
  const cfg = JSON.stringify({ enabled: true, send_at: '12:00' });
  function montar(labs: string[]) {
    const b = banco(labs, {
      'globalSetting.findMany': () => [CLINICA, LAB, OUTRA_CLINICA].map((t) => ({ key: `BIRTHDAY_GREETING_${t}`, value: cfg })),
    });
    const chamadas: any[] = [];
    const agenda = {
      setBirthdayGreetingConfig: jest.fn(async (...a: any[]) => chamadas.push(['marca', ...a])),
      sendBirthdayGreetingsNow: jest.fn(async (...a: any[]) => chamadas.push(['envia', ...a])),
    };
    return { svc: new CalendarCronService(b.prisma, {} as any, agenda as any), chamadas, ...b };
  }

  it('sem laboratório cadastrado: marca e envia em cada conta, na ordem de antes', async () => {
    const m = montar([]);
    await m.svc.checkBirthdayGreetings();
    expect(m.chamadas).toEqual([
      ['marca', CLINICA, { last_run_date: '2026-10-21' }],
      ['envia', CLINICA, 1],
      ['marca', LAB, { last_run_date: '2026-10-21' }],
      ['envia', LAB, 1],
      ['marca', OUTRA_CLINICA, { last_run_date: '2026-10-21' }],
      ['envia', OUTRA_CLINICA, 1],
    ]);
  });

  it('clínica com OUTRA conta laboratório: igual, sem as do laboratório', async () => {
    const m = montar([LAB]);
    await m.svc.checkBirthdayGreetings();
    expect(m.chamadas).toEqual([
      ['marca', CLINICA, { last_run_date: '2026-10-21' }],
      ['envia', CLINICA, 1],
      ['marca', OUTRA_CLINICA, { last_run_date: '2026-10-21' }],
      ['envia', OUTRA_CLINICA, 1],
    ]);
  });

  it('laboratório: nem grava last_run_date, nem envia', async () => {
    const m = montar([LAB]);
    await m.svc.checkBirthdayGreetings();
    expect(tocaLab(m.chamadas)).toBe(false);
  });
});

// ─── pacientes sem agendamento ───────────────────────────────────────────────

describe('"Pacientes sem agendamento" aos ADMs (cron) — laboratório não recebe', () => {
  const MEIA_NOITE = (() => {
    const d = new Date(AGORA);
    d.setHours(0, 0, 0, 0);
    return d;
  })();
  function montar(labs: string[]) {
    const b = banco(labs, {
      'tenant.findMany': () => [CLINICA, LAB, OUTRA_CLINICA].map((id) => ({ id, name: `Conta ${id}` })),
      'globalSetting.findUnique': ({ where }) => (where.key.startsWith('PACIENTES_SEM_AGENDAMENTO_ORTO_') ? null : { value: 'true' }),
    });
    const svc = new QuotesService(b.prisma, {} as any, {} as any, {} as any);
    jest
      .spyOn(svc, 'buildSemAgendamentoDigest')
      .mockImplementation(async (t: string) => ({ semAgendar: 1, parados: 0, standby: 0, text: `Resumo de ${t}` }) as any);
    const envio = jest.spyOn(svc as any, 'sendResumoAosAdms').mockImplementation(async () => ({ sent: [1], recipients: 1 }));
    return { svc, envio, ...b };
  }

  it('sem laboratório cadastrado: cada conta ligada recebe, na ordem de antes', async () => {
    const m = montar([]);
    await m.svc.cronPacientesSemAgendamento();
    expect(m.de('tenant.findMany')).toEqual([{ where: { status: { not: 'DELETED' } }, select: { id: true, name: true } }]);
    expect(m.envio.mock.calls).toEqual(
      [CLINICA, LAB, OUTRA_CLINICA].map((t) => [
        t,
        `Resumo de ${t}`,
        'pacientes_sem_agendamento_adm',
        { dedupSince: MEIA_NOITE, disparo: 'pacientes_sem_agendamento' },
      ]),
    );
  });

  it('clínica com OUTRA conta laboratório: o mesmo rastro e os mesmos envios, sem o laboratório', async () => {
    const antes = montar([]);
    await antes.svc.cronPacientesSemAgendamento();
    const depois = montar([LAB]);
    await depois.svc.cronPacientesSemAgendamento();
    expect(depois.ops).toEqual(semOLab(antes.ops));
    expect(depois.envio.mock.calls).toEqual(antes.envio.mock.calls.filter((c: any[]) => c[0] !== LAB));
  });

  it('laboratório: nem lê o toggle, nem monta, nem envia', async () => {
    const m = montar([LAB]);
    await m.svc.cronPacientesSemAgendamento();
    expect(tocaLab(m.ops)).toBe(false);
    expect(tocaLab(m.envio.mock.calls)).toBe(false);
    expect((m.svc.buildSemAgendamentoDigest as jest.Mock).mock.calls.some((c: any[]) => c[0] === LAB)).toBe(false);
  });
});

// ─── retorno pós-tratamento (backfill do cron das 4 h e do boot) ─────────────

describe('Retorno pós-tratamento (backfill: cron e boot) — laboratório não ganha recall', () => {
  const FIM = new Date('2026-09-01T12:00:00.000Z');
  function montar(labs: string[]) {
    invalidateAllSettings();
    const b = banco(labs, {
      'tenant.findMany': () => [CLINICA, LAB, OUTRA_CLINICA].map((id) => ({ id })),
      'treatmentPlan.findMany': ({ where }) => [
        {
          id: `plano-${where.patient.tenant_id}`,
          patient_id: `pac-${where.patient.tenant_id}`,
          status: 'COMPLETED',
          end_date: FIM,
          items: [{ status: 'DONE', executed_at: FIM }],
        },
      ],
    });
    const maintenance = { createFromPlanCompletion: jest.fn(async () => ({ id: 'retorno' })) };
    const svc = new TreatmentPlansService(b.prisma, {} as any, undefined, maintenance as any);
    return { svc, maintenance, ...b };
  }
  const retorno = (t: string) => [{ tenantId: t, patientId: `pac-${t}`, treatmentPlanId: `plano-${t}`, months: 6, completedAt: FIM }];

  it('sem laboratório cadastrado: cria o retorno de cada conta, como antes', async () => {
    const m = montar([]);
    await m.svc.cronEnsurePostTreatmentReturns();
    expect(m.de('tenant.findMany')).toEqual([{ select: { id: true } }]);
    expect(m.maintenance.createFromPlanCompletion.mock.calls).toEqual([retorno(CLINICA), retorno(LAB), retorno(OUTRA_CLINICA)]);
  });

  it('clínica com OUTRA conta laboratório: o mesmo rastro e os mesmos retornos, sem o laboratório', async () => {
    const antes = montar([]);
    await antes.svc.cronEnsurePostTreatmentReturns();
    const depois = montar([LAB]);
    await depois.svc.cronEnsurePostTreatmentReturns();
    // A leitura global do RECALL_DEFAULT_MONTHS (sem conta) é uma por conta varrida.
    const semRecall = (ops: Op[]) => ops.filter(([o, a]) => !(o === 'globalSetting.findUnique' && a?.where?.key === 'RECALL_DEFAULT_MONTHS'));
    expect(semRecall(depois.ops)).toEqual(semRecall(semOLab(antes.ops)));
    expect(depois.de('globalSetting.findUnique')).toHaveLength(antes.de('globalSetting.findUnique').length - 1);
    expect(depois.maintenance.createFromPlanCompletion.mock.calls).toEqual([retorno(CLINICA), retorno(OUTRA_CLINICA)]);
  });

  it('laboratório (cron): nem varre os planos, nem cria retorno', async () => {
    const m = montar([LAB]);
    await m.svc.cronEnsurePostTreatmentReturns();
    expect(tocaLab(m.ops)).toBe(false);
    expect(tocaLab(m.maintenance.createFromPlanCompletion.mock.calls)).toBe(false);
  });

  it('boot (+15 s): o mesmo backfill, sem o laboratório', async () => {
    const m = montar([LAB]);
    const timer = jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as any;
    }) as any);
    try {
      m.svc.onModuleInit();
      expect(timer.mock.calls[0][1]).toBe(15000);
    } finally {
      timer.mockRestore();
    }
    await esperar();
    expect(m.maintenance.createFromPlanCompletion.mock.calls).toEqual([retorno(CLINICA), retorno(OUTRA_CLINICA)]);
    expect(tocaLab(m.ops)).toBe(false);
  });
});

// ─── fila calendar-reminders: lembretes 48/24 h, 1 h, 15 min ─────────────────

describe('Lembretes da agenda (fila calendar-reminders) — evento de laboratório não envia', () => {
  const MIN = 1440;
  const evento = (t: string | null, contato: string | null = t, paciente: string | null = null) => ({
    id: 'ev-1',
    type: 'CONSULTA',
    status: 'AGENDADO',
    tenant_id: t,
    title: 'Avaliação',
    start_at: new Date('2026-10-22T14:30:00.000Z'),
    location: null,
    assigned_user: { id: 'u-1', name: 'Dra. Ana Exemplo', phone: '5582900000011' },
    lead: { id: 'lead-1', name: 'Maria Exemplo', phone: TEL[contato ?? CLINICA], tenant_id: contato },
    patient: paciente ? { id: 'pac-1', name: 'Maria Exemplo', phone: TEL[paciente], tenant_id: paciente } : null,
    reminders: [{ minutes_before: MIN }],
  });
  function montar(labs: string[], ev: any) {
    for (const t of [CLINICA, LAB, OUTRA_CLINICA]) limparCacheAnexos(t, lembreteClinicoIdFor(MIN));
    const b = banco(labs, {
      'eventReminder.findUnique': () => ({ id: 'r1', sent_at: null, minutes_before: MIN }),
      'calendarEvent.findUnique': () => ev,
      'instance.findMany': ({ where }) => [{ name: `chip-${where.tenant_id}`, purpose: 'CLINICA' }],
      'conversation.findFirst': () => ({ id: 'conv-1', instance_name: 'chip-qualquer', ai_mode: false }),
    });
    const whatsapp = { sendText: jest.fn(async (tel: string, ..._resto: any[]) => ({ key: { id: `wamid-${tel}` }, data: { key: { id: `wamid-${tel}` } } })) };
    const settings = { getAiConfig: jest.fn(async () => { throw new Error('sem IA no teste'); }) };
    const worker = new CalendarReminderWorker(b.prisma, whatsapp as any, settings as any);
    const email = jest.spyOn(worker as any, 'sendEmailReminder').mockImplementation(async () => true);
    return { worker, whatsapp, email, ...b };
  }
  const job = (channel: 'WHATSAPP' | 'EMAIL') => ({ name: 'send-reminder', id: 'j1', data: { reminderId: 'r1', eventId: 'ev-1', channel } }) as any;

  it('WhatsApp, sem laboratório cadastrado: reivindica, envia ao paciente e grava enviado, como antes', async () => {
    const m = montar([], evento(CLINICA));
    await m.worker.process(job('WHATSAPP'));
    expect(m.ops.slice(0, 4).map(([o]) => o)).toEqual([
      'eventReminder.findUnique',
      'calendarEvent.findUnique',
      'globalSetting.findUnique',
      'eventReminder.updateMany',
    ]);
    expect(m.de('globalSetting.findUnique')[0]).toEqual({ where: { key: `REMINDER_CONFIG_${CLINICA}` } });
    expect(m.de('eventReminder.updateMany')).toEqual([{ where: { id: 'r1', sent_at: null }, data: { sent_at: AGORA } }]);
    expect(m.whatsapp.sendText.mock.calls.map((c: any[]) => [c[0], c[2], c[4]])).toEqual([[TEL[CLINICA], `chip-${CLINICA}`, CLINICA]]);
    expect(m.de('eventReminder.update').at(-1)).toEqual({
      where: { id: 'r1' },
      data: { sent_at: AGORA, last_error: null, external_message_id: `wamid-${TEL[CLINICA]}` },
    });
  });

  it.each([
    ['evento da clínica', evento(CLINICA)],
    ['evento legado sem conta, contato da clínica', evento(null, CLINICA)],
  ])('WhatsApp, clínica com OUTRA conta laboratório — %s: o mesmo rastro e o mesmo envio', async (_n, ev) => {
    const antes = montar([], ev);
    await antes.worker.process(job('WHATSAPP'));
    const depois = montar([LAB], ev);
    await depois.worker.process(job('WHATSAPP'));
    expect(depois.ops).toEqual(antes.ops);
    expect(depois.whatsapp.sendText.mock.calls).toEqual(antes.whatsapp.sendText.mock.calls);
    expect(depois.whatsapp.sendText).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['evento do laboratório', evento(LAB)],
    ['evento legado sem conta, contato do laboratório', evento(null, LAB)],
    ['evento legado sem conta, paciente do laboratório', evento(null, null, LAB)],
  ])('WhatsApp, %s: não reivindica, não envia, não grava falha nem avisa', async (_n, ev) => {
    const m = montar([LAB], ev);
    await m.worker.process(job('WHATSAPP'));
    expect(m.ops.map(([o]) => o)).toEqual(['eventReminder.findUnique', 'calendarEvent.findUnique']);
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('e-mail, sem laboratório cadastrado e com OUTRA conta laboratório: reivindica e envia igual', async () => {
    const antes = montar([], evento(CLINICA));
    await antes.worker.process(job('EMAIL'));
    expect(antes.email).toHaveBeenCalledTimes(1);
    expect(antes.de('eventReminder.updateMany')).toEqual([{ where: { id: 'r1', sent_at: null }, data: { sent_at: AGORA } }]);
    const depois = montar([LAB], evento(CLINICA));
    await depois.worker.process(job('EMAIL'));
    expect(depois.ops).toEqual(antes.ops);
    expect(depois.email.mock.calls).toEqual(antes.email.mock.calls);
  });

  it('e-mail, evento do laboratório: o e-mail não sai e o lembrete não é reivindicado', async () => {
    const m = montar([LAB], evento(LAB));
    await m.worker.process(job('EMAIL'));
    expect(m.email).not.toHaveBeenCalled();
    expect(m.ops.map(([o]) => o)).toEqual(['eventReminder.findUnique', 'calendarEvent.findUnique']);
  });
});

describe('Aviso de audiência/perícia (fila calendar-reminders) — evento de laboratório não notifica', () => {
  const evento = (t: string | null, contato: string | null = t) => ({
    id: 'ev-1',
    type: 'AUDIENCIA',
    status: 'AGENDADO',
    tenant_id: t,
    title: 'Audiência',
    start_at: new Date('2026-10-22T14:30:00.000Z'),
    location: 'Fórum Exemplo',
    assigned_user: null,
    lead: { id: 'lead-1', name: 'Maria Exemplo', phone: TEL[contato ?? CLINICA], tenant_id: contato },
    patient: null,
  });
  function montar(labs: string[], ev: any) {
    const b = banco(labs, {
      'calendarEvent.findUnique': () => ev,
      'instance.findMany': ({ where }) => [{ name: `chip-${where.tenant_id}`, purpose: 'CLINICA' }],
      'conversation.findFirst': () => ({ id: 'conv-1', ai_mode: false, instance_name: 'chip-qualquer' }),
    });
    const whatsapp = { sendText: jest.fn(async (tel: string, ..._resto: any[]) => ({ key: { id: `wamid-${tel}` }, data: { key: { id: `wamid-${tel}` } } })) };
    const settings = { getAiConfig: jest.fn(async () => { throw new Error('sem IA no teste'); }) };
    return { worker: new CalendarReminderWorker(b.prisma, whatsapp as any, settings as any), whatsapp, settings, ...b };
  }
  const job = { name: 'notify-hearing-scheduled', id: 'j2', data: { eventId: 'ev-1' } } as any;

  it('sem laboratório cadastrado: envia pelo chip da clínica, como antes', async () => {
    const m = montar([], evento(CLINICA));
    await m.worker.process(job);
    expect(m.whatsapp.sendText.mock.calls.map((c: any[]) => [c[0], c[2], c[3], c[4]])).toEqual([
      [TEL[CLINICA], `chip-${CLINICA}`, undefined, CLINICA],
    ]);
    expect(m.ops.slice(0, 2).map(([o]) => o)).toEqual(['calendarEvent.findUnique', 'instance.findMany']);
  });

  it('clínica com OUTRA conta laboratório: o mesmo rastro e o mesmo envio', async () => {
    const antes = montar([], evento(CLINICA));
    await antes.worker.process(job);
    const depois = montar([LAB], evento(CLINICA));
    await depois.worker.process(job);
    expect(depois.ops).toEqual(antes.ops);
    expect(depois.whatsapp.sendText.mock.calls).toEqual(antes.whatsapp.sendText.mock.calls);
  });

  it.each([
    ['evento do laboratório', evento(LAB)],
    ['evento legado sem conta, contato do laboratório', evento(null, LAB)],
  ])('%s: sem IA, sem chip, sem envio — e sem lançar (o BullMQ não re-tenta)', async (_n, ev) => {
    const m = montar([LAB], ev);
    await expect(m.worker.process(job)).resolves.toBeUndefined();
    expect(m.ops.map(([o]) => o)).toEqual(['calendarEvent.findUnique']);
    expect(m.settings.getAiConfig).not.toHaveBeenCalled();
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
  });
});

// ─── fila fechamento-jobs ────────────────────────────────────────────────────

describe('Fechamento deferido (fila fechamento-jobs e fallback) — laboratório não recebe', () => {
  const TERMOS = { entrada: 500, parcelas: 10, valorParcela: 250, total: 3000, forma: 'BOLETO' };
  const PACIENTE = { name: 'Maria Exemplo', phone: TEL[CLINICA] };
  function montar(labs: string[]) {
    const b = banco(labs, { 'treatmentPlan.findUnique': () => ({ patient: PACIENTE }) });
    const svc = new QuotesService(b.prisma, {} as any, {} as any, {} as any);
    const negociacao = jest.spyOn(svc as any, 'sendNegociacaoAprovada').mockImplementation(async () => undefined);
    const entrada = jest.spyOn(svc as any, 'sendEntradaCobranca').mockImplementation(async () => undefined);
    return { svc, negociacao, entrada, processor: new FechamentoProcessor(svc), ...b };
  }

  it('sem laboratório cadastrado: mesma consulta e os dois envios, como antes', async () => {
    const m = montar([]);
    await m.svc.runFechamentoDeferido({ tenantId: CLINICA, planId: 'plano-1', terms: TERMOS });
    expect(m.ops).toEqual([
      ['treatmentPlan.findUnique', { where: { id: 'plano-1' }, select: { patient: { select: { name: true, phone: true } } } }],
    ]);
    expect(m.negociacao.mock.calls).toEqual([[CLINICA, 'plano-1', PACIENTE, TERMOS]]);
    expect(m.entrada.mock.calls).toEqual([[CLINICA, 'plano-1', PACIENTE]]);
  });

  it('clínica com OUTRA conta laboratório (pela fila): igual', async () => {
    const antes = montar([]);
    await antes.processor.process({ name: 'deferido', id: 'f1', data: { tenantId: CLINICA, planId: 'plano-1', terms: TERMOS } } as any);
    const depois = montar([LAB]);
    await depois.processor.process({ name: 'deferido', id: 'f1', data: { tenantId: CLINICA, planId: 'plano-1', terms: TERMOS } } as any);
    expect(depois.ops).toEqual(antes.ops);
    expect(depois.negociacao.mock.calls).toEqual(antes.negociacao.mock.calls);
    expect(depois.entrada.mock.calls).toEqual(antes.entrada.mock.calls);
    expect(depois.negociacao).toHaveBeenCalledTimes(1);
  });

  it('laboratório (fila e fallback): nem negociação, nem boleto da entrada', async () => {
    const m = montar([LAB]);
    await m.processor.process({ name: 'deferido', id: 'f1', data: { tenantId: LAB, planId: 'plano-lab', terms: TERMOS } } as any);
    await m.svc.runFechamentoDeferido({ tenantId: LAB, planId: 'plano-lab', terms: TERMOS });
    expect(m.ops).toEqual([]);
    expect(m.negociacao).not.toHaveBeenCalled();
    expect(m.entrada).not.toHaveBeenCalled();
  });
});

// ─── apresentação do Financeiro e âncora no fechamento ───────────────────────

describe('Apresentação do Financeiro no fechamento — laboratório: sem mensagem e sem âncora do carnê', () => {
  const PACIENTE = { name: 'Maria Exemplo', phone: TEL[CLINICA] };
  function montar(labs: string[], ligados: Record<string, string>) {
    const b = banco(labs, {
      'globalSetting.findUnique': ({ where }) => (where.key in ligados ? { value: ligados[where.key] } : null),
      'tenant.findUnique': () => ({ name: 'Clínica Exemplo' }),
    });
    const whatsapp = {
      getInstanceForPurpose: jest.fn(async (_t: string, p: string) => `chip-${p.toLowerCase()}`),
      sendText: jest.fn(async (tel: string, ..._resto: any[]) => ({ key: { id: `wamid-${tel}` } })),
    };
    return { svc: new QuotesService(b.prisma, {} as any, whatsapp as any, {} as any), whatsapp, ...b };
  }
  const ligadosDe = (t: string) => ({ [`BOLETO_INTRO_ENABLED_${t}`]: 'true', [`BOLETO_DELIVERY_ENABLED_${t}`]: 'true' });
  const soEntregaDe = (t: string) => ({ [`BOLETO_DELIVERY_ENABLED_${t}`]: 'true' });

  it('sem laboratório cadastrado: apresenta e ancora, como antes', async () => {
    const m = montar([], ligadosDe(CLINICA));
    await (m.svc as any).sendApresentacao(CLINICA, 'plano-1', PACIENTE);
    expect(m.ops[0]).toEqual(['auditLog.findFirst', { where: { entity: 'BOLETO_INTRO', entity_id: 'plano-1' }, select: { id: true } }]);
    expect(m.whatsapp.sendText.mock.calls.map((c: any[]) => [c[0], c[2]])).toEqual([[TEL[CLINICA], 'chip-financeiro']]);
    expect(m.de('auditLog.create')).toEqual([
      { data: { entity: 'BOLETO_INTRO', entity_id: 'plano-1', action: 'intro', meta_json: { tenant_id: CLINICA, source: 'fechamento' } } },
    ]);
  });

  it.each([
    ['apresentação + entrega ligadas', ligadosDe(CLINICA)],
    ['só a entrega ligada (só ancora)', soEntregaDe(CLINICA)],
  ])('clínica com OUTRA conta laboratório — %s: o mesmo rastro', async (_n, ligados) => {
    const antes = montar([], ligados);
    await (antes.svc as any).sendApresentacao(CLINICA, 'plano-1', PACIENTE);
    const depois = montar([LAB], ligados);
    await (depois.svc as any).sendApresentacao(CLINICA, 'plano-1', PACIENTE);
    expect(depois.ops).toEqual(antes.ops);
    expect(depois.whatsapp.sendText.mock.calls).toEqual(antes.whatsapp.sendText.mock.calls);
    expect(depois.de('auditLog.create')).toHaveLength(1);
  });

  it.each([
    ['apresentação + entrega ligadas', ligadosDe(LAB)],
    ['só a entrega ligada', soEntregaDe(LAB)],
  ])('laboratório — %s: nem mensagem, nem âncora BOLETO_INTRO', async (_n, ligados) => {
    const m = montar([LAB], ligados);
    await (m.svc as any).sendApresentacao(LAB, 'plano-lab', { name: 'Dr. Cliente Exemplo', phone: TEL[LAB] });
    expect(m.ops).toEqual([]);
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
  });
});

// ─── carnê automático D+2 ────────────────────────────────────────────────────

describe('Entrega automática do carnê D+2 (cron) — venda de laboratório não entra', () => {
  const intro = (t: string, plano = `plano-${t}`) => ({ entity_id: plano, meta_json: { tenant_id: t, source: 'fechamento' } });
  function montar(labs: string[], logs: any[]) {
    const b = banco(labs, {
      'auditLog.findMany': ({ where }) => (where.entity === 'BOLETO_INTRO' ? logs : []),
      'globalSetting.findUnique': () => ({ value: 'true' }),
    });
    const svc = new BoletoDeliveryService(b.prisma, {} as any, {} as any);
    const entrega = jest.spyOn(svc as any, 'deliverOne').mockImplementation(async () => undefined);
    jest.spyOn(svc as any, 'sleep').mockImplementation(async () => undefined);
    return { svc, entrega, ...b };
  }
  const TRES = [intro(CLINICA), intro(LAB), intro(OUTRA_CLINICA)];

  it('sem laboratório cadastrado: todas as vendas entram, na ordem de antes', async () => {
    const m = montar([], TRES);
    await m.svc.tick();
    expect(m.entrega.mock.calls).toEqual([
      [{ planId: `plano-${CLINICA}`, tenantId: CLINICA }],
      [{ planId: `plano-${LAB}`, tenantId: LAB }],
      [{ planId: `plano-${OUTRA_CLINICA}`, tenantId: OUTRA_CLINICA }],
    ]);
  });

  it('clínica com OUTRA conta laboratório: o mesmo rastro e as mesmas entregas, sem o laboratório', async () => {
    const antes = montar([], TRES);
    await antes.svc.tick();
    const depois = montar([LAB], TRES);
    await depois.svc.tick();
    // As leituras de antes do laço (as âncoras e as já entregues) são as mesmas; só as
    // do toggle do laboratório saem.
    expect(depois.ops).toEqual(antes.ops.filter(([o, a]) => !(o === 'globalSetting.findUnique' && tocaLab(a))));
    expect(depois.entrega.mock.calls).toEqual(antes.entrega.mock.calls.filter((c: any[]) => c[0].tenantId !== LAB));
  });

  it('laboratório: não entra na fila nem ocupa vaga do teto por rodada (30)', async () => {
    const lab = Array.from({ length: 30 }, (_, i) => intro(LAB, `plano-${LAB}-${i}`));
    const m = montar([LAB], [...lab, intro(CLINICA)]);
    const fila = await (m.svc as any).findPendingDeliveries();
    expect(fila).toEqual([{ planId: `plano-${CLINICA}`, tenantId: CLINICA }]);
    expect(m.de('globalSetting.findUnique').some((a: any) => a.where.key.endsWith(LAB))).toBe(false);
    // Sem laboratório cadastrado, as 30 de antes ocupavam o teto (como hoje).
    const hoje = montar([], [...lab, intro(CLINICA)]);
    expect(await (hoje.svc as any).findPendingDeliveries()).toHaveLength(30);
  });
});

// ─── régua por e-mail ────────────────────────────────────────────────────────

describe('E-mail "vence amanhã" (cron) — cobrança de laboratório fica fora da busca', () => {
  const INICIO = new Date('2026-10-22T03:00:00.000Z'); // amanhã 00:00 em Maceió
  const FIM = new Date('2026-10-23T03:00:00.000Z');
  const BASE = {
    status: 'PENDING',
    due_reminder_sent_at: null,
    due_date: { gte: INICIO, lt: FIM },
    installment_id: { not: null },
    tenant_id: { not: null },
  };
  const cobranca = (t: string) => ({
    id: `cob-${t}`,
    tenant_id: t,
    amount: 250,
    due_date: new Date('2026-10-22T15:00:00.000Z'),
    billing_type: 'BOLETO',
    invoice_url: `https://pagamento.exemplo.test/${t}`,
    boleto_url: null,
    installment: { patient: { name: 'Maria Exemplo', email: `paciente@${t}.exemplo.test` } },
  });
  function montar(labs: string[], cobrancas: any[]) {
    const b = banco(labs, {
      'paymentGatewayCharge.findMany': ({ where }) => cobrancas.filter((c) => casa(where, c)),
      'tenant.findUnique': ({ where }) => ({ name: `Conta ${where.id}`, email: null }),
    });
    const mail = { renderTemplate: jest.fn(() => '<html>corpo</html>'), send: jest.fn(async () => true) };
    return { svc: new EmailAutomationService(b.prisma, mail as any), mail, ...b };
  }
  const efeitos = (m: ReturnType<typeof montar>) => ({
    emails: m.mail.send.mock.calls,
    marcados: m.de('paymentGatewayCharge.update'),
  });

  it('sem laboratório cadastrado: mesmo where de antes e todas recebem', async () => {
    const m = montar([], [cobranca(CLINICA), cobranca(LAB), cobranca(OUTRA_CLINICA)]);
    await m.svc.sendDueTomorrowReminders();
    expect(m.de('paymentGatewayCharge.findMany')[0].where).toEqual(BASE);
    expect(m.mail.send.mock.calls.map((c: any[]) => c[0].to)).toEqual([
      `paciente@${CLINICA}.exemplo.test`,
      `paciente@${LAB}.exemplo.test`,
      `paciente@${OUTRA_CLINICA}.exemplo.test`,
    ]);
    expect(m.de('paymentGatewayCharge.update').map((a: any) => a.where.id)).toEqual([`cob-${CLINICA}`, `cob-${LAB}`, `cob-${OUTRA_CLINICA}`]);
  });

  it('clínica com OUTRA conta laboratório: where de antes + fora o laboratório; e-mails iguais', async () => {
    const lista = [cobranca(CLINICA), cobranca(OUTRA_CLINICA)];
    const antes = montar([], lista);
    await antes.svc.sendDueTomorrowReminders();
    const depois = montar([LAB], lista);
    await depois.svc.sendDueTomorrowReminders();
    expect(depois.de('paymentGatewayCharge.findMany')[0].where).toEqual({ AND: [BASE, OR_SEM_LAB] });
    expect(efeitos(depois)).toEqual(efeitos(antes));
    expect(depois.mail.send).toHaveBeenCalledTimes(2);
  });

  it('laboratório: o e-mail não sai e a cobrança não é marcada', async () => {
    const m = montar([LAB], [cobranca(CLINICA), cobranca(LAB)]);
    await m.svc.sendDueTomorrowReminders();
    expect(m.mail.send.mock.calls.map((c: any[]) => c[0].to)).toEqual([`paciente@${CLINICA}.exemplo.test`]);
    expect(tocaLab(m.ops.filter(([o]) => o !== 'paymentGatewayCharge.findMany'))).toBe(false);
  });
});

describe('E-mail "pagamento em atraso" (webhook do Asaas) — cobrança de laboratório não manda', () => {
  const cobranca = (t: string) => ({
    id: `cob-${t}`,
    installment_id: `parc-${t}`,
    tenant_id: t,
    amount: 250,
    due_date: new Date('2026-10-19T15:00:00.000Z'),
    invoice_url: `https://pagamento.exemplo.test/${t}`,
  });
  function montar(labs: string[]) {
    const b = banco(labs, {
      'installment.findUnique': ({ where }) => ({ patient: { name: 'Maria Exemplo', email: `paciente@${where.id}.exemplo.test` } }),
    });
    const emails = { dispatch: jest.fn(async () => true) };
    const svc = new PaymentGatewayService(b.prisma, {} as any, {} as any, {} as any, {} as any, emails as any, {} as any);
    return { svc, emails, ...b };
  }

  it('sem laboratório cadastrado: mesma leitura e o mesmo e-mail de antes', async () => {
    const m = montar([]);
    await (m.svc as any).sendPaymentOverdueEmail(cobranca(CLINICA));
    expect(m.ops).toEqual([
      ['installment.findUnique', { where: { id: `parc-${CLINICA}` }, select: { patient: { select: { name: true, email: true } } } }],
    ]);
    expect(m.emails.dispatch.mock.calls).toEqual([
      [
        'pagamento_atrasado',
        CLINICA,
        `paciente@parc-${CLINICA}.exemplo.test`,
        { paciente_nome: 'Maria Exemplo', valor: (250).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }), vencimento: new Date('2026-10-19T15:00:00.000Z').toLocaleDateString('pt-BR') },
        { ctaUrl: `https://pagamento.exemplo.test/${CLINICA}` },
      ],
    ]);
  });

  it('clínica com OUTRA conta laboratório: igual', async () => {
    const antes = montar([]);
    await (antes.svc as any).sendPaymentOverdueEmail(cobranca(CLINICA));
    const depois = montar([LAB]);
    await (depois.svc as any).sendPaymentOverdueEmail(cobranca(CLINICA));
    expect(depois.ops).toEqual(antes.ops);
    expect(depois.emails.dispatch.mock.calls).toEqual(antes.emails.dispatch.mock.calls);
    expect(depois.emails.dispatch).toHaveBeenCalledTimes(1);
  });

  it('laboratório: nem lê a parcela, nem manda', async () => {
    const m = montar([LAB]);
    await (m.svc as any).sendPaymentOverdueEmail(cobranca(LAB));
    expect(m.ops).toEqual([]);
    expect(m.emails.dispatch).not.toHaveBeenCalled();
  });
});
