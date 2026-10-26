/**
 * F1 — retrato de comportamento "clínica idêntica": as MENSAGENS que o WORKER manda ao paciente.
 *
 * Complemento de apps/api/src/__guards__/mensagens-paciente.spec.ts. Congela (jest
 * snapshot, estrito) o texto que sai pela Evolution nos crons do worker: régua de
 * cobrança (cada estágio × tipo de pagamento, boleto único e aviso agrupado, com a
 * mensagem do código PIX), apresentação do Financeiro, confirmação de agendamento
 * 24h (e a de ortodontia), lembrete de ortodontia, recall de revisão, a
 * confirmação fixa que sai quando a IA marca a avaliação e a pesquisa
 * pós-atendimento. As fases do laboratório trocam palavras num caminho NOVO; a
 * clínica tem que continuar recebendo exatamente isto.
 *
 * Services reais, construídos com `new`: Prisma mockado (gravador), Evolution
 * mockada no axios (grava o corpo de cada POST) — sem banco, sem rede. Relógio
 * fixo (terça 20/10/2026, 12:00 em Maceió).
 *
 * Fuso: a confirmação 24h e o lembrete de ortodontia formatam {data}/{hora} com
 * toLocale* SEM timeZone, ou seja, no fuso do PROCESSO. Produção e CI rodam em UTC
 * e saem com a hora naive de Maceió; noutro fuso sairiam deslocadas. Nesses dois
 * retratos a data/hora renderizadas viram ‹data›/‹hora› (o snapshot vale em
 * qualquer fuso) e o valor em UTC é conferido à parte quando o processo roda em UTC.
 *
 * Se a mudança for de propósito para as clínicas:
 * `npx jest __guards__/mensagens-paciente-worker -u` em apps/worker e commite o .snap
 * junto, explicando no commit o que o paciente passa a receber.
 */
import axios from 'axios';
import { COBRANCA_STAGES, COBRANCA_TIPOS, type CobrancaStage, type CobrancaTipo } from '@crm/shared';
import { AppointmentConfirmationDispatcherService } from '../automation/appointment-confirmation-dispatcher.service';
import { AppointmentConfirmationSchedulerService } from '../automation/appointment-confirmation-scheduler.service';
import { BookAppointmentHandler } from '../ai/tool-handlers/book-appointment';
import { AppointmentOrtoReminderService } from '../automation/appointment-orto-reminder.service';
import { MaintenanceRecallCronService } from '../maintenance/maintenance-recall-cron.service';
import { PaymentAlertsCronService } from '../payment/payment-alerts-cron.service';
import { PostCareCronService } from '../post-care/post-care-cron.service';

jest.mock('axios', () => {
  const m: any = { post: jest.fn(), get: jest.fn() };
  m.default = m;
  return { __esModule: true, ...m };
});

// ─── Dados de exemplo (repositório público: nada real) ───────────────────────
const TENANT = 'tenant-clinica-exemplo';
const CLINICA = 'Clínica Exemplo';
const AGORA = new Date('2026-10-20T15:00:00.000Z'); // terça, 12:00 em Maceió
const TEL = '5582900000001';
const PACIENTE = 'Maria Exemplo da Silva';
const DENTISTA = 'Dra. Ana Exemplo Souza';
const EVO = 'https://evolution.exemplo.test';
const PIX_EXEMPLO = '000201EXEMPLO-PIX-COPIA-E-COLA';
const ENDERECO = {
  address: 'Rua Exemplo', address_number: '100', address_complement: 'Sala 2',
  neighborhood: 'Centro', city: 'Maceió', state: 'AL',
};
// Consulta na quarta 21/10/2026 às 14:30 de Maceió — gravada nos campos UTC (naive).
const CONSULTA = new Date('2026-10-21T14:30:00.000Z');

/**
 * Prisma falso: grava `prisma.<model>.<método>(args)` e responde pelo mapa
 * `respostas` (padrão: null). `$transaction(cb)` roda o callback com o mesmo
 * gravador; `$executeRaw` (template) é aceito e não faz nada.
 */
