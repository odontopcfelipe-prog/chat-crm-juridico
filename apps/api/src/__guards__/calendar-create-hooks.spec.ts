/**
 * F1 — retrato de EFEITOS "clínica idêntica": o que CalendarService.create
 * dispara ao criar um evento na agenda, para CADA tipo de evento.
 *
 * Congela (jest snapshot, estrito), por tipo (CONSULTA, PROCEDIMENTO, RETORNO,
 * ORTODONTIA, BLOQUEIO, TAREFA, OUTRO e os legados AUDIENCIA, PERICIA, PRAZO):
 * o que é gravado no banco (evento, lembretes, auditoria, DispatchLog, datas de
 * visita), os jobs da fila `calendar-reminders` (lembretes e aviso de audiência),
 * o aviso de socket pro profissional, o e-mail automático (variáveis do modelo)
 * e QUANDO o create pede o WhatsApp "consulta agendada". E alguns caminhos que
 * mudam o que sai: lead × paciente, confirmação desligada, ortodontia por ordem
 * de chegada, encaixe já atendido, retroativo, recorrência, devedor.
 *
 * O TEXTO do WhatsApp não entra: sendAppointmentEventWhatsapp faz
 * `await import('@crm/shared')` antes de montar a mensagem, e o jest deste projeto
 * (module nodenext, sem --experimental-vm-modules) não executa import dinâmico —
 * mesmo motivo de calendar-reminder.chip.spec.ts. Aqui ele é trocado por um fake
 * que anota a chamada (evento, paciente, lead, clínica, tipo do aviso); só o
 * retorno antecipado de "evento no passado" (antes do import) roda de verdade.
 *
 * As fases do laboratório vão dar outros nomes aos tipos e avisos; o que a
 * CLÍNICA grava e manda ao criar cada tipo de evento tem que continuar isto.
 *
 * Sem banco, sem Redis, sem Evolution: Prisma é um gravador (Proxy), a fila, o
 * WhatsApp, o e-mail, o socket e o LeadsService (resolvido pelo ModuleRef) são
 * fakes que só anotam a chamada. Relógio fixo em 20/10/2026 12:00 de Maceió.
 * Se a mudança for de propósito para as clínicas:
 * `npx jest src/__guards__/calendar-create-hooks -u` em apps/api, commite o .snap
 * junto e explique no commit o que mudou (o diff do .snap mostra o efeito novo).
 */
import { Logger } from '@nestjs/common';
import { CalendarService } from '../calendar/calendar.service';
import { MSG_CRIAR_SO_ADMIN, TIPOS_CLINICOS } from '../calendar/agenda-status-guard';
import { LeadsService } from '../leads/leads.service';

const AGORA = new Date('2026-10-20T15:00:00.000Z'); // 12:00 em Maceió
const TENANT = 'tenant-clinica-exemplo';
const LEAD = 'lead-1';
const PACIENTE = 'paciente-1';
const TELEFONE = '5582900000001';
// A agenda grava a hora de Maceió "naive" no campo UTC: 14:00Z = 14:00 em Maceió.
const INICIO = '2026-10-27T14:00:00.000Z';
const FIM = '2026-10-27T14:30:00.000Z';
// Antecedências padrão que a tela da agenda manda (apps/web .../agenda/page.tsx).
const LEMBRETES_DA_TELA = [
  { minutes_before: 1440, channel: 'WHATSAPP' },
  { minutes_before: 60, channel: 'WHATSAPP' },
  { minutes_before: 15, channel: 'WHATSAPP' },
];
const TODOS_OS_TIPOS = [
  'CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA', 'BLOQUEIO', 'TAREFA', 'OUTRO',
  'AUDIENCIA', 'PERICIA', 'PRAZO',
];

type Efeito = [string, ...any[]];

const LEITURAS = new Set(['findUnique', 'findFirst', 'findMany', 'count', 'aggregate', 'groupBy']);

