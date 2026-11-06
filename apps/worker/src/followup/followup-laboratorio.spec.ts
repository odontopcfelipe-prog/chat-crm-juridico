/**
 * Laboratório — o worker só roda sequência de mensagens e comunicado em massa do
 * laboratório quando a PRÓPRIA conta ligou: sequência da conta, ligada, com texto fixo
 * (sem IA). Sequência global, de outra conta ou desligada pausa a inscrição sem enviar.
 * O comunicado só sai se for do tipo COMUNICADO, com texto, de contato da mesma conta.
 * A clínica segue gerando a mensagem pela IA como sempre.
 *
 * Banco, Evolution e IA de teste: dublês em memória. Dados de exemplo (repositório público).
 */
import axios from 'axios';
import { __limparCacheLabTenants } from '@crm/shared';
import { FollowupProcessor } from './followup.processor';
import { FollowupCronService } from './followup-cron.service';

jest.mock('axios');
const post = axios.post as jest.Mock;

const LAB = 'conta-lab';
const CLINICA = 'conta-clinica';
// terça-feira, 12:00 em Maceió: dentro do horário comercial
const TERCA_MEIO_DIA = new Date('2027-01-12T15:00:00Z');

beforeEach(() => {
  __limparCacheLabTenants();
  post.mockReset();
  post.mockResolvedValue({ data: {} });
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout'] });
  jest.setSystemTime(TERCA_MEIO_DIA);
});
afterEach(() => jest.useRealTimers());

function montar(over: { tenant?: string; seq?: any; step?: any; lead?: any; status?: string; chaves?: string[]; conversa?: any; mensagens?: any[] } = {}) {
  const tenant = over.tenant ?? LAB;
  const step = { id: 'st1', position: 1, channel: 'whatsapp', custom_prompt: 'Olá, {{nome}}! Posso ajudar?', auto_send: true, ...over.step };
  const seq = { id: 's1', tenant_id: tenant, active: true, category: 'LEADS', steps: [step], ...over.seq };
  const lead = { id: 'l1', tenant_id: tenant, name: 'Ana Souza', phone: '5582999990000', is_client: false, ...over.lead };
  const enrollment = { id: 'e1', status: 'ATIVO', lead_id: 'l1', current_step: 1, lead, sequence: seq };
  const msgs: any[] = [];
  const enrollUpdates: any[] = [];
  const prisma: any = {
    tenantBusinessProfile: { findMany: jest.fn(async () => [{ tenant_id: LAB }]) },
    followupEnrollment: {
      findUnique: jest.fn(async () => enrollment),
      update: jest.fn(async (a: any) => {
        enrollUpdates.push(a.data);
        return {};
      }),
      findMany: jest.fn(async () => []),
    },
    followupMessage: {
      count: jest.fn(async () => 0),
      create: jest.fn(async ({ data }: any) => {
        msgs.push(data);
        return { id: 'm1', ...data };
      }),
      update: jest.fn(async () => ({})),
      findUnique: jest.fn(async () => ({ enrollment: { ...enrollment, sequence: seq } })),
    },
    conversation: {
      findFirst: jest.fn(async () => ({ id: 'cv1', instance_name: 'chip-da-conta', ai_mode: true, last_message_at: new Date('2027-01-01T00:00:00Z'), ...over.conversa })),
      update: jest.fn(async () => ({})),
    },
    message: { create: jest.fn(async () => ({})), findMany: jest.fn(async () => over.mensagens ?? []) },
    tenant: { findUnique: jest.fn(async () => ({ status: over.status ?? 'ACTIVE' })) },
    globalSetting: { findMany: jest.fn(async ({ where }: any) => (over.chaves ?? []).filter((k) => where.key.in.includes(k)).map(() => ({ value: 'true' }))) },
    lead: { findUnique: jest.fn(async () => lead), update: jest.fn(async () => ({})) },
    dispatchLog: { create: jest.fn(async () => ({})), findMany: jest.fn(async () => []) },
    leadDispatch: { findMany: jest.fn(async () => []) },
    broadcastJob: { findUnique: jest.fn(), update: jest.fn(async () => ({})) },
    broadcastItem: { findUnique: jest.fn(), update: jest.fn(async () => ({})), count: jest.fn(async () => 1) },
    calendarEvent: { findUnique: jest.fn(async () => null) },
  };
  const settings: any = { getEvolutionConfig: jest.fn(async () => ({ apiUrl: 'http://evolution.test', apiKey: 'k' })) };
  const ia: any = {
    buildDossie: jest.fn(async () => ({ pessoa: {}, historico: {}, tarefa: {} })),
    generateMessage: jest.fn(async () => 'texto da IA'),
    classifyRisk: jest.fn(() => 'baixo'),
  };
  const proc = new FollowupProcessor(prisma, settings, ia);
  return { proc, prisma, ia, msgs, enrollUpdates };
}