function gravador(respostas: Record<string, (args: any) => any> = {}) {
  const chamadas: { op: string; args: any }[] = [];
  const modelos: Record<string, any> = {};
  const prisma: any = new Proxy(
    {},
    {
      get(_alvo, modelo: string | symbol) {
        if (typeof modelo !== 'string' || modelo === 'then') return undefined;
        if (modelo === '$transaction') return async (cb: any) => cb(prisma);
        if (modelo.startsWith('$')) return async () => 0;
        modelos[modelo] ??= new Proxy(
          {},
          {
            get(_m, metodo: string | symbol) {
              if (typeof metodo !== 'string' || metodo === 'then') return undefined;
              return async (args: any) => {
                const op = `${modelo}.${metodo}`;
                chamadas.push({ op, args });
                const r = respostas[op];
                return r ? r(args) : null;
              };
            },
          },
        );
        return modelos[modelo];
      },
    },
  );
  const de = (op: string) => chamadas.filter((c) => c.op === op).map((c) => c.args);
  return { prisma, de };
}

/** Banco de uma clínica de exemplo. `settings` = GlobalSetting por chave. */
function banco(extra: Record<string, (args: any) => any> = {}, settings: Record<string, string> = {}) {
  return {
    'globalSetting.findUnique': (a: any) => (a.where.key in settings ? { value: settings[a.where.key] } : null),
    'globalSetting.findMany': () => [],
    'tenantSetting.findUnique': () => null,
    'tenant.findUnique': () => ({ name: CLINICA, ...ENDERECO }),
    'instance.findFirst': (a: any) => ({ name: `chip-${String(a?.where?.purpose ?? 'clinica').toLowerCase()}` }),
    'instance.findMany': () => [
      { name: 'chip-clinica', purpose: 'CLINICA' },
      { name: 'chip-comercial', purpose: 'COMERCIAL' },
      { name: 'chip-financeiro', purpose: 'FINANCEIRO' },
    ],
    'disparoAnexo.findMany': () => [],
    'dispatchLog.findFirst': () => null,
    'dispatchLog.count': () => 0,
    'auditLog.findFirst': () => null,
    ...extra,
  };
}

const SETTINGS: any = {
  getEvolutionConfig: async () => ({ apiUrl: EVO, apiKey: 'chave-somente-teste' }),
  getAsaasConfig: async () => null,
};

/** Corpo de cada POST pra Evolution, como o paciente recebe. */
let envios: any[] = [];

beforeEach(() => {
  envios = [];
  let n = 0;
  (axios.post as jest.Mock).mockImplementation(async (url: string, corpo: any) => {
    n++;
    envios.push({ rota: String(url).replace(EVO, ''), ...corpo });
    return { data: { key: { id: `wamid-${n}` } } };
  });
  (axios.get as jest.Mock).mockRejectedValue(new Error('sem rede no retrato'));
  // Só o relógio é falso; promessas e timers seguem reais.
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
});

// O worker formata {data}/{hora} no fuso do processo (ver cabeçalho).
const NO_FUSO = {
  data: CONSULTA.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
  hora: CONSULTA.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
};
const semFuso = (s: string) => s.split(NO_FUSO.data).join('‹data›').split(NO_FUSO.hora).join('‹hora›');

