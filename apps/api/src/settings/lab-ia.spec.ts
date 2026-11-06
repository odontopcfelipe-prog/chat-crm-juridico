/**
 * IA do laboratório na API: transcrição e correção só com a conta em ACTIVE e com texto de
 * laboratório; a clínica faz a mesma chamada de sempre. Ligar a IA numa conversa só na conta
 * dela. Robô com prompt e ferramentas de laboratório.
 *
 * Repositório público: ids fictícios.
 */
import { Logger } from '@nestjs/common';
import { __limparCacheLabTenants } from '@crm/shared';
import { MessagesService } from '../messages/messages.service';
import { ConversationsService } from '../conversations/conversations.service';
import { AdminBotService } from '../admin-bot/admin-bot.service';
import { LAB_ROBO, LAB_ROBO_FERRAMENTAS } from '../admin-bot/lab-robo-textos';
import { SettingsController } from './settings.controller';
import { LIMITE_CORRECAO, LIMITE_TESTE_DA_IA, LIMITE_TRANSCRICAO } from './lab-ia-conta';

const mockCriarChat = jest.fn();
const mockTranscrever = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCriarChat } },
    audio: { transcriptions: { create: mockTranscrever } },
  })),
  toFile: jest.fn(async () => ({})),
}));

const LAB = 'conta-lab';
const CLINICA = 'conta-clinica';
const { LAB_IA_API } = jest.requireActual('./lab-ia-api-textos');

const prismaBase = (status: string, extra: any = {}) => ({
  tenantBusinessProfile: { findMany: jest.fn(async () => [{ tenant_id: LAB }]) },
  tenant: { findUnique: jest.fn(async () => ({ status })) },
  globalSetting: { findMany: jest.fn(async () => []) },
  tenantSetting: { findUnique: jest.fn(async () => null) },
  aiUsage: { create: jest.fn(async () => ({})) },
  ...extra,
});