/**
 * Prisma falso: grava toda chamada `prisma.<model>.<método>(args)` na lista de
 * efeitos (em ordem, junto com os fakes) e responde pelo mapa `respostas`
 * (padrão: findMany → [], updateMany/deleteMany → {count: 1}, resto → null).
 * `$transaction(cb)` roda o callback com um gravador-FILHO, cujas chamadas saem
 * com o prefixo `tx.`, e grava `$transaction:fim` quando o callback termina.
 */
function gravador(efeitos: Efeito[], respostas: Record<string, (args: any) => any>) {
  const cliente = (prefixo: string): any => {
    const modelos: Record<string, any> = {};
    return new Proxy(
      {},
      {
        get(_alvo, modelo: string | symbol) {
          // Não é Promise nem tem símbolos (inspect/toPrimitive).
          if (typeof modelo !== 'string' || modelo === 'then') return undefined;
          if (modelo === '$transaction') {
            return async (cb: any) => {
              efeitos.push([`${prefixo}$transaction`]);
              const r = await cb(cliente(`${prefixo}tx.`));
              efeitos.push([`${prefixo}$transaction:fim`]);
              return r;
            };
          }
          modelos[modelo] ??= new Proxy(
            {},
            {
              get(_m, metodo: string | symbol) {
                if (typeof metodo !== 'string' || metodo === 'then') return undefined;
                return async (args: any) => {
                  const op = `${modelo}.${metodo}`;
                  efeitos.push([`${prefixo}${op}`, args]);
                  const r = respostas[op];
                  if (r) return r(args);
                  if (metodo === 'findMany') return [];
                  if (metodo === 'updateMany' || metodo === 'deleteMany') return { count: 1 };
                  return null;
                };
              },
            },
          );
          return modelos[modelo];
        },
      },
    );
  };
  return cliente('prisma.');
}

/** Fake de serviço vizinho: anota `[nome, ...args]` e devolve a resposta. */
function fake(efeitos: Efeito[], nome: string, resposta?: (...a: any[]) => any) {
  return (...args: any[]) => {
    efeitos.push([nome, ...args]);
    return resposta ? resposta(...args) : undefined;
  };
}

interface Mundo {
  /** O contato já é paciente (is_client). false = lead do Comercial. */
  is_client: boolean;
  /** GlobalSetting por chave completa (toggles da Central). Ausente = padrão do código. */
  config: Record<string, string>;
  /** Cobranças vencidas do paciente (bloqueio de devedor). */
  vencidas: { amount: number }[];
}

