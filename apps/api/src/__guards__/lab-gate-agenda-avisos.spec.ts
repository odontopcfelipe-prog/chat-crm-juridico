/**
 * F7 do laboratório — resumo do dia e aniversário (cron e envio) na conta de
 * laboratório. Os casos da clínica vieram de lab-gate-automatismos.spec.ts (F2 parte
 * 2b) sem mudança: a clínica segue EXATAMENTE como antes (mesmas consultas, mesmos
 * argumentos, mesma ordem).
 *
 *  - resumo do dia: no laboratório é o de coleta, prova e entrega, para quem é o
 *    responsável no evento (qualquer papel), só a agenda da conta (sem o legado sem
 *    conta), com os rótulos do laboratório; opt-in (o padrão gravado nasce desligado)
 *    e só pelo cron (o "Enviar agora" segue negado na rota);
 *  - aniversário: no laboratório só a mensagem clássica, com a config e o texto do
 *    laboratório; a 2 e a 3 nunca marcam last_run_date nem enviam.
 *
 * Cada freio tem três casos: (a) sem laboratório cadastrado (o caso de produção hoje)
 * = mesmas chamadas de antes; (b) clínica com OUTRA conta laboratório = a clínica igual
 * ao (a); (c) laboratório = o ramo do laboratório.
 *
 * O banco de teste grava cada operação (menos a leitura da lista de laboratórios) e
 * responde aos where só no que importa aqui.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { BadRequestException, Logger } from '@nestjs/common';
import { BIRTHDAY_GREETING_PADRAO_DO_LABORATORIO, TIPOS_AVISO_LAB, __limparCacheLabTenants } from '@crm/shared';
import { CalendarCronService } from '../calendar/calendar-cron.service';

// ─── Dados de exemplo (repositório público: nada real) ───────────────────────
const CLINICA = 'tenant-clinica';
const OUTRA_CLINICA = 'tenant-clinica-2';
const LAB = 'tenant-lab';
const AGORA = new Date('2026-10-21T15:00:00.000Z'); // quarta, 12:00 em Maceió

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
  return { prisma, ops, de, perfis };
}

const tocaLab = (x: unknown) => JSON.stringify(x).includes(LAB);

// ─── resumo diário do dentista ───────────────────────────────────────────────

describe('Resumo diário do dentista (cron) — o laboratório recebe o resumo de coleta, prova e entrega', () => {
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
  // (resumo-dentista-por-conta.spec).
  it('sem laboratório cadastrado: dispara para cada chave de conta ligada, na ordem de antes', async () => {
    const m = montar([]);
    await m.svc.checkDentistDailySummary();
    expect(m.agenda.sendDentistDailySummaryNow.mock.calls).toEqual([[CLINICA], [LAB], [OUTRA_CLINICA]]);
  });

  it('clínica com OUTRA conta laboratório: igual, sem a do laboratório', async () => {
    const m = montar([LAB]);
    await m.svc.checkDentistDailySummary();
    expect(m.agenda.sendDentistDailySummaryNow.mock.calls.filter((c: any[]) => c[0] !== LAB)).toEqual([[CLINICA], [OUTRA_CLINICA]]);
  });

  it('laboratório com o resumo ligado: disparado pela conta (o envio escolhe o resumo do laboratório)', async () => {
    const m = montar([LAB]);
    await m.svc.checkDentistDailySummary();
    expect(m.agenda.sendDentistDailySummaryNow.mock.calls).toEqual([[CLINICA], [LAB], [OUTRA_CLINICA]]);
  });

  it('laboratório com o resumo desligado (o padrão gravado): não é disparado', async () => {
    const b = banco([LAB], {
      'globalSetting.findMany': () => [{ key: `DENTIST_DAILY_SUMMARY_${LAB}`, value: JSON.stringify({ enabled: false, send_at: '12:00' }) }],
    });
    const agenda = { sendDentistDailySummaryNow: jest.fn(async () => ({ total: 1, results: [] })) };
    await new CalendarCronService(b.prisma, {} as any, agenda as any).checkDentistDailySummary();
    expect(agenda.sendDentistDailySummaryNow).not.toHaveBeenCalled();
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
  function montar(labs: string[], respostas: Respostas = {}) {
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
      ...respostas,
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

  it('laboratório (cron): toda a equipe da conta, só coleta, prova e entrega da conta (sem o legado sem conta), rótulos do laboratório', async () => {
    const m = montar([LAB], {
      'calendarEvent.findMany': () => [
        { start_at: new Date('2026-10-21T14:30:00.000Z'), type: 'COLETA', patient: { name: 'Dra. Bia Exemplo' }, lead: null },
        { start_at: new Date('2026-10-21T16:00:00.000Z'), type: 'ENTREGA', patient: null, lead: null },
      ],
    });
    const r = await m.svc.sendDentistDailySummaryNow(LAB);
    expect(m.de('user.findMany')).toEqual([{ where: { tenant_id: LAB }, select: SELECT }]);
    const busca = m.de('calendarEvent.findMany')[0].where;
    expect(busca).toEqual({
      assigned_user_id: `u-${LAB}`,
      tenant_id: LAB,
      start_at: { gte: new Date('2026-10-21T00:00:00.000Z'), lt: new Date('2026-10-22T00:00:00.000Z') },
      status: { in: ['AGENDADO', 'CONFIRMADO'] },
      type: { in: [...TIPOS_AVISO_LAB] },
    });
    expect(busca).not.toHaveProperty('OR');
    expect(m.whatsapp.sendText.mock.calls.map((c: any[]) => [c[0], c[2], c[3], c[4]])).toEqual([
      ['5582900000013', `chip-${LAB}`, undefined, LAB],
    ]);
    const texto = m.whatsapp.sendText.mock.calls[0][1];
    expect(texto).toContain('Bom dia, Dr. Lab Exemplo! 👋');
    expect(texto).toContain('tem 2 coleta(s), prova(s) e entrega(s):');
    expect(texto).toContain('- 14:30  Dra. Bia Exemplo (Coleta)');
    expect(texto).toContain('- 16:00  Cliente (Entrega)');
    expect(texto).not.toMatch(/Paciente|Avaliacao|Doutor/);
    // O chip é o de Atendimento (função CLINICA da conta).
    expect(m.de('instance.findFirst')[0].where).toEqual({ type: 'whatsapp', tenant_id: LAB, purpose: 'CLINICA' });
    expect(r.total).toBe(1);
  });

  it('laboratório: quem não tem visita no dia não recebe; quem desligou no cadastro também não', async () => {
    const m = montar([LAB], {
      'user.findMany': () => [
        { id: 'u-exp', name: 'Expedição Exemplo', phone: '5582900000021', disparos_off: ['resumo_dentista'] },
        { id: 'u-vazio', name: 'Sem Visita', phone: '5582900000022', disparos_off: [] },
      ],
      'calendarEvent.findMany': () => [],
    });
    const r = await m.svc.sendDentistDailySummaryNow(LAB);
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
    expect(r.results.map((x: any) => [x.user_id, x.sent])).toEqual([['u-exp', false], ['u-vazio', false]]);
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

describe('Aniversário (cron) — laboratório só manda a mensagem clássica', () => {
  const cfg = JSON.stringify({ enabled: true, send_at: '12:00' });
  function montar(labs: string[], valor = cfg) {
    const b = banco(labs, {
      'globalSetting.findMany': () => [CLINICA, LAB, OUTRA_CLINICA].map((t) => ({ key: `BIRTHDAY_GREETING_${t}`, value: valor })),
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
    expect(m.chamadas.filter((c: any[]) => !tocaLab(c))).toEqual([
      ['marca', CLINICA, { last_run_date: '2026-10-21' }],
      ['envia', CLINICA, 1],
      ['marca', OUTRA_CLINICA, { last_run_date: '2026-10-21' }],
      ['envia', OUTRA_CLINICA, 1],
    ]);
  });

  it('laboratório: só a mensagem clássica, com a config do laboratório; a 2 e a 3 nem marcam a data', async () => {
    const todas = JSON.stringify({
      enabled: true, send_at: '12:00',
      message2_enabled: true, message2_send_at: '12:00',
      message3_enabled: true, message3_send_at: '12:00',
    });
    const m = montar([LAB], todas);
    await m.svc.checkBirthdayGreetings();
    expect(m.chamadas.filter((c: any[]) => tocaLab(c))).toEqual([
      ['marca', LAB, { last_run_date: '2026-10-21' }, true],
      ['envia', LAB, 1, true],
    ]);
    // As clínicas mandam as 3, como antes.
    expect(m.chamadas.filter((c: any[]) => c[0] === 'envia' && c[1] === CLINICA).map((c: any[]) => c[2])).toEqual([1, 2, 3]);
    expect(JSON.stringify(m.chamadas.filter((c: any[]) => tocaLab(c)))).not.toMatch(/message[23]_last_run_date/);
  });
});

describe('Aniversário (envio) — laboratório', () => {
  function montar(labs: string[], salvo?: Record<string, unknown>) {
    const b = banco(labs, {
      'globalSetting.findUnique': ({ where }) =>
        salvo && where.key === `BIRTHDAY_GREETING_${LAB}` ? { value: JSON.stringify(salvo) } : null,
      'tenant.findUnique': () => ({ name: 'Laboratório Exemplo' }),
      'patient.findMany': () => [
        { id: 'pac-1', name: 'Dra. Bia Exemplo', phone: '5582900000031', birth_date: new Date('1985-10-21T00:00:00.000Z') },
      ],
      'instance.findFirst': ({ where }) => ({ name: `chip-${where.purpose}-${where.tenant_id}` }),
    });
    const whatsapp = { sendText: jest.fn(async (tel: string, ..._resto: any[]) => ({ key: { id: `wamid-${tel}` } })) };
    const svc = new CalendarService(b.prisma, {} as any, {} as any, {} as any, whatsapp, {} as any, {} as any);
    return { svc, whatsapp, ...b };
  }

  it('mensagem clássica: texto do laboratório, nome sem Dr./Dra., chip de Atendimento, sem anexos', async () => {
    const m = montar([LAB]);
    const r = await m.svc.sendBirthdayGreetingsNow(LAB, 1, true);
    expect(r.total).toBe(1);
    expect(m.whatsapp.sendText.mock.calls).toEqual([
      ['5582900000031', BIRTHDAY_GREETING_PADRAO_DO_LABORATORIO.template.replace('{nome}', 'Bia'), `chip-CLINICA-${LAB}`, undefined, LAB],
    ]);
    expect(m.ops.some(([o]) => o.startsWith('disparoAnexo.'))).toBe(false);
  });

  it('texto salvo com palavra de clínica ou vazio: cai no texto do laboratório', async () => {
    for (const template of ['Parabéns, {nome}! Venha cuidar do seu sorriso na próxima consulta.', '  ']) {
      const m = montar([LAB], { enabled: true, template });
      await m.svc.sendBirthdayGreetingsNow(LAB, 1, true);
      expect(m.whatsapp.sendText.mock.calls[0][1]).toBe(BIRTHDAY_GREETING_PADRAO_DO_LABORATORIO.template.replace('{nome}', 'Bia'));
    }
    const proprio = montar([LAB], { enabled: true, template: 'Feliz aniversário, {nome}! Abraço da equipe {clinica}.' });
    await proprio.svc.sendBirthdayGreetingsNow(LAB, 1, true);
    expect(proprio.whatsapp.sendText.mock.calls[0][1]).toBe('Feliz aniversário, Bia! Abraço da equipe Laboratório Exemplo.');
  });

  it('mensagens 2 e 3 no laboratório: nada é lido nem enviado', async () => {
    for (const qual of [2, 3] as const) {
      const m = montar([LAB]);
      expect(await m.svc.sendBirthdayGreetingsNow(LAB, qual, true)).toEqual({ total: 0, results: [] });
      expect(m.ops).toEqual([]);
      expect(m.whatsapp.sendText).not.toHaveBeenCalled();
    }
  });
});