beforeAll(() => {
  for (const m of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
});
beforeEach(() => {
  __limparCacheLabTenants();
  mockCriarChat.mockReset();
  mockTranscrever.mockReset();
  mockCriarChat.mockResolvedValue({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
  mockTranscrever.mockResolvedValue({ text: 'transcrito', usage: { input_tokens: 4, output_tokens: 1 } });
  for (const limite of [LIMITE_TESTE_DA_IA, LIMITE_CORRECAO, LIMITE_TRANSCRICAO]) limite.limpar();
});

function montarMensagens(prisma: any) {
  const svc: any = Object.create(MessagesService.prototype);
  svc.prisma = prisma;
  svc.logger = { warn: jest.fn(), log: jest.fn() };
  svc.settings = { getAiConfig: jest.fn(async () => ({ apiKey: 'sk-teste' })) };
  svc.assertMessageTenant = jest.fn(async () => undefined);
  svc.fileStorage = { read: jest.fn(async () => Buffer.from('a')) };
  return svc;
}

describe('correção de texto', () => {
  it.each(['TRIAL', 'SUSPENDED', 'DELETED'])('laboratório em %s: 403 explicando a assinatura, sem chamar a OpenAI', async (status) => {
    const svc = montarMensagens(prismaBase(status));
    await expect(svc.correctText('oi', 'corrigir', LAB)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'LAB_IA_SEM_ASSINATURA' }),
    });
    expect(mockCriarChat).not.toHaveBeenCalled();
  });

  it('laboratório em ACTIVE: sem texto de outro ramo e com o gasto na conta dele, mesmo sem chip ligado', async () => {
    const prisma = prismaBase('ACTIVE');
    const svc = montarMensagens(prisma);
    await svc.correctText('oi', 'profissional', LAB);
    const sistema = mockCriarChat.mock.calls[0][0].messages[0].content;
    expect(sistema).toContain('laboratório de prótese');
    expect(sistema).not.toMatch(/jur[ií]dic/i);
    expect(prisma.aiUsage.create.mock.calls[0][0].data).toMatchObject({ tenant_id: LAB, call_type: 'chat', prompt_tokens: 3, completion_tokens: 2 });
  });

  it('clínica: o prompt de sempre, sem ler status nem gravar gasto', async () => {
    const prisma = prismaBase('ACTIVE');
    const svc = montarMensagens(prisma);
    await svc.correctText('oi', 'profissional', CLINICA);
    expect(mockCriarChat.mock.calls[0][0].messages[0].content).toBe(
      'Reescreva o texto a seguir de forma profissional, adequada para comunicação jurídica. Retorne apenas o texto reescrito, sem nenhuma explicação.',
    );
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.aiUsage.create).not.toHaveBeenCalled();
  });

  it('laboratório: texto acima de 4.000 caracteres é recusado sem chamar a OpenAI e sem contar no limite', async () => {
    const svc = montarMensagens(prismaBase('ACTIVE'));
    await expect(svc.correctText('a'.repeat(4001), 'corrigir', LAB)).rejects.toMatchObject({ status: 400 });
    expect(mockCriarChat).not.toHaveBeenCalled();
    await svc.correctText('a'.repeat(4000), 'corrigir', LAB);
    expect(mockCriarChat).toHaveBeenCalledTimes(1);
  });

  it('laboratório: a chamada leva max_tokens; clínica: sem max_tokens e sem limite de tamanho', async () => {
    const svc = montarMensagens(prismaBase('ACTIVE'));
    await svc.correctText('oi', 'corrigir', LAB);
    expect(mockCriarChat.mock.calls[0][0].max_tokens).toBeGreaterThan(0);
    mockCriarChat.mockClear();
    await svc.correctText('a'.repeat(4001), 'corrigir', CLINICA);
    expect(Object.keys(mockCriarChat.mock.calls[0][0]).sort()).toEqual(['messages', 'model']);
  });

  it('laboratório: a chamada 121 da hora responde 429 sem chamar a OpenAI; outra conta e clínica não sentem', async () => {
    const svc = montarMensagens(prismaBase('ACTIVE'));
    for (let i = 0; i < 120; i++) await svc.correctText('oi', 'corrigir', LAB);
    mockCriarChat.mockClear();
    await expect(svc.correctText('oi', 'corrigir', LAB)).rejects.toMatchObject({ status: 429, message: LAB_IA_API.limiteCorrecao });
    expect(mockCriarChat).not.toHaveBeenCalled();
    await svc.correctText('oi', 'corrigir', CLINICA);
    expect(mockCriarChat).toHaveBeenCalledTimes(1);
  });
});

describe('transcrição', () => {
  const audio = { id: 'm1', type: 'audio', conversation_id: 'c1', media: { file_path: 'a.ogg', mime_type: 'audio/ogg' } };
  const comMensagem = (status: string) =>
    prismaBase(status, { message: { findUnique: jest.fn(async () => audio), update: jest.fn(async () => ({})) } });

  it('laboratório em TRIAL: 403, sem ler a mensagem nem chamar a OpenAI', async () => {
    const prisma = comMensagem('TRIAL');
    const svc = montarMensagens(prisma);
    await expect(svc.transcribeAudio('m1', LAB)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'LAB_IA_SEM_ASSINATURA' }),
    });
    expect(prisma.message.findUnique).not.toHaveBeenCalled();
    expect(mockTranscrever).not.toHaveBeenCalled();
  });

  it('laboratório em ACTIVE: prompt de laboratório e gasto na conta dele', async () => {
    const prisma = comMensagem('ACTIVE');
    const svc = montarMensagens(prisma);
    expect(await svc.transcribeAudio('m1', LAB)).toEqual({ transcription: 'transcrito' });
    expect(mockTranscrever.mock.calls[0][0].prompt).toContain('laboratório de prótese');
    expect(prisma.aiUsage.create.mock.calls[0][0].data).toMatchObject({ tenant_id: LAB, call_type: 'whisper', conversation_id: 'c1' });
  });

  it('clínica: o prompt de sempre, sem gravar gasto', async () => {
    const prisma = comMensagem('ACTIVE');
    const svc = montarMensagens(prisma);
    await svc.transcribeAudio('m1', CLINICA);
    expect(mockTranscrever.mock.calls[0][0].prompt).toMatch(/escritório de advocacia/);
    expect(prisma.aiUsage.create).not.toHaveBeenCalled();
  });

  it('laboratório: a transcrição 121 da hora responde 429 sem chamar a OpenAI; clínica não sente', async () => {
    const svc = montarMensagens(comMensagem('ACTIVE'));
    for (let i = 0; i < 120; i++) await svc.transcribeAudio('m1', LAB);
    mockTranscrever.mockClear();
    await expect(svc.transcribeAudio('m1', LAB)).rejects.toMatchObject({ status: 429, message: LAB_IA_API.limiteTranscricao });
    expect(mockTranscrever).not.toHaveBeenCalled();
    await svc.transcribeAudio('m1', CLINICA);
    expect(mockTranscrever).toHaveBeenCalledTimes(1);
  });
});