function montar(m: Partial<Mundo> = {}) {
  const mundo: Mundo = { is_client: true, config: {}, vencidas: [], ...m };
  const efeitos: Efeito[] = [];
  let filhos = 0;
  let criado: any = null;

  const respostas: Record<string, (args: any) => any> = {
    'globalSetting.findUnique': (a) =>
      a.where.key in mundo.config ? { key: a.where.key, value: mundo.config[a.where.key] } : null,
    // Paciente vinculado ao lead (o create resolve um pelo outro).
    'patient.findUnique': (a) =>
      a.where.lead_id === LEAD || a.where.id === PACIENTE
        ? {
            id: PACIENTE,
            lead_id: LEAD,
            name: 'Maria Exemplo da Silva',
            email: 'paciente@exemplo.test',
            phone: TELEFONE,
            first_visit_at: null,
            last_visit_at: null,
            lead: { is_client: mundo.is_client },
          }
        : null,
    'lead.findUnique': () => ({ name: 'Maria Exemplo', email: null, phone: TELEFONE, is_client: mundo.is_client }),
    'paymentGatewayCustomer.findMany': () => [{ external_id: 'cus_exemplo_1' }],
    'paymentGatewayCharge.findMany': () => mundo.vencidas,
    'calendarEvent.create': (a) => {
      const id = a.data.parent_event_id ? `evento-filho-${++filhos}` : 'evento-1';
      if (!a.data.parent_event_id) criado = a.data;
      return {
        id,
        ...a.data,
        reminders: (a.data.reminders?.create ?? []).map((r: any, i: number) => ({
          id: `${id}-lembrete-${i + 1}`,
          event_id: id,
          ...r,
        })),
        assigned_user: a.data.assigned_user_id ? { id: a.data.assigned_user_id, name: 'Dra. Ana Exemplo Souza' } : null,
        lead: a.data.lead_id ? { id: LEAD, name: 'Maria Exemplo', phone: TELEFONE, is_client: mundo.is_client } : null,
      };
    },
    // autoPromoteFromAttendance relê o evento recém-criado.
    'calendarEvent.findUnique': (a) =>
      a.where.id === 'evento-1' && criado
        ? { lead_id: criado.lead_id, patient_id: criado.patient_id, tenant_id: criado.tenant_id, type: criado.type, status: criado.status }
        : null,
    'instance.findFirst': (a) =>
      a.where.purpose === 'CLINICA'
        ? { name: 'chip-clinica-exemplo' }
        : a.where.purpose === 'COMERCIAL'
          ? { name: 'chip-comercial-exemplo' }
          : null,
    'tenant.findUnique': () => ({
      address: 'Rua Exemplo',
      address_number: '100',
      address_complement: null,
      neighborhood: 'Centro',
      city: 'Maceió',
      state: 'AL',
    }),
  };

  const prisma = gravador(efeitos, respostas);
  const chatGateway: any = { emitCalendarUpdate: fake(efeitos, 'socket.emitCalendarUpdate') };
  const fila: any = {
    add: fake(efeitos, 'fila.calendar-reminders.add', async () => ({ id: 'job' })),
    getJob: fake(efeitos, 'fila.calendar-reminders.getJob', async () => null),
  };
  const whatsapp: any = {
    sendText: fake(efeitos, 'whatsapp.sendText', async () => ({ data: { key: { id: 'wamid-exemplo-1' } } })),
    sendMedia: fake(efeitos, 'whatsapp.sendMedia', async () => ({ data: { key: { id: 'wamid-exemplo-2' } } })),
  };
  const email: any = { dispatch: fake(efeitos, 'email.dispatch', async () => undefined) };
  const waitlist: any = { notifySlotOpened: fake(efeitos, 'waitlist.notifySlotOpened', async () => ({ notified: 0 })) };
  const leads: any = {
    promoteToPatientIfEligible: fake(efeitos, 'leads.promoteToPatientIfEligible', async () => ({ ok: true })),
  };
  // ModuleRef falso: a agenda acha o LeadsService em runtime (regra compareceu → paciente).
  const moduleRef: any = { get: (cls: any) => (cls === LeadsService ? leads : undefined) };
  const agenda = new CalendarService(prisma, chatGateway, fila, waitlist, whatsapp, email, moduleRef);
  // O aviso "consulta agendada" por WhatsApp para no import dinâmico no jest (ver
  // cabeçalho): anota o pedido com o resumo do evento e não roda o corpo.
  jest
    .spyOn(agenda as any, 'sendAppointmentEventWhatsapp')
    .mockImplementation(async (ev: any, patientId: any, leadId: any, tenantId: any, kind: any) => {
      efeitos.push([
        'agenda.sendAppointmentEventWhatsapp',
        {
          evento: ev.id,
          type: ev.type,
          status: ev.status,
          start_at: ev.start_at,
          lead_is_client: ev.lead?.is_client ?? null,
          dentista: ev.assigned_user?.name ?? null,
        },
        patientId,
        leadId,
        tenantId,
        kind,
      ]);
      return { sent: false, reason: 'fake do retrato' };
    });
  return { efeitos, agenda, prisma };
}

// O método real, guardado antes de qualquer spy (pra rodar o retorno de "evento no passado").
const sendAppointmentEventWhatsappReal = (CalendarService.prototype as any).sendAppointmentEventWhatsapp;