describe('retrato: régua de cobrança → paciente (F1)', () => {
  // Vencimento coerente com o estágio (hoje em Maceió = 20/10/2026).
  const VENCE: Record<CobrancaStage, string> = {
    boleto_1d_antes: '2026-10-21',
    boleto_no_dia: '2026-10-20',
    boleto_atraso_1d: '2026-10-19',
    boleto_atraso_2d: '2026-10-18',
    boleto_atraso_3d: '2026-10-17',
    boleto_atraso_15d: '2026-10-05',
    boleto_atraso_30d: '2026-09-20',
    boleto_atrasado: '2026-08-10',
  };
  const LINK = 'https://pagamento.exemplo.test/fatura/1';
  const PDF = 'https://asaas.exemplo.test/b/parcela.pdf';

  function membro(i: number, over: Record<string, any> = {}) {
    return { chargeId: `ch-${i}`, amount: 250, dueDate: new Date(`${VENCE.boleto_atraso_15d}T00:00:00.000Z`), link: `${LINK}?p=${i}`, ...over };
  }

  /** Boleto ÚNICO: boleto/parcelado com PDF + PIX do boleto; PIX à vista sem PDF. */
  function unico(stage: CobrancaStage, tipo: CobrancaTipo, over: Record<string, any> = {}) {
    const dueDate = new Date(`${VENCE[stage]}T00:00:00.000Z`);
    const pdfUrls = tipo === 'pix' ? [] : [PDF];
    return {
      chargeId: 'ch-1', gateway: 'LOCAL', patientId: 'pac-1', tenantId: TENANT, stage, phone: TEL, name: PACIENTE,
      amount: 250, count: 1, dueDate, link: LINK, codigo: PIX_EXEMPLO, pdfUrls, tipo,
      members: [{ chargeId: 'ch-1', amount: 250, dueDate, link: LINK, codigo: PIX_EXEMPLO, pdfUrl: pdfUrls[0], tipo }],
      ...over,
    };
  }

  function regua() {
    const g = gravador(
      banco({
        // Freio ao vivo: tudo ainda em aberto no banco.
        'paymentGatewayCharge.findMany': (a: any) =>
          (a?.where?.id?.in ?? []).map((id: string) => ({ id, status: 'PENDING', received_in_cash: false })),
      }),
    );
    return new PaymentAlertsCronService(g.prisma, SETTINGS);
  }

  it('apps/worker/src/payment/payment-alerts-cron.service.ts — sendPacedCharge, boleto único: cada estágio × tipo (+ código PIX em msg separada)', async () => {
    const casos: Record<string, any> = {};
    for (const stage of COBRANCA_STAGES) {
      for (const tipo of COBRANCA_TIPOS) {
        envios = [];
        const r = await (regua() as any).sendPacedCharge(unico(stage, tipo), AGORA.getTime());
        expect([stage, tipo, r]).toEqual([stage, tipo, 'sent']);
        casos[`${stage} · ${tipo}`] = envios;
      }
    }
    expect(casos).toMatchSnapshot();
  });

  it('apps/worker/src/payment/payment-alerts-cron.service.ts — sendPacedCharge, casos de borda do boleto único', async () => {
    const casos: Record<string, any> = {};
    const rodar = async (nome: string, pick: any) => {
      envios = [];
      expect(await (regua() as any).sendPacedCharge(pick, AGORA.getTime())).toBe('sent');
      casos[nome] = envios;
    };
    // Vence na segunda: o aviso sai na sexta e troca o "amanhã" do texto.
    await rodar(
      '1 dia antes, vencimento na segunda (sai na sexta)',
      unico('boleto_1d_antes', 'boleto', { venceEm: 'na segunda-feira', dueDate: new Date('2026-10-26T00:00:00.000Z') }),
    );
    // Sem PDF e sem código: o link vai no texto (nunca fica sem como pagar).
    await rodar(
      'atraso 3d · parcelado sem PDF e sem código (só link)',
      unico('boleto_atraso_3d', 'parcelado', {
        pdfUrls: [], codigo: undefined,
        members: [{ chargeId: 'ch-1', amount: 250, dueDate: new Date('2026-10-17T00:00:00.000Z'), link: LINK, tipo: 'parcelado' }],
      }),
    );
    expect(casos).toMatchSnapshot();
  });

  it('apps/worker/src/payment/payment-alerts-cron.service.ts + cobranca-grupo.ts — sendPacedCharge, aviso AGRUPADO', async () => {
    const grupo = (stage: CobrancaStage, members: any[]) => ({
      chargeId: members[0].chargeId, gateway: 'LOCAL', patientId: 'pac-1', tenantId: TENANT, stage, phone: TEL, name: PACIENTE,
      amount: members.reduce((s, m) => s + m.amount, 0), count: members.length, dueDate: members[0].dueDate,
      link: members[0].link, codigo: undefined, pdfUrls: [], tipo: 'parcelado', members,
    });
    const casos: Record<string, any> = {};
    const rodar = async (nome: string, pick: any) => {
      envios = [];
      expect(await (regua() as any).sendPacedCharge(pick, AGORA.getTime())).toBe('sent');
      casos[nome] = envios;
    };
    await rodar(
      '3 boletos com PDF',
      grupo('boleto_atraso_15d', [1, 2, 3].map((i) => membro(i, { pdfUrl: `https://asaas.exemplo.test/b/parcela-${i}.pdf`, codigo: `${PIX_EXEMPLO}-${i}` }))),
    );
    await rodar('2 cobranças só com PIX', grupo('boleto_atraso_15d', [1, 2].map((i) => membro(i, { codigo: `${PIX_EXEMPLO}-${i}` }))));
    await rodar(
      'misto: 1 PDF, 1 PIX e 1 só link',
      grupo('boleto_atrasado', [
        membro(1, { pdfUrl: 'https://asaas.exemplo.test/b/parcela-1.pdf' }),
        membro(2, { codigo: `${PIX_EXEMPLO}-2`, dueDate: new Date('2026-09-05T00:00:00.000Z') }),
        membro(3, { dueDate: new Date('2026-08-05T00:00:00.000Z') }),
      ]),
    );
    expect(casos).toMatchSnapshot();
  });

  it('apps/worker/src/payment/payment-alerts-cron.service.ts — sendIntro (apresentação do Financeiro, D+1)', async () => {
    expect(await (regua() as any).sendIntro({ planId: 'plan-1', tenantId: TENANT, phone: TEL, name: PACIENTE }, AGORA.getTime())).toBe('sent');
    expect(envios).toMatchSnapshot();
  });
});