describe('chat de teste da IA', () => {
  const pedido = (conta: string) => ({ user: { tenant_id: conta } });

  function montarControle() {
    const aiTest = { run: jest.fn(async () => ({ ok: true })) };
    const ctl = new SettingsController({} as any, {} as any, {} as any, prismaBase('ACTIVE') as any, aiTest as any);
    return { ctl, aiTest };
  }

  it('laboratório: a chamada 31 da hora responde 429 sem rodar o teste; outra conta segue', async () => {
    const { ctl, aiTest } = montarControle();
    for (let i = 0; i < 30; i++) await ctl.aiTestChat(pedido(LAB), {});
    expect(aiTest.run).toHaveBeenCalledTimes(30);
    await expect(ctl.aiTestChat(pedido(LAB), {})).rejects.toMatchObject({ status: 429, message: LAB_IA_API.limiteTeste });
    expect(aiTest.run).toHaveBeenCalledTimes(30);
  });

  it('clínica: sem limite', async () => {
    const { ctl, aiTest } = montarControle();
    for (let i = 0; i < 31; i++) await ctl.aiTestChat(pedido(CLINICA), {});
    expect(aiTest.run).toHaveBeenCalledTimes(31);
  });
});

describe('ligar a IA numa conversa', () => {
  function montarConversas(status: string, chaves: Record<string, string>, conversa: any) {
    const prisma: any = prismaBase(status, {
      tenantSetting: {
        findUnique: jest.fn(async ({ where }: any) => {
          const v = chaves[where.tenant_id_key.key];
          return v === undefined ? null : { value: v };
        }),
      },
      conversation: {
        findFirst: jest.fn(async ({ where }: any) => (where.tenant_id === conversa?.tenant_id ? conversa : null)),
        update: jest.fn(async ({ data }: any) => ({ id: 'c1', lead_id: null, ...data })),
      },
      instance: { findFirst: jest.fn(async () => ({ purpose: 'COMERCIAL' })) },
      lead: { updateMany: jest.fn(async () => ({ count: 0 })) },
    });
    const svc: any = Object.create(ConversationsService.prototype);
    svc.prisma = prisma;
    svc.logger = { warn: jest.fn(), log: jest.fn() };
    return { svc, prisma };
  }
  const daConta = { id: 'c1', tenant_id: LAB, instance_name: 'chip-1' };

  it('conversa de outra conta: não encontrada', async () => {
    const { svc, prisma } = montarConversas('ACTIVE', { AI_ENABLED_COMERCIAL: 'true' }, { ...daConta, tenant_id: CLINICA });
    await expect(svc.setAiMode('c1', true, LAB)).rejects.toMatchObject({ status: 404 });
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it('TRIAL: 403 explicando; chip desligado: 400; os dois sem gravar', async () => {
    const trial = montarConversas('TRIAL', { AI_ENABLED_COMERCIAL: 'true' }, daConta);
    await expect(trial.svc.setAiMode('c1', true, LAB)).rejects.toMatchObject({ status: 403 });
    const sem = montarConversas('ACTIVE', {}, daConta);
    await expect(sem.svc.setAiMode('c1', true, LAB)).rejects.toMatchObject({ status: 400 });
    expect(trial.prisma.conversation.update).not.toHaveBeenCalled();
    expect(sem.prisma.conversation.update).not.toHaveBeenCalled();
  });

  it('chip ligado em ACTIVE: liga; desligar vale sempre', async () => {
    const ok = montarConversas('ACTIVE', { AI_ENABLED_COMERCIAL: 'true' }, daConta);
    await expect(ok.svc.setAiMode('c1', true, LAB)).resolves.toMatchObject({ ai_mode: true });
    const trial = montarConversas('TRIAL', {}, daConta);
    await expect(trial.svc.setAiMode('c1', false, LAB)).resolves.toMatchObject({ ai_mode: false });
  });

  it('clínica: não confere nada além do que já fazia', async () => {
    const c = montarConversas('ACTIVE', {}, daConta);
    await c.svc.setAiMode('c1', true, CLINICA);
    expect(c.prisma.conversation.findFirst).not.toHaveBeenCalled();
    expect(c.prisma.conversation.update).toHaveBeenCalledTimes(1);
  });
});

describe('robô dos ADMs', () => {
  function montarRobo(raw: string | null) {
    const prisma: any = prismaBase('TRIAL', {
      globalSetting: { findUnique: jest.fn(async () => (raw === null ? null : { value: raw })), findMany: jest.fn(async () => []) },
      lead: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
      user: { findFirst: jest.fn(async () => null) },
    });
    const svc: any = Object.create(AdminBotService.prototype);
    svc.prisma = prisma;
    svc.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
    svc.enabledCache = new Map();
    svc.sessions = new Map();
    return { svc, prisma };
  }

  it("laboratório: só liga com a chave da conta em 'true' (nasce desligado)", async () => {
    expect(await montarRobo(null).svc.isEnabled(LAB)).toBe(false);
    __limparCacheLabTenants();
    expect(await montarRobo('false').svc.isEnabled(LAB)).toBe(false);
    __limparCacheLabTenants();
    expect(await montarRobo('true').svc.isEnabled(LAB)).toBe(true);
  });

  it('prompt e ferramentas de laboratório sem texto de outro ramo', () => {
    const tudo = `${LAB_ROBO.prompt('hoje', '10:00')}\n${JSON.stringify(LAB_ROBO_FERRAMENTAS)}`;
    expect(tudo).not.toMatch(/jur[ií]dic|processo|audi[eê]ncia|honor[aá]rio|consulta\b|paciente|escrit[oó]rio|legal_case|CONSULTA/i);
    const tipos = LAB_ROBO_FERRAMENTAS.find((f) => f.function.name === 'create_calendar_event').function.parameters.properties.type.enum;
    expect(tipos).toEqual(['COLETA', 'PROVA', 'ENTREGA', 'TAREFA', 'OUTRO']);
  });

  it('ferramenta fora da lista do laboratório é recusada', async () => {
    const { svc } = montarRobo('true');
    expect(await svc.executeTool('create_charge', { lead_id: 'x' }, 'u', LAB, true)).toEqual({ error: LAB_ROBO.ferramentaFechada });
    expect(await svc.executeTool('search_leads', { query: 'x' }, 'u', null, true)).toEqual({ error: LAB_ROBO.ferramentaFechada });
  });

  it('cliente de outra conta é recusado, com texto de laboratório', async () => {
    const { svc, prisma } = montarRobo('true');
    expect(await svc.executeTool('create_task', { title: 't', lead_id: 'de-outra-conta' }, 'u', LAB, true)).toEqual({ error: LAB_ROBO.clienteFora });
    expect(prisma.lead.findFirst.mock.calls[0][0].where).toEqual({ id: 'de-outra-conta', tenant_id: LAB });
  });

  it('agenda: hora de Maceió sem fuso continua naive-UTC', () => {
    const { svc } = montarRobo('true');
    expect(svc.argumentosDoLaboratorio('create_calendar_event', { start_at: '2031-01-10T14:00:00' }).start_at).toBe('2031-01-10T14:00:00Z');
    expect(svc.argumentosDoLaboratorio('create_calendar_event', { start_at: '2031-01-10T14:00:00-03:00' }).start_at).toBe('2031-01-10T14:00:00-03:00');
  });
});