/** O que a tela manda ao salvar (controller injeta created_by_id, tenant_id e actor_roles). */
function evento(tipo: string, extra: Record<string, any> = {}) {
  return {
    type: tipo,
    title: `${tipo} de exemplo`,
    description: 'Observação de exemplo',
    start_at: INICIO,
    end_at: FIM,
    lead_id: LEAD,
    assigned_user_id: 'dentista-1',
    created_by_id: 'recepcao-1',
    tenant_id: TENANT,
    actor_roles: ['OPERADOR'],
    reminders: LEMBRETES_DA_TELA,
    ...extra,
  } as any;
}

/** Deixa terminar os avisos soltos com `void` (WhatsApp, e-mail). */
async function drenar() {
  for (let i = 0; i < 5; i++) await new Promise((res) => setImmediate(res));
}

const ehLeitura = (e: Efeito) => {
  const m = /^prisma\.(?:tx\.)?\w+\.(\w+)$/.exec(e[0]);
  return !!m && LEITURAS.has(m[1]);
};
/**
 * O que vai pro snapshot: escritas e chamadas a vizinhos com os argumentos;
 * leituras numa linha só, com o `where` (mostra QUAL toggle/cadastro foi lido).
 */
const retrato = (efeitos: Efeito[]) =>
  efeitos.map((e) => (ehLeitura(e) ? `${e[0]} ${JSON.stringify(e[1]?.where ?? e[1] ?? null)}` : e));
const chamadas = (efeitos: Efeito[], op: string) => efeitos.filter((e) => e[0] === op);