describe('sequência no worker', () => {
  it('laboratório com sequência própria e ligada: envia o texto fixo pelo chip da conta, sem IA', async () => {
    const { proc, ia, msgs } = montar();
    await proc.process({ name: 'process-step', data: { enrollment_id: 'e1' } } as any);
    expect(ia.buildDossie).not.toHaveBeenCalled();
    expect(ia.generateMessage).not.toHaveBeenCalled();
    expect(msgs[0]).toMatchObject({ generated_text: 'Olá, Ana! Posso ajudar?', status: 'APROVADO', risk_level: 'baixo' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('http://evolution.test/message/sendText/chip-da-conta');
    expect(post.mock.calls[0][1]).toEqual({ number: '5582999990000', text: 'Olá, Ana! Posso ajudar?' });
  });

  it.each([
    ['sequência global (das clínicas)', { seq: { tenant_id: null } }],
    ['sequência de outra conta', { seq: { tenant_id: CLINICA } }],
    ['sequência desligada', { seq: { active: false } }],
    ['contato que pediu para não receber', { lead: { contact_opt_out_at: new Date() } }],
    ['número sem WhatsApp', { lead: { whatsapp_invalid_at: new Date() } }],
  ])('laboratório: %s pausa a inscrição e não envia', async (_n, over) => {
    const { proc, msgs, enrollUpdates } = montar(over as any);
    await proc.process({ name: 'process-step', data: { enrollment_id: 'e1' } } as any);
    expect(enrollUpdates[0].status).toBe('PAUSADO');
    expect(msgs).toHaveLength(0);
    expect(post).not.toHaveBeenCalled();
  });

  it('laboratório: passo sem texto fixo (que seria de IA) pausa e não gera texto', async () => {
    const { proc, ia, msgs, enrollUpdates } = montar({ step: { custom_prompt: null } });
    await proc.process({ name: 'process-step', data: { enrollment_id: 'e1' } } as any);
    expect(ia.generateMessage).not.toHaveBeenCalled();
    expect(enrollUpdates[0].status).toBe('PAUSADO');
    expect(msgs).toHaveLength(0);
    expect(post).not.toHaveBeenCalled();
  });

  it('clínica: continua gerando a mensagem pela IA', async () => {
    const { proc, ia, msgs } = montar({ tenant: CLINICA, step: { custom_prompt: 'instrução extra' } });
    await proc.process({ name: 'process-step', data: { enrollment_id: 'e1' } } as any);
    expect(ia.generateMessage).toHaveBeenCalledTimes(1);
    expect(msgs[0].generated_text).toBe('texto da IA');
  });
});

describe('sequência com a conta de laboratório suspensa ou congelada', () => {
  it.each([
    ['SUSPENDED', { status: 'SUSPENDED' }],
    ['DELETED', { status: 'DELETED' }],
    ['LAB_FREEZE', { chaves: ['LAB_FREEZE'] }],
    ['LAB_FREEZE_<conta>', { chaves: [`LAB_FREEZE_${LAB}`] }],
  ])('%s: não envia, não pausa e olha de novo em 12 h', async (_n, conta) => {
    const m = montar(conta as any);
    await m.proc.process({ name: 'process-step', data: { enrollment_id: 'e1' } } as any);
    expect(post).not.toHaveBeenCalled();
    expect(m.msgs).toHaveLength(0);
    expect(m.enrollUpdates).toEqual([{ next_send_at: new Date(TERCA_MEIO_DIA.getTime() + 12 * 3600000) }]);
  });

  it('TRIAL envia; a conta que volta a ficar ativa envia na próxima rodada', async () => {
    const trial = montar({ status: 'TRIAL' });
    await trial.proc.process({ name: 'process-step', data: { enrollment_id: 'e1' } } as any);
    expect(post).toHaveBeenCalledTimes(1);

    post.mockClear();
    const m = montar({ status: 'SUSPENDED' });
    await m.proc.process({ name: 'process-step', data: { enrollment_id: 'e1' } } as any);
    expect(post).not.toHaveBeenCalled();
    m.prisma.tenant.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    await m.proc.process({ name: 'process-step', data: { enrollment_id: 'e1' } } as any);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('mensagem aprovada antes de a conta ser suspensa não sai', async () => {
    const m = montar({ status: 'SUSPENDED' });
    m.prisma.followupMessage.findUnique.mockResolvedValue({
      id: 'm1', status: 'APROVADO', lead_id: 'l1', generated_text: 'x',
      enrollment: { id: 'e1', lead: { tenant_id: LAB }, sequence: { category: 'LEADS' } },
      step: { channel: 'whatsapp' },
    });
    await m.proc.process({ name: 'send-message', data: { message_id: 'm1' } } as any);
    expect(post).not.toHaveBeenCalled();
  });

  it('a clínica não lê o status da conta', async () => {
    const m = montar({ tenant: CLINICA, status: 'SUSPENDED' });
    await m.proc.process({ name: 'process-step', data: { enrollment_id: 'e1' } } as any);
    expect(m.prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(m.ia.generateMessage).toHaveBeenCalledTimes(1);
  });
});

describe('sequência com a conversa aberta e a IA desligada', () => {
  const rodar = (m: ReturnType<typeof montar>) => m.proc.process({ name: 'process-step', data: { enrollment_id: 'e1' } } as any);
  const HA_2H = new Date(TERCA_MEIO_DIA.getTime() - 2 * 3600000);
  const adiada = [{ next_send_at: new Date(TERCA_MEIO_DIA.getTime() + 12 * 3600000) }];

  it('laboratório: ai_mode=false sem mensagem recente envia (antes adiava para sempre)', async () => {
    const m = montar({ conversa: { ai_mode: false } });
    await rodar(m);
    expect(post).toHaveBeenCalledTimes(1);
    expect(m.msgs).toHaveLength(1);
  });

  it.each([
    ['do contato', { direction: 'in', external_message_id: 'wa-1', skill_id: null, created_at: HA_2H }],
    ['da equipe', { direction: 'out', external_message_id: 'out_123', skill_id: null, created_at: HA_2H }],
  ])('laboratório: mensagem %s nas últimas 12 h adia 12 h', async (_n, msg) => {
    const m = montar({ conversa: { ai_mode: false, last_message_at: HA_2H }, mensagens: [msg] });
    await rodar(m);
    expect(post).not.toHaveBeenCalled();
    expect(m.enrollUpdates).toEqual(adiada);
  });

  it.each([
    ['da própria sequência', { direction: 'out', external_message_id: 'sys_followup_ia_1', skill_id: null, created_at: HA_2H }],
    ['de lembrete', { direction: 'out', external_message_id: 'sys_reminder_1', skill_id: null, created_at: HA_2H }],
    ['da IA', { direction: 'out', external_message_id: 'wa-2', skill_id: 'skill-1', created_at: HA_2H }],
  ])('laboratório: envio automático %s não adia, mesmo com last_message_at recente', async (_n, msg) => {
    const m = montar({ conversa: { ai_mode: false, last_message_at: HA_2H }, mensagens: [msg] });
    await rodar(m);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('laboratório: a consulta fica na janela de 12 h e fora as notas internas', async () => {
    const m = montar({ conversa: { ai_mode: false } });
    await rodar(m);
    expect(m.prisma.message.findMany.mock.calls[0][0].where).toEqual({
      conversation_id: 'cv1',
      created_at: { gte: new Date(TERCA_MEIO_DIA.getTime() - 12 * 3600000) },
      type: { notIn: ['internal_note', 'note', 'transfer_event'] },
    });
  });

  it('laboratório: sem conseguir ler as mensagens, adia (não envia no escuro)', async () => {
    const m = montar({ conversa: { ai_mode: false } });
    m.prisma.message.findMany.mockRejectedValue(new Error('banco fora'));
    await rodar(m);
    expect(post).not.toHaveBeenCalled();
    expect(m.enrollUpdates).toEqual(adiada);
  });

  it('clínica: ai_mode=false continua adiando 12 h, sem olhar as mensagens', async () => {
    const m = montar({ tenant: CLINICA, conversa: { ai_mode: false } });
    await rodar(m);
    expect(m.ia.generateMessage).not.toHaveBeenCalled();
    expect(m.prisma.message.findMany).not.toHaveBeenCalled();
    expect(m.enrollUpdates).toEqual(adiada);
  });

  it('clínica: conversa com last_message_at nas últimas 12 h continua adiando', async () => {
    const m = montar({ tenant: CLINICA, conversa: { last_message_at: HA_2H } });
    await rodar(m);
    expect(m.ia.generateMessage).not.toHaveBeenCalled();
    expect(m.enrollUpdates).toEqual(adiada);
  });
});

describe('comunicado em massa no worker', () => {
  function disparo(tipo: string, tenantDoDisparo: string, tenantDoContato: string, over: any = {}) {
    const m = montar({ tenant: tenantDoContato, lead: over.lead });
    m.prisma.broadcastJob.findUnique.mockResolvedValue({ id: 'b1', status: 'ENVIANDO', type: tipo, tenant_id: tenantDoDisparo });
    m.prisma.broadcastItem.findUnique.mockResolvedValue({ id: 'i1', status: 'PENDENTE', lead_id: 'l1', event_id: null });
    return m;
  }
  const rodar = (m: ReturnType<typeof montar>, texto?: string) =>
    m.proc.process({ name: 'broadcast-send', data: { broadcast_id: 'b1', item_id: 'i1', custom_prompt: texto } } as any);

  it('laboratório: comunicado da conta, com texto, sai com {{nome}} trocado', async () => {
    const m = disparo('COMUNICADO', LAB, LAB);
    await rodar(m, 'Olá, {{nome}}! Fechamos na sexta.');
    expect(post.mock.calls[0][1]).toEqual({ number: '5582999990000', text: 'Olá, Ana! Fechamos na sexta.' });
  });

  it.each([
    ['tipo que gera texto por IA', 'AUDIENCIA', LAB, LAB, 'texto'],
    ['sem texto', 'COMUNICADO', LAB, LAB, undefined],
    ['contato de outra conta', 'COMUNICADO', LAB, CLINICA, 'texto'],
    ['disparo da clínica para contato do laboratório', 'COMUNICADO', CLINICA, LAB, 'texto'],
  ])('laboratório: %s não sai', async (_n, tipo, tDisparo, tContato, texto) => {
    const m = disparo(tipo as string, tDisparo as string, tContato as string);
    await rodar(m, texto as string | undefined);
    expect(post).not.toHaveBeenCalled();
    expect(m.prisma.broadcastItem.update.mock.calls[0][0].data.status).toBe('FALHOU');
  });

  it('contato que pediu para não receber não recebe o comunicado do laboratório', async () => {
    const m = disparo('COMUNICADO', LAB, LAB, { lead: { contact_opt_out_at: new Date() } });
    await rodar(m, 'texto');
    expect(post).not.toHaveBeenCalled();
  });

  it('conta do laboratório suspensa: o item vira falha e nada sai', async () => {
    const m = disparo('COMUNICADO', LAB, LAB);
    m.prisma.tenant.findUnique.mockResolvedValue({ status: 'SUSPENDED' });
    await rodar(m, 'texto');
    expect(post).not.toHaveBeenCalled();
    expect(m.prisma.broadcastItem.update.mock.calls[0][0].data).toMatchObject({ status: 'FALHOU' });
  });

  it('clínica: comunicado sai como sempre', async () => {
    const m = disparo('COMUNICADO', CLINICA, CLINICA);
    await rodar(m, 'Olá, {{nome}}!');
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('cron de inscrições', () => {
  it('a inscrição do laboratório vem numa busca própria, sem ocupar o take da clínica', async () => {
    const queue: any = { add: jest.fn(async () => ({})) };
    const prisma: any = {
      tenantBusinessProfile: { findMany: jest.fn(async () => [{ tenant_id: LAB }]) },
      followupEnrollment: { findMany: jest.fn(async () => [{ id: 'e1' }]) },
    };
    const cron = new FollowupCronService(prisma, {} as any, queue);
    await cron.processEnrollments();
    expect(prisma.followupEnrollment.findMany.mock.calls[0][0].where.lead).toBeDefined();
    expect(prisma.followupEnrollment.findMany.mock.calls[1][0].where.lead).toEqual({ tenant_id: { in: [LAB] } });
    expect(queue.add).toHaveBeenCalledTimes(2);
  });
});
