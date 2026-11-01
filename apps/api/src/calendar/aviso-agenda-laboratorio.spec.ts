/**
 * F7 do laboratório — aviso ao cliente da coleta, prova ou entrega marcada ou
 * remarcada (aviso-agenda-laboratorio.ts): texto exato do laboratório, endereço do
 * consultório do cliente, liga/desliga da Central, chip de Atendimento (nunca o
 * Financeiro), e-mail de agenda da conta e o histórico de disparos.
 *
 * Dados de exemplo (repositório público: nada real).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { Logger } from '@nestjs/common';
import { LAB_AGENDA_TEXTOS, __limparCacheLabTenants } from '@crm/shared';
import { avisarAgendaDoLaboratorio } from './aviso-agenda-laboratorio';

const LAB = 'tenant-lab';
const AGORA = new Date('2026-10-21T15:00:00.000Z'); // 12:00 em Maceió
const INICIO = new Date('2026-10-28T14:00:00.000Z'); // 14:00 em Maceió (naive)
const TEL = '5582900000003';
const ENDERECO = {
  address: 'Rua das Flores',
  address_number: '100',
  address_complement: null,
  neighborhood: 'Centro',
  city: 'Maceió',
  state: 'AL',
};
const PACIENTE_DO_LAB = { name: 'Dra. Ana Souza', phone: TEL, email: 'ana@exemplo.test', ...ENDERECO };

beforeEach(() => {
  jest.useFakeTimers({
    now: AGORA,
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
});
afterEach(() => jest.useRealTimers());

function montar(o: {
  settings?: Record<string, string>;
  paciente?: any;
  contato?: any;
  conta?: any;
  chip?: string | null;
  envio?: any;
  remarcacao?: string;
} = {}) {
  const prisma: any = {
    globalSetting: { findUnique: jest.fn(async ({ where }: any) => (o.settings && where.key in o.settings ? { value: o.settings[where.key] } : null)) },
    patient: { findUnique: jest.fn(async () => (o.paciente === undefined ? PACIENTE_DO_LAB : o.paciente)) },
    lead: { findUnique: jest.fn(async () => o.contato ?? null) },
    tenant: { findUnique: jest.fn(async () => (o.conta === undefined ? { name: 'Laboratório Exemplo' } : o.conta)) },
  };
  const whatsapp = { sendText: jest.fn(async (..._a: any[]) => o.envio ?? { key: { id: 'wamid-1' }, data: { key: { id: 'wamid-1' } } }) };
  const emailAutomation = { dispatch: jest.fn(async (..._a: any[]) => true) };
  const registros: any[] = [];
  const deps: any = {
    prisma,
    whatsapp,
    emailAutomation,
    logger: { log: jest.fn(), warn: jest.fn() },
    resolverChip: jest.fn(async () => (o.chip === undefined ? 'chip-atendimento' : o.chip)),
    textoDaRemarcacao: jest.fn(async () => o.remarcacao ?? LAB_AGENDA_TEXTOS.remarcacao),
    registrar: jest.fn(async (p: any) => {
      registros.push(p);
    }),
  };
  return { deps, prisma, whatsapp, emailAutomation, registros };
}

const evento = (extra: Record<string, any> = {}) => ({
  id: 'evento-1',
  type: 'COLETA',
  start_at: INICIO,
  location: null,
  assigned_user: { name: 'Bruno Expedição' },
  ...extra,
});
const pedido = (extra: Record<string, any> = {}, kind: 'created' | 'rescheduled' = 'created') => ({
  event: evento(extra),
  patientId: 'pac-1',
  leadId: 'lead-1',
  tenantId: LAB,
  kind,
});

describe('Aviso de agenda do laboratório — WhatsApp', () => {
  it('coleta marcada: texto exato do laboratório, nome sem Dr./Dra., endereço do cadastro do cliente', async () => {
    const m = montar();
    expect(await avisarAgendaDoLaboratorio(m.deps, pedido())).toEqual({ sent: true });
    expect(m.whatsapp.sendText.mock.calls).toEqual([
      [
        TEL,
        'Olá Ana! Agendamos a *coleta* do seu trabalho para *28/10* às *14:00*.\n' +
          '📍 Rua das Flores, 100, Centro, Maceió/AL\n\n' +
          'Qualquer dúvida, é só chamar por aqui.',
        'chip-atendimento',
        undefined,
        LAB,
      ],
    ]);
    expect(m.deps.resolverChip).toHaveBeenCalledWith(LAB);
    // O endereço é o do cliente: da conta só o nome é lido.
    expect(m.prisma.tenant.findUnique).toHaveBeenCalledWith({ where: { id: LAB }, select: { name: true } });
  });

  it('local digitado no evento vale mais que o cadastro; sem endereço nenhum, a linha some', async () => {
    const comLocal = montar();
    await avisarAgendaDoLaboratorio(comLocal.deps, pedido({ type: 'PROVA', location: 'Consultório 2, sala 5' }));
    expect(comLocal.whatsapp.sendText.mock.calls[0][1]).toBe(
      'Olá Ana! Agendamos a *prova* do seu trabalho para *28/10* às *14:00*.\n' +
        '📍 Consultório 2, sala 5\n\n' +
        'Qualquer dúvida, é só chamar por aqui.',
    );
    const semEndereco = montar({ paciente: { name: 'Dr. Paulo Lima', phone: TEL, email: null } });
    await avisarAgendaDoLaboratorio(semEndereco.deps, pedido({ type: 'ENTREGA' }));
    expect(semEndereco.whatsapp.sendText.mock.calls[0][1]).toBe(
      'Olá Paulo! Agendamos a *entrega* do seu trabalho para *28/10* às *14:00*.\n\n' +
        'Qualquer dúvida, é só chamar por aqui.',
    );
  });

  it('remarcação: o texto da conta; texto vazio cai no do laboratório', async () => {
    const vazio = montar({ remarcacao: '' });
    await avisarAgendaDoLaboratorio(vazio.deps, pedido({}, 'rescheduled'));
    expect(vazio.whatsapp.sendText.mock.calls[0][1]).toBe(
      'Olá Ana! O horário da coleta do seu trabalho mudou para *28/10* às *14:00*.\n' +
        '📍 Rua das Flores, 100, Centro, Maceió/AL\n\n' +
        'Qualquer dúvida, é só chamar por aqui.',
    );
    const proprio = montar({ remarcacao: 'Oi {nome}, a {tipo} passou para {data} {hora}.' });
    await avisarAgendaDoLaboratorio(proprio.deps, pedido({}, 'rescheduled'));
    expect(proprio.whatsapp.sendText.mock.calls[0][1]).toBe('Oi Ana, a coleta passou para 28/10 14:00.');
    expect(proprio.deps.textoDaRemarcacao).toHaveBeenCalledWith(LAB);
  });

  it('sem cadastro com telefone: usa o contato (nome, telefone e e-mail)', async () => {
    const m = montar({ paciente: null, contato: { name: 'Clínica Sorriso Exemplo', phone: '5582900000009', email: 'contato@exemplo.test' } });
    await avisarAgendaDoLaboratorio(m.deps, pedido());
    expect(m.whatsapp.sendText.mock.calls[0][0]).toBe('5582900000009');
    expect(m.whatsapp.sendText.mock.calls[0][1]).toBe(
      'Olá Clínica! Agendamos a *coleta* do seu trabalho para *28/10* às *14:00*.\n\nQualquer dúvida, é só chamar por aqui.',
    );
    expect(m.emailAutomation.dispatch.mock.calls[0][2]).toBe('contato@exemplo.test');
  });

  it('evento no passado: nada é lido nem enviado', async () => {
    const m = montar();
    expect(await avisarAgendaDoLaboratorio(m.deps, pedido({ start_at: new Date('2026-10-20T14:00:00.000Z') }))).toEqual({
      sent: false,
      reason: 'evento_passado',
    });
    expect(m.prisma.globalSetting.findUnique).not.toHaveBeenCalled();
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
    expect(m.emailAutomation.dispatch).not.toHaveBeenCalled();
  });

  it('liga/desliga da Central: a confirmação de agendamento corta o "marcada", o reagendamento corta o "remarcada" (WhatsApp e e-mail)', async () => {
    const criado = montar({ settings: { [`APPOINTMENT_CONFIRMATION_ENABLED_${LAB}`]: 'false' } });
    expect((await avisarAgendaDoLaboratorio(criado.deps, pedido())).sent).toBe(false);
    expect(criado.prisma.globalSetting.findUnique).toHaveBeenCalledWith({ where: { key: `APPOINTMENT_CONFIRMATION_ENABLED_${LAB}` } });
    expect(criado.whatsapp.sendText).not.toHaveBeenCalled();
    expect(criado.emailAutomation.dispatch).not.toHaveBeenCalled();

    const remarcado = montar({ settings: { [`APPOINTMENT_RESCHEDULED_ENABLED_${LAB}`]: 'false' } });
    expect((await avisarAgendaDoLaboratorio(remarcado.deps, pedido({}, 'rescheduled'))).sent).toBe(false);
    expect(remarcado.prisma.globalSetting.findUnique).toHaveBeenCalledWith({ where: { key: `APPOINTMENT_RESCHEDULED_ENABLED_${LAB}` } });
    expect(remarcado.whatsapp.sendText).not.toHaveBeenCalled();
    expect(remarcado.emailAutomation.dispatch).not.toHaveBeenCalled();

    // O desligado de um não corta o outro.
    const outro = montar({ settings: { [`APPOINTMENT_RESCHEDULED_ENABLED_${LAB}`]: 'false' } });
    expect((await avisarAgendaDoLaboratorio(outro.deps, pedido())).sent).toBe(true);
  });

  it('tipo que não é coleta, prova ou entrega: nada acontece', async () => {
    for (const type of ['OUTRO', 'TAREFA', 'BLOQUEIO', 'CONSULTA']) {
      const m = montar();
      expect((await avisarAgendaDoLaboratorio(m.deps, pedido({ type }))).sent).toBe(false);
      expect(m.prisma.globalSetting.findUnique).not.toHaveBeenCalled();
      expect(m.whatsapp.sendText).not.toHaveBeenCalled();
    }
  });
});

describe('Aviso de agenda do laboratório — histórico de disparos', () => {
  it('enviado: SENT com o tipo do aviso, o cliente e o id da mensagem', async () => {
    const m = montar();
    await avisarAgendaDoLaboratorio(m.deps, pedido());
    await avisarAgendaDoLaboratorio(m.deps, pedido({}, 'rescheduled'));
    expect(m.registros).toEqual([
      {
        tenantId: LAB, type: 'agendamento_criado', recipientName: 'Dra. Ana Souza', recipientPhone: TEL, status: 'SENT',
        externalMessageId: 'wamid-1', refEventId: 'evento-1', refPatientId: 'pac-1',
      },
      {
        tenantId: LAB, type: 'agendamento_remarcado', recipientName: 'Dra. Ana Souza', recipientPhone: TEL, status: 'SENT',
        externalMessageId: 'wamid-1', refEventId: 'evento-1', refPatientId: 'pac-1',
      },
    ]);
  });

  it('sem chip de Atendimento: FAILED com o texto do laboratório e nada sai', async () => {
    const m = montar({ chip: null });
    expect(await avisarAgendaDoLaboratorio(m.deps, pedido())).toEqual({ sent: false, reason: LAB_AGENDA_TEXTOS.semChip });
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
    expect(m.registros).toEqual([
      {
        tenantId: LAB, type: 'agendamento_criado', recipientName: 'Dra. Ana Souza', recipientPhone: TEL, status: 'FAILED',
        error: LAB_AGENDA_TEXTOS.semChip, refEventId: 'evento-1', refPatientId: 'pac-1',
      },
    ]);
  });

  it('Evolution recusou: FAILED com o motivo', async () => {
    const m = montar({ envio: { statusCode: 400, error: 'Bad Request' } });
    const r = await avisarAgendaDoLaboratorio(m.deps, pedido());
    expect(r).toEqual({ sent: false, reason: 'Evolution recusou o envio (HTTP 400): Bad Request' });
    expect(m.registros.map((x) => [x.status, x.error])).toEqual([['FAILED', 'Evolution recusou o envio (HTTP 400): Bad Request']]);
  });

  it('cliente sem telefone: não envia nem registra; o e-mail sai', async () => {
    const m = montar({ paciente: { ...PACIENTE_DO_LAB, phone: null } });
    expect(await avisarAgendaDoLaboratorio(m.deps, pedido())).toEqual({ sent: false, reason: LAB_AGENDA_TEXTOS.semTelefone });
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
    expect(m.registros).toEqual([]);
    expect(m.emailAutomation.dispatch).toHaveBeenCalledTimes(1);
  });

  it('nunca lança: falha de leitura vira FAILED', async () => {
    const m = montar();
    m.prisma.patient.findUnique = jest.fn(() => {
      throw new Error('banco fora');
    });
    expect(await avisarAgendaDoLaboratorio(m.deps, pedido())).toEqual({ sent: false, reason: 'banco fora' });
    expect(m.registros).toEqual([
      { tenantId: LAB, type: 'agendamento_criado', status: 'FAILED', error: 'banco fora', refEventId: 'evento-1', refPatientId: 'pac-1' },
    ]);
  });
});

describe('Aviso de agenda do laboratório — e-mail', () => {
  it('variáveis do e-mail do laboratório: cliente, tipo, data com ano, hora e local', async () => {
    const m = montar();
    await avisarAgendaDoLaboratorio(m.deps, pedido());
    await avisarAgendaDoLaboratorio(m.deps, pedido({ type: 'ENTREGA' }, 'rescheduled'));
    expect(m.emailAutomation.dispatch.mock.calls).toEqual([
      ['agendamento_criado', LAB, 'ana@exemplo.test', {
        cliente_nome: 'Dra. Ana Souza', tipo: 'coleta', data: '28/10/2026', hora: '14:00', local: 'Rua das Flores, 100, Centro, Maceió/AL',
      }],
      ['agendamento_remarcado', LAB, 'ana@exemplo.test', {
        cliente_nome: 'Dra. Ana Souza', tipo: 'entrega', data: '28/10/2026', hora: '14:00', local: 'Rua das Flores, 100, Centro, Maceió/AL',
      }],
    ]);
  });

  it('sem endereço: local "a combinar"; sem e-mail: nada', async () => {
    const semEndereco = montar({ paciente: { name: 'Dr. Paulo Lima', phone: TEL, email: 'paulo@exemplo.test' } });
    await avisarAgendaDoLaboratorio(semEndereco.deps, pedido());
    expect(semEndereco.emailAutomation.dispatch.mock.calls[0][3].local).toBe(LAB_AGENDA_TEXTOS.localACombinar);
    const semEmail = montar({ paciente: { ...PACIENTE_DO_LAB, email: null } });
    await avisarAgendaDoLaboratorio(semEmail.deps, pedido());
    expect(semEmail.emailAutomation.dispatch).not.toHaveBeenCalled();
  });
});

// ─── Pelo CalendarService: o chip e o texto da remarcação de verdade ─────────
// Mesmo carregador dos retratos: o jest deste projeto não executa `await import(...)`.
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

describe('Aviso de agenda do laboratório — pelo CalendarService', () => {
  beforeAll(() => {
    for (const nivel of ['log', 'warn', 'debug', 'error'] as const) jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
  });
  beforeEach(() => __limparCacheLabTenants());

  function servico(respostas: Record<string, (a: any) => any>) {
    const ops: Array<[string, any]> = [];
    const prisma: any = new Proxy({}, {
      get(_a, modelo: string | symbol) {
        if (typeof modelo !== 'string' || modelo === 'then') return undefined;
        if (modelo === 'tenantBusinessProfile') return { findMany: async () => [{ tenant_id: LAB }] };
        return new Proxy({}, {
          get(_m, metodo: string | symbol) {
            if (typeof metodo !== 'string' || metodo === 'then') return undefined;
            return async (args: any) => {
              const op = `${modelo}.${metodo}`;
              ops.push([op, args]);
              if (respostas[op]) return respostas[op](args);
              return metodo === 'findMany' ? [] : null;
            };
          },
        });
      },
    });
    const whatsapp = { sendText: jest.fn(async () => ({ key: { id: 'wamid-2' } })) };
    const email = { dispatch: jest.fn(async () => true) };
    const svc = new CalendarService(prisma, {} as any, {} as any, {} as any, whatsapp, email, {} as any);
    return { svc, whatsapp, ops };
  }

  it('só o chip Financeiro conectado: não envia por ele; FAILED com o texto do laboratório', async () => {
    const m = servico({
      'patient.findUnique': () => PACIENTE_DO_LAB,
      // Nenhum chip de Atendimento nem de Comercial; só o do Financeiro existe.
      'instance.findFirst': () => null,
      'instance.findMany': () => [{ name: 'chip-financeiro' }],
      'conversation.findFirst': () => null,
    });
    const r = await avisarAgendaDoLaboratorio((m.svc as any).depsDoAviso(), pedido());
    expect(r).toEqual({ sent: false, reason: LAB_AGENDA_TEXTOS.semChip });
    expect(m.whatsapp.sendText).not.toHaveBeenCalled();
    // O chip é pedido por função (Atendimento, depois Comercial) e o Financeiro fica fora.
    const buscas = m.ops.filter(([o]) => o === 'instance.findFirst').map(([, a]) => a.where);
    expect(buscas[0]).toEqual({ type: 'whatsapp', tenant_id: LAB, purpose: 'CLINICA' });
    expect(buscas[1]).toEqual({ type: 'whatsapp', tenant_id: LAB, purpose: 'COMERCIAL' });
    expect(buscas[2]).toEqual({ type: 'whatsapp', tenant_id: LAB, NOT: { purpose: 'FINANCEIRO' } });
    const registro = m.ops.find(([o]) => o === 'dispatchLog.create')?.[1].data;
    expect(registro).toMatchObject({ tenant_id: LAB, type: 'agendamento_criado', status: 'FAILED', error: LAB_AGENDA_TEXTOS.semChip });
  });

  it('chip de Atendimento da conta: sai por ele', async () => {
    const m = servico({
      'patient.findUnique': () => PACIENTE_DO_LAB,
      'instance.findFirst': ({ where }) => (where.purpose === 'CLINICA' ? { name: 'chip-atendimento-lab' } : null),
    });
    await avisarAgendaDoLaboratorio((m.svc as any).depsDoAviso(), pedido());
    expect((m.whatsapp.sendText.mock.calls[0] as any[])[2]).toBe('chip-atendimento-lab');
  });

  it('remarcação com o texto da conta vazio: o texto do laboratório, nunca o da clínica', async () => {
    const m = servico({
      'patient.findUnique': () => PACIENTE_DO_LAB,
      'instance.findFirst': ({ where }) => (where.purpose === 'CLINICA' ? { name: 'chip-atendimento-lab' } : null),
      'globalSetting.findUnique': ({ where }) =>
        where.key === `APPOINTMENT_RESCHEDULED_TEMPLATE_${LAB}` ? { value: JSON.stringify({ template: '  ' }) } : null,
    });
    await avisarAgendaDoLaboratorio((m.svc as any).depsDoAviso(), pedido({}, 'rescheduled'));
    const texto = (m.whatsapp.sendText.mock.calls[0] as any[])[1];
    expect(texto).toBe(
      'Olá Ana! O horário da coleta do seu trabalho mudou para *28/10* às *14:00*.\n' +
        '📍 Rua das Flores, 100, Centro, Maceió/AL\n\n' +
        'Qualquer dúvida, é só chamar por aqui.',
    );
    expect(texto).not.toContain('consulta');
    expect(texto).not.toBe(m.svc.DEFAULT_RESCHEDULED_TEMPLATE);
  });
});