describe('retrato: agenda → paciente pelo worker (F1)', () => {
  it('em UTC (CI/produção) a data/hora do worker saem como a hora naive de Maceió', () => {
    if (Intl.DateTimeFormat().resolvedOptions().timeZone === 'UTC') {
      expect(NO_FUSO).toEqual({ data: '21/10', hora: '14:30' });
    } else {
      expect(NO_FUSO.data).toMatch(/^\d{2}\/\d{2}$/);
    }
  });

  function eventoAgenda(over: Record<string, any> = {}) {
    return {
      id: 'ev-1', tenant_id: TENANT, type: 'CONSULTA', title: 'Avaliação', start_at: CONSULTA, location: null,
      assigned_user: { name: DENTISTA },
      patient: { id: 'pac-1', name: PACIENTE, phone: TEL, lead: { is_client: true } },
      ...over,
    };
  }

  it('apps/worker/src/automation/appointment-confirmation-scheduler.service.ts — scheduleConfirmations (confirmação 24h e de ortodontia)', async () => {
    const casos: Record<string, any> = {};
    const rodar = async (nome: string, ev: any, settings: Record<string, string> = {}, extra = {}) => {
      const g = gravador(banco({ 'calendarEvent.findMany': () => [ev], ...extra }, settings));
      await new AppointmentConfirmationSchedulerService(g.prisma).scheduleConfirmations();
      const criadas = g.de('appointmentConfirmation.create');
      expect([nome, criadas.length]).toEqual([nome, 1]);
      casos[nome] = semFuso(criadas[0].data.message_text);
    };
    await rodar('consulta (texto padrão do worker)', eventoAgenda());
    await rodar('consulta sem endereço cadastrado', eventoAgenda(), {}, { 'tenant.findUnique': () => ({ name: CLINICA }) });
    await rodar('consulta com local digitado no evento', eventoAgenda({ location: 'Unidade Centro — 2º andar' }));
    await rodar('ortodontia por ordem de chegada + confirmação de ortô ligada', eventoAgenda({ type: 'ORTODONTIA' }), {
      [`ORTO_ORDEM_CHEGADA_${TENANT}`]: 'true',
      [`APPOINTMENT_CONFIRMATION_ORTO_ENABLED_${TENANT}`]: 'true',
    });
    expect(casos).toMatchSnapshot();
  });

  it('apps/worker/src/automation/appointment-confirmation-dispatcher.service.ts — dispatchPending (texto de reserva quando a linha veio sem mensagem)', async () => {
    const g = gravador(
      banco({
        'appointmentConfirmation.findMany': () => [
          { id: 'conf-1', message_text: null, appointment: { id: 'ev-1', tenant_id: TENANT, type: 'CONSULTA', start_at: CONSULTA, patient: { id: 'pac-1', name: PACIENTE, phone: TEL } } },
        ],
        'appointmentConfirmation.updateMany': () => ({ count: 1 }),
      }),
    );
    await new AppointmentConfirmationDispatcherService(g.prisma, SETTINGS).dispatchPending();
    expect(envios).toMatchSnapshot();
  });

  it('apps/worker/src/automation/appointment-orto-reminder.service.ts — sendOrtoReminders (portões ~1h antes)', async () => {
    const g = gravador(
      banco(
        { 'calendarEvent.findMany': () => [eventoAgenda({ type: 'ORTODONTIA' })] },
        { [`APPOINTMENT_ORTO_REMINDER_ENABLED_${TENANT}`]: 'true', [`ORTO_ORDEM_CHEGADA_${TENANT}`]: 'true' },
      ),
    );
    await new AppointmentOrtoReminderService(g.prisma, SETTINGS).sendOrtoReminders();
    expect(envios).toHaveLength(1);
    expect(envios.map((e) => ({ ...e, text: semFuso(e.text) }))).toMatchSnapshot();
  });

  it('apps/worker/src/maintenance/maintenance-recall-cron.service.ts — sendOnePacedRecall (recall de revisão, DEFAULT_RECALL_TEMPLATE)', async () => {
    const g = gravador(
      banco({
        'maintenanceTask.findFirst': () => ({
          id: 'task-1', title: 'Revisão', due_date: new Date('2026-10-25T15:00:00.000Z'),
          patient: { id: 'pac-1', name: PACIENTE, phone: TEL, tenant_id: TENANT },
          procedure: { name: 'Limpeza' },
        }),
        'maintenanceTask.updateMany': () => ({ count: 1 }),
        'whatsappChipPacer.updateMany': () => ({ count: 1 }),
      }),
    );
    expect(await new MaintenanceRecallCronService(g.prisma, SETTINGS).sendOnePacedRecall()).toBe('sent');
    expect(envios).toMatchSnapshot();
  });

  it('apps/worker/src/ai/tool-handlers/book-appointment.ts — notifyPatient (confirmação fixa quando a IA marca a avaliação)', async () => {
    const instanciaAntes = process.env.EVOLUTION_INSTANCE_NAME;
    process.env.EVOLUTION_INSTANCE_NAME = 'chip-do-env';
    try {
      const casos: Record<string, any> = {};
      const rodar = async (nome: string, ev: any, settings: Record<string, string>) => {
        envios = [];
        const g = gravador(banco({}, { EVOLUTION_API_URL: EVO, EVOLUTION_GLOBAL_APIKEY: 'chave-somente-teste', ...settings }));
        await (new BookAppointmentHandler() as any).notifyPatient(ev, g.prisma);
        casos[nome] = envios;
      };
      const ev = {
        id: 'ev-1', start_at: CONSULTA, location: null, assigned_user: { name: DENTISTA },
        lead_id: 'lead-1', lead: { name: PACIENTE, phone: TEL },
      };
      await rodar('com endereço da clínica (CLINIC_ADDRESS)', ev, { CLINIC_ADDRESS: 'Rua Exemplo, 100 — Centro, Maceió/AL' });
      await rodar('sem dentista e sem endereço', { ...ev, assigned_user: null }, {});
      expect(casos).toMatchSnapshot();
    } finally {
      if (instanciaAntes === undefined) delete process.env.EVOLUTION_INSTANCE_NAME;
      else process.env.EVOLUTION_INSTANCE_NAME = instanciaAntes;
    }
  });

  it('apps/worker/src/post-care/post-care-cron.service.ts — tick (pesquisa pós-atendimento: os 3 estilos)', async () => {
    const casos: Record<string, any> = {};
    for (const estilo of ['descontraido', 'formal', 'breve']) {
      envios = [];
      const g = gravador(
        banco(
          {
            'calendarEvent.findMany': () => [],
            'postCareSurvey.findMany': () => [
              { id: 's-1', procedure_summary: 'Limpeza', patient: { id: 'pac-1', name: PACIENTE, phone: TEL, tenant_id: TENANT }, dentist: { name: DENTISTA } },
            ],
          },
          // Sem config salva = padrão (ligado, "descontraído"); os outros estilos vêm da Central.
          estilo === 'descontraido' ? {} : { POST_CARE_CONFIG: JSON.stringify({ initial_choice: estilo }) },
        ),
      );
      await new PostCareCronService(g.prisma, SETTINGS).tick();
      casos[estilo] = envios;
    }
    expect(casos).toMatchSnapshot();
  });
});