describe('retrato: efeitos de CalendarService.create por tipo de evento (F1)', () => {
  let avisos: string[];

  beforeEach(() => {
    // Só o relógio é falso (atrasos dos lembretes, "evento no passado", vencidos de
    // hoje); setImmediate/setTimeout seguem reais (drenar e o limite da fila).
    jest.useFakeTimers({
      now: AGORA,
      doNotFake: [
        'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
        'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
      ],
    });
    // Logs calados; warn/error anotados — erro engolido por best-effort aparece aqui.
    avisos = [];
    for (const nivel of ['log', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined);
    }
    for (const nivel of ['warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, nivel).mockImplementation((m: any) => {
        avisos.push(String(m));
      });
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('a lista de tipos aceitos e de tipos clínicos é a de hoje', async () => {
    expect([...TIPOS_CLINICOS]).toEqual(['CONSULTA', 'PROCEDIMENTO', 'RETORNO', 'ORTODONTIA']);
    const { agenda, efeitos } = montar();
    // AVALIACAO não é tipo de evento (avaliação é CONSULTA): a agenda recusa.
    const erro: any = await agenda.create(evento('AVALIACAO')).catch((e) => e);
    expect(erro?.getStatus?.()).toBe(400);
    expect(erro.message).toBe(`Tipo invalido: AVALIACAO. Use: ${TODOS_OS_TIPOS.join(', ')}`);
    expect(efeitos).toEqual([]);
  });

  describe('um retrato por tipo (paciente da clínica, padrões da Central, 3 lembretes da tela)', () => {
    it.each(TODOS_OS_TIPOS)('%s', async (tipo) => {
      const { agenda, efeitos } = montar();
      const ev: any = await agenda.create(evento(tipo));
      await drenar();

      expect(ev.id).toBe('evento-1');
      expect(avisos).toEqual([]);

      const clinico = (TIPOS_CLINICOS as readonly string[]).includes(tipo);
      // Os 3 lembretes de WhatsApp viram 3 jobs (24h, 1h, 15 min antes do horário real).
      const jobs = chamadas(efeitos, 'fila.calendar-reminders.add');
      expect(jobs.filter((j) => j[1] === 'send-reminder').map((j) => j[3].jobId)).toEqual([
        'reminder-evento-1-lembrete-1', 'reminder-evento-1-lembrete-2', 'reminder-evento-1-lembrete-3',
      ]);
      // Aviso imediato ao cliente só nos legados AUDIENCIA/PERICIA.
      expect(jobs.filter((j) => j[1] === 'notify-hearing-scheduled')).toHaveLength(
        tipo === 'AUDIENCIA' || tipo === 'PERICIA' ? 1 : 0,
      );
      // "Consulta agendada" (WhatsApp + e-mail) só nos tipos clínicos.
      expect(chamadas(efeitos, 'agenda.sendAppointmentEventWhatsapp')).toHaveLength(clinico ? 1 : 0);
      expect(chamadas(efeitos, 'email.dispatch')).toHaveLength(clinico ? 1 : 0);
      expect(chamadas(efeitos, 'whatsapp.sendText')).toEqual([]);
      expect(chamadas(efeitos, 'socket.emitCalendarUpdate')).toHaveLength(1);
      // Nada de Task: criar evento não mexe em tarefa.
      expect(efeitos.filter((e) => e[0].startsWith('prisma.task.'))).toEqual([]);

      expect(retrato(efeitos)).toMatchSnapshot('efeitos em ordem');
    });

    it.each([...TIPOS_CLINICOS])('%s sem dentista responsável: 400 e nada gravado', async (tipo) => {
      const { agenda, efeitos } = montar();
      const erro: any = await agenda.create(evento(tipo, { assigned_user_id: undefined })).catch((e) => e);
      expect(erro?.getStatus?.()).toBe(400);
      expect(efeitos).toEqual([]);
    });
  });

  describe('caminhos que mudam o que sai', () => {
    it('lembretes repetidos, por e-mail e push: dedup por (antecedência, canal); push não vai pra fila', async () => {
      const { agenda, efeitos } = montar();
      await agenda.create(
        evento('CONSULTA', {
          reminders: [
            { minutes_before: 1440, channel: 'WHATSAPP' },
            { minutes_before: 1440, channel: 'WHATSAPP' },
            { minutes_before: 1440, channel: 'EMAIL' },
            { minutes_before: 30 },
          ],
        }),
      );
      await drenar();

      expect(avisos).toEqual([]);
      const [criar] = chamadas(efeitos, 'prisma.calendarEvent.create');
      expect(criar[1].data.reminders).toEqual({
        create: [
          { minutes_before: 1440, channel: 'WHATSAPP' },
          { minutes_before: 1440, channel: 'EMAIL' },
          { minutes_before: 30, channel: 'PUSH' },
        ],
      });
      expect(retrato(efeitos)).toMatchSnapshot('efeitos em ordem');
    });

    it('contato ainda LEAD (is_client=false) com ficha: o create pede o mesmo aviso (a escolha Comercial × Clínica é lá dentro) e manda o e-mail', async () => {
      const { agenda, efeitos } = montar({ is_client: false });
      await agenda.create(evento('CONSULTA'));
      await drenar();

      expect(avisos).toEqual([]);
      const [pedido] = chamadas(efeitos, 'agenda.sendAppointmentEventWhatsapp');
      expect(pedido[1].lead_is_client).toBe(false);
      expect(chamadas(efeitos, 'email.dispatch')).toHaveLength(1);
      expect(retrato(efeitos)).toMatchSnapshot('efeitos em ordem');
    });

    it('"Confirmação de agendamento" desligada na Central: nem WhatsApp nem e-mail, só os lembretes', async () => {
      const { agenda, efeitos } = montar({ config: { [`APPOINTMENT_CONFIRMATION_ENABLED_${TENANT}`]: 'false' } });
      await agenda.create(evento('CONSULTA'));
      await drenar();

      expect(avisos).toEqual([]);
      expect(chamadas(efeitos, 'agenda.sendAppointmentEventWhatsapp')).toEqual([]);
      expect(chamadas(efeitos, 'email.dispatch')).toEqual([]);
      expect(retrato(efeitos)).toMatchSnapshot('efeitos em ordem');
    });

    it('ORTODONTIA por ordem de chegada com a confirmação imediata de ortô ligada: pede o WhatsApp, sem e-mail', async () => {
      const { agenda, efeitos } = montar({
        config: {
          [`ORTO_ORDEM_CHEGADA_${TENANT}`]: 'true',
          [`APPOINTMENT_ORTO_IMMEDIATE_ENABLED_${TENANT}`]: 'true',
        },
      });
      await agenda.create(evento('ORTODONTIA'));
      await drenar();

      expect(avisos).toEqual([]);
      expect(chamadas(efeitos, 'agenda.sendAppointmentEventWhatsapp')).toHaveLength(1);
      expect(chamadas(efeitos, 'email.dispatch')).toEqual([]);
      expect(retrato(efeitos)).toMatchSnapshot('efeitos em ordem');
    });

    it('ORTODONTIA por ordem de chegada com a confirmação imediata DESLIGADA (padrão): nem WhatsApp nem e-mail', async () => {
      const { agenda, efeitos } = montar({ config: { [`ORTO_ORDEM_CHEGADA_${TENANT}`]: 'true' } });
      await agenda.create(evento('ORTODONTIA'));
      await drenar();

      expect(avisos).toEqual([]);
      expect(chamadas(efeitos, 'agenda.sendAppointmentEventWhatsapp')).toEqual([]);
      expect(chamadas(efeitos, 'email.dispatch')).toEqual([]);
      expect(retrato(efeitos)).toMatchSnapshot('efeitos em ordem');
    });

    // Encaixe de hoje 11:00 (já passou): lembretes não vão pra fila.
    const ENCAIXE = { start_at: '2026-10-20T11:00:00.000Z', end_at: '2026-10-20T11:30:00.000Z' };

    it('encaixe lançado pelo ADMIN já como CONCLUIDO: auditoria, datas de visita e lead → paciente', async () => {
      const { agenda, efeitos } = montar();
      await agenda.create(evento('CONSULTA', { ...ENCAIXE, status: 'CONCLUIDO', actor_roles: ['ADMIN'] }));
      await drenar();

      expect(avisos).toEqual([]);
      expect(chamadas(efeitos, 'prisma.auditLog.create')).toHaveLength(1);
      expect(chamadas(efeitos, 'prisma.patient.update')).toHaveLength(1);
      expect(chamadas(efeitos, 'leads.promoteToPatientIfEligible')).toEqual([
        ['leads.promoteToPatientIfEligible', LEAD, TENANT, 'agenda CONCLUIDO (evento evento-1)'],
      ]);
      expect(retrato(efeitos)).toMatchSnapshot('efeitos em ordem');
    });

    it('recepção encaixa já como COMPARECEU (Chegou): auditoria e lead → paciente, sem datas de visita', async () => {
      const { agenda, efeitos } = montar();
      await agenda.create(evento('CONSULTA', { ...ENCAIXE, status: 'COMPARECEU' }));
      await drenar();

      expect(avisos).toEqual([]);
      expect(chamadas(efeitos, 'prisma.auditLog.create')).toHaveLength(1);
      expect(chamadas(efeitos, 'prisma.patient.update')).toEqual([]);
      expect(chamadas(efeitos, 'leads.promoteToPatientIfEligible')).toEqual([
        ['leads.promoteToPatientIfEligible', LEAD, TENANT, 'agenda COMPARECEU (evento evento-1)'],
      ]);
      expect(retrato(efeitos)).toMatchSnapshot('efeitos em ordem');
    });

    it('não-ADMIN não cria consulta já CONCLUIDO: 403 e nada gravado', async () => {
      const { agenda, efeitos } = montar();
      const erro: any = await agenda.create(evento('CONSULTA', { status: 'CONCLUIDO' })).catch((e) => e);
      expect(erro?.getStatus?.()).toBe(403);
      expect(JSON.stringify(erro.getResponse())).toContain(MSG_CRIAR_SO_ADMIN);
      expect(efeitos).toEqual([]);
    });

    it('retroativo (hoje 08:00, já passou): sem jobs de lembrete; o WhatsApp é pedido e o e-mail ainda sai', async () => {
      const { agenda, efeitos } = montar();
      await agenda.create(
        evento('CONSULTA', { start_at: '2026-10-20T08:00:00.000Z', end_at: '2026-10-20T08:30:00.000Z' }),
      );
      await drenar();

      expect(avisos).toEqual([]);
      expect(chamadas(efeitos, 'fila.calendar-reminders.add')).toEqual([]);
      expect(chamadas(efeitos, 'agenda.sendAppointmentEventWhatsapp')).toHaveLength(1);
      expect(chamadas(efeitos, 'email.dispatch')).toHaveLength(1);
      expect(retrato(efeitos)).toMatchSnapshot('efeitos em ordem');
    });

    it('o aviso por WhatsApp REAL com evento no passado: não envia, não lê nada, não grava DispatchLog', async () => {
      const { agenda, efeitos } = montar();
      const ev = {
        id: 'evento-1',
        type: 'CONSULTA',
        start_at: new Date('2026-10-20T08:00:00.000Z'),
        lead: { id: LEAD, name: 'Maria Exemplo', phone: TELEFONE, is_client: true },
        assigned_user: { id: 'dentista-1', name: 'Dra. Ana Exemplo Souza' },
      };
      const r = await sendAppointmentEventWhatsappReal.call(agenda, ev, PACIENTE, LEAD, TENANT, 'created');
      await drenar();

      expect(r).toEqual({ sent: false, reason: 'evento_passado' });
      expect(efeitos).toEqual([]);
      expect(avisos).toEqual([]);
    });

    it('recorrência semanal até 17/11: 3 filhos com os lembretes do pai, cada um com seus jobs', async () => {
      const { agenda, efeitos } = montar();
      await agenda.create(
        evento('RETORNO', { recurrence_rule: 'WEEKLY', recurrence_end: '2026-11-17T23:59:00.000Z' }),
      );
      await drenar();

      expect(avisos).toEqual([]);
      const filhos = chamadas(efeitos, 'prisma.calendarEvent.create').slice(1);
      expect(filhos.map((f) => f[1].data.start_at.toISOString())).toEqual([
        '2026-11-03T14:00:00.000Z', '2026-11-10T14:00:00.000Z', '2026-11-17T14:00:00.000Z',
      ]);
      expect(retrato(efeitos)).toMatchSnapshot('efeitos em ordem');
    });

    it('devedor com o bloqueio ligado: 400 com o valor em atraso e o evento NÃO é gravado', async () => {
      const { agenda, efeitos } = montar({
        config: { [`BLOCK_SCHED_ON_OVERDUE_${TENANT}`]: 'true' },
        vencidas: [{ amount: 150 }],
      });
      const erro: any = await agenda.create(evento('CONSULTA')).catch((e) => e);
      await drenar();

      expect(erro?.getStatus?.()).toBe(400);
      expect(erro.getResponse()).toMatchSnapshot('resposta 400');
      expect(chamadas(efeitos, 'prisma.calendarEvent.create')).toEqual([]);
      expect(retrato(efeitos)).toMatchSnapshot('efeitos em ordem');
    });

    it('devedor liberado por ADMIN com motivo: grava a liberação no próprio evento', async () => {
      const { agenda, efeitos } = montar({
        config: { [`BLOCK_SCHED_ON_OVERDUE_${TENANT}`]: 'true' },
        vencidas: [{ amount: 150 }],
      });
      await agenda.create(
        evento('CONSULTA', {
          actor_roles: ['ADMIN'],
          override_overdue_block: true,
          override_overdue_reason: '  Acordo de pagamento combinado  ',
        }),
      );
      await drenar();

      expect(avisos).toEqual([]);
      const [criar] = chamadas(efeitos, 'prisma.calendarEvent.create');
      expect(criar[1].data).toMatchObject({
        overdue_override_by_user_id: 'recepcao-1',
        overdue_override_at: AGORA,
        overdue_override_reason: 'Acordo de pagamento combinado',
      });
      expect(retrato(efeitos)).toMatchSnapshot('efeitos em ordem');
    });
  });
});
